// ─── Custom categories (tags) for goals & alerts ────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. A per-client list of operational areas the
// client created themselves (Ticketing, Cashless, Access control…), SHARED by the
// goal and alert editors — so a custom category created once is reusable in both.
// Stored as a JSON array of names under one settings key per entity; the built-in
// presets live in the client, this is only the client's own additions. Mounted from
// index.js with one line. To remove: delete this file + that line (the setting rows
// are harmless leftovers). Nothing else depends on it.
//
// Dual-surface: the same entity-scoped routes serve a client self-serving and an
// admin acting on their behalf (admins pass the ownership check, like digest-tiles).

const KEY = (entityId) => `custom_categories:${entityId}`;

function mount(app, { db, auth }) {
  function list(entityId) {
    try { const v = JSON.parse(db.getSetting(KEY(entityId), '[]')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []; }
    catch { return []; }
  }
  function add(entityId, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return list(entityId);
    const cur = list(entityId);
    if (!cur.some((c) => c.toLowerCase() === clean.toLowerCase())) cur.push(clean); // case-insensitive dedupe, keep first casing
    db.setSetting(KEY(entityId), JSON.stringify(cur.slice(0, 100)));
    return list(entityId);
  }
  function remove(entityId, name) {
    const lc = String(name || '').trim().toLowerCase();
    const cur = list(entityId).filter((c) => c.toLowerCase() !== lc);
    db.setSetting(KEY(entityId), JSON.stringify(cur));
    return cur;
  }
  // Admins can act as any client (preview); a member owns their own entity.
  const owns = (req) => req.user.role === 'admin' || (req.user.entityIds || []).includes(req.params.entityId);

  app.get('/api/my/categories/:entityId', auth.requireAuth, (req, res) => {
    if (!owns(req)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ categories: list(req.params.entityId) });
  });
  app.post('/api/my/categories/:entityId', auth.requireAuth, (req, res) => {
    if (!owns(req)) return res.status(403).json({ error: 'Not allowed' });
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'A category name is required' });
    res.json({ categories: add(req.params.entityId, name) });
  });
  app.delete('/api/my/categories/:entityId/:name', auth.requireAuth, (req, res) => {
    if (!owns(req)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ categories: remove(req.params.entityId, decodeURIComponent(req.params.name)) });
  });

  return { list, add, remove };
}

module.exports = { mount };
