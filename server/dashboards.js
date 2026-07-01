// ─── Dashboards: storage, Looker import & query execution ──────────────────────
// SELF-CONTAINED ROUTES MODULE. Owns /api/dashboards*, /api/looker* (folder /
// models / explores), /api/admin/folders*, /api/admin/backfill-folders,
// /api/run-query and /api/drill. Mounted from index.js with injected deps;
// routes are lifted verbatim, behaviour unchanged.
//
// run-query / drill funnel through the SHARED query engine (runLookerQuery /
// applyScope / ...), injected here, so there is one shared cache + one scope
// boundary across the whole app (see server/query.js). collectFolderTree is
// private to this module.

const fx = require('./filterExpression'); // combined-field OR → Looker filter_expression

function mount(app, {
  store, db, auth, looker,
  convertDashboard, fetchDashboard, parseDrillUrl,
  runLookerQuery, applyScope, stripAnyValue, currentFirstEventSort,
}) {
app.get('/api/dashboards', auth.requireAuth, (req, res) => {
  res.json(store.list().filter((d) => auth.canAccessDashboard(req.user, d)));
});

// Folder-level "📌 Imported filters" — a PERSISTENT setting on the folder path that
// cascades to every dashboard in it (+ subfolders), including ones added later.
// Applied at view time (see GET /api/dashboards/:id); never written onto dashboards.
// MUST be declared before `/api/dashboards/:id` or it'd match id="folder-settings".
app.get('/api/dashboards/folder-settings', auth.requireAdmin, (_req, res) => res.json(db.folderSettingsMap()));
app.post('/api/dashboards/folder/keep-imported', auth.requireAdmin, (req, res) => {
  const folder = String((req.body || {}).folder || '');
  const on = !!(req.body || {}).on;
  db.setFolderKeepImported(folder, on);
  res.json({ ok: true, folder, on });
});

app.get('/api/dashboards/:id', auth.requireAuth, (req, res) => {
  const d = store.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  if (!auth.canAccessDashboard(req.user, d)) return res.status(403).json({ error: 'Not allowed' });
  // View-time cascade: a persistent folder setting can pin imported filters for the
  // whole folder. Surfaced as a separate hint so the editor still shows the
  // dashboard's OWN flag; it's never persisted onto the dashboard.
  res.json({ ...d, folderKeepImported: db.folderKeepImportedFor(d.folder) });
});

// Create / edit / delete / import — admin only (Howler builds; clients view).
app.post('/api/dashboards', auth.requireAdmin, (req, res) => res.status(201).json(store.create(req.body || {})));
app.put('/api/dashboards/:id', auth.requireAdmin, (req, res) => {
  const d = store.update(req.params.id, req.body || {});
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(d);
});
app.delete('/api/dashboards/:id', auth.requireAdmin, (req, res) => {
  res.status(store.remove(req.params.id) ? 204 : 404).end();
});

app.post('/api/dashboards/import', auth.requireAdmin, async (req, res) => {
  const { lookerDashboardId, title, folder } = req.body || {};
  if (!lookerDashboardId) return res.status(400).json({ error: 'lookerDashboardId is required' });
  try {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    const def = convertDashboard(source);
    if (title) def.title = title;
    if (req.body?.keepImportedFilters) def.keepImportedFilters = true; // Looker defaults stay authoritative
    // Folder: explicit choice, else the dashboard's Looker folder.
    def.folder = (folder || source.dashboard?.folder?.name || '').trim();
    const created = store.create(def);
    try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
    res.status(201).json(created);
  } catch (err) {
    console.error('[POST /api/dashboards/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Preview a Looker folder as a tree of folders → dashboards (admin picks/
// confirms before importing). Honours ?subfolders=0 to show top-level only.
app.get('/api/looker/folder/:id', auth.requireAdmin, async (req, res) => {
  try {
    const includeSub = req.query.subfolders !== '0';
    const root = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(req.params.id)}?fields=id,name,dashboards(id,title)`);
    let tree;
    if (includeSub) {
      try { tree = await collectFolderTree(req.params.id); }
      catch { tree = (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, folder: root.name, folderId: String(root.id), depth: 0 })); }
    } else {
      tree = (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, folder: root.name, folderId: String(root.id), depth: 0 }));
    }
    // Group into folders, preserving depth-first order. `path` is the nested
    // folder path (e.g. "Festivals/MTN Bushfire/Cashless") used when importing.
    const order = [];
    const byId = new Map();
    for (const d of tree) {
      if (!byId.has(d.folderId)) { byId.set(d.folderId, { id: d.folderId, name: d.folder, depth: d.depth, path: (d.path || [d.folder]).join('/'), dashboards: [] }); order.push(d.folderId); }
      byId.get(d.folderId).dashboards.push({ id: d.id, title: d.title });
    }
    res.json({ id: String(root.id), name: root.name, folders: order.map((fid) => byId.get(fid)), total: tree.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recursively collect every dashboard in a folder and its subfolders.
// Returns [{ id, title, folder, folderId, depth, path }] where path is the array
// of folder names from the import root down to where the dashboard lives.
async function collectFolderTree(folderId, maxDepth = 6) {
  const result = [];
  const seen = new Set();
  async function walk(id, depth, pathArr) {
    if (seen.has(String(id))) return; // guard against odd cycles
    seen.add(String(id));
    const f = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(id)}?fields=id,name,dashboards(id,title)`);
    const name = f.name || 'Imported folder';
    const path = [...pathArr, name];
    for (const d of f.dashboards || []) result.push({ id: String(d.id), title: d.title, folder: name, folderId: String(f.id), depth, path });
    if (depth < maxDepth) {
      let children = [];
      try { children = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(id)}/children?fields=id,name`); } catch { children = []; }
      for (const c of children || []) await walk(c.id, depth + 1, path);
    }
  }
  await walk(folderId, 0, []);
  return result;
}

// Import every dashboard in a Looker folder, filing them under a folder (the
// Looker folder name by default). With includeSubfolders, the whole tree is
// imported and each dashboard is filed under its own Looker (sub)folder name.
// Sequential — can take a while for big folders.
app.post('/api/dashboards/import-folder', auth.requireAdmin, async (req, res) => {
  const { folderId, folder: folderName, includeSubfolders = true, keepImportedFilters = false } = req.body || {};
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  try {
    const root = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(folderId)}?fields=id,name,dashboards(id,title)`);
    const rootName = (folderName || root.name || 'Imported folder').trim();
    const list = includeSubfolders
      ? await collectFolderTree(folderId)
      : (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, path: [root.name], depth: 0 }));
    let imported = 0;
    const failed = [];
    for (const d of list) {
      try {
        const source = await fetchDashboard(String(d.id));
        await looker.resolveElementQueries(source.elements);
        const def = convertDashboard(source);
        if (keepImportedFilters) def.keepImportedFilters = true; // Looker defaults stay authoritative
        // Nested folder path; the root segment honours the optional name override.
        const path = (d.path || [root.name]).slice();
        path[0] = rootName;
        def.folder = path.join('/');
        const created = store.create(def);
        try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
        imported++;
      } catch (e) {
        failed.push({ id: d.id, title: d.title, error: e.message });
      }
    }
    const folders = [...new Set(list.map((d) => { const p = (d.path || [root.name]).slice(); p[0] = rootName; return p.join('/'); }))];
    res.json({ folder: rootName, imported, total: list.length, failed, folders: folders.length });
  } catch (err) {
    console.error('[POST /api/dashboards/import-folder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Backfill folders: for already-imported dashboards with no folder, look up
// their source Looker dashboard's folder name and file them under it.
app.post('/api/admin/backfill-folders', auth.requireAdmin, async (_req, res) => {
  let updated = 0;
  const errors = [];
  for (const d of db.listDashboards()) {
    if (d.folder) continue;
    const lid = db.getDashboard(d.id)?.source?.lookerDashboardId;
    if (!lid) continue;
    try {
      const ld = await looker.lookerRequest('GET', `/dashboards/${encodeURIComponent(lid)}?fields=folder`);
      const name = ld.folder?.name;
      if (name) { db.updateDashboard(d.id, { folder: name }); updated++; }
    } catch (e) { errors.push({ id: d.id, error: e.message }); }
  }
  res.json({ updated, errors });
});

// Distinct dashboard folders (for pickers/grouping).
app.get('/api/admin/folders', auth.requireAdmin, (_req, res) => {
  const set = new Set();
  for (const d of db.listDashboards()) if (d.folder) set.add(d.folder);
  res.json([...set].sort((a, b) => a.localeCompare(b)));
});

// Rename a folder (and everything nested beneath it). `from`/`to` are folder
// paths; the matched prefix is rewritten on every dashboard under it.
app.post('/api/admin/folders/rename', auth.requireAdmin, (req, res) => {
  const from = String((req.body || {}).from || '').replace(/\/+$/, '');
  const toLeaf = String((req.body || {}).to || '').trim();
  if (!from || !toLeaf) return res.status(400).json({ error: 'from and to are required' });
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const newPrefix = parent + toLeaf;
  let updated = 0;
  for (const d of db.listDashboards()) {
    const f = d.folder || '';
    if (f === from || f.startsWith(from + '/')) {
      db.updateDashboard(d.id, { folder: newPrefix + f.slice(from.length) });
      updated++;
    }
  }
  res.json({ updated });
});

// Delete a folder (and subfolders): removes every dashboard filed under it.
app.post('/api/admin/folders/delete', auth.requireAdmin, (req, res) => {
  const path = String((req.body || {}).path || '').replace(/\/+$/, '');
  if (!path) return res.status(400).json({ error: 'path is required' });
  let deleted = 0;
  for (const d of db.listDashboards()) {
    const f = d.folder || '';
    if (f === path || f.startsWith(path + '/')) { store.remove(d.id); deleted++; }
  }
  res.json({ deleted });
});

// ─── LookML metadata (admin builds tiles) ──────────────────────────────────────
app.get('/api/looker/models', auth.requireAdmin, async (_req, res) => {
  try { res.json(await looker.listModels()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/looker/explores/:model/:explore', auth.requireAdmin, async (req, res) => {
  try { res.json(await looker.getExploreFields(req.params.model, req.params.explore)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Query execution (the calculation engine) — scoped per tenant ──────────────

// Slow explores (e.g. cashless) get hammered with identical queries when many
// tiles or repeat views run. Cache results briefly AND de-duplicate in-flight
// runs so the same Looker query is never launched twice at once.
// Query cache with stale-while-revalidate. Fresh hits (< TTL) return instantly.
// Stale hits (< TTL+STALE) return the cached data immediately AND kick off a
// background refresh, so users never wait on a slow Looker query for repeat
// views while data still stays reasonably current. Concurrent identical runs
// are de-duplicated into one Looker call.
// Data updates on a ~30-min Howler→Looker pipeline, so caching up to that cadence
// costs no freshness — instant within a cycle, a new run picked up within ~5 min,
// and the dashboard Refresh button force-bypasses for the latest run on demand.

app.post('/api/run-query', auth.requireAuth, async (req, res) => {
  try {
    const { query, filterOverrides = {}, suiteId, refresh = false, combinedFilters = [] } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const queryBody = { ...query, filters: stripAnyValue({ ...(query.filters || {}), ...filterOverrides }) };
    if (!(await applyScope(queryBody, req.user, suiteId))) {
      // Admins get the specific reason (which explore couldn't be scoped, or no
      // organiser configured) so a blocked dashboard is diagnosable; clients get
      // the generic message (don't leak scoping internals).
      let error = 'No data access is configured for your account yet.';
      if (req.user.role === 'admin') {
        const r = await auth.resolveScope(queryBody, req.user, suiteId);
        if (r.block) error = `Scope blocked: ${r.reason}`;
      }
      return res.status(403).json({ error });
    }
    // Combined-field OR locks (from the client's applicable-to-this-tile set) →
    // filter_expression. Applied AFTER applyScope so the organiser scope in the
    // filters map is already fixed; Looker AND-combines the two, so scope holds.
    if (Array.isArray(combinedFilters) && combinedFilters.length) fx.applyCombinedToBody(queryBody, combinedFilters, queryBody);
    // Force current-event-first ordering for offset comparison tiles; fall back
    // to the original query if the explore doesn't expose the event date field.
    const altered = currentFirstEventSort(queryBody);
    let data;
    if (altered) {
      try { data = await runLookerQuery('/queries/run/json_detail', altered, undefined, !!refresh); }
      catch (e) { console.warn('[run-query] event-date sort fallback:', e.message); data = await runLookerQuery('/queries/run/json_detail', queryBody, undefined, !!refresh); }
    } else {
      data = await runLookerQuery('/queries/run/json_detail', queryBody, undefined, !!refresh);
    }
    res.json(data);
  } catch (err) {
    console.error('[POST /api/run-query]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drill', auth.requireAuth, async (req, res) => {
  try {
    const query = parseDrillUrl(req.body?.url);
    if (!query) return res.status(400).json({ error: 'Could not parse drill link' });
    if (!(await applyScope(query, req.user, req.body?.suiteId))) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    // Combined-field OR locks constrain the drill too (narrowed to the fields the
    // drill query joins), so drilling never reveals rows the lock excludes.
    const combinedFilters = req.body?.combinedFilters;
    if (Array.isArray(combinedFilters) && combinedFilters.length) fx.applyCombinedToBody(query, combinedFilters, query);
    const data = await runLookerQuery('/queries/run/json_detail', query);
    res.json({ query, data });
  } catch (err) {
    console.error('[POST /api/drill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

  console.log('[dashboards] dashboards, Looker import & query routes mounted');
}

module.exports = { mount };
