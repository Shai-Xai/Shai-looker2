require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const looker = require('./looker');
const store = require('./store');
const { convertDashboard } = require('./convert');
const { recreateDashboard, fetchDashboard } = require('./recreate');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Serve built React app (client/dist) if present, else raw client/
const clientDist = path.join(__dirname, '../client/dist');
const clientFallback = path.join(__dirname, '../client');
const staticDir = fs.existsSync(clientDist) ? clientDist : clientFallback;
app.use(express.static(staticDir));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Saved (editable) dashboards — CRUD ────────────────────────────────────────

app.get('/api/dashboards', (_req, res) => {
  res.json(store.list());
});

app.get('/api/dashboards/:id', (req, res) => {
  const d = store.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(d);
});

app.post('/api/dashboards', (req, res) => {
  const d = store.create(req.body || {});
  res.status(201).json(d);
});

app.put('/api/dashboards/:id', (req, res) => {
  const d = store.update(req.params.id, req.body || {});
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(d);
});

app.delete('/api/dashboards/:id', (req, res) => {
  const ok = store.remove(req.params.id);
  res.status(ok ? 204 : 404).end();
});

// Import a live Looker dashboard into an editable definition, then save it.
app.post('/api/dashboards/import', async (req, res) => {
  const { lookerDashboardId, title } = req.body || {};
  if (!lookerDashboardId) {
    return res.status(400).json({ error: 'lookerDashboardId is required' });
  }
  try {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    const def = convertDashboard(source);
    if (title) def.title = title;
    const saved = store.create(def);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /api/dashboards/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LookML metadata (build tiles from scratch) ────────────────────────────────

app.get('/api/looker/models', async (_req, res) => {
  try {
    res.json(await looker.listModels());
  } catch (err) {
    console.error('[GET /api/looker/models]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/looker/explores/:model/:explore', async (req, res) => {
  try {
    res.json(await looker.getExploreFields(req.params.model, req.params.explore));
  } catch (err) {
    console.error('[GET /api/looker/explores]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Query execution (the calculation engine) ──────────────────────────────────

// Run a Looker query with optional filter overrides → json_detail rows.
app.post('/api/run-query', async (req, res) => {
  try {
    const { query, filterOverrides = {} } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const queryBody = {
      ...query,
      filters: { ...(query.filters || {}), ...filterOverrides },
    };
    const data = await looker.lookerRequest('POST', '/queries/run/json_detail', queryBody);
    res.json(data);
  } catch (err) {
    console.error('[POST /api/run-query]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Filter value suggestions from Looker.
app.post('/api/filter-suggest', async (req, res) => {
  try {
    const { model, explore, field } = req.body;
    const data = await looker.lookerRequest(
      'GET',
      `/looks/model/explore/fields?model_name=${encodeURIComponent(model)}&explore_name=${encodeURIComponent(explore)}&field_names=${encodeURIComponent(field)}&limit=100`
    );
    res.json({ suggestions: data?.suggest_dimension?.suggestions || [] });
  } catch (_) {
    res.json({ suggestions: [] });
  }
});

// ─── Live Looker dashboard ops (preview / recreate / live view) ────────────────

// Lightweight metadata preview of a live Looker dashboard.
app.get('/api/looker-dashboard/:id', async (req, res) => {
  try {
    const data = await fetchDashboard(req.params.id);
    res.json({
      id: data.dashboard.id,
      title: data.dashboard.title,
      folder: data.dashboard.folder?.name || null,
      tileCount: data.elements.length,
      filterCount: data.filters.length,
    });
  } catch (err) {
    console.error('[GET /api/looker-dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recreate a Looker dashboard inside Looker (clone workflow).
app.post('/api/recreate', async (req, res) => {
  const { sourceDashboardId, newTitle, targetFolderId } = req.body;
  if (!sourceDashboardId || !newTitle || !targetFolderId) {
    return res.status(400).json({
      error: 'sourceDashboardId, newTitle, and targetFolderId are required',
    });
  }
  try {
    const source = await fetchDashboard(sourceDashboardId);
    const results = await recreateDashboard(source, newTitle, targetFolderId);
    res.json(results);
  } catch (err) {
    console.error('[POST /api/recreate]', err.message);
    res.status(500).json({ error: err.message });
  }
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
