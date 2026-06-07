require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const looker = require('./looker');
const store = require('./store');
const auth = require('./auth');
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
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyCredentials(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  auth.issueCookie(res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

// Current user (200 with null when not logged in, so the client can decide).
app.get('/api/auth/me', (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

// ─── Admin: tenants & users ────────────────────────────────────────────────────
app.get('/api/admin/tenants', auth.requireAdmin, (_req, res) => res.json(auth.listTenants()));
app.post('/api/admin/tenants', auth.requireAdmin, (req, res) => res.status(201).json(auth.createTenant(req.body || {})));
app.put('/api/admin/tenants/:id', auth.requireAdmin, (req, res) => {
  const t = auth.updateTenant(req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  res.json(t);
});
app.delete('/api/admin/tenants/:id', auth.requireAdmin, (req, res) => { auth.deleteTenant(req.params.id); res.status(204).end(); });

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

// Tenants the current user may assign/see (admins manage; clients can read their own for the UI).
app.get('/api/tenants', auth.requireAuth, (req, res) => {
  if (req.user.role === 'admin') return res.json(auth.listTenants());
  // Client: their own entities (presented in the legacy tenant shape).
  res.json((req.user.entityIds || []).map(auth.getTenant).filter(Boolean));
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
  const { lookerDashboardId, title } = req.body || {};
  if (!lookerDashboardId) return res.status(400).json({ error: 'lookerDashboardId is required' });
  try {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    const def = convertDashboard(source);
    if (title) def.title = title;
    res.status(201).json(store.create(def));
  } catch (err) {
    console.error('[POST /api/dashboards/import]', err.message);
    res.status(500).json({ error: err.message });
  }
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

// Inject the user's mandatory scope filters (overriding any client-supplied
// value on those fields). Returns false if the user has no data access.
function applyScope(query, user) {
  const scope = auth.scopeFiltersForUser(user);
  if (scope && scope.__block) return false;
  query.filters = { ...(query.filters || {}), ...(scope || {}) };
  return true;
}

app.post('/api/run-query', auth.requireAuth, async (req, res) => {
  try {
    const { query, filterOverrides = {} } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const queryBody = { ...query, filters: { ...(query.filters || {}), ...filterOverrides } };
    if (!applyScope(queryBody, req.user)) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    const data = await looker.lookerRequest('POST', '/queries/run/json_detail', queryBody);
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
    if (!applyScope(query, req.user)) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    const data = await looker.lookerRequest('POST', '/queries/run/json_detail', query);
    res.json({ query, data });
  } catch (err) {
    console.error('[POST /api/drill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filter-suggest', auth.requireAuth, async (req, res) => {
  try {
    const { model, explore, field } = req.body;
    if (!model || !explore || !field) return res.json({ suggestions: [] });
    // Get distinct values by running an inline query for just this dimension.
    // Scope it to the user's tenant so clients only see their own values
    // (e.g. a client never sees other organisers' event names).
    const q = { model, view: explore, fields: [field], sorts: [field], limit: 500 };
    if (!applyScope(q, req.user)) return res.json({ suggestions: [] });
    const rows = await looker.lookerRequest('POST', '/queries/run/json', q);
    const seen = new Set();
    const suggestions = [];
    for (const r of rows || []) {
      const v = r[field];
      if (v == null || v === '') continue;
      const s = String(v);
      if (!seen.has(s)) { seen.add(s); suggestions.push(s); }
    }
    res.json({ suggestions });
  } catch (err) {
    console.error('[POST /api/filter-suggest]', err.message);
    res.json({ suggestions: [] });
  }
});

// ─── AI insight for a tile ─────────────────────────────────────────────────────
app.get('/api/insight/status', auth.requireAuth, (_req, res) => {
  res.json({ enabled: insights.isConfigured() });
});

// Streams the insight back as plain text chunks as Claude writes it.
app.post('/api/insight', auth.requireAuth, async (req, res) => {
  const { title, visType, fields, rows, filters } = req.body || {};
  if (!fields || !rows) return res.status(400).json({ error: 'fields and rows are required' });
  if (!insights.isConfigured()) {
    return res.status(400).json({ error: 'AI insights are not configured. Set ANTHROPIC_API_KEY in your .env to enable them.' });
  }
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    await insights.streamInsight({ title, visType, fields, rows, filters }, (text) => res.write(text));
    res.end();
  } catch (err) {
    console.error('[POST /api/insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${looker.LOOKER_BASE_URL}`);
});
