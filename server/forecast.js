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

// Shape-scaled projection: where you'll land if you finish the curve like last time.
function shapeForecast({ cum, currentValue, r }) {
  const f = fractionAt(cum, r);
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
function forecast({ cum, currentValue, target, r, daysLeft, recentRatePerDay, weightMomentum = null }) {
  const shape = shapeForecast({ cum, currentValue, r });
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
    fNow: fractionAt(cum, r),
    status: statusVsTarget(projected, target),
    vsTargetPct: target > 0 ? Math.round((projected / target) * 100) : null,
  };
}

module.exports = { toCumulative, fractionAt, shapeForecast, momentumForecast, statusVsTarget, forecast };
