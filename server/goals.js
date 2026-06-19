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

const SOURCES = ['ticketing', 'cashless', 'access', 'audience', 'ga4', 'app', 'social_paid', 'sponsorship', 'manual'];
const DIRECTIONS = ['at_least', 'at_most', 'exact'];

function mount(app, { db, auth, resolveTileValue }) {
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
    CREATE INDEX IF NOT EXISTS idx_goals_suite ON goals(suite_id);
    CREATE INDEX IF NOT EXISTS idx_goal_snapshots ON goal_snapshots(goal_id, at);
  `);

  const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
  function rowToGoal(r) {
    if (!r) return null;
    return {
      id: r.id, suiteId: r.suite_id, entityId: r.entity_id, scope: r.scope, ownerRef: r.owner_ref,
      name: r.name, metricKey: r.metric_key, source: r.source, metricRef: parseJson(r.metric_ref, {}),
      targetValue: r.target_value, unit: r.unit, direction: r.direction, byDate: r.by_date,
      isNorthStar: !!r.is_north_star, position: r.position,
      baselineEventId: r.baseline_event_id, baselineValue: r.baseline_value, baselineSource: r.baseline_source,
      baselineComparable: !!r.baseline_comparable,
      conversionRef: r.conversion_ref ? parseJson(r.conversion_ref, null) : null,
      rollsUpTo: r.rolls_up_to || null,
      status: r.status, resultBand: r.result_band || null,
      createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
    };
  }
  const goalById = (id) => rowToGoal(sql.prepare('SELECT * FROM goals WHERE id=?').get(id));
  const listGoals = (suiteId) => sql.prepare("SELECT * FROM goals WHERE suite_id=? AND status='active' ORDER BY is_north_star DESC, position, created_at").all(suiteId).map(rowToGoal);

  // Sanitise incoming goal fields. P1 exposes only event goals; cascade/attribution
  // columns exist but aren't set here.
  function cleanInput(b = {}) {
    const mr = b.metricRef && typeof b.metricRef === 'object' ? b.metricRef : {};
    return {
      name: String(b.name || '').slice(0, 120),
      metricKey: String(b.metricKey || '').slice(0, 80),
      source: SOURCES.includes(b.source) ? b.source : 'manual',
      metricRef: { dashboardId: String(mr.dashboardId || '').slice(0, 64), tileId: String(mr.tileId || '').slice(0, 64), field: String(mr.field || '').slice(0, 200) },
      targetValue: Number(b.targetValue) || 0,
      unit: String(b.unit || '').slice(0, 16),
      direction: DIRECTIONS.includes(b.direction) ? b.direction : 'at_least',
      byDate: String(b.byDate || '').slice(0, 32),
      position: Number.isFinite(Number(b.position)) ? Number(b.position) : 0,
      baselineEventId: String(b.baselineEventId || '').slice(0, 64),
      baselineValue: b.baselineValue == null || b.baselineValue === '' ? null : Number(b.baselineValue),
      baselineSource: String(b.baselineSource || '').slice(0, 32),
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

  function resultBand(goal, value, pct) {
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
  // Progress = resolved value vs target, respecting direction + (linear) pace.
  // Pace needs a deadline; status is ahead/on_track/behind before it, 'final' after.
  function computeProgress(goal, value) {
    if (value == null || !goal.targetValue) return { value, pct: null, status: null, band: goal.resultBand || null };
    const pct = goal.direction === 'at_most'
      ? (value <= 0 ? 100 : Math.round((goal.targetValue / value) * 100))
      : Math.round((value / goal.targetValue) * 100);
    let expected = null, onPace = null, status = null;
    const start = Date.parse(goal.createdAt);
    const end = goal.byDate ? Date.parse(goal.byDate) : NaN;
    const nowMs = Date.now();
    if (!Number.isNaN(end) && !Number.isNaN(start) && end > start) {
      const frac = Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
      expected = Math.round(goal.targetValue * frac);
      onPace = goal.direction === 'at_most' ? value <= (expected || goal.targetValue) : value >= expected * 0.95;
      status = nowMs >= end ? 'final' : (onPace ? (pct >= 100 ? 'ahead' : 'on_track') : 'behind');
    }
    const band = (!Number.isNaN(end) && nowMs >= end) ? resultBand(goal, value, pct) : (goal.resultBand || null);
    return { value, pct, target: goal.targetValue, direction: goal.direction, expected, onPace, status, band };
  }

  // ── Access guards (admin OR an entity member; writes need goals.manage) ──
  const canView = (user, suiteId) => user.role === 'admin' || auth.canAccessSuite(user, suiteId);
  function canManage(user, suiteId) {
    if (user.role === 'admin') return true;
    const su = db.getSuite(suiteId);
    return !!su && auth.canAccessSuite(user, suiteId) && auth.hasPermission(user, su.entityId, 'goals.manage');
  }

  // ── Routes (one guarded set serves admin + client self-service, keyed by suite) ──
  app.get('/api/goals/suites/:suiteId', auth.requireAuth, async (req, res) => {
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const goals = listGoals(req.params.suiteId);
    const out = [];
    for (const g of goals) {
      const m = await resolveMetric(g, { user: req.user });
      out.push({ ...g, progress: { ...computeProgress(g, m.value), asOf: m.asOf, resolvedSource: m.source } });
    }
    res.json({ goals: out, canManage: canManage(req.user, req.params.suiteId) });
  });

  app.post('/api/goals/suites/:suiteId', auth.requireAuth, (req, res) => {
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = cleanInput(req.body || {});
    if (!c.name) return res.status(400).json({ error: 'A goal name is required' });
    const id = uuid(); const ts = now();
    const existing = sql.prepare("SELECT COUNT(*) n FROM goals WHERE suite_id=? AND scope='event' AND status='active'").get(req.params.suiteId).n;
    sql.prepare(`INSERT INTO goals (id, suite_id, entity_id, scope, owner_ref, name, metric_key, source, metric_ref,
        target_value, unit, direction, by_date, is_north_star, position, baseline_event_id, baseline_value, baseline_source,
        status, created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, req.params.suiteId, su.entityId, 'event', req.params.suiteId, c.name, c.metricKey, c.source, JSON.stringify(c.metricRef),
      c.targetValue, c.unit, c.direction, c.byDate, 0, c.position, c.baselineEventId, c.baselineValue, c.baselineSource,
      'active', req.user.email, ts, req.user.email, ts);
    // First active event goal becomes the North Star; or honour an explicit request.
    if (existing === 0 || req.body?.isNorthStar) setNorthStar(req.params.suiteId, id);
    audit(id, 'created', null, c.name, req.user.email);
    res.status(201).json({ goal: goalById(id) });
  });

  app.put('/api/goals/:id', auth.requireAuth, (req, res) => {
    const g = goalById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    if (!canManage(req.user, g.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = cleanInput({ ...g, ...req.body });
    // Audit the fields people care about.
    for (const [field, oldV, newV] of [['name', g.name, c.name], ['target_value', g.targetValue, c.targetValue], ['by_date', g.byDate, c.byDate], ['direction', g.direction, c.direction]]) {
      if (String(oldV) !== String(newV)) audit(g.id, field, oldV, newV, req.user.email);
    }
    sql.prepare(`UPDATE goals SET name=?, metric_key=?, source=?, metric_ref=?, target_value=?, unit=?, direction=?,
        by_date=?, position=?, baseline_event_id=?, baseline_value=?, baseline_source=?, updated_by=?, updated_at=? WHERE id=?`).run(
      c.name, c.metricKey, c.source, JSON.stringify(c.metricRef), c.targetValue, c.unit, c.direction,
      c.byDate, c.position, c.baselineEventId, c.baselineValue, c.baselineSource, req.user.email, now(), g.id);
    if (req.body?.isNorthStar && !g.isNorthStar) { setNorthStar(g.suiteId, g.id); audit(g.id, 'is_north_star', false, true, req.user.email); }
    res.json({ goal: goalById(g.id) });
  });

  app.delete('/api/goals/:id', auth.requireAuth, (req, res) => {
    const g = goalById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    if (!canManage(req.user, g.suiteId)) return res.status(403).json({ error: 'Not allowed' });
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
    if (!canManage(req.user, g.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const v = Number(req.body?.value);
    if (!Number.isFinite(v)) return res.status(400).json({ error: 'A numeric value is required' });
    sql.prepare('INSERT INTO goal_snapshots (id, goal_id, at, actual_value) VALUES (?,?,?,?)').run(uuid(), g.id, now(), v);
    res.status(201).json({ ok: true, value: v });
  });

  console.log('[goals] Results pillar mounted');
  // Exposed so the briefing/digest can lead with the North Star (resolved values).
  return { resolveMetric, computeProgress, listGoals, goalById };
}

module.exports = { mount };
