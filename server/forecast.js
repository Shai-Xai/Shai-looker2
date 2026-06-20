// ─── Goal forecasting (deterministic) ───────────────────────────────────────────
// Pure functions, no I/O and no AI (see docs/GOALS_FORECAST.md). Given last time's
// cumulative curve and where we are now in the cycle, project the final outcome and
// a range. The AI only PHRASES these computed numbers elsewhere — it never invents
// them. Two signals:
//   • shape   — scale the current value by last time's fraction-reached-by-now
//               (rides the historical curve, so it knows sales are back-loaded);
//   • momentum — extend the recent run-rate to the deadline (catches a spike/slump).

// Series → cumulative array. Accepts [{v}] or [number]; if the values look like
// per-period increments (not non-decreasing) they're accumulated.
function toCumulative(series) {
  const vals = (series || []).map((p) => (typeof p === 'number' ? p : Number(p && p.v))).filter(Number.isFinite);
  if (vals.length < 2) return [];
  const nonDec = vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-9);
  let run = 0;
  return vals.map((v) => { run = nonDec ? v : run + v; return run; });
}

// Cumulative fraction of the final total reached at relative position r∈[0,1].
function fractionAt(cum, r) {
  if (!cum || !cum.length) return null;
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const x = Math.max(0, Math.min(1, r)) * (cum.length - 1);
  const i = Math.floor(x), f = x - i;
  const c = i + 1 < cum.length ? cum[i] + (cum[i + 1] - cum[i]) * f : cum[i];
  return c / total;
}

// Cumulative series that KEEPS each point's x-axis label. Mirrors toCumulative
// (accumulates only when the values look like per-period increments), returning
// [{ t, c }] so we can later align by the real axis, not by row position.
function cumulativeWithAxis(series) {
  const pts = (series || []).filter((p) => p && Number.isFinite(Number(p.v)));
  if (pts.length < 2) return null;
  const vals = pts.map((p) => Number(p.v));
  const nonDec = vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-9);
  let run = 0;
  return pts.map((p) => { run = nonDec ? Number(p.v) : run + Number(p.v); return { t: p.t, c: run }; });
}

// Interpolate a cumulative value at a target "days before the event", given points
// sorted by daysBefore DESCENDING (far from the event → event day → after). Clamps
// outside the data range.
function interpByDaysBefore(sorted, target) {
  if (!sorted.length) return null;
  if (target >= sorted[0].d) return sorted[0].c;
  if (target <= sorted[sorted.length - 1].d) return sorted[sorted.length - 1].c;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1]; // a.d > b.d
    if (target <= a.d && target >= b.d) {
      if (a.d === b.d) return b.c;
      const f = (a.d - target) / (a.d - b.d);
      return a.c + (b.c - a.c) * f;
    }
  }
  return sorted[sorted.length - 1].c;
}

// Read where last time ACTUALLY was at the same point in the sell cycle as now —
// not an index-position guess. When the curve's x-axis is "days before the event"
// (the ticket trend tile), we read last year's cumulative at days-before = daysLeft
// (the real data point). For an ISO-date axis (no shared event anchor) we fall back
// to the window fraction (position between start and deadline). Returns
// { fraction, total, valueAtNow, basis, daysLeft } or null.
function fractionAtNow(series, { deadlineMs, nowMs = Date.now(), startMs, daysLeft = null } = {}) {
  const cum = cumulativeWithAxis(series);
  if (!cum) return null;
  const total = Math.max(...cum.map((p) => p.c));
  if (!(total > 0)) return null;
  const isISO = (t) => /^\d{4}-\d{2}/.test(String(t));
  // Points that carry a real numeric "days before event" label. Trend tiles append a
  // stray totals row (empty x); ignore it rather than letting it veto the whole axis.
  const numPts = cum.filter((p) => p.t !== '' && p.t != null && !isISO(p.t) && Number.isFinite(Number(p.t)));
  const numericAxis = numPts.length >= 2 && numPts.length >= cum.length - 2;
  const dLeft = Number.isFinite(daysLeft) ? daysLeft
    : (Number.isFinite(deadlineMs) ? Math.round((deadlineMs - nowMs) / 86400000) : null);
  if (numericAxis && dLeft != null) {
    const sorted = numPts.map((p) => ({ d: Number(p.t), c: p.c })).sort((a, b) => b.d - a.d);
    const valueAtNow = interpByDaysBefore(sorted, dLeft);
    if (valueAtNow != null) return { fraction: valueAtNow / total, total, valueAtNow, basis: 'days-before', daysLeft: dLeft };
  }
  // Fallback: position within the [start → deadline] window, read by curve index.
  if (Number.isFinite(startMs) && Number.isFinite(deadlineMs) && deadlineMs > startMs) {
    const r = (nowMs - startMs) / (deadlineMs - startMs);
    const f = fractionAt(cum.map((p) => p.c), r);
    if (f != null) return { fraction: f, total, valueAtNow: total * f, basis: 'window', daysLeft: null };
  }
  return null;
}

// Shape-scaled projection: where you'll land if you finish the curve like last time.
// Prefer an explicit fNow (the real days-before fraction); else read it by index at r.
function shapeForecast({ cum, currentValue, r, fNow = null }) {
  const f = fNow != null ? fNow : fractionAt(cum, r);
  if (f == null || f <= 0 || !Number.isFinite(currentValue)) return null;
  return currentValue / f;
}

// Run-rate projection: extend recent daily rate to the deadline.
function momentumForecast({ currentValue, recentRatePerDay, daysLeft }) {
  if (![currentValue, recentRatePerDay, daysLeft].every(Number.isFinite)) return null;
  return currentValue + recentRatePerDay * Math.max(0, daysLeft);
}

function statusVsTarget(projected, target) {
  if (!Number.isFinite(projected) || !Number.isFinite(target) || target <= 0) return 'unknown';
  const ratio = projected / target;
  if (ratio >= 1) return 'will_hit';
  if (ratio >= 0.95) return 'borderline';
  return 'short';
}

// Blend the two signals into a projected final + an honest [lo,hi] range. Momentum is
// weighted more as the event nears (r→1) unless `weightMomentum` is given.
function forecast({ cum, currentValue, target, r, daysLeft, recentRatePerDay, weightMomentum = null, fNow = null }) {
  const shape = shapeForecast({ cum, currentValue, r, fNow });
  const momentum = momentumForecast({ currentValue, recentRatePerDay, daysLeft });
  if (shape == null && momentum == null) return null;
  const w = weightMomentum == null ? Math.max(0, Math.min(1, Number.isFinite(r) ? r : 0.5)) : weightMomentum;
  let projected;
  if (shape != null && momentum != null) projected = Math.round(shape * (1 - w) + momentum * w);
  else projected = Math.round(shape != null ? shape : momentum);
  const ends = [shape, momentum].filter((x) => x != null).map(Math.round);
  return {
    projected,
    range: [Math.min(...ends, projected), Math.max(...ends, projected)],
    shape: shape == null ? null : Math.round(shape),
    momentum: momentum == null ? null : Math.round(momentum),
    fNow: fNow != null ? fNow : fractionAt(cum, r),
    status: statusVsTarget(projected, target),
    vsTargetPct: target > 0 ? Math.round((projected / target) * 100) : null,
  };
}

module.exports = { toCumulative, fractionAt, cumulativeWithAxis, interpByDaysBefore, fractionAtNow, shapeForecast, momentumForecast, statusVsTarget, forecast };
