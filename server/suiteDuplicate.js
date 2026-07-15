// ─── Duplicate a suite (admin) ────────────────────────────────────────────────
// Stand up a new event "just like" an existing one: clone the suite's Sets and
// its CLIENT-OWNED dashboards into fresh copies, then the admin just renames and
// repoints the event. Faithful by design — the copy carries the source's locks,
// live-dashboard target, exclusions and briefing — so if a working suite is
// duplicated it behaves identically (and, conversely, proves whether a fault is
// in the config or the event).
//
// Two correctness rules the copy MUST honour, or it's born broken:
//   1. Preserve TILE IDs. createDashboard copies `tiles` verbatim, so tile ids
//      survive — which keeps daysBeforeSync.sourceTileId and every tileId-keyed
//      lock valid in the copy (a remap miss here is exactly how copies silently
//      lose their days-to-go sync).
//   2. Remap DASHBOARD IDs everywhere they're referenced — set membership +
//      nesting, dashboardLocks, excludedDashboards and liveDashboardId — so the
//      copy points at ITS dashboards, never the source's.
//
// Shared (owner-less) template dashboards are REFERENCED, not copied: they're
// masters serving many clients, exactly as the source suite referenced them.
//
// A factory over db's public API (like server/query.js) — mounts in one line and
// keeps the duplication logic out of db.js (which is at its line budget).

module.exports = function createSuiteDuplicator(db) {
  // A client-owned dashboard → a fresh copy for `entityId` (same tiles → same
  // tile ids). Shared masters and dangling refs are returned unchanged. Create
  // THEN update with the full def — createDashboard only whitelists a subset of
  // fields (it drops daysBeforeSync/keepImportedFilters), so the update is what
  // carries the whole definition over (mirrors forkDashboardForSuite).
  function cloneDashboard(dashId, entityId) {
    const def = db.getDashboard(dashId);
    if (!def) return dashId;               // dangling reference — leave it be
    if (!def.ownerEntityId) return dashId; // shared template — reference, don't fork
    const created = db.createDashboard({ title: def.title, ownerEntityId: entityId, folder: def.folder });
    db.updateDashboard(created.id, { ...def, ownerEntityId: entityId });
    return created.id;
  }

  function duplicateSuite(suiteId, opts = {}) {
    const src = db.getSuite(suiteId);
    if (!src) return null;
    const entityId = opts.entityId || src.entityId;
    const name = (opts.name && String(opts.name).trim()) || `${src.name} (copy)`;

    // old dashboard id → its copy (or itself). Cached so a dashboard shared across
    // several of the suite's sets is cloned once and re-referenced consistently.
    const dashMap = {};
    const remap = (id) => (id == null ? id : (id in dashMap ? dashMap[id] : (dashMap[id] = cloneDashboard(id, entityId))));

    const newSetIds = [];
    for (const setId of src.setIds || []) {
      const set = db.getSet(setId);
      if (!set) continue;
      const copy = db.createSet({ name: set.name, icon: set.icon, folder: set.folder, ownerEntityId: entityId });
      db.setSetDashboards(copy.id, (set.dashboards || []).map((e) => ({ id: remap(e.id), parentId: remap(e.parentId), displayName: e.displayName || '' })));
      newSetIds.push(copy.id);
    }

    // dashboardId-keyed structures repoint onto the copies; tileLocks are keyed by
    // tileId (preserved above), so they carry over verbatim.
    const remapKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [dashMap[k] || k, v]));
    const suite = db.createSuite({ entityId, name, icon: src.icon, lockedFilters: src.lockedFilters, setIds: newSetIds });
    return db.updateSuite(suite.id, {
      briefing: src.briefing,
      dashboardLocks: remapKeys(src.dashboardLocks),
      tileLocks: src.tileLocks,
      excludedDashboards: (src.excludedDashboards || []).map((id) => dashMap[id] || id),
      liveDashboardId: src.liveDashboardId ? (dashMap[src.liveDashboardId] || src.liveDashboardId) : '',
      eventUrl: src.eventUrl,
      howlerEventId: src.howlerEventId,
    });
  }

  return { duplicateSuite };
};
