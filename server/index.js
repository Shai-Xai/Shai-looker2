require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const looker = require('./looker');
const store = require('./store');
const auth = require('./auth');
const db = require('./db');
const migrate = require('./migrate');
const { convertDashboard } = require('./convert');
const { recreateDashboard, fetchDashboard } = require('./recreate');
const { parseDrillUrl } = require('./drill');
const insights = require('./insights');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(auth.attachUser);

// Serve built React app (client/dist) if present, else raw client/
const clientDist = path.join(__dirname, '../client/dist');
const clientFallback = path.join(__dirname, '../client');
const staticDir = fs.existsSync(clientDist) ? clientDist : clientFallback;
app.use(express.static(staticDir));

// Bring legacy JSON data into SQLite on first boot (idempotent), then ensure an
// admin exists.
migrate.run();
auth.seedAdmin();

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Auth ───────────────────────────────────────────────────────────────────
// publicUser + the user's client(s) (name + logo) for header branding.
function meUser(user) {
  const pub = auth.publicUser(user);
  if (!pub) return null;
  const entities = (pub.entityIds || []).map((id) => { const e = db.getEntity(id); return e ? { id: e.id, name: e.name, logo: e.logo || '' } : null; }).filter(Boolean);
  return { ...pub, entities };
}
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyCredentials(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  auth.issueCookie(res, user);
  res.json({ user: meUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

// Current user (200 with null when not logged in, so the client can decide).
app.get('/api/auth/me', (req, res) => {
  res.json({ user: meUser(req.user) });
});

// ─── Admin: users ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth.requireAdmin, (_req, res) => res.json(auth.loadUsers().map(auth.publicUser)));
app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  try { res.status(201).json(auth.createUser(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const u = auth.updateUser(req.params.id, req.body || {});
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});
app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  auth.deleteUser(req.params.id); res.status(204).end();
});

// ─── Admin: entities / sets / suites (the model) ───────────────────────────────
app.get('/api/admin/entities', auth.requireAdmin, (_req, res) => res.json(db.listEntities()));
app.post('/api/admin/entities', auth.requireAdmin, (req, res) => res.status(201).json(db.createEntity(req.body || {})));
app.put('/api/admin/entities/:id', auth.requireAdmin, (req, res) => {
  const e = db.updateEntity(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: 'Entity not found' });
  res.json(e);
});
app.delete('/api/admin/entities/:id', auth.requireAdmin, (req, res) => { db.deleteEntity(req.params.id); res.status(204).end(); });

// Sets = reusable dashboard collections (Ticketing, Cashless, …).
app.get('/api/admin/sets', auth.requireAdmin, (_req, res) => res.json(db.listSets()));
app.post('/api/admin/sets', auth.requireAdmin, (req, res) => res.status(201).json(db.createSet(req.body || {})));
app.put('/api/admin/sets/:id', auth.requireAdmin, (req, res) => {
  const s = db.updateSet(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Set not found' });
  res.json(s);
});
app.delete('/api/admin/sets/:id', auth.requireAdmin, (req, res) => { db.deleteSet(req.params.id); res.status(204).end(); });

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
    };
  }));
});

// One suite: merged locks (for pre-fill + lock) + its Sets, each with its
// dashboards. This is everything the client needs to navigate the suite.
app.get('/api/my/suites/:id', auth.requireAuth, (req, res) => {
  if (!auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
  const su = db.getSuite(req.params.id);
  if (!su) return res.status(404).json({ error: 'Suite not found' });
  const sets = su.setIds.map((sid) => {
    const set = db.getSet(sid);
    if (!set) return null;
    const dashboards = set.dashboardIds.map((id) => store.get(id)).filter(Boolean)
      .map((d) => ({ id: d.id, title: d.title, description: d.description || '', tileCount: (d.tiles || []).length }));
    return { id: set.id, name: set.name, icon: set.icon || '', dashboards };
  }).filter(Boolean);
  const ent = db.getEntity(su.entityId);
  res.json({
    id: su.id, name: su.name, icon: su.icon || '',
    entityName: ent?.name || '', entityLogo: ent?.logo || '',
    lockedFilters: auth.lockedFiltersForSuite(su.id), sets,
  });
});

// ─── Saved (editable) dashboards ───────────────────────────────────────────────

// List — scoped by access (admin sees all; client sees shared + their own).
app.get('/api/dashboards', auth.requireAuth, (req, res) => {
  res.json(store.list().filter((d) => auth.canAccessDashboard(req.user, d)));
});

app.get('/api/dashboards/:id', auth.requireAuth, (req, res) => {
  const d = store.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  if (!auth.canAccessDashboard(req.user, d)) return res.status(403).json({ error: 'Not allowed' });
  res.json(d);
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

// Preview a Looker folder's dashboards (admin picks before importing).
app.get('/api/looker/folder/:id', auth.requireAdmin, async (req, res) => {
  try {
    const f = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(req.params.id)}?fields=id,name,dashboards(id,title)`);
    res.json({ id: f.id, name: f.name, dashboards: (f.dashboards || []).map((d) => ({ id: String(d.id), title: d.title })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import every dashboard in a Looker folder, filing them under a folder (the
// Looker folder name by default). Sequential — can take a while for big folders.
app.post('/api/dashboards/import-folder', auth.requireAdmin, async (req, res) => {
  const { folderId, folder: folderName } = req.body || {};
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  try {
    const folder = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(folderId)}?fields=id,name,dashboards(id,title)`);
    const name = (folderName || folder.name || 'Imported folder').trim();
    const list = folder.dashboards || [];
    let imported = 0;
    const failed = [];
    for (const d of list) {
      try {
        const source = await fetchDashboard(String(d.id));
        await looker.resolveElementQueries(source.elements);
        const def = convertDashboard(source);
        def.folder = name;
        const created = store.create(def);
        try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
        imported++;
      } catch (e) {
        failed.push({ id: d.id, title: d.title, error: e.message });
      }
    }
    res.json({ folder: name, imported, total: list.length, failed });
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
const QCACHE_TTL = (Number(process.env.QUERY_CACHE_TTL) || 60) * 1000;
const QCACHE_MAX = 300;
const qCache = new Map();    // key -> { at, data }
const qInflight = new Map(); // key -> Promise
function stableKey(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(stableKey).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableKey(obj[k])).join(',') + '}';
  return JSON.stringify(obj);
}
async function runLookerQuery(path, body) {
  const key = path + '|' + stableKey(body);
  const hit = qCache.get(key);
  if (hit && Date.now() - hit.at < QCACHE_TTL) return hit.data;
  if (qInflight.has(key)) return qInflight.get(key); // dedup concurrent identical runs
  const p = looker.lookerRequest('POST', path, body)
    .then((data) => {
      qInflight.delete(key);
      qCache.set(key, { at: Date.now(), data });
      if (qCache.size > QCACHE_MAX) qCache.delete(qCache.keys().next().value);
      return data;
    })
    .catch((e) => { qInflight.delete(key); throw e; });
  qInflight.set(key, p);
  return p;
}

// Force the user's ENTITY (organiser) lock onto every query — the hard security
// boundary. Suite locks (event/cashless) are NOT forced here; they're per-tile
// presets applied client-side via listenTo, so current/past/comparison don't
// clobber each other. A suiteId only gates access + picks the right entity.
// Admins are unscoped. Returns false to deny.
function applyScope(query, user, suiteId) {
  let scope;
  if (suiteId) {
    // A suite context (client view, or an admin previewing a client) is always
    // scoped to that suite's organiser — so an admin preview faithfully matches
    // what the client sees.
    if (!auth.canAccessSuite(user, suiteId)) return false;
    scope = auth.forcedScopeForSuite(suiteId);
  } else {
    if (user.role === 'admin') return true; // admin browsing their own studio
    scope = auth.scopeFiltersForUser(user);
    if (scope && scope.__block) return false;
  }
  if (!scope || !Object.keys(scope).length) return false; // fail closed (need organiser)
  query.filters = { ...(query.filters || {}), ...scope };
  return true;
}

app.post('/api/run-query', auth.requireAuth, async (req, res) => {
  try {
    const { query, filterOverrides = {}, suiteId } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const queryBody = { ...query, filters: { ...(query.filters || {}), ...filterOverrides } };
    if (!applyScope(queryBody, req.user, suiteId)) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    const data = await runLookerQuery('/queries/run/json_detail', queryBody);
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
    if (!applyScope(query, req.user, req.body?.suiteId)) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    const data = await runLookerQuery('/queries/run/json_detail', query);
    res.json({ query, data });
  } catch (err) {
    console.error('[POST /api/drill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filter-suggest', auth.requireAuth, async (req, res) => {
  try {
    const { model, explore, field, suiteId, q: term, pair } = req.body;
    if (!model || !explore || !field) return res.json({ suggestions: [] });
    // Get distinct values by running an inline query for just this dimension.
    // A search term filters server-side (contains for text, exact for numeric
    // ids) so this works even with thousands of values. Scope it so clients
    // only see their own values.
    // For organiser/event, also pull the companion field (id↔name) so each
    // suggestion can show both, e.g. "Ultra South Africa  (id: 42)".
    const COMPANION = {
      'core_organisers.name': 'core_organisers.id', 'core_organisers.id': 'core_organisers.name',
      'core_events.name': 'core_events.id', 'core_events.id': 'core_events.name',
    };
    const comp = pair ? COMPANION[field] : null;
    const q = { model, view: explore, fields: comp ? [field, comp] : [field], sorts: [field], limit: 100 };
    const t = (term || '').trim();
    if (t) {
      if (/^\d+$/.test(t)) {
        q.filters = { [field]: t };
      } else {
        // Looker's `%x%` LIKE can be case-sensitive (depends on the dialect),
        // so OR a few case variants to make search effectively case-insensitive.
        const tc = t.replace(/\b\w/g, (c) => c.toUpperCase());
        const variants = [...new Set([t, t.toLowerCase(), t.toUpperCase(), tc])];
        q.filters = { [field]: variants.map((v) => `%${v}%`).join(',') };
      }
    }
    if (!applyScope(q, req.user, suiteId)) return res.json({ suggestions: [] });
    const rows = await runLookerQuery('/queries/run/json', q);
    const seen = new Set();
    const suggestions = [];
    const isId = field.endsWith('.id');
    for (const r of rows || []) {
      const v = r[field];
      if (v == null || v === '') continue;
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      if (comp) {
        const other = r[comp] == null ? '' : String(r[comp]);
        suggestions.push({ value: s, label: isId ? `${s} — ${other}` : `${s}  (id: ${other})` });
      } else {
        suggestions.push(s);
      }
    }
    res.json({ suggestions });
  } catch (err) {
    console.error('[POST /api/filter-suggest]', err.message);
    res.json({ suggestions: [] });
  }
});

// Combined AI instructions: the global standing instructions, plus the
// per-client context when the request is in a suite (client) context.
function aiInstructionsFor(suiteId) {
  const parts = [];
  const global = db.getSetting('ai_instructions');
  if (global && global.trim()) parts.push(global.trim());
  if (suiteId) {
    const su = db.getSuite(suiteId);
    const ent = su && db.getEntity(su.entityId);
    if (ent?.aiContext && ent.aiContext.trim()) parts.push(`Context for the client "${ent.name}":\n${ent.aiContext.trim()}`);
  }
  return parts.join('\n\n');
}

// ─── AI insight for a tile ─────────────────────────────────────────────────────
app.get('/api/insight/status', auth.requireAuth, (_req, res) => {
  res.json({ enabled: insights.isConfigured() });
});

// Global AI instructions (admin) — appended to every AI prompt.
app.get('/api/admin/ai-instructions', auth.requireAdmin, (_req, res) => {
  res.json({ instructions: db.getSetting('ai_instructions'), aiEnabled: insights.isConfigured() });
});
app.put('/api/admin/ai-instructions', auth.requireAdmin, (req, res) => {
  res.json({ instructions: db.setSetting('ai_instructions', (req.body || {}).instructions || '') });
});

// Streams the insight back as plain text chunks as Claude writes it.
app.post('/api/insight', auth.requireAuth, async (req, res) => {
  const { title, visType, fields, rows, filters, userContext, history, suiteId } = req.body || {};
  if (!fields || !rows) return res.status(400).json({ error: 'fields and rows are required' });
  if (!insights.isConfigured()) {
    return res.status(400).json({ error: 'AI insights are not configured. Set ANTHROPIC_API_KEY in your .env to enable them.' });
  }
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    await insights.streamInsight({ title, visType, fields, rows, filters, userContext, history, instructions: aiInstructionsFor(suiteId) }, (text) => res.write(text));
    res.end();
  } catch (err) {
    console.error('[POST /api/insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// Whole-dashboard summary: runs every tile's query (same scope + filters as the
// live view), then streams an executive summary of the whole dashboard.
app.post('/api/dashboard-insight', auth.requireAuth, async (req, res) => {
  const { dashboardId, filterValues = {}, suiteId } = req.body || {};
  if (!dashboardId) return res.status(400).json({ error: 'dashboardId is required' });
  if (!insights.isConfigured()) {
    return res.status(400).json({ error: 'AI insights are not configured. Set ANTHROPIC_API_KEY in your .env to enable them.' });
  }
  const def = store.get(dashboardId);
  if (!def) return res.status(404).json({ error: 'Dashboard not found' });
  if (req.user.role !== 'admin' && !auth.canAccessDashboard(req.user, def)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Build each runnable tile's scoped query (mirrors the client's per-tile logic).
  const MAX_TILES = 24;
  const allTiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const jobs = [];
  for (const tile of allTiles) {
    const q = tile.query;
    if (tile.type === 'text' || !q?.model || !q?.view || !(q.fields || []).length) continue;
    const overrides = {};
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const v = filterValues[filterName];
      if (v && String(v).trim()) overrides[queryField] = String(v).trim();
    }
    const queryBody = { ...q, filters: { ...(q.filters || {}), ...overrides } };
    if (!applyScope(queryBody, req.user, suiteId)) continue; // skip blocked tiles
    jobs.push({ title: tile.title, visType: tile.vis?.type, queryBody });
    if (jobs.length >= MAX_TILES) break;
  }

  const settled = await Promise.all(jobs.map(async (j) => {
    try {
      const data = await runLookerQuery('/queries/run/json_detail', j.queryBody);
      if (!data?.data?.length) return null;
      return { title: j.title, visType: j.visType, fields: data.fields, rows: data.data };
    } catch { return null; }
  }));
  const tiles = settled.filter(Boolean);
  if (!tiles.length) return res.status(400).json({ error: 'No tile data available to summarize.' });

  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    await insights.streamDashboardInsight({ title: def.title, filters: filterValues, tiles, instructions: aiInstructionsFor(suiteId) }, (t) => res.write(t));
    res.end();
  } catch (err) {
    console.error('[POST /api/dashboard-insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// ─── Tile library (admin) ──────────────────────────────────────────────────────
// A catalogue of reusable tiles harvested from imported dashboards. Admins
// curate the labels; the editor stamps copies into new dashboards.
app.get('/api/admin/library', auth.requireAdmin, (req, res) => {
  res.json({
    tiles: db.listLibraryTiles({ search: req.query.search, category: req.query.category }),
    categories: db.listLibraryCategories(),
    aiEnabled: insights.isConfigured(),
  });
});
app.get('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  const t = db.getLibraryTile(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});
app.put('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  const t = db.updateLibraryTile(req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});
app.delete('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  res.status(db.deleteLibraryTile(req.params.id) ? 204 : 404).end();
});
// Record that a library tile was used (stamped into a dashboard).
app.post('/api/admin/library/:id/use', auth.requireAdmin, (req, res) => {
  db.bumpLibraryUsage(req.params.id); res.json({ ok: true });
});
// Backfill: harvest tiles from every existing dashboard into the library.
app.post('/api/admin/library/backfill', auth.requireAdmin, (_req, res) => {
  let added = 0, scanned = 0;
  for (const d of store.list()) {
    const def = store.get(d.id);
    if (!def) continue;
    scanned++;
    try { added += db.harvestDashboardTiles(def, { sourceDashboardId: d.id }); } catch (e) { console.error('[backfill]', e.message); }
  }
  res.json({ scanned, added });
});
// AI-describe one library tile (label + description + category).
app.post('/api/admin/library/:id/describe', auth.requireAdmin, async (req, res) => {
  const t = db.getLibraryTile(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!insights.isConfigured()) return res.status(400).json({ error: 'AI is not configured (set ANTHROPIC_API_KEY).' });
  try {
    const out = await insights.describeTile({
      title: t.name, visType: t.visType, fields: (t.def.query?.fields || []),
      model: t.model, explore: t.explore, instructions: db.getSetting('ai_instructions'),
    });
    const saved = db.updateLibraryTile(t.id, {
      name: out.name || t.name,
      description: out.description || t.description,
      category: out.category || t.category,
    });
    res.json(saved);
  } catch (err) {
    console.error('[POST /api/admin/library/:id/describe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Live Looker dashboard ops (admin) ─────────────────────────────────────────
app.get('/api/looker-dashboard/:id', auth.requireAdmin, async (req, res) => {
  try {
    const data = await fetchDashboard(req.params.id);
    res.json({
      id: data.dashboard.id, title: data.dashboard.title,
      folder: data.dashboard.folder?.name || null,
      tileCount: data.elements.length, filterCount: data.filters.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/recreate', auth.requireAdmin, async (req, res) => {
  const { sourceDashboardId, newTitle, targetFolderId } = req.body;
  if (!sourceDashboardId || !newTitle || !targetFolderId) {
    return res.status(400).json({ error: 'sourceDashboardId, newTitle, and targetFolderId are required' });
  }
  try {
    const source = await fetchDashboard(sourceDashboardId);
    res.json(await recreateDashboard(source, newTitle, targetFolderId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

const PORT = process.env.PORT || 3045;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${looker.LOOKER_BASE_URL}`);
});
