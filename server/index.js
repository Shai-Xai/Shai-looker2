require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

const LOOKER_BASE_URL = process.env.LOOKER_BASE_URL?.replace(/\/$/, '');
const API_BASE = `${LOOKER_BASE_URL}/api/4.0`;

// ─── Token Cache ───────────────────────────────────────────────────────────────

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.LOOKER_CLIENT_ID,
      client_secret: process.env.LOOKER_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Looker auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Looker tokens expire in `expires_in` seconds; refresh 30s early
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };

  console.log('[auth] Obtained new Looker access token');
  return tokenCache.token;
}

// ─── Looker API Helper ─────────────────────────────────────────────────────────

async function lookerRequest(method, path, body = null, retry = true) {
  const token = await getAccessToken();

  const options = {
    method,
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, options);

  // Auto-refresh on 401
  if (res.status === 401 && retry) {
    console.log('[auth] Token expired, refreshing...');
    tokenCache = { token: null, expiresAt: 0 };
    return lookerRequest(method, path, body, false);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Looker API ${method} ${path} failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('application/json') ? res.json() : res.text();
}

// ─── Step 1: Fetch Dashboard ───────────────────────────────────────────────────

async function fetchDashboard(dashboardId) {
  const [dashboard, elements, filters] = await Promise.all([
    lookerRequest('GET', `/dashboards/${dashboardId}`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_elements`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_filters`),
  ]);
  return { dashboard, elements, filters };
}

// ─── Step 2: Recreate Dashboard ───────────────────────────────────────────────

async function recreateDashboard(source, newTitle, folderId) {
  const { dashboard, elements, filters } = source;

  // 2a. Create dashboard shell
  const newDashboard = await lookerRequest('POST', '/dashboards', {
    title: newTitle,
    folder_id: folderId,
    description: dashboard.description || '',
    background_color: dashboard.background_color || null,
    load_configuration: dashboard.load_configuration || null,
    lookml_link_id: null, // detach from LookML if it was linked
  });

  console.log(`[recreate] Created dashboard shell: ${newDashboard.id}`);

  const results = {
    dashboardId: newDashboard.id,
    dashboardUrl: `${LOOKER_BASE_URL}/dashboards/${newDashboard.id}`,
    tilesCreated: 0,
    tilesFailed: 0,
    filtersCreated: 0,
    filtersFailed: 0,
    errors: [],
  };

  // Build a map of old element ID → new element ID (needed for filter links)
  const elementIdMap = {};

  // 2b. Recreate each tile
  for (const el of elements) {
    try {
      const payload = buildElementPayload(el, newDashboard.id);
      const newEl = await lookerRequest('POST', '/dashboard_elements', payload);
      elementIdMap[el.id] = newEl.id;
      results.tilesCreated++;
      console.log(`[recreate] Tile created: old=${el.id} new=${newEl.id} title="${el.title}"`);
    } catch (err) {
      results.tilesFailed++;
      const msg = `Tile "${el.title || el.id}" failed: ${err.message}`;
      results.errors.push(msg);
      console.error(`[recreate] ${msg}`);
    }
  }

  // 2c. Recreate each filter
  for (const filter of filters) {
    try {
      const payload = buildFilterPayload(filter, newDashboard.id, elementIdMap);
      await lookerRequest('POST', '/dashboard_filters', payload);
      results.filtersCreated++;
      console.log(`[recreate] Filter created: "${filter.name}"`);
    } catch (err) {
      results.filtersFailed++;
      const msg = `Filter "${filter.name || filter.id}" failed: ${err.message}`;
      results.errors.push(msg);
      console.error(`[recreate] ${msg}`);
    }
  }

  return results;
}

function buildElementPayload(el, newDashboardId) {
  const payload = {
    dashboard_id: newDashboardId,
    title: el.title || '',
    type: el.type,
    vis_config: el.vis_config || null,
    note_text: el.note_text || null,
    note_display: el.note_display || null,
    note_state: el.note_state || null,
    // Dashboard layout positioning is handled separately via dashboard_layouts;
    // include row/col if the API accepts them at creation time
    row: el.row ?? null,
    col: el.col ?? null,
    width: el.width ?? null,
    height: el.height ?? null,
  };

  // Tile backed by a saved Look
  if (el.look_id) {
    payload.look_id = el.look_id;
  }

  // Tile backed by an inline query
  if (el.query) {
    payload.query = {
      model: el.query.model,
      view: el.query.view,
      fields: el.query.fields || [],
      pivots: el.query.pivots || null,
      fill_fields: el.query.fill_fields || null,
      filters: el.query.filters || null,
      filter_expression: el.query.filter_expression || null,
      sorts: el.query.sorts || null,
      limit: el.query.limit || null,
      column_limit: el.query.column_limit || null,
      total: el.query.total ?? null,
      row_total: el.query.row_total || null,
      subtotals: el.query.subtotals || null,
      vis_config: el.query.vis_config || null,
      dynamic_fields: el.query.dynamic_fields || null,
      query_timezone: el.query.query_timezone || null,
    };
  }

  // Merge tile (text/markdown)
  if (el.body_text !== undefined) {
    payload.body_text = el.body_text;
  }

  return payload;
}

function buildFilterPayload(filter, newDashboardId, elementIdMap) {
  // Remap listens_to_filters to use new element IDs
  const listensTo = (filter.listens_to_filters || []).map((link) => ({
    ...link,
    dashboard_element_id: elementIdMap[link.dashboard_element_id] || link.dashboard_element_id,
  }));

  return {
    dashboard_id: newDashboardId,
    name: filter.name,
    title: filter.title || filter.name,
    type: filter.type,
    default_value: filter.default_value || '',
    model: filter.model || null,
    explore: filter.explore || null,
    dimension: filter.dimension || null,
    row: filter.row ?? null,
    width: filter.width ?? null,
    field: filter.field || null,
    listens_to_filters: listensTo,
    allow_multiple_values: filter.allow_multiple_values ?? null,
    required: filter.required ?? false,
    ui_config: filter.ui_config || null,
  };
}

// ─── Express Routes ────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Fetch dashboard info (preview before recreating)
app.get('/api/dashboard/:id', async (req, res) => {
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
    console.error('[GET /api/dashboard]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recreate dashboard
app.post('/api/recreate', async (req, res) => {
  const { sourceDashboardId, newTitle, targetFolderId } = req.body;

  if (!sourceDashboardId || !newTitle || !targetFolderId) {
    return res.status(400).json({
      error: 'sourceDashboardId, newTitle, and targetFolderId are required',
    });
  }

  try {
    console.log(`[recreate] Fetching source dashboard: ${sourceDashboardId}`);
    const source = await fetchDashboard(sourceDashboardId);

    console.log(
      `[recreate] Source has ${source.elements.length} tiles, ${source.filters.length} filters`
    );

    const results = await recreateDashboard(source, newTitle, targetFolderId);

    console.log(
      `[recreate] Done — tiles: ${results.tilesCreated}/${source.elements.length}, ` +
        `filters: ${results.filtersCreated}/${source.filters.length}`
    );

    res.json(results);
  } catch (err) {
    console.error('[POST /api/recreate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${LOOKER_BASE_URL}`);
});
