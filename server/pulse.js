// ─── Pulse feed: the header "heartbeat" strip's data (insight, ambiently) ────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `tile_snapshots` table + the /api/pulse
// routes. Merges multiple beat sources into ONE recency-ordered feed for the strip
// (client/src/components/LivePulse.jsx):
//   • alerts   — recent fires (injected alertBeats(), owned by server/alerts.js)
//   • momentum — movement on a client's key single-value tiles ("+142 Tickets sold
//                in the last hour"), sampled here on a slow tick into tile_snapshots
//   • goals / owl anomalies — future sources, merged the same way (add a *Beats() fn)
//
// Momentum tile SELECTION is deliberately swappable: pickMomentumTiles() AUTO-PICKS
// today (key single-value tiles, capped to bound Looker load). A pins/picker version
// can drop in later by changing only that function — the sampler, the delta maths and
// the feed are selection-agnostic.
//
// Kill switch: setting `pulse_enabled` ('0' disables the sampler + 404s the routes).
// Cost knobs: PULSE_SAMPLE_MS (sampler cadence), PULSE_MAX_TILES (tiles/entity/tick).
// To remove the whole feature: delete this file + its mount line, and drop the
// tile_snapshots table. The alerts module is untouched (it only exposes recentBeats).

const crypto = require('crypto');

const SINGLE_VALUE = (vt) => vt === 'single_value' || vt === 'single_value_period_over_period' || (vt || '').includes('bar_gauge');
// Titles that read like a momentum metric — preferred when capping the tile set.
const KEY_RE = /(sold|sales|revenue|income|gmv|amount|payment|ticket|scan|attend|check.?in|guest|order|sign.?up|download|view|traffic|visit|redeem|top.?up)/i;
const CUR_RE = /(revenue|income|gmv|amount|payment|sales|price|spend|value|rand|zar)/i;

function mount(app, { db, auth, resolveTileValue, alertBeats }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('pulse_enabled', '1') !== '0';

  sql.exec(`
    CREATE TABLE IF NOT EXISTS tile_snapshots (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      dashboard_id TEXT NOT NULL,
      tile_id      TEXT NOT NULL,
      value        REAL,
      at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tile_snap ON tile_snapshots(entity_id, dashboard_id, tile_id, at);
  `);

  const isAdmin = (u) => u && u.role === 'admin';
  const canEntity = (u, eid) => isAdmin(u) || (u && (u.entityIds || []).includes(eid));
  const off = (res) => res.status(404).json({ error: 'Pulse is disabled' });

  // ── momentum tile selection (SWAPPABLE: auto-pick today) ──────────────────────
  // Walk entity → suites → dashboards → tiles; keep single-value KPIs that have a
  // query, prefer titles that read like a momentum metric, cap to bound Looker load.
  // Cheap (local JSON only) but memoised briefly so a busy poll doesn't re-walk.
  const MAX_TILES = Math.max(1, Number(process.env.PULSE_MAX_TILES) || 5);
  const pickCache = new Map(); // entityId -> { at, tiles }
  function pickMomentumTiles(entityId) {
    const c = pickCache.get(entityId);
    if (c && Date.now() - c.at < 5 * 60000) return c.tiles;
    const out = [];
    const seen = new Set();
    let suites = [];
    try { suites = db.listSuitesForEntity(entityId) || []; } catch { suites = []; }
    for (const su of suites) {
      let dashIds = [];
      try { dashIds = db.dashboardsInSuite(su.id) || []; } catch { dashIds = []; }
      for (const did of dashIds) {
        let def; try { def = db.getDashboard(did); } catch { def = null; }
        if (!def) continue;
        const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((cr) => cr.tiles || []))];
        for (const t of tiles) {
          const vt = (t.vis && t.vis.type) || '';
          if (!SINGLE_VALUE(vt)) continue;
          if (!(t.query && t.query.fields && t.query.fields.length)) continue;
          const key = did + ':' + t.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const title = t.title || 'Metric';
          const fmt = (t.vis && (t.vis.value_format || '')) || '';
          const unit = /%/.test(fmt) ? '%' : (/[r$]|zar/i.test(fmt) || CUR_RE.test(title)) ? 'ZAR' : 'count';
          out.push({ suiteId: su.id, dashboardId: did, tileId: t.id, title, unit, key: KEY_RE.test(title) });
        }
      }
    }
    out.sort((a, b) => (b.key === a.key ? 0 : b.key ? 1 : -1)); // key metrics first, then cap
    const tiles = out.slice(0, MAX_TILES);
    pickCache.set(entityId, { at: Date.now(), tiles });
    return tiles;
  }

  // Read a tile as a synthetic client locked to this entity — the same per-tenant
  // scope a real client request gets (mirrors how alerts evaluate values).
  const evalUser = (entityId) => ({ id: `pulse:${entityId}`, email: 'pulse@howler', role: 'client', entityIds: [entityId] });

  // ── the sampler: snapshot each entity's momentum tiles on a slow tick ─────────
  const SAMPLE_MS = Math.max(60000, Number(process.env.PULSE_SAMPLE_MS) || 15 * 60000);
  const RETAIN_MS = 50 * 3600 * 1000; // ~2 days of history (matches the feed window)
  let sampling = false;
  async function sampleEntity(entityId) {
    for (const t of pickMomentumTiles(entityId)) {
      try {
        const v = await resolveTileValue({ dashboardId: t.dashboardId, tileId: t.tileId, user: evalUser(entityId), suiteId: t.suiteId });
        if (v == null || !Number.isFinite(Number(v))) continue;
        sql.prepare('INSERT INTO tile_snapshots (id, entity_id, dashboard_id, tile_id, value, at) VALUES (?,?,?,?,?,?)')
          .run(uuid(), entityId, t.dashboardId, t.tileId, Number(v), now());
      } catch (e) { console.error('[pulse] sample failed', entityId, t.tileId, e.message); }
    }
  }
  async function sample() {
    if (!enabled() || sampling) return;
    sampling = true;
    try {
      const entityIds = sql.prepare('SELECT DISTINCT entity_id FROM suites').all().map((r) => r.entity_id).filter(Boolean);
      for (const eid of entityIds) { try { await sampleEntity(eid); } catch (e) { console.error('[pulse] sampleEntity failed', eid, e.message); } }
      sql.prepare('DELETE FROM tile_snapshots WHERE at < ?').run(new Date(Date.now() - RETAIN_MS).toISOString());
    } finally { sampling = false; }
  }
  const timer = setInterval(() => sample().catch(() => {}), SAMPLE_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => sample().catch(() => {}), 30000); // first sample shortly after boot

  // ── momentum beats: latest value vs ~1h ago, per tracked tile ─────────────────
  const fmtNum = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-ZA') : String(Math.round(n * 100) / 100));
  function fmtDelta(d, unit, moneySym = 'R') {
    const sign = d < 0 ? '-' : '+';
    const a = Math.abs(d);
    if (unit === 'ZAR') return `${sign}${moneySym}${fmtNum(a)}`; // money unit; symbol follows the client's reporting currency
    if (unit === '%') return `${sign}${fmtNum(a)} pts`;
    return `${sign}${fmtNum(a)}`;
  }
  function momentumBeats(entityId, { windowMs = 3600 * 1000 } = {}) {
    const beats = [];
    let sym = 'R';
    try { sym = require('./currency').symbolFor(require('./mailer').resolveBranding(entityId).currency); } catch { /* default R */ }
    for (const t of pickMomentumTiles(entityId)) {
      const latest = sql.prepare('SELECT value, at FROM tile_snapshots WHERE entity_id=? AND dashboard_id=? AND tile_id=? ORDER BY at DESC LIMIT 1').get(entityId, t.dashboardId, t.tileId);
      if (!latest || latest.value == null) continue;
      // the snapshot closest to `windowMs` ago, within a tolerance — so cadence drift
      // doesn't break the "last hour" delta.
      const target = new Date(Date.now() - windowMs).toISOString();
      const loBound = new Date(Date.now() - windowMs * 1.75).toISOString();
      const hiBound = new Date(Date.now() - windowMs * 0.5).toISOString();
      const prior = sql.prepare('SELECT value, at FROM tile_snapshots WHERE entity_id=? AND dashboard_id=? AND tile_id=? AND at>=? AND at<=? ORDER BY ABS(julianday(at)-julianday(?)) LIMIT 1')
        .get(entityId, t.dashboardId, t.tileId, loBound, hiBound, target);
      if (!prior || prior.value == null) continue;
      const delta = Number(latest.value) - Number(prior.value);
      if (!delta) continue;                                  // no movement → no beat
      if (t.unit !== '%' && delta < 0) continue;             // drops on a running total are alerts' job, not momentum
      beats.push({
        id: `mom:${t.dashboardId}:${t.tileId}:${latest.at}`,
        kind: 'momentum', at: latest.at, tier: 'info',
        message: `${fmtDelta(delta, t.unit, sym)} ${t.title} in the last hour`,
        name: t.title, value: Number(latest.value), abs: Math.abs(delta),
      });
    }
    beats.sort((a, b) => b.abs - a.abs);                     // strongest movers first
    return beats.slice(0, 3).map(({ abs, ...b }) => b);      // cap so momentum can't flood the strip
  }

  // ── the merged feed (recency-ordered) ─────────────────────────────────────────
  function feed(entityId, limit) {
    const alerts = (typeof alertBeats === 'function' ? alertBeats(entityId, { limit }) : []) || [];
    const momentum = momentumBeats(entityId);
    return [...alerts, ...momentum]
      .filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) // newest first
      .slice(0, limit);
  }

  app.get('/api/pulse/entities/:entityId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const eid = req.params.entityId;
    if (!canEntity(req.user, eid)) return res.status(403).json({ error: 'Not allowed' });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
    res.json({ beats: feed(eid, limit) });
  });

  app.get('/api/pulse/status', auth.requireAuth, (req, res) => res.json({ enabled: enabled() }));

  console.log('[pulse] mounted', enabled() ? `(sampling every ${Math.round(SAMPLE_MS / 60000)}m, ${MAX_TILES} tiles/entity)` : '(disabled — set pulse_enabled=1)');
  return { sample, feed, momentumBeats };
}

module.exports = { mount };
