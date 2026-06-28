// ─── Owl pin — turn an Owl chart into a real dashboard tile ────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns /api/owl/pin + /api/owl/pin-targets.
// Mounted from owlChat.js (so index.js stays at budget). Remove that line + this
// file to uninstall.
//
// An Owl chart already carries a live Looker query + a chart type, so a "tile" is
// just that persisted. We strip the organiser scope (re-applied per client at
// render, like every tile) so the pinned tile stays LIVE, not a frozen snapshot.
//   - Pin to a DASHBOARD  → append a tile to it.
//   - Pin to HOME         → append to a per-client "Saved from Owl" dashboard
//                           (auto-created + bundled into the client's suite) and
//                           add a 'pin' mark so it shows on the home page.
// Gated to admins for now (the Owl is allowlisted anyway); clients can follow.

const crypto = require('crypto');
const { owlAllowed } = require('./owlChat');

const ORG = 'core_organisers.name';
const VIS = { line: 'looker_line', bar: 'looker_column', pie: 'looker_pie', metric: 'single_value' };

// Drop the forced organiser filter — tiles are re-scoped to the viewing client at
// render, so baking it in would be wrong elsewhere. Keep the analytical filters.
function cleanQuery(qb) {
  const q = { ...(qb || {}) };
  q.filters = { ...(q.filters || {}) };
  delete q.filters[ORG];
  return q;
}
function nextY(tiles) {
  let y = 0;
  for (const t of tiles || []) { const b = (t.layout?.y || 0) + (t.layout?.h || 6); if (b > y) y = b; }
  return y;
}
function buildTile(title, qb, chartType) {
  return {
    id: crypto.randomUUID(), type: 'vis', title: String(title || 'Owl chart').slice(0, 120), body_text: '',
    layout: { x: 0, y: 0, w: 12, h: 7 }, query: cleanQuery(qb),
    vis: { type: VIS[chartType] || 'looker_column' }, listenTo: {},
  };
}
// Find (or create) the client's "Saved from Owl" dashboard, bundled into one of
// their suites so home pins actually render.
function ensureOwlDashboard(db, entityId, suiteId) {
  const existing = db.listDashboards().find((d) => d.ownerEntityId === entityId && d.source === 'owl-saved');
  if (existing) return db.getDashboard(existing.id);
  const dash = db.createDashboard({ title: 'Saved from Owl', ownerEntityId: entityId, folder: 'Saved from Owl', source: 'owl-saved' });
  const set = db.createSet({ name: 'Saved from Owl', ownerEntityId: entityId, dashboardIds: [dash.id] });
  let suite = suiteId ? db.getSuite(suiteId) : null;
  if (!suite || suite.entityId !== entityId) suite = db.listSuitesForEntity(entityId)[0] || null;
  if (suite) db.setSuiteSets(suite.id, [...(suite.setIds || []), set.id]);
  return db.getDashboard(dash.id);
}

function mount(app, { db, auth }) {
  const allowed = (u) => u && u.role === 'admin' && owlAllowed(u);

  // Dashboards the user can pin to (for the picker). Home is always an option.
  app.get('/api/owl/pin-targets', auth.requireAuth, (req, res) => {
    if (!allowed(req.user)) return res.status(403).json({ error: 'Not allowed.' });
    const entityId = String(req.query.entityId || '');
    if (!entityId) return res.json({ dashboards: [] });
    const dashboards = db.dashboardPoolFor(entityId).filter((d) => d.source !== 'owl-saved').map((d) => ({ id: d.id, title: d.title }));
    res.json({ dashboards });
  });

  // Pin a chart. body: { entityId, suiteId?, target:'home'|<dashboardId>, title, queryBody, chartType }
  app.post('/api/owl/pin', auth.requireAuth, (req, res) => {
    if (!allowed(req.user)) return res.status(403).json({ error: 'The Owl pin isn\'t enabled for your account yet.' });
    const { entityId, suiteId, target, title, queryBody, chartType } = req.body || {};
    if (!entityId) return res.status(400).json({ error: 'Pick a client first.' });
    if (!queryBody || !queryBody.model || !queryBody.view) return res.status(400).json({ error: 'This answer has no chart to pin.' });

    let dash; let pinnedToHome = false;
    if (target === 'home') { dash = ensureOwlDashboard(db, entityId, suiteId); pinnedToHome = true; }
    else {
      dash = db.getDashboard(target);
      if (!dash) return res.status(404).json({ error: 'Dashboard not found.' });
      if (dash.ownerEntityId && dash.ownerEntityId !== entityId) return res.status(403).json({ error: 'Not allowed for this client.' });
    }
    const tile = buildTile(title, queryBody, chartType);
    tile.layout.y = nextY([...(dash.tiles || []), ...((dash.carousels || []).flatMap((c) => c.tiles || []))]);
    db.updateDashboard(dash.id, { tiles: [...(dash.tiles || []), tile] });
    if (pinnedToHome) db.setMark('user', req.user.id, dash.id, tile.id, 'pin', true);
    res.json({ ok: true, dashboardId: dash.id, dashboardTitle: dash.title, pinnedToHome });
  });

  console.log('[owlPin] pin-to-dashboard module mounted');
}

module.exports = { mount, cleanQuery, buildTile, ensureOwlDashboard };
