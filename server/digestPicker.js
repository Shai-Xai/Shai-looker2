// ─── Digest picker surfaces: tile catalogue · event scope · saved tiles ────────
// Disposable routes-module extracted from index.js (composition-root budget).
// Owns the read-only pickers the digest editor (and briefing checklist) draw
// from: which tiles can be curated, which events a digest can scope to (with
// their post-event coverage state), and a viewer's saved (📌 pinned / ⭐
// followed) tiles. Returns { savedTileMarks } — buildDigestContent (index.js)
// uses it to resolve a digest creator's saved tiles at send time.
module.exports.mount = function mountDigestPicker(app, { db, store, auth, clientCatalogue, suiteCoverage, cooldownDays }) {
  // Selectable tiles per client, grouped by dashboard — drives the curated
  // digest picker. Only data tiles (with fields, not text) can be chosen.
  // People-data heuristic: does a tile's query expose an email or phone/mobile
  // column? Used to offer ONLY tiles with usable contact data when building a
  // segment (a segment needs an email or mobile per person). Name-based, mirroring
  // how CreateSegmentModal guesses the email/phone columns.
  const CONTACT_FIELD_RE = /(e-?mail|phone|mobile|cell|msisdn|contact.?number)/i;
  function tileHasContact(t) {
    return (t.query?.fields || []).some((f) => CONTACT_FIELD_RE.test(String(f)));
  }
  function digestTileCatalogue(entityId) {
    const { catalogue } = clientCatalogue(entityId);
    const dashboards = [];
    for (const c of catalogue) {
      const def = store.get(c.dashboardId);
      if (!def) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length)
        .map((t) => ({ tileId: t.id, title: t.title || '(untitled)', visType: t.vis?.type || '', hasContact: tileHasContact(t) }));
      if (tiles.length) dashboards.push({ dashboardId: c.dashboardId, title: c.title, setName: c.setName, suiteId: c.suiteId, suiteName: c.suiteName, tiles });
    }
    return { dashboards };
  }
  app.get('/api/admin/entities/:id/digest-tiles', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(digestTileCatalogue(req.params.id));
  });
  app.get('/api/my/digest-tiles/:entityId', auth.requireAuth, (req, res) => {
    // Admins can act as any client (preview), so they pass the ownership check.
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json(digestTileCatalogue(req.params.entityId));
  });

  // The client's events (suites) a digest can be scoped to — id, name, whether
  // the event is still running, and whether it's still inside the post-event
  // cool-down (covered). Drives the digest editor's event picker; only shown
  // there for multi-event clients.
  function digestEventList(entityId) {
    return {
      events: clientCatalogue(entityId).suites.map((su) => {
        const cov = suiteCoverage(su.briefing || {});
        return { id: su.id, name: su.name, active: !cov.ended, covered: cov.covered };
      }),
      cooldownDays: cooldownDays(),
    };
  }
  app.get('/api/admin/entities/:id/digest-events', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(digestEventList(req.params.id));
  });
  app.get('/api/my/digest-events/:entityId', auth.requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json(digestEventList(req.params.entityId));
  });

  // The SAVED tiles for a viewer — the ones marked as mattering, whether 📌 pinned
  // (shown on home) or ⭐ followed (always read by the briefing). `userId` returns
  // that viewer's own ('user') marks PLUS the client's ('entity') marks — exactly
  // what the home Pinned/briefing sees — so the digest checklist matches what you
  // actually see pinned. Deduped across kinds.
  function savedTileMarks(entityId, userId = '') {
    const marks = [...db.listMarks({ userId, entityId, kind: 'pin' }), ...db.listMarks({ userId, entityId, kind: 'follow' })];
    const byKey = new Map();
    for (const m of marks) {
      const key = `${m.dashboardId}|${m.tileId}`;
      if (!byKey.has(key)) byKey.set(key, { dashboardId: m.dashboardId, tileId: m.tileId, kinds: new Set() });
      byKey.get(key).kinds.add(m.kind === 'follow' ? 'follow' : 'pin');
    }
    return [...byKey.values()];
  }
  function followedTilesFor(entityId, userId = '') {
    const { catalogue } = clientCatalogue(entityId);
    const meta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    const out = [];
    for (const m of savedTileMarks(entityId, userId)) {
      const def = store.get(m.dashboardId);
      const c = meta[m.dashboardId];
      if (!def || !c) continue; // only tiles still in this client's catalogue
      const tile = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))].find((t) => t.id === m.tileId);
      if (!tile || tile.type === 'text') continue;
      out.push({ dashboardId: m.dashboardId, tileId: m.tileId, title: tile.title || '(untitled)', visType: tile.vis?.type || '', dashTitle: c.title, setName: c.setName, suiteName: c.suiteName, kinds: [...m.kinds] });
    }
    return { tiles: out };
  }
  app.get('/api/admin/entities/:id/followed-tiles', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(followedTilesFor(req.params.id, req.user.id));
  });
  app.get('/api/my/followed-tiles/:entityId', auth.requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json(followedTilesFor(req.params.entityId, req.user.id));
  });

  return { savedTileMarks };
};
