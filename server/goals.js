// ─── Goals: the Results pillar ──────────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the goals / goal_snapshots / goal_audit
// tables and all /api/goals routes. Mounted from index.js with injected deps.
// Canonical spec: docs/GOALS_MERGED.md. This is P1 (Foundation): event goals set
// per suite, the source-aware metric resolver (manual + tile-sourced), the North
// Star, pace + result bands. Roles/cascade (P3) and campaign attribution (P2) are
// schema-ready but dormant.
//
// Non-negotiables honoured here:
//   - goal values are COMPUTED by the resolver (the AI only phrases them);
//   - scope is enforced INSIDE the resolver — tile-sourced values go through the
//     same scoped query path as run-query (applyScope), never trusted to a caller;
//   - exactly ONE North Star per event, always present;
//   - goals are editable mid-event, lightly logged (goal_audit).
//
// resolveTileValue({ dashboardId, tileId, user, suiteId }) → number|null is
// injected by index.js (built on the shared query engine, server/query.js) so a
// tile-sourced goal reads the very number the dashboard shows.

const crypto = require('crypto');
const fc = require('./forecast');

const SOURCES = ['ticketing', 'cashless', 'access', 'audience', 'ga4', 'app', 'social_paid', 'sponsorship', 'manual'];
const DIRECTIONS = ['at_least', 'at_most', 'exact', 'range', 'composition'];

// Place a goal's sell-curve onto a 0..1 x-axis (1 = event day) so the chart can
// draw it without guessing the axis format. Last time spans its full cycle (0→1);
// this year reaches only `now` (= elapsed / (elapsed + daysLeft)), leaving the rest
// of the axis for the forecast curve. The forecast follows last time's REMAINING
// shape scaled to the current value (so it lands on `projected`).
// Trailing rows that don't increase the cumulative are empty/lagging data points
// (Looker returns 0 for days not yet ingested), not real zero-sales days — drop
// them so "actual" ends on the last day it genuinely moved.
function dropFlatTail(arr, valOf) {
  let end = arr.length - 1;
  while (end > 0 && valOf(arr[end]) <= valOf(arr[end - 1]) + 1e-9) end--;
  return arr.slice(0, end + 1);
}

// Returns { last:[{x,y}], cur:[{x,y}], forecast:[{x,y}], nowFrac, cycleDays } | null.
function positionForecast({ cumLast, cumThis, daysLeft, projected }) {
  if ((!cumLast || cumLast.length < 2) && (!cumThis || cumThis.length < 2)) return null;
  const DAY = 86400000;
  const isISO = (t) => /^\d{4}-\d{2}/.test(String(t));
  const dLeft = Number.isFinite(daysLeft) ? Math.max(0, daysLeft) : null;
  const allT = [...cumThis, ...cumLast].map((p) => p.t);
  // A numeric axis is only "days before event" when it's a COUNTDOWN (cumulative
  // rises as the number falls). A forward axis (day-of-month, week #) must use the
  // proportional/index path instead — otherwise it draws inverted and collapses.
  const numAll = [...cumLast, ...cumThis].filter((p) => p.t !== '' && p.t != null && !isISO(p.t) && Number.isFinite(Number(p.t)));
  const numericAxis = numAll.length >= 2 && fc.isCountdownAxis(numAll);
  const datedAxis = allT.length > 0 && allT.every((t) => isISO(t) && !Number.isNaN(Date.parse(t)));

  let last, cur, nowFrac, cycleDays = null;
  if (numericAxis) {
    // x-axis is "days before event": x = 1 − d/maxD, so d=0 (event) → right.
    const maxD = Math.max(...allT.map(Number), 1);
    const xOf = (t) => Math.max(0, Math.min(1, 1 - Number(t) / maxD));
    last = cumLast.map((p) => ({ x: xOf(p.t), y: Math.round(p.c) })).sort((a, b) => a.x - b.x);
    const curRaw = cumThis.map((p) => ({ x: xOf(p.t), y: Math.round(p.c) })).sort((a, b) => a.x - b.x);
    cur = dropFlatTail(curRaw, (p) => p.y); // end on the last real movement (largest x)
    nowFrac = cur.length ? cur[cur.length - 1].x : (dLeft != null ? xOf(dLeft) : 1);
    cycleDays = maxD;
  } else if (datedAxis && dLeft != null) {
    const cdRaw = cumThis.map((p) => ({ t: Date.parse(p.t), c: p.c })).sort((a, b) => a.t - b.t);
    const ld = cumLast.map((p) => ({ t: Date.parse(p.t), c: p.c })).sort((a, b) => a.t - b.t);
    // Cycle length uses the ORIGINAL last date (≈ today) + days to event, so the
    // axis still spans start→event even after we trim the lagging tail.
    const ty0 = cdRaw[0]?.t, tyNow = cdRaw[cdRaw.length - 1]?.t;
    const total = (tyNow - ty0) / DAY + dLeft;
    const cd = dropFlatTail(cdRaw, (p) => p.c); // end on the last day sales actually moved
    const ly0 = ld[0]?.t, lyEnd = ld[ld.length - 1]?.t; const lspan = (lyEnd - ly0) || 1;
    last = ld.map((p) => ({ x: (p.t - ly0) / lspan, y: Math.round(p.c) }));
    cur = total > 0 ? cd.map((p) => ({ x: (p.t - ty0) / (total * DAY), y: Math.round(p.c) })) : cd.map((p, i) => ({ x: i / Math.max(cd.length - 1, 1), y: Math.round(p.c) }));
    nowFrac = cur.length ? cur[cur.length - 1].x : 1;
    cycleDays = total > 0 ? Math.round(total) : null;
  } else {
    // No usable axis: align by index, but end this year at its cycle fraction so the
    // forecast still has room when daysLeft is known.
    const cumThisT = dropFlatTail(cumThis, (p) => p.c);
    const nC = cumThisT.length;
    nowFrac = dLeft != null && (nC + dLeft) > 0 ? Math.min(1, (nC - 1) / (nC - 1 + dLeft)) : 1;
    last = cumLast.map((p, i) => ({ x: cumLast.length > 1 ? i / (cumLast.length - 1) : 0, y: Math.round(p.c) }));
    cur = cumThisT.map((p, i) => ({ x: nC > 1 ? (i / (nC - 1)) * nowFrac : 0, y: Math.round(p.c) }));
    cycleDays = dLeft != null ? (nC - 1 + dLeft) : null; // rough: each point ≈ a day
  }

  // Forecast curve from `now`, hugging last time's remaining shape.
  let forecast = null;
  const now = cur.length ? cur[cur.length - 1] : null;
  if (now && last.length >= 2) {
    const interp = (pts, xq) => {
      if (xq <= pts[0].x) return pts[0].y;
      if (xq >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
      for (let i = 1; i < pts.length; i++) { if (pts[i].x >= xq) { const a = pts[i - 1], b = pts[i]; const f = (xq - a.x) / ((b.x - a.x) || 1); return a.y + (b.y - a.y) * f; } }
      return pts[pts.length - 1].y;
    };
    const Lnow = interp(last, now.x);
    if (Lnow > 0) {
      // Shape-only remaining curve from `now`…
      const shapeAhead = last.filter((p) => p.x > now.x).map((p) => ({ x: p.x, y: (now.y * p.y) / Lnow }));
      const shapeEnd = (now.y * interp(last, 1)) / Lnow;
      // …then remap its growth so it lands on the (possibly momentum-blended) projected,
      // keeping the curve's bend. So the dashed line, its end dot and the legend agree.
      const targetEnd = Number.isFinite(projected) ? projected : shapeEnd;
      const denom = (shapeEnd - now.y) || 1;
      const remap = (y) => Math.round(now.y + (y - now.y) * ((targetEnd - now.y) / denom));
      forecast = [{ x: now.x, y: now.y }, ...shapeAhead.map((p) => ({ x: p.x, y: remap(p.y) }))];
      if (forecast[forecast.length - 1].x < 0.999) forecast.push({ x: 1, y: Math.round(targetEnd) });
    }
  }
  if (!forecast && now && Number.isFinite(projected)) forecast = [{ x: now.x, y: now.y }, { x: 1, y: projected }];

  return { last, cur, forecast, nowFrac, cycleDays };
}

function mount(app, { db, auth, resolveTileValue, resolveTileSeries, resolveTileSeriesAll, resolveEventDate }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'event',
      owner_ref TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      metric_key TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      metric_ref TEXT NOT NULL DEFAULT '{}',
      target_value REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'at_least',
      display TEXT NOT NULL DEFAULT 'bar',
      by_date TEXT NOT NULL DEFAULT '',
      is_north_star INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      baseline_event_id TEXT NOT NULL DEFAULT '',
      baseline_value REAL,
      baseline_source TEXT NOT NULL DEFAULT '',
      baseline_comparable INTEGER NOT NULL DEFAULT 1,
      conversion_ref TEXT NOT NULL DEFAULT '',
      rolls_up_to TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      result_band TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goal_snapshots (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actual_value REAL,
      pace_projection REAL,
      on_pace INTEGER
    );
    CREATE TABLE IF NOT EXISTS goal_audit (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old TEXT,
      new TEXT,
      by TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goal_templates (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'entity',
      name TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_suite ON goals(suite_id);
    CREATE INDEX IF NOT EXISTS idx_goal_templates ON goal_templates(entity_id);
    CREATE INDEX IF NOT EXISTS idx_goal_snapshots ON goal_snapshots(goal_id, at);
  `);
  // Additive migration for tables created before `display` existed (idempotent).
  try { sql.exec("ALTER TABLE goals ADD COLUMN display TEXT NOT NULL DEFAULT 'bar'"); } catch { /* column already present */ }
  // Goal templates created before global scope existed.
  try { sql.exec("ALTER TABLE goal_templates ADD COLUMN scope TEXT NOT NULL DEFAULT 'entity'"); } catch { /* column already present */ }
  // Range goals: an upper bound for "keep it within a healthy band" (e.g. returning % 30–38).
  try { sql.exec('ALTER TABLE goals ADD COLUMN target_max REAL'); } catch { /* column already present */ }
  // Composition goals: parts of a 100% split (New/Returning, age bands…), each a target share.
  try { sql.exec("ALTER TABLE goals ADD COLUMN parts TEXT NOT NULL DEFAULT '[]'"); } catch { /* column already present */ }
  // Milestones: weekly/monthly checkpoints on the way to the target (Slice C).
  try { sql.exec("ALTER TABLE goals ADD COLUMN milestones TEXT NOT NULL DEFAULT '[]'"); } catch { /* column already present */ }
  // Personal goals (Slice D): per-user goals that contribute to the event. Default
  // team-visible; an owner can mark theirs private (owner + admins only).
  try { sql.exec("ALTER TABLE goals ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'"); } catch { /* column already present */ }
  // Checkpoint curve link: the value-over-time tile used to suggest checkpoints
  // (remembered so reopening the editor restores the link). { dashboardId, tileId, cadence }.
  try { sql.exec("ALTER TABLE goals ADD COLUMN curve_ref TEXT NOT NULL DEFAULT '{}'"); } catch { /* column already present */ }
  // Track-from date: the start of the sell window, so pace is measured over the real
  // cycle (not from when the goal happened to be created). Blank → falls back to created_at.
  try { sql.exec("ALTER TABLE goals ADD COLUMN start_date TEXT NOT NULL DEFAULT ''"); } catch { /* column already present */ }
  // Baseline tile link: a dashboard tile picked for "last time's" number (e.g. a
  // last-year KPI), remembered so reopening restores it and the card re-reads it live.
  // { dashboardId, tileId }. Distinct from baseline_event_id (a past event) / a typed value.
  try { sql.exec("ALTER TABLE goals ADD COLUMN baseline_ref TEXT NOT NULL DEFAULT '{}'"); } catch { /* column already present */ }
  // Tag: an operational area for the goal (Ticketing, Cashless, Access control…), so the
  // Goals page can group goals into one row per tag. Blank = untagged.
  try { sql.exec("ALTER TABLE goals ADD COLUMN tag TEXT NOT NULL DEFAULT ''"); } catch { /* column already present */ }

  const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
  function rowToGoal(r) {
    if (!r) return null;
    return {
      id: r.id, suiteId: r.suite_id, entityId: r.entity_id, scope: r.scope, ownerRef: r.owner_ref,
      name: r.name, metricKey: r.metric_key, source: r.source, metricRef: parseJson(r.metric_ref, {}),
      targetValue: r.target_value, targetMax: r.target_max == null ? null : r.target_max, unit: r.unit, direction: r.direction, display: r.display || 'bar', byDate: r.by_date,
      isNorthStar: !!r.is_north_star, position: r.position, milestones: parseJson(r.milestones, []),
      parts: parseJson(r.parts, []), tag: r.tag || '',
      curveRef: parseJson(r.curve_ref, null), startDate: r.start_date || '',
      baselineEventId: r.baseline_event_id, baselineValue: r.baseline_value, baselineSource: r.baseline_source,
      baselineRef: parseJson(r.baseline_ref, null),
      baselineComparable: !!r.baseline_comparable,
      conversionRef: r.conversion_ref ? parseJson(r.conversion_ref, null) : null,
      rollsUpTo: r.rolls_up_to || null, visibility: r.visibility || 'team',
      status: r.status, resultBand: r.result_band || null,
      createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
    };
  }
  const goalById = (id) => rowToGoal(sql.prepare('SELECT * FROM goals WHERE id=?').get(id));
  // Ordered by position (drag-to-reorder) then recency. The North Star is marked
  // by is_north_star, not forced to the front — so a client can order goals freely.
  const listGoals = (suiteId) => sql.prepare("SELECT * FROM goals WHERE suite_id=? AND scope='event' AND status='active' ORDER BY position, created_at").all(suiteId).map(rowToGoal);
  // Personal goals visible to this user: their own always; others only when
  // team-visible. Admins see all (for support / acting on a client's behalf).
  const listPersonalGoals = (suiteId, user) => {
    const all = sql.prepare("SELECT * FROM goals WHERE suite_id=? AND scope='personal' AND status='active' ORDER BY position, created_at").all(suiteId).map(rowToGoal);
    if (user.role === 'admin') return all;
    return all.filter((g) => g.visibility === 'team' || g.ownerRef === user.email);
  };

  // Sanitise incoming goal fields. P1 exposes only event goals; cascade/attribution
  // columns exist but aren't set here.
  function cleanInput(b = {}) {
    const mr = b.metricRef && typeof b.metricRef === 'object' ? b.metricRef : {};
    const cr = b.curveRef && typeof b.curveRef === 'object' ? b.curveRef : {};
    const br = b.baselineRef && typeof b.baselineRef === 'object' ? b.baselineRef : {};
    return {
      name: String(b.name || '').slice(0, 120),
      metricKey: String(b.metricKey || '').slice(0, 80),
      source: SOURCES.includes(b.source) ? b.source : 'manual',
      metricRef: { dashboardId: String(mr.dashboardId || '').slice(0, 64), tileId: String(mr.tileId || '').slice(0, 64), field: String(mr.field || '').slice(0, 200) },
      targetValue: Number(b.targetValue) || 0,
      // Range goals carry an upper bound; targetValue is the lower bound of the band.
      targetMax: (b.targetMax == null || b.targetMax === '') ? null : Number(b.targetMax),
      // Composition goals: the parts of a 100% split, each with a target share %.
      // A part may carry its own tile ref (tile-per-slice mode); else the goal's
      // breakdown tile (metricRef) supplies all slices by label.
      parts: Array.isArray(b.parts) ? b.parts.map((p) => ({
        label: String(p.label || '').slice(0, 60),
        target: Number(p.target) || 0,
        ...(p.tol != null && p.tol !== '' ? { tol: Number(p.tol) } : {}),
        ...(p.focus ? { focus: true } : {}),
        ...(p.ref && p.ref.tileId ? { ref: { dashboardId: String(p.ref.dashboardId || '').slice(0, 64), tileId: String(p.ref.tileId || '').slice(0, 64), dashboardName: String(p.ref.dashboardName || '').slice(0, 120), tileName: String(p.ref.tileName || '').slice(0, 120) } } : {}),
        ...(p.lastRef && p.lastRef.tileId ? { lastRef: { dashboardId: String(p.lastRef.dashboardId || '').slice(0, 64), tileId: String(p.lastRef.tileId || '').slice(0, 64), dashboardName: String(p.lastRef.dashboardName || '').slice(0, 120), tileName: String(p.lastRef.tileName || '').slice(0, 120) } } : {}),
      })).filter((p) => p.label).slice(0, 12) : [],
      unit: String(b.unit || '').slice(0, 16),
      tag: String(b.tag || '').trim().slice(0, 40),
      direction: DIRECTIONS.includes(b.direction) ? b.direction : 'at_least',
      display: ['bar', 'dial', 'ring'].includes(b.display) ? b.display : 'bar',
      byDate: String(b.byDate || '').slice(0, 32),
      startDate: String(b.startDate || '').slice(0, 32),
      position: Number.isFinite(Number(b.position)) ? Number(b.position) : 0,
      baselineEventId: String(b.baselineEventId || '').slice(0, 64),
      baselineValue: b.baselineValue == null || b.baselineValue === '' ? null : Number(b.baselineValue),
      baselineSource: String(b.baselineSource || '').slice(0, 32),
      // Personal-goal fields (ignored for event goals at the route level).
      scope: b.scope === 'personal' ? 'personal' : 'event',
      visibility: b.visibility === 'private' ? 'private' : 'team',
      rollsUpTo: String(b.rollsUpTo || '').slice(0, 64),
      // Checkpoint curve link (remembered for the editor): the value-over-time tile
      // used to suggest checkpoints + the cadence.
      curveRef: (cr.dashboardId && cr.tileId)
        ? { dashboardId: String(cr.dashboardId).slice(0, 64), tileId: String(cr.tileId).slice(0, 64), cadence: cr.cadence === 'weekly' ? 'weekly' : 'monthly', ...(cr.compareKey ? { compareKey: String(cr.compareKey).slice(0, 32) } : {}) }
        : null,
      // Baseline tile link (remembered for the editor + re-read live on the card): the
      // tile a picked "last time" number comes from.
      baselineRef: (br.dashboardId && br.tileId)
        ? { dashboardId: String(br.dashboardId).slice(0, 64), tileId: String(br.tileId).slice(0, 64) }
        : null,
      // Milestones: dated checkpoints on the way to the target. Sanitised, kept in
      // date order, capped (a goal isn't a project plan).
      milestones: Array.isArray(b.milestones) ? b.milestones
        .map((m) => {
          const lv = m && m.lastValue;
          const out = { byDate: String((m && m.byDate) || '').slice(0, 32), targetValue: Number(m && m.targetValue) };
          if (lv != null && lv !== '' && Number.isFinite(Number(lv))) out.lastValue = Number(lv); // last time's value at this checkpoint
          return out;
        })
        .filter((m) => m.byDate && Number.isFinite(m.targetValue))
        .sort((a, z) => a.byDate.localeCompare(z.byDate))
        .slice(0, 24) : [],
    };
  }

  // Exactly one North Star per event: setting one clears the rest (atomic).
  const setNorthStar = sql.transaction((suiteId, goalId) => {
    sql.prepare("UPDATE goals SET is_north_star=0 WHERE suite_id=? AND scope='event'").run(suiteId);
    sql.prepare('UPDATE goals SET is_north_star=1, updated_at=? WHERE id=?').run(now(), goalId);
  });
  // Guarantee one always exists: if the suite has active event goals but no North
  // Star, promote the top one.
  function ensureNorthStar(suiteId) {
    const hasNorth = sql.prepare("SELECT 1 FROM goals WHERE suite_id=? AND scope='event' AND is_north_star=1 AND status='active'").get(suiteId);
    if (hasNorth) return;
    const top = sql.prepare("SELECT id FROM goals WHERE suite_id=? AND scope='event' AND status='active' ORDER BY position, created_at LIMIT 1").get(suiteId);
    if (top) sql.prepare('UPDATE goals SET is_north_star=1 WHERE id=?').run(top.id);
  }
  const audit = (goalId, field, oldV, newV, by) =>
    sql.prepare('INSERT INTO goal_audit (id, goal_id, field, old, new, by, at) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), goalId, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), by || '', now());

  // ── The metric resolver (the real deliverable) ──
  // manual → the latest human-entered snapshot value. tile-sourced → the live
  // number off the dashboard tile (scope enforced inside resolveTileValue, which
  // runs the tile's query through applyScope). Returns { value, asOf, source }.
  async function resolveMetric(goal, ctx = {}) {
    const ref = goal.metricRef || {};
    // A goal is tile-sourced when it carries a tile ref — the tile IS the source.
    // `source` is just a descriptive category; everything without a tile ref reads
    // its latest manual snapshot (the universal fallback).
    const tileSourced = !!(ref.dashboardId && ref.tileId);
    if (!tileSourced) {
      const snap = sql.prepare('SELECT actual_value, at FROM goal_snapshots WHERE goal_id=? ORDER BY at DESC LIMIT 1').get(goal.id);
      return { value: snap ? snap.actual_value : null, asOf: snap ? snap.at : null, source: 'manual' };
    }
    if (typeof resolveTileValue !== 'function' || !ctx.user) return { value: null, asOf: null, source: goal.source };
    try {
      const value = await resolveTileValue({ dashboardId: ref.dashboardId, tileId: ref.tileId, field: ref.field, user: ctx.user, suiteId: goal.suiteId });
      return { value: value == null ? null : Number(value), asOf: now(), source: goal.source };
    } catch (e) { console.error('[goals] tile resolve failed', goal.id, e.message); return { value: null, asOf: null, source: goal.source }; }
  }

  // Composition goal: each part is a SHARE of the total. Two sources:
  //  • breakdown tile (one tile, category → value), matched to parts by label; or
  //  • a tile PER slice (each part carries its own ref) — summed to the total.
  // Parts are interlinked by construction (shared denominator), so up on one is down
  // on another, and slices drifting outside their band are flagged.
  async function resolveComposition(goal, user) {
    const partsCfg = Array.isArray(goal.parts) ? goal.parts : [];
    const build = (withVal, total, lastTotal) => {
      const parts = withVal.map((pt) => {
        const share = Math.round((pt.value / total) * 1000) / 10; // one decimal place
        const tol = Number.isFinite(Number(pt.tol)) ? Number(pt.tol) : 5; // ±pp default band
        const diff = share - Number(pt.target);
        const status = diff > tol ? 'over' : diff < -tol ? 'under' : 'in';
        let lastShare = null, deltaPp = null;
        if (Number.isFinite(pt.lastValue) && lastTotal > 0) {
          lastShare = Math.round((pt.lastValue / lastTotal) * 1000) / 10;
          deltaPp = Math.round((share - lastShare) * 10) / 10; // movement in percentage points
        }
        return { label: pt.label, target: Number(pt.target), tol, value: Math.round(pt.value), share, status, focus: !!pt.focus, lastShare, deltaPp };
      });
      const drift = parts.filter((p) => p.status !== 'in');
      return { composition: true, total: Math.round(total), parts, balanced: parts.length ? drift.length === 0 : null, driftCount: drift.length, asOf: now() };
    };
    // Tile-per-slice mode: at least two parts each carry their own tile ref. A part may
    // also carry a last-year tile (lastRef) to show its share's movement vs last time.
    if (partsCfg.filter((p) => p.ref && p.ref.tileId).length >= 2 && typeof resolveTileValue === 'function') {
      const read = async (r) => { if (!r || !r.tileId) return null; try { const v = await resolveTileValue({ dashboardId: r.dashboardId, tileId: r.tileId, user, suiteId: goal.suiteId }); return Number(v); } catch { return null; } };
      const withVal = await Promise.all(partsCfg.map(async (pt) => ({ ...pt, value: (await read(pt.ref)) || 0, lastValue: await read(pt.lastRef) })));
      const total = withVal.reduce((s, p) => s + (p.value || 0), 0);
      if (!(total > 0)) return { composition: true, parts: [], balanced: null, total: 0, asOf: now() };
      const lastTotal = withVal.reduce((s, p) => s + (Number.isFinite(p.lastValue) ? p.lastValue : 0), 0);
      return build(withVal, total, lastTotal);
    }
    // Breakdown-tile mode: one tile returns category → value.
    const ref = goal.metricRef || {};
    if (!ref.dashboardId || !ref.tileId || typeof resolveTileSeries !== 'function') return null;
    let series;
    try { series = await resolveTileSeries({ dashboardId: ref.dashboardId, tileId: ref.tileId, user, suiteId: goal.suiteId }); }
    catch { return null; }
    const rows = (series || []).filter((p) => p && Number.isFinite(Number(p.v)));
    const total = rows.reduce((s, p) => s + Number(p.v), 0);
    if (!(total > 0)) return { composition: true, parts: [], balanced: null, total: 0, asOf: now() };
    const valOf = (label) => rows.filter((p) => String(p.t).toLowerCase() === String(label).toLowerCase()).reduce((s, p) => s + Number(p.v), 0);
    return build(partsCfg.map((pt) => ({ ...pt, value: valOf(pt.label) })), total);
  }

  function resultBand(goal, value, pct) {
    if (goal.direction === 'range' && Number.isFinite(goal.targetMax)) {
      const lo = goal.targetValue, hi = goal.targetMax;
      if (value > hi) return 'over';            // above the healthy band → flagged
      if (value >= lo) return 'hit';            // inside the band
      if (value >= lo * 0.95) return 'near';
      return 'missed';
    }
    if (goal.direction === 'at_most') {
      if (value <= goal.targetValue * 0.9) return 'smashed';
      if (value <= goal.targetValue) return 'hit';
      if (value <= goal.targetValue * 1.05) return 'near';
      return 'missed';
    }
    if (pct >= 110) return 'smashed';
    if (pct >= 100) return 'hit';
    if (pct >= 95) return 'near';
    return 'missed';
  }
  // Interpolate the expected value at time x along a piecewise-linear curve through
  // sorted [ [t, value], … ] points. Clamps before the first / after the last point.
  function interpAt(points, x) {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
    for (let i = 1; i < points.length; i++) {
      const [t0, v0] = points[i - 1]; const [t1, v1] = points[i];
      if (x <= t1) return v0 + (v1 - v0) * ((x - t0) / (t1 - t0));
    }
    return points[points.length - 1][1];
  }
  // The deadline for days-to-go and curve alignment is the EVENT date. Priority:
  // (1) the live date from Looker (core_events.start_date, scoped to the suite —
  // always present, nothing to type), (2) the suite's briefing eventStart/eventEnd,
  // (3) the goal's own by_date as a last resort. Parsed at local midnight (date-only),
  // like resolvePhase, so it counts whole days cleanly.
  function eventDeadline(goal, lookerDate) {
    const su = goal.suiteId ? db.getSuite(goal.suiteId) : null;
    const b = (su && su.briefing) || {};
    const pick = lookerDate || b.eventStart || b.eventEnd || goal.byDate || null;
    const source = lookerDate ? 'looker' : b.eventStart ? 'eventStart' : b.eventEnd ? 'eventEnd' : (goal.byDate ? 'byDate' : 'none');
    const ms = pick ? new Date(`${String(pick).slice(0, 10)}T00:00:00`).getTime() : NaN;
    return { ms, source };
  }
  // Whole calendar days from today → the event (date-to-date, ignoring time-of-day),
  // so "11 days" doesn't become "10" just because it's the afternoon.
  function calendarDaysLeft(deadlineMs, nowMs) {
    if (!Number.isFinite(deadlineMs)) return null;
    const floorDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    return Math.round((floorDay(deadlineMs) - floorDay(nowMs)) / 86400000);
  }
  // Last time's shape from an all-columns tile read: the COMPLETE prior period (the
  // largest-total column that isn't the current/highest-key one). Returns its raw
  // [{ t, v }] series — the SAME column the live card uses as its baseline curve, so
  // the checkpoint suggester and the card read one shape.
  // The column to compare against = the most recent PRIOR period that has real data
  // (the immediately preceding year), NOT the biggest-total year. YoY must compare to
  // LAST year: with 2023/24/25/26 columns and 2026 current, "last time" is 2025 —
  // even if 2024 had a bigger total (picking by total gave the wrong year + a wrong
  // "vs last time" %).
  function pickLastYearColumn(data) {
    if (!data || !Array.isArray(data.columns) || !data.columns.length) return null;
    const totalOf = (c) => (c.series || []).reduce((s, p) => s + (Number(p.v) || 0), 0);
    const okPts = (c) => (c.series || []).filter((p) => p && Number.isFinite(Number(p.v))).length >= 2;
    const byKeyDesc = [...data.columns].sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true }));
    // "This event" = the column matched to the suite's Current Event lock when known
    // (reliable), else the newest-sorting key (fallback). Everything else = prior.
    const thisKey = data.currentKey || byKeyDesc[0]?.key;
    const prior = byKeyDesc.filter((c) => c.key !== thisKey);
    return prior.find((c) => totalOf(c) > 0 && okPts(c)) || prior[0] || byKeyDesc[0] || null;
  }
  function pickLastYearShape(data) {
    const col = pickLastYearColumn(data);
    return (col?.series || []).filter((p) => p && Number.isFinite(Number(p.v)));
  }
  // Honour a user-chosen comparison year (curveRef.compareKey) when present; else the
  // most recent prior year. Lets a client compare against a specific past year.
  function pickCompareColumn(data, compareKey) {
    if (compareKey) {
      const c = (data?.columns || []).find((x) => String(x.key) === String(compareKey));
      if (c) return c;
    }
    return pickLastYearColumn(data);
  }
  // The prior-year column keys (newest first) — the choices for "compare against".
  function priorYearKeys(data) {
    if (!data || !Array.isArray(data.columns) || !data.columns.length) return [];
    const byKeyDesc = [...data.columns].sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true }));
    const thisKey = data.currentKey || byKeyDesc[0]?.key;
    return byKeyDesc.filter((c) => c.key !== thisKey).map((c) => c.key);
  }
  // Progress = resolved value vs target, with honest PACE. Pace is measured over the
  // sell window [start_date (or created_at) → deadline]. When the goal links a
  // value-over-time curve (curveRef → `curve`, a cumulative array of last time's
  // shape), "expected by now" follows that real shape (and we surface last time's
  // value at the equivalent point, `lastAtNow`, + its final total `baselineFinal`) —
  // so the back-loaded ticket curve isn't cried "behind" too early and "vs last time"
  // is apples-to-apples. With no curve it falls back to a milestone-linear pace line.
  function computeProgress(goal, value, curve, opts = {}) {
    const milestones = Array.isArray(goal.milestones) ? goal.milestones : [];
    const nowMs = Date.now();
    const upcoming = milestones
      .map((m) => ({ byDate: m.byDate, targetValue: Number(m.targetValue), t: Date.parse(m.byDate) }))
      .filter((m) => !Number.isNaN(m.t) && m.t >= nowMs)
      .sort((a, b) => a.t - b.t)[0] || null;
    const nextMilestone = upcoming ? { byDate: upcoming.byDate, targetValue: upcoming.targetValue } : null;
    const start = Date.parse(goal.startDate || goal.createdAt);
    const hasCurve = Array.isArray(curve) && curve.length >= 2;
    // Deadline rule (scoped so we don't trample goals with their own schedule):
    //  • a curve goal whose curve is a days-before-event COUNTDOWN (e.g. tickets) is
    //    aligned to the EVENT DAY — that's the axis its sell-curve is measured against;
    //  • every other goal — including a curve on a CALENDAR/forward axis (day-of-month,
    //    monthly) — keeps its OWN by_date; the event day only fills in if none was set.
    const ev = eventDeadline(goal, opts.eventDateIso);
    const ownEnd = goal.byDate ? new Date(`${String(goal.byDate).slice(0, 10)}T00:00:00`).getTime() : NaN;
    // A forward NUMERIC axis (day-of-month, week #: cumulative rises as the number
    // rises) is a calendar/periodic curve, NOT an event sell-curve — keep the goal's
    // own by_date. Countdown (days-before-event) and ISO-date curves stay event-anchored.
    const isISO = (t) => /^\d{4}-\d{2}/.test(String(t));
    const numCurve = (fc.cumulativeWithAxis(curve) || []).filter((p) => p.t !== '' && p.t != null && !isISO(p.t) && Number.isFinite(Number(p.t)));
    const forwardPeriodic = numCurve.length >= 2 && !fc.isCountdownAxis(numCurve);
    const eventAnchored = hasCurve && !forwardPeriodic;
    const end = eventAnchored ? ev.ms : (Number.isFinite(ownEnd) ? ownEnd : ev.ms);
    const daysLeft = calendarDaysLeft(end, nowMs);
    // Align last time's curve to where we are now by its REAL axis (days-before-event),
    // not by row position — so "last time at this point" is the actual recorded value.
    // Days-to-go is whole calendar days to the event day (the same anchor as last
    // year's days_before axis), so the curve is read at the right point.
    const at = hasCurve ? fc.fractionAtNow(curve, { deadlineMs: end, nowMs, startMs: start, daysLeft }) : null;
    const baselineFinal = at ? Math.round(at.total) : (goal.baselineValue != null ? goal.baselineValue : null);
    if (value == null || !goal.targetValue) return { value, pct: null, status: null, band: goal.resultBand || null, milestones, nextMilestone, lastAtNow: null, baselineFinal };
    // Range goal = a healthy BAND [lo, hi]: in-band is good, above hi is flagged.
    const isRange = goal.direction === 'range' && Number.isFinite(goal.targetMax);
    const lo = goal.targetValue, hi = goal.targetMax;
    const over = isRange ? value > hi : false;          // drifted above the band
    const inRange = isRange ? (value >= lo && value <= hi) : false;
    // Range %: below the band reads toward 100 (value/lo); in-band is 100; ABOVE the
    // band keeps counting past 100 against the ceiling (value/hi) so the dial shows how
    // far over you've drifted (e.g. 68 over a 62–65 band → ~105%) instead of a flat 100.
    const pct = isRange
      ? (value < lo ? Math.max(0, Math.min(100, Math.round((value / lo) * 100)))
        : over && hi > 0 ? Math.round((value / hi) * 100)
        : 100)
      : goal.direction === 'at_most'
        ? (value <= 0 ? 100 : Math.round((goal.targetValue / value) * 100))
        : Math.round((value / goal.targetValue) * 100);
    let expected = null, onPace = null, status = null, lastAtNow = null;
    if (!Number.isNaN(end) && !Number.isNaN(start) && end > start) {
      if (at) {
        // Curve-based pace: where last time's shape sits at this point in the cycle.
        expected = Math.round(goal.targetValue * at.fraction);
        lastAtNow = Math.round(at.valueAtNow);
      } else {
        const points = [[start, 0]];
        for (const m of milestones) { const t = Date.parse(m.byDate); if (!Number.isNaN(t) && Number.isFinite(Number(m.targetValue))) points.push([t, Number(m.targetValue)]); }
        points.push([end, goal.targetValue]);
        points.sort((a, b) => a[0] - b[0]);
        expected = Math.round(interpAt(points, nowMs));
      }
      if (isRange) {
        // Pace toward entering the band (lo); flag if already above it.
        onPace = value >= lo && value <= hi;
        if (nowMs >= end) status = 'final';
        else if (over) status = 'over';
        else if (value >= lo) status = 'on_track';     // inside the band
        else { const ratio = expected > 0 ? value / expected : (value > 0 ? 2 : 1); status = ratio >= 1.1 ? 'ahead' : ratio >= 0.95 ? 'on_track' : 'behind'; }
      } else if (goal.direction === 'at_most') {
        const cap = expected || goal.targetValue;
        onPace = value <= cap;
        status = nowMs >= end ? 'final' : (value <= cap * 0.9 ? 'ahead' : onPace ? 'on_track' : 'behind');
      } else {
        // Ahead / on-track / behind judged against the expected-by-now value (the pace
        // line), NOT against the final target — so a goal well above where it should be
        // by today reads "ahead" even before it has hit 100%.
        const ratio = expected > 0 ? value / expected : (value > 0 ? 2 : 1);
        onPace = ratio >= 0.95;
        status = nowMs >= end ? 'final' : (ratio >= 1.1 ? 'ahead' : ratio >= 0.95 ? 'on_track' : 'behind');
      }
    }
    const band = (!Number.isNaN(end) && nowMs >= end) ? resultBand(goal, value, pct) : (goal.resultBand || null);
    // Projected final landing — "if you finish like last time's shape from where you are
    // now" (currentValue ÷ the fraction of last time's curve reached at this point). Only
    // for curve goals heading UP to a target (an "under a cap" goal flips the meaning).
    let forecast = null;
    if (at && goal.direction !== 'at_most' && !isRange && !Number.isNaN(end) && !Number.isNaN(start) && end > start) {
      const cum = fc.toCumulative((Array.isArray(curve) ? curve : []).map((p) => p.v));
      const r = Math.max(0, Math.min(1, (nowMs - start) / (end - start)));
      // Blend last time's SHAPE with recent run-rate (momentum) so a hot/cold streak
      // nudges the projection — but cap momentum at half so the seasonal shape (which
      // captures a late surge a linear rate can't) stays the primary signal.
      const f = cum.length >= 2 ? fc.forecast({ cum, currentValue: value, target: goal.targetValue, r, daysLeft, recentRatePerDay: opts.recentRatePerDay ?? null, weightMomentum: Math.min(0.5, r), fNow: at.fraction }) : null;
      if (f && Number.isFinite(f.projected)) forecast = { projected: f.projected, status: f.status, vsTargetPct: f.vsTargetPct, shape: f.shape, momentum: f.momentum };
    }
    return { value, pct, target: goal.targetValue, targetMax: goal.targetMax ?? null, over, inRange, direction: goal.direction, expected, onPace, status, band, milestones, nextMilestone, lastAtNow, baselineFinal, daysLeft, forecast };
  }

  // ── Full live progress resolver (shared) ──────────────────────────────────
  // Produces the SAME rich progress the Goals page card detail shows — current from
  // the curve's this-year column, last-time-at-now, baseline total, pace, forecast,
  // days-left. Reused by the suite GET route and the Owl goals summary so both read
  // identical numbers. `caches` (optional) dedupes curve + event-date reads across a
  // batch of goals in one suite.
  const makeGoalCaches = () => ({ curve: new Map(), eventDate: new Map() });
  function resolveCurve(g, user, cache) {
    const cr = g.curveRef;
    if (!cr || !cr.dashboardId || !cr.tileId) return Promise.resolve(null);
    const key = `${cr.dashboardId}|${cr.tileId}|${g.suiteId}|${cr.compareKey || ''}`;
    if (cache && cache.has(key)) return cache.get(key);
    const p = (async () => {
      try {
        // All-columns resolver: last time's shape (chosen / most-recent prior column) +
        // this year's own running total, from the SAME tile. `shape` stays raw for align.
        if (typeof resolveTileSeriesAll === 'function') {
          const data = await resolveTileSeriesAll({ dashboardId: cr.dashboardId, tileId: cr.tileId, user, suiteId: g.suiteId });
          if (data && Array.isArray(data.columns) && data.columns.length) {
            const cmp = pickCompareColumn(data, cr.compareKey);
            const shape = (cmp?.series || []).filter((p2) => p2 && Number.isFinite(Number(p2.v)));
            const byKeyDesc = [...data.columns].sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true }));
            const thisCol = data.columns.find((c) => c.key === (data.currentKey || byKeyDesc[0]?.key));
            const thisCum = fc.toCumulative((thisCol?.series || []).map((x) => x.v));
            const thisNow = thisCum.length ? thisCum[thisCum.length - 1] : null;
            const recentRatePerDay = fc.recentRate(thisCol?.series || []); // momentum from this year's tail
            return { shape: shape.length >= 2 ? shape : null, thisNow, recentRatePerDay };
          }
        }
        if (typeof resolveTileSeries === 'function') {
          const s = await resolveTileSeries({ dashboardId: cr.dashboardId, tileId: cr.tileId, user, suiteId: g.suiteId });
          const pts = (s || []).filter((x) => x && Number.isFinite(Number(x.v)));
          return { shape: pts.length >= 2 ? pts : null, thisNow: null };
        }
        return null;
      } catch { return null; }
    })();
    if (cache) cache.set(key, p);
    return p;
  }
  function resolveEventDateCached(suiteId, user, cache) {
    if (typeof resolveEventDate !== 'function') return Promise.resolve(null);
    if (cache && cache.has(suiteId)) return cache.get(suiteId);
    const p = resolveEventDate({ suiteId, user }).catch(() => null);
    if (cache) cache.set(suiteId, p);
    return p;
  }
  function resolveLiveBaseline(g, user) {
    const br = g.baselineRef;
    if (!br || !br.dashboardId || !br.tileId || typeof resolveTileValue !== 'function') return Promise.resolve(null);
    return resolveTileValue({ dashboardId: br.dashboardId, tileId: br.tileId, user, suiteId: g.suiteId }).catch(() => null);
  }
  async function attachProgress(g, user, caches = null) {
    // Composition goals don't have a single metric/curve — they read a breakdown.
    if (g.direction === 'composition') {
      const comp = await resolveComposition(g, user);
      return { ...g, progress: comp || { composition: true, parts: [], balanced: null, asOf: now() } };
    }
    const c = caches || makeGoalCaches();
    const [m, curve, eventDateIso, liveBaseline] = await Promise.all([
      resolveMetric(g, { user }),
      resolveCurve(g, user, c.curve),
      resolveEventDateCached(g.suiteId, user, c.eventDate),
      resolveLiveBaseline(g, user),
    ]);
    // Curve goals read CURRENT from the curve tile's this-year column (the same core
    // measure that drives baseline + forecast); a live baseline tile overrides the
    // stored snapshot (no-curve case).
    const shape = curve?.shape || null;
    const useCurveNow = curve && curve.thisNow != null;
    const value = useCurveNow ? curve.thisNow : m.value;
    const gp = (liveBaseline != null && Number.isFinite(Number(liveBaseline))) ? { ...g, baselineValue: Number(liveBaseline) } : g;
    return { ...gp, progress: { ...computeProgress(gp, value, shape, { eventDateIso, recentRatePerDay: curve?.recentRatePerDay }), asOf: m.asOf, resolvedSource: useCurveNow ? 'curve-this-year' : m.source } };
  }

  // ── Access guards (admin OR an entity member; writes need goals.manage) ──
  const canView = (user, suiteId) => user.role === 'admin' || auth.canAccessSuite(user, suiteId);
  function canManage(user, suiteId) {
    if (user.role === 'admin') return true;
    const su = db.getSuite(suiteId);
    return !!su && auth.canAccessSuite(user, suiteId) && auth.hasPermission(user, su.entityId, 'goals.manage');
  }
  // Who may edit/delete a given goal: admins anything; the OWNER of a personal goal
  // their own (no goals.manage needed — it's theirs); event goals need goals.manage.
  function canEditGoal(user, goal) {
    if (user.role === 'admin') return true;
    if (goal.scope === 'personal') return goal.ownerRef === user.email && auth.canAccessSuite(user, goal.suiteId);
    return canManage(user, goal.suiteId);
  }

  // ── Routes (one guarded set serves admin + client self-service, keyed by suite) ──
  app.get('/api/goals/suites/:suiteId', auth.requireAuth, async (req, res) => {
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    // Resolve every goal's FULL live progress (curve, baseline, pace, forecast) with a
    // shared per-request cache so a curve/event-date is read once per suite.
    const caches = makeGoalCaches();
    const [goals, personalGoals] = await Promise.all([
      Promise.all(listGoals(req.params.suiteId).map((g) => attachProgress(g, req.user, caches))),
      Promise.all(listPersonalGoals(req.params.suiteId, req.user).map((g) => attachProgress(g, req.user, caches))),
    ]);
    res.json({ goals, personalGoals, canManage: canManage(req.user, req.params.suiteId), me: req.user.email });
  });

  app.post('/api/goals/suites/:suiteId', auth.requireAuth, (req, res) => {
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    const c = cleanInput(req.body || {});
    const personal = c.scope === 'personal';
    // Event goals need goals.manage; a personal goal is the user's own, so any
    // suite member may create one (admins can do either).
    if (personal ? !canView(req.user, req.params.suiteId) : !canManage(req.user, req.params.suiteId)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    if (!c.name) return res.status(400).json({ error: 'A goal name is required' });
    const id = uuid(); const ts = now();
    const ownerRef = personal ? req.user.email : req.params.suiteId;
    const existing = sql.prepare("SELECT COUNT(*) n FROM goals WHERE suite_id=? AND scope='event' AND status='active'").get(req.params.suiteId).n;
    sql.prepare(`INSERT INTO goals (id, suite_id, entity_id, scope, owner_ref, name, metric_key, source, metric_ref,
        target_value, target_max, parts, unit, tag, direction, display, by_date, start_date, is_north_star, position, baseline_event_id, baseline_value, baseline_source, baseline_ref,
        milestones, curve_ref, visibility, rolls_up_to, status, created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, req.params.suiteId, su.entityId, c.scope, ownerRef, c.name, c.metricKey, c.source, JSON.stringify(c.metricRef),
      c.targetValue, c.targetMax, JSON.stringify(c.parts), c.unit, c.tag, c.direction, c.display, c.byDate, c.startDate, 0, c.position, c.baselineEventId, c.baselineValue, c.baselineSource, JSON.stringify(c.baselineRef),
      JSON.stringify(c.milestones), JSON.stringify(c.curveRef), personal ? c.visibility : 'team', personal ? c.rollsUpTo : '', 'active', req.user.email, ts, req.user.email, ts);
    // Only EVENT goals get a North Star; the first becomes it, or honour a request.
    if (!personal && (existing === 0 || req.body?.isNorthStar)) setNorthStar(req.params.suiteId, id);
    audit(id, 'created', null, c.name, req.user.email);
    res.status(201).json({ goal: goalById(id) });
  });

  app.put('/api/goals/:id', auth.requireAuth, (req, res) => {
    const g = goalById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    if (!canEditGoal(req.user, g)) return res.status(403).json({ error: 'Not allowed' });
    const c = cleanInput({ ...g, ...req.body });
    const personal = g.scope === 'personal';
    // Audit the fields people care about.
    for (const [field, oldV, newV] of [['name', g.name, c.name], ['target_value', g.targetValue, c.targetValue], ['by_date', g.byDate, c.byDate], ['direction', g.direction, c.direction]]) {
      if (String(oldV) !== String(newV)) audit(g.id, field, oldV, newV, req.user.email);
    }
    sql.prepare(`UPDATE goals SET name=?, metric_key=?, source=?, metric_ref=?, target_value=?, target_max=?, parts=?, unit=?, tag=?, direction=?,
        display=?, by_date=?, start_date=?, position=?, baseline_event_id=?, baseline_value=?, baseline_source=?, baseline_ref=?, milestones=?, curve_ref=?, visibility=?, rolls_up_to=?, updated_by=?, updated_at=? WHERE id=?`).run(
      c.name, c.metricKey, c.source, JSON.stringify(c.metricRef), c.targetValue, c.targetMax, JSON.stringify(c.parts), c.unit, c.tag, c.direction,
      c.display, c.byDate, c.startDate, c.position, c.baselineEventId, c.baselineValue, c.baselineSource, JSON.stringify(c.baselineRef), JSON.stringify(c.milestones),
      JSON.stringify(c.curveRef), personal ? c.visibility : 'team', personal ? c.rollsUpTo : '', req.user.email, now(), g.id);
    if (req.body?.isNorthStar && !g.isNorthStar) { setNorthStar(g.suiteId, g.id); audit(g.id, 'is_north_star', false, true, req.user.email); }
    res.json({ goal: goalById(g.id) });
  });

  app.delete('/api/goals/:id', auth.requireAuth, (req, res) => {
    const g = goalById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    if (!canEditGoal(req.user, g)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('DELETE FROM goals WHERE id=?').run(g.id);
    sql.prepare('DELETE FROM goal_snapshots WHERE goal_id=?').run(g.id);
    if (g.isNorthStar) ensureNorthStar(g.suiteId); // promote the next so one always leads
    res.status(204).end();
  });

  // Manual actual entry (the universal fallback / sponsorship / cash float). Appends
  // a snapshot; resolveMetric reads the latest for manual-sourced goals.
  app.post('/api/goals/:id/snapshot', auth.requireAuth, (req, res) => {
    const g = goalById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    if (!canEditGoal(req.user, g)) return res.status(403).json({ error: 'Not allowed' });
    const v = Number(req.body?.value);
    if (!Number.isFinite(v)) return res.status(400).json({ error: 'A numeric value is required' });
    sql.prepare('INSERT INTO goal_snapshots (id, goal_id, at, actual_value) VALUES (?,?,?,?)').run(uuid(), g.id, now(), v);
    res.status(201).json({ ok: true, value: v });
  });

  // ── Goal templates — save a goal's reusable config and start new goals from it ──
  // Entity-scoped (a client's reusable patterns, e.g. "Monthly revenue"). The payload
  // is the editor's create-body MINUS instance fields (dates, North Star, snapshots),
  // so applying it just pre-fills the form; creation still goes through cleanInput.
  const tmplCanEntity = (user, eid) => user.role === 'admin' || (user.entityIds || []).includes(eid);
  const templatePayloadFromGoal = (g) => ({
    name: g.name, source: g.source, metricKey: g.metricKey,
    metricRef: g.metricRef || null, targetValue: g.targetValue, unit: g.unit,
    direction: g.direction, display: g.display,
    curveRef: g.curveRef || null, baselineRef: g.baselineRef || null, baselineSource: g.baselineSource || '',
  });

  app.get('/api/goals/templates/:entityId', auth.requireAuth, (req, res) => {
    if (!tmplCanEntity(req.user, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    // This client's own templates PLUS every global (platform) template.
    const rows = sql.prepare("SELECT id, name, payload, scope, created_at FROM goal_templates WHERE (scope='entity' AND entity_id=?) OR scope='global' ORDER BY scope DESC, created_at DESC").all(req.params.entityId);
    res.json({ templates: rows.map((r) => ({ id: r.id, name: r.name, payload: parseJson(r.payload, {}), scope: r.scope, global: r.scope === 'global', createdAt: r.created_at })) });
  });

  app.post('/api/goals/templates', auth.requireAuth, (req, res) => {
    let { entityId, name, payload } = req.body || {};
    const fromGoalId = req.body?.fromGoalId;
    const wantGlobal = !!req.body?.global;
    if (wantGlobal && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can create global templates' });
    if (fromGoalId) {
      const g = goalById(fromGoalId);
      if (!g) return res.status(404).json({ error: 'Goal not found' });
      if (!canView(req.user, g.suiteId)) return res.status(403).json({ error: 'Not allowed' });
      entityId = g.entityId; name = name || g.name; payload = templatePayloadFromGoal(g);
    }
    if (!name || !payload || typeof payload !== 'object') return res.status(400).json({ error: 'name and payload are required' });
    const scope = wantGlobal ? 'global' : 'entity';
    const eid = wantGlobal ? '' : entityId;
    if (!wantGlobal && (!eid || !tmplCanEntity(req.user, eid))) return res.status(403).json({ error: 'Not allowed' });
    // Templates keep the dashboard NAME + tile title in each ref (set by the editor), so
    // a global template re-resolves to each client's matching dashboard/tile by name.
    const id = uuid(); const ts = now();
    sql.prepare('INSERT INTO goal_templates (id, entity_id, scope, name, payload, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, eid, scope, String(name).slice(0, 120), JSON.stringify(payload).slice(0, 8000), req.user.email, ts);
    res.status(201).json({ template: { id, name: String(name).slice(0, 120), payload, scope, global: wantGlobal, createdAt: ts } });
  });

  app.delete('/api/goals/templates/:id', auth.requireAuth, (req, res) => {
    const row = sql.prepare('SELECT entity_id, scope FROM goal_templates WHERE id=?').get(req.params.id);
    if (!row) return res.json({ ok: true });
    // Global templates: admins only. Entity templates: the client (or an admin).
    const allowed = row.scope === 'global' ? req.user.role === 'admin' : tmplCanEntity(req.user, row.entity_id);
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('DELETE FROM goal_templates WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // Live preview of a tile's current number for the editor — so when you pick a
  // tile to track, you see the actual figure before saving the target. Read-only
  // (suite membership); scope is still enforced inside resolveTileValue.
  app.post('/api/goals/suites/:suiteId/tile-value', auth.requireAuth, async (req, res) => {
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { dashboardId, tileId } = req.body || {};
    if (typeof resolveTileValue !== 'function' || !dashboardId || !tileId) return res.json({ value: null });
    try {
      const value = await resolveTileValue({ dashboardId, tileId, user: req.user, suiteId: req.params.suiteId });
      res.json({ value: value == null ? null : Number(value) });
    } catch (e) { res.json({ value: null, error: e.message }); }
  });

  // Time-series for a tile under an event's scope — "last time's curve". Powers the
  // checkpoint suggester in the editor: link a chart/table tile that carries the
  // sell-by-now shape, read its [{ t, v }] rows under a comparable past event, and
  // suggest checkpoint targets from that shape (scaled to this goal's target).
  app.post('/api/goals/suites/:suiteId/tile-series', auth.requireAuth, async (req, res) => {
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { dashboardId, tileId } = req.body || {};
    if (typeof resolveTileSeries !== 'function' || !dashboardId || !tileId) return res.json({ series: [] });
    try {
      const series = await resolveTileSeries({ dashboardId, tileId, user: req.user, suiteId: req.params.suiteId });
      res.json({ series });
    } catch (e) { res.json({ series: [], error: e.message }); }
  });

  // Server-computed checkpoint suggestions for the editor. Uses the SAME days-before
  // alignment as the live pace engine (fc.fractionAtNow against the event-day anchor:
  // Looker → briefing → by_date), so suggested checkpoints and the card's Ahead/Behind
  // run on identical math. Returns last time's shape (for the sparkline) + per-checkpoint
  // FRACTIONS of last time's total (target-independent — the client multiplies by the
  // live target, so typing a target doesn't re-query) plus last time's value at each.
  app.post('/api/goals/suites/:suiteId/checkpoint-suggestions', auth.requireAuth, async (req, res) => {
    const suiteId = req.params.suiteId;
    if (!db.getSuite(suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { dashboardId, tileId, cadence, startDate, byDate, compareKey } = req.body || {};
    if (typeof resolveTileSeriesAll !== 'function' || !dashboardId || !tileId) return res.json({ series: [], checkpoints: [] });
    let series = [], years = [], usedCompareKey = null;
    try {
      const data = await resolveTileSeriesAll({ dashboardId, tileId, user: req.user, suiteId });
      const cmp = pickCompareColumn(data, compareKey);
      series = (cmp?.series || []).filter((p) => p && Number.isFinite(Number(p.v)));
      years = priorYearKeys(data); // choices for "compare against" (newest first)
      usedCompareKey = cmp?.key || null;
    } catch (e) { return res.json({ series: [], checkpoints: [], error: e.message }); }
    // Event-day anchor + window — identical inputs to the live pace engine.
    let lookerDate = null;
    try { lookerDate = (typeof resolveEventDate === 'function') ? await resolveEventDate({ suiteId, user: req.user }) : null; } catch { lookerDate = null; }
    // The editor's "By (deadline)" is explicit user intent — honour it; only fall
    // back to the event/briefing date when the user left it blank.
    const endMs = byDate
      ? new Date(`${String(byDate).slice(0, 10)}T00:00:00`).getTime()
      : eventDeadline({ suiteId }, lookerDate).ms;
    const startMs = startDate ? new Date(`${String(startDate).slice(0, 10)}T00:00:00`).getTime() : Date.now();
    const eventDate = Number.isFinite(endMs) ? new Date(endMs).toISOString().slice(0, 10) : null;
    if (series.length < 2 || !Number.isFinite(endMs) || !Number.isFinite(startMs) || !(endMs > startMs)) {
      return res.json({ series, pointsRead: series.length, eventDate, checkpoints: [], years, compareKey: usedCompareKey });
    }
    // Lay out checkpoint dates by cadence from the start to the event day…
    const weekly = cadence !== 'monthly';
    const dates = []; const d = new Date(startMs);
    const bump = () => (weekly ? d.setDate(d.getDate() + 7) : d.setMonth(d.getMonth() + 1));
    bump();
    while (d.getTime() < endMs && dates.length < 24) { dates.push(new Date(d)); bump(); }
    // …and read last time at each by the SAME days-before alignment the card uses.
    const checkpoints = [];
    for (const dt of dates) {
      const daysLeft = calendarDaysLeft(endMs, dt.getTime());
      const at = fc.fractionAtNow(series, { deadlineMs: endMs, nowMs: dt.getTime(), startMs, daysLeft });
      if (at && Number.isFinite(at.fraction)) {
        checkpoints.push({ byDate: dt.toISOString().slice(0, 10), fraction: Number(at.fraction.toFixed(6)), lastValue: Math.round(at.valueAtNow), basis: at.basis });
      }
    }
    res.json({ series, pointsRead: series.length, eventDate, checkpoints, years, compareKey: usedCompareKey });
  });

  // Forecast chart data for a goal — last time's full curve, this year's actual to date,
  // and the projected finish — so the detail can draw "last year · this year · forecast"
  // with a "you are here" marker. Cumulative, axis-preserved (days-before or date).
  app.get('/api/goals/suites/:suiteId/forecast-chart', auth.requireAuth, async (req, res) => {
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const g = req.query.goalId ? goalById(req.query.goalId) : null;
    if (!g || g.suiteId !== req.params.suiteId) return res.json({ available: false });
    const cr = g.curveRef;
    if (!cr || !cr.dashboardId || !cr.tileId || typeof resolveTileSeriesAll !== 'function') return res.json({ available: false });
    let data; try { data = await resolveTileSeriesAll({ dashboardId: cr.dashboardId, tileId: cr.tileId, user: req.user, suiteId: g.suiteId }); } catch { return res.json({ available: false }); }
    if (!data || !Array.isArray(data.columns) || !data.columns.length) return res.json({ available: false });
    const byKeyDesc = [...data.columns].sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true }));
    const thisKey = data.currentKey || byKeyDesc[0]?.key;
    const lastCol = pickCompareColumn(data, cr.compareKey); // chosen year, else most recent prior
    const thisCol = data.columns.find((c) => c.key === thisKey);
    const toXY = (series) => (fc.cumulativeWithAxis(series) || []).map((p) => ({ x: p.t, y: Math.round(p.c) }));
    const prog = (await attachProgress(g, req.user)).progress;
    const projected = prog.forecast ? prog.forecast.projected : null;
    // Axis labels: a forward/calendar curve (day-of-month etc.) is date-based, so the
    // chart should label real dates across [start → deadline]; an event sell-curve
    // labels "days before event". (Mirrors the deadline-anchoring rule.)
    const numCmp = (fc.cumulativeWithAxis(lastCol ? lastCol.series : []) || []).filter((p) => p.t !== '' && p.t != null && !/^\d{4}-\d{2}/.test(String(p.t)) && Number.isFinite(Number(p.t)));
    const dateMode = numCmp.length >= 2 && !fc.isCountdownAxis(numCmp);
    const endIso = dateMode
      ? (g.byDate ? String(g.byDate).slice(0, 10) : (Number.isFinite(prog.daysLeft) ? new Date(Date.now() + prog.daysLeft * 86400000).toISOString().slice(0, 10) : null))
      : null;
    res.json({
      available: true, unit: g.unit || '', target: g.targetValue, daysLeft: prog.daysLeft, projected,
      axisMode: dateMode ? 'date' : 'event', startDate: dateMode ? (g.startDate || null) : null, endDate: endIso,
      lastKey: lastCol ? lastCol.key : null, thisKey: thisKey || null, years: priorYearKeys(data),
      lastYear: toXY(lastCol ? lastCol.series : []),
      thisYear: toXY(thisCol ? thisCol.series : []),
      // Pre-positioned coordinates (0..1 x, where 1 = event day) so the chart never
      // has to guess the axis. `now` ends the actual line partway and leaves the rest
      // of the axis for the forecast curve. Computed here where daysLeft + the real
      // axis are known. The client falls back to lastYear/thisYear if this is absent.
      positioned: positionForecast({
        cumLast: fc.cumulativeWithAxis(lastCol ? lastCol.series : []) || [],
        cumThis: fc.cumulativeWithAxis(thisCol ? thisCol.series : []) || [],
        daysLeft: prog.daysLeft, projected,
      }),
    });
  });

  // ── Forecast probe (read-only diagnostic) ──
  // Validate the forecast model on a LIVE tile before we build any UI. Reads every
  // pivot column of a trend tile, auto-picks last-year (largest complete column) +
  // this-year (latest key), computes the forecast, and returns it all as JSON.
  // Tunable via query params so we can correct the column pick on real data.
  //   GET /api/goals/suites/:suiteId/forecast-probe
  //     ?dashboardId=&tileId=&target=&start=YYYY-MM-DD&end=YYYY-MM-DD
  //     [&recentDays=30&lastKey=&thisKey=&currentValue=]
  app.get('/api/goals/suites/:suiteId/forecast-probe', auth.requireAuth, async (req, res) => {
    if (typeof resolveTileSeriesAll !== 'function') return res.status(400).json({ error: 'series resolver unavailable' });
    // Convenience: ?goalId=… defaults the tile, dates, target + current value off the goal.
    const g = req.query.goalId ? goalById(req.query.goalId) : null;
    const suiteId = g?.suiteId || req.params.suiteId;
    if (!db.getSuite(suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const dashboardId = req.query.dashboardId || g?.curveRef?.dashboardId || g?.metricRef?.dashboardId;
    const tileId = req.query.tileId || g?.curveRef?.tileId || g?.metricRef?.tileId;
    if (!dashboardId || !tileId) return res.status(400).json({ error: 'dashboardId and tileId are required (or pass goalId)' });
    let data;
    try { data = await resolveTileSeriesAll({ dashboardId, tileId, user: req.user, suiteId }); }
    catch (e) { return res.json({ error: e.message }); }
    if (!data || !data.columns.length) return res.json({ error: 'No series read from that tile', data });

    const totalOf = (c) => c.series.reduce((s, p) => s + (Number(p.v) || 0), 0);
    const cols = data.columns.map((c) => ({ key: c.key, n: c.series.length, total: Math.round(totalOf(c)), last: c.series[c.series.length - 1]?.v }));
    // this-year = highest key (current period); last-year = the most recent PRIOR year.
    const byKeyDesc = [...data.columns].sort((a, b) => String(b.key).localeCompare(String(a.key), undefined, { numeric: true }));
    const thisKey = req.query.thisKey || data.currentKey || byKeyDesc[0]?.key;
    const lastCol = req.query.lastKey ? data.columns.find((c) => c.key === req.query.lastKey)
      : pickLastYearColumn(data);
    const thisCol = data.columns.find((c) => c.key === thisKey);

    const cum = fc.toCumulative((lastCol?.series || []).map((p) => p.v));
    const thisCum = fc.toCumulative((thisCol?.series || []).map((p) => p.v));
    // Current value MUST be the SAME measure as the shape curve, or current ÷
    // last-year-fraction mixes units. Prefer the curve tile's own this-year column
    // (e.g. core_tickets so far), then an explicit override, then the goal's KPI
    // metric only as a last resort. (The KPI tile can read a different ticket
    // measure — that mismatch is what made 41,018 ≠ the curve's 44,810.)
    const curveNow = thisCum.length ? thisCum[thisCum.length - 1] : null;
    let currentValue, currentValueSource;
    if (req.query.currentValue) { currentValue = Number(req.query.currentValue); currentValueSource = 'query'; }
    else if (curveNow != null) { currentValue = curveNow; currentValueSource = 'curve-this-year'; }
    else if (g) { currentValue = (await resolveMetric(g, { user: req.user })).value; currentValueSource = 'goal-metric'; }
    else { currentValue = null; currentValueSource = null; }

    // Recent run-rate from this-year's tail over ~recentDays (by date if parseable).
    const recentDays = Number(req.query.recentDays) || 30;
    let recentRatePerDay = null, recentBasis = null;
    if (thisCol && thisCol.series.length >= 2 && thisCum.length === thisCol.series.length) {
      const s = thisCol.series; const lastT = Date.parse(s[s.length - 1].t);
      let startIdx = 0;
      if (!Number.isNaN(lastT)) {
        for (let i = s.length - 1; i >= 0; i--) { const t = Date.parse(s[i].t); if (!Number.isNaN(t) && (lastT - t) >= recentDays * 86400000) { startIdx = i; break; } }
        const st = Date.parse(s[startIdx].t); const spanDays = !Number.isNaN(st) ? (lastT - st) / 86400000 : null;
        if (spanDays && spanDays > 0) { recentRatePerDay = (thisCum[thisCum.length - 1] - thisCum[startIdx]) / spanDays; recentBasis = `${Math.round(spanDays)}d, ${s.length - startIdx} pts`; }
      }
    }

    const now = Date.now();
    const startStr = req.query.start || g?.startDate || '';
    const startMs = startStr ? Date.parse(startStr) : NaN;
    // Deadline = the EVENT date from Looker (scoped), falling back to the suite
    // briefing then by_date; overridable by ?end=. Whole calendar days to the event.
    const lookerDate = (typeof resolveEventDate === 'function' && g)
      ? await resolveEventDate({ suiteId, user: req.user }).catch(() => null) : null;
    const ed = g ? eventDeadline(g, lookerDate) : { ms: NaN, source: 'none' };
    const endMs = req.query.end ? Date.parse(req.query.end) : ed.ms;
    const r = (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) ? Math.max(0, Math.min(1, (now - startMs) / (endMs - startMs))) : null;
    const daysLeft = calendarDaysLeft(endMs, now);
    const target = Number(req.query.target) || (g ? g.targetValue : 0);
    // Align last year to NOW by its real axis (days-before-event) where possible, so the
    // forecast rides last year's ACTUAL cumulative at days-to-go — not an index guess.
    const at = (lastCol?.series && !Number.isNaN(endMs))
      ? fc.fractionAtNow(lastCol.series, { deadlineMs: endMs, nowMs: now, startMs, daysLeft }) : null;
    const result = (cum.length >= 2 && (r != null || at != null) && currentValue != null)
      ? fc.forecast({ cum, currentValue, target, r, daysLeft, recentRatePerDay, fNow: at ? at.fraction : null }) : null;

    res.json({
      columns: cols,
      strippedFilters: data.strippedFilters || [],
      deadline: { iso: Number.isFinite(endMs) ? new Date(endMs).toISOString().slice(0, 10) : null, source: req.query.end ? 'query' : ed.source, daysLeft },
      chosen: { lastKey: lastCol?.key, thisKey },
      // What the goal's own metric is pointed at — so we can see WHY goalMetric may
      // differ from the curve/dashboard (wrong tile, a field/pivot pick, or filters).
      goalMetricRef: g ? { source: g.source, metricKey: g.metricKey || null, unit: g.unit || null, metricRef: g.metricRef || null, curveRef: g.curveRef || null } : null,
      align: at ? { basis: at.basis, daysLeft: at.daysLeft, lastYearAtNow: Math.round(at.valueAtNow), fractionReached: Number(at.fraction.toFixed(4)) } : null,
      inputs: { currentValue, currentValueSource, goalMetric: g ? (await resolveMetric(g, { user: req.user })).value : null, target, r: r == null ? null : Number(r.toFixed(4)), daysLeft: daysLeft == null ? null : Math.round(daysLeft), recentRatePerDay: recentRatePerDay == null ? null : Math.round(recentRatePerDay), recentBasis, lastYearTotal: cum.length ? cum[cum.length - 1] : null },
      forecast: result,
      sample: { lastYearTail: (lastCol?.series || []).slice(-6), thisYearTail: (thisCol?.series || []).slice(-6) },
    });
  });

  console.log('[goals] Results pillar mounted');
  // Exposed so the briefing/digest can lead with the North Star (resolved values).
  return { resolveMetric, computeProgress, listGoals, listPersonalGoals, goalById, attachProgress, makeGoalCaches };
}

module.exports = { mount };
