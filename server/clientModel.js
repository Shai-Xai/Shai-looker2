// ─── Client content model & navigation ─────────────────────────────────────────
// Disposable routes-module. Owns the suite/set/dashboard MODEL and how a client
// navigates it:
//   • Custom sets + bespoke-dashboard import (admin)
//   • Suites CRUD + the locked-filter field catalogue (admin)
//   • Client navigation: /api/my/suites (the Entity→Suite→Set→Dashboard tree)
//   • Saved dashboard filter views (dual-surface) + per-dashboard/-tile lock
//     overrides and shared-dashboard fork/revert (admin)
// Remove the mount() line in index.js + this file to uninstall. Lifted VERBATIM
// out of index.js — its collaborators arrive as injected deps.

module.exports.mount = function mountClientModel(app, { db, auth, store, looker, fetchDashboard, convertDashboard, expandLockMap, cleanFilterMap, resolvePhase, suiteHasGoals }) {
  // Phases in which tickets are actively selling (used to flag the "current event
  // on sale" — pre_launch hasn't opened, day_after/post_event are over).
  const ON_SALE_PHASES = new Set(['launch', 'artist_drops', 'mid_campaign', 'build_up', 'event_day']);
  const suiteOnSale = (su) => { try { return resolvePhase ? ON_SALE_PHASES.has(resolvePhase(su.briefing || {}).key) : false; } catch { return false; } };
  // A client's custom sets + the dashboard pool available to build them with
  // (shared dashboards + this client's own bespoke dashboards).
  app.get('/api/admin/entities/:id/sets', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ sets: db.listSetsForEntity(req.params.id), pool: db.dashboardPoolFor(req.params.id), templates: db.listSets() });
  });
  app.post('/api/admin/entities/:id/sets', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.status(201).json(db.createSet({ ...(req.body || {}), ownerEntityId: req.params.id }));
  });
  // Clone a shared template set into a client-owned custom copy.
  app.post('/api/admin/entities/:id/sets/clone', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const { setId, name } = req.body || {};
    const copy = db.cloneSetForEntity(setId, req.params.id, name);
    if (!copy) return res.status(400).json({ error: 'Template set not found' });
    res.status(201).json(copy);
  });
  // Import a bespoke Looker dashboard as CLIENT-OWNED, optionally adding it to one
  // of the client's custom sets.
  app.post('/api/admin/entities/:id/dashboards/import', auth.requireAdmin, async (req, res) => {
    const entityId = req.params.id;
    const entity = db.getEntity(entityId);
    if (!entity) return res.status(404).json({ error: 'Not found' });
    const { lookerDashboardId, title, setId } = req.body || {};
    if (!lookerDashboardId) return res.status(400).json({ error: 'lookerDashboardId is required' });
    try {
      const source = await fetchDashboard(lookerDashboardId);
      await looker.resolveElementQueries(source.elements);
      const def = convertDashboard(source);
      if (title) def.title = title;
      if (req.body?.keepImportedFilters) def.keepImportedFilters = true; // Looker defaults stay authoritative
      // Always filed under the client's own folder so it's findable in the library.
      def.folder = `Custom/${entity.name}`;
      def.ownerEntityId = entityId; // bespoke to this client
      const created = store.create(def);
      try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
      // Add to the chosen custom set (must belong to this client).
      if (setId) {
        const set = db.getSet(setId);
        if (set && set.ownerEntityId === entityId) db.setSetDashboards(setId, [...set.dashboards, { id: created.id, parentId: null }]);
      }
      res.status(201).json({ dashboard: { id: created.id, title: created.title } });
    } catch (err) {
      console.error('[POST entity dashboards/import]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Suites = a client's event context: locks + bundled Sets.
  function enrichSuite(su) {
    return { ...su, entityName: db.getEntity(su.entityId)?.name || '', dashboardCount: db.dashboardsInSuite(su.id).length };
  }
  app.get('/api/admin/suites', auth.requireAdmin, (_req, res) => res.json(db.listSuites().map(enrichSuite)));
  app.post('/api/admin/suites', auth.requireAdmin, (req, res) => res.status(201).json(enrichSuite(db.createSuite(req.body || {}))));
  app.put('/api/admin/suites/:id', auth.requireAdmin, (req, res) => {
    const su = db.updateSuite(req.params.id, req.body || {});
    if (!su) return res.status(404).json({ error: 'Suite not found' });
    res.json(enrichSuite(su));
  });
  app.delete('/api/admin/suites/:id', auth.requireAdmin, (req, res) => { db.deleteSuite(req.params.id); res.status(204).end(); });

  // Distinct filter fields across all dashboards (for the locked-filter editor).
  app.get('/api/admin/filter-fields', auth.requireAdmin, (_req, res) => {
    const byField = new Map();        // field -> option
    const namesByField = new Map();   // field -> Set(distinct filter names)
    const filters = [];               // { name, field, model, explore }
    for (const d of db.listDashboards()) {
      const full = store.get(d.id);
      for (const f of full?.filters || []) {
        const field = f.field || f.dimension;
        if (!field) continue;
        const name = f.name || f.title || field;
        filters.push({ name, field, model: f.model || null, explore: f.explore || null });
        if (!byField.has(field)) byField.set(field, { field, title: f.title || field, suggestField: field, model: f.model || null, explore: f.explore || null });
        if (!namesByField.has(field)) namesByField.set(field, new Set());
        namesByField.get(field).add(name);
      }
    }
    const sharedField = (field) => (namesByField.get(field)?.size || 0) >= 2;
    // Field-based options — but NOT for fields used by several named filters
    // (those must be locked via the named filters, never the raw field, or the
    // field lock would clobber per-tile values like current/past/comparison).
    const out = [...byField.values()].filter((f) => !sharedField(f.field));
    // Id sibling for organiser/event (ids are stable; names can change).
    for (const f of [...out]) {
      const m = f.field.match(/^(core_organisers|core_events)\.name$/);
      if (!m) continue;
      const idField = `${m[1]}.id`;
      if (!out.some((x) => x.field === idField)) out.push({ field: idField, title: `${f.title} ID`, suggestField: idField, model: f.model, explore: f.explore });
    }
    // Name-based options for fields used by 2+ distinct filter names.
    const seenName = new Set();
    for (const fl of filters) {
      if (!sharedField(fl.field) || seenName.has(fl.name)) continue;
      seenName.add(fl.name);
      out.push({ field: fl.name, title: fl.name, suggestField: fl.field, model: fl.model, explore: fl.explore, byName: true });
    }
    res.json(out);
  });

  // ─── Client navigation: Entity → Suite → Set → Dashboards ──────────────────────
  // The suites this user can open (each carries its entity name).
  app.get('/api/my/suites', auth.requireAuth, (req, res) => {
    res.json(auth.suitesForUser(req.user).map((su) => {
      const ent = db.getEntity(su.entityId);
      return {
        id: su.id, name: su.name, icon: su.icon || '', entityId: su.entityId,
        entityName: ent?.name || '', entityLogo: ent?.logo || '',
        setCount: su.setIds.length, dashboardCount: db.dashboardsInSuite(su.id).length,
        onSale: suiteOnSale(su), hasGoals: suiteHasGoals ? suiteHasGoals(su.id) : false,
      };
    }));
  });

  // One suite: merged locks (for pre-fill + lock) + its Sets, each with its
  // dashboards. This is everything the client needs to navigate the suite.
  app.get('/api/my/suites/:id', auth.requireAuth, (req, res) => {
    if (!auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const su = db.getSuite(req.params.id);
    if (!su) return res.status(404).json({ error: 'Suite not found' });
    // Role-based dashboard visibility for this client (admins see everything).
    const isAdmin = req.user.role === 'admin';
    const role = auth.roleForEntity(req.user, su.entityId);
    const visible = (setId, dashId) => isAdmin || db.dashboardVisibleToRole(su.entityId, setId, dashId, role);
    // Dashboards an admin removed from THIS suite (a subset of a shared set). Hidden
    // for everyone — including admin preview — so it matches what the client sees.
    const excluded = new Set(su.excludedDashboards || []);
    const sets = su.setIds.map((sid) => {
      const set = db.getSet(sid);
      if (!set) return null;
      // One-level tree: top-level dashboards carry their sub-dashboards (tabs)
      // in `children`. An orphaned parent reference renders top-level.
      const nodes = (set.dashboards || []).map(({ id, parentId }) => {
        const d = store.get(id);
        return d && !excluded.has(id) && visible(set.id, id) && { id: d.id, title: d.title, description: d.description || '', tileCount: (d.tiles || []).length, parentId };
      }).filter(Boolean);
      const valid = new Set(nodes.map((n) => n.id));
      const dashboards = nodes.filter((n) => !n.parentId || !valid.has(n.parentId)).map(({ parentId, ...top }) => ({
        ...top,
        children: nodes.filter((c) => c.parentId === top.id).map(({ parentId: _p, ...rest }) => rest),
      }));
      return { id: set.id, name: set.name, icon: set.icon || '', dashboards };
    }).filter((s) => s && (isAdmin || s.dashboards.length)); // drop sets fully hidden for this role
    const ent = db.getEntity(su.entityId);
    // Per-dashboard lock overrides, expanded the same way as the suite-wide locks
    // so ViewPage can layer them on top for the matching dashboard.
    const dashboardLocks = {};
    for (const [did, locks] of Object.entries(su.dashboardLocks || {})) {
      if (locks && Object.keys(locks).length) dashboardLocks[did] = expandLockMap(locks);
    }
    res.json({
      id: su.id, name: su.name, icon: su.icon || '',
      entityId: su.entityId, // the suite's client — authoritative scope for tile actions (e.g. create segment)
      entityName: ent?.name || '', entityLogo: ent?.logo || '',
      lockedFilters: expandLockMap(auth.lockedFiltersForSuite(su.id)), dashboardLocks, tileLocks: su.tileLocks || {}, sets,
    });
  });

  // ── Saved dashboard filter views (dual-surface) ──────────────────────────────
  // Per-user "save my view" (client self-service) + the client default an admin
  // sets. Resolution on load is user view > entity default > the dashboard's own
  // default_value (applied client-side in ViewPage). Locks always still win.

  app.get('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
    const { dashboardId } = req.params;
    // The entity whose default applies: the suite's entity (if accessible), else
    // the user's own first entity.
    let entityId = null;
    const suiteId = req.query.suiteId;
    if (suiteId && auth.canAccessSuite(req.user, suiteId)) entityId = db.getSuite(suiteId)?.entityId || null;
    if (!entityId && req.user.role !== 'admin') entityId = (req.user.entityIds || [])[0] || null;
    res.json({
      user: db.getFilterView('user', req.user.id, dashboardId),
      entityDefault: entityId ? db.getFilterView('entity', entityId, dashboardId) : null,
    });
  });
  app.put('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
    db.setFilterView('user', req.user.id, req.params.dashboardId, cleanFilterMap(req.body?.filters));
    res.json({ ok: true });
  });
  app.delete('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
    db.deleteFilterView('user', req.user.id, req.params.dashboardId);
    res.json({ ok: true });
  });
  // Admin: set/clear the CLIENT default for a dashboard (applies to everyone on
  // that entity until a user saves their own view).
  app.put('/api/admin/entities/:entityId/dashboard-filters/:dashboardId', auth.requireAdmin, (req, res) => {
    db.setFilterView('entity', req.params.entityId, req.params.dashboardId, cleanFilterMap(req.body?.filters));
    res.json({ ok: true });
  });
  app.delete('/api/admin/entities/:entityId/dashboard-filters/:dashboardId', auth.requireAdmin, (req, res) => {
    db.deleteFilterView('entity', req.params.entityId, req.params.dashboardId);
    res.json({ ok: true });
  });
  // Admin: set the per-dashboard LOCKED-filter overrides for one dashboard within a
  // suite (the same suite.dashboardLocks the suite editor writes). An empty map
  // clears the override so the dashboard falls back to the suite-wide locks. Keyed
  // by the dashboard's filter name; the client view + goal resolvers expand it.
  app.put('/api/admin/suites/:suiteId/dashboard-locks/:dashboardId', auth.requireAdmin, (req, res) => {
    const map = db.setSuiteDashboardLocks(req.params.suiteId, req.params.dashboardId, cleanFilterMap(req.body?.locks));
    if (map == null) return res.status(404).json({ error: 'Suite not found' });
    res.json({ ok: true });
  });
  // Admin: lock filter(s) on a SINGLE tile for this client (suite.tileLocks). The
  // override is keyed by the dashboard filter name the tile listens to. Empty map
  // clears the tile's entry.
  app.put('/api/admin/suites/:suiteId/tile-locks/:tileId', auth.requireAdmin, (req, res) => {
    const map = db.setSuiteTileLocks(req.params.suiteId, req.params.tileId, cleanFilterMap(req.body?.locks));
    if (map == null) return res.status(404).json({ error: 'Suite not found' });
    res.json({ ok: true });
  });
  // Admin: fork a shared dashboard into a CLIENT-OWNED version for this suite's
  // client. The (edited) definition is supplied in the body so "Save as new" can
  // capture in-editor changes without first overwriting the shared template. The
  // admin can pick the destination folder + set; the default replaces the template
  // in place within the suite (cloning a shared set so other clients are untouched).
  app.post('/api/admin/suites/:suiteId/dashboards/:dashboardId/fork', auth.requireAdmin, (req, res) => {
    const { def, title, folder, setId, newSetName } = req.body || {};
    if (!def || typeof def !== 'object') return res.status(400).json({ error: 'def is required' });
    const out = db.forkDashboardForSuite(req.params.suiteId, req.params.dashboardId, def, { title, folder, setId, newSetName });
    if (!out) return res.status(404).json({ error: 'Suite not found' });
    res.status(201).json({ dashboard: { id: out.dashboard.id, title: out.dashboard.title }, suiteId: req.params.suiteId });
  });
  // Admin: revert a client version back to the shared template — repoints the suite
  // and discards the copy. Returns the template id to navigate back to.
  app.post('/api/admin/suites/:suiteId/dashboards/:dashboardId/revert', auth.requireAdmin, (req, res) => {
    const templateId = db.revertForkToTemplate(req.params.suiteId, req.params.dashboardId);
    if (!templateId) return res.status(400).json({ error: 'Not a revertable client version' });
    res.json({ dashboardId: templateId, suiteId: req.params.suiteId });
  });
};
