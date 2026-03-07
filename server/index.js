require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Serve built React app (client/dist) if it exists, otherwise raw client/
const clientDist = path.join(__dirname, '../client/dist');
const clientFallback = path.join(__dirname, '../client');
const staticDir = fs.existsSync(clientDist) ? clientDist : clientFallback;
app.use(express.static(staticDir));

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

// Fields to request when fetching elements — includes nested query for viewer
const ELEMENT_FIELDS = [
  'id', 'type', 'title', 'body_text', 'vis_config',
  'row', 'col', 'width', 'height',
  'look_id', 'query_id', 'result_maker_id',
  'result_maker(query(id,model,view,fields,pivots,fill_fields,filters,filter_expression,sorts,limit,column_limit,total,row_total,dynamic_fields,query_timezone))',
  'query(id,model,view,fields,pivots,fill_fields,filters,filter_expression,sorts,limit,column_limit,total,row_total,dynamic_fields,query_timezone)',
  'note_text', 'note_display', 'note_state',
].join(',');

async function fetchDashboard(dashboardId) {
  const [dashboard, elements, filters] = await Promise.all([
    lookerRequest('GET', `/dashboards/${dashboardId}`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_elements?fields=${encodeURIComponent(ELEMENT_FIELDS)}`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_filters`),
  ]);
  return { dashboard, elements, filters };
}

// Resolve the full query body for elements that don't have it inline.
// Handles result_maker_id, query_id, and look_id tiles.
async function resolveElementQueries(elements) {
  await Promise.all(elements.map(async (el) => {
    if (el.type === 'text') return;

    // Already have a full query inline
    const q = el.result_maker?.query || el.query;
    if (q?.model) return;

    try {
      if (el.result_maker_id) {
        // Fetch the result_maker to get its query
        const rm = await lookerRequest('GET', `/result_makers/${el.result_maker_id}`);
        el._resolvedQuery = rm.query;
      } else if (el.query_id) {
        el._resolvedQuery = await lookerRequest('GET', `/queries/${el.query_id}`);
      } else if (el.look_id) {
        // Look → query_id → query
        const look = await lookerRequest('GET', `/looks/${el.look_id}`);
        if (look.query_id) {
          el._resolvedQuery = await lookerRequest('GET', `/queries/${look.query_id}`);
        } else if (look.query) {
          el._resolvedQuery = look.query;
        }
      }
    } catch (err) {
      console.warn(`[view] Could not resolve query for element "${el.title}" (${el.id}): ${err.message}`);
    }
  }));
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
      // DEBUG: log what fields this element has
      console.log(`[debug] Element "${el.title}" type=${el.type} look_id=${el.look_id} query_id=${el.query_id} result_maker_id=${el.result_maker_id} has_query=${!!el.query} has_result_maker=${!!el.result_maker} result_maker_query=${!!(el.result_maker && el.result_maker.query)}`);
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
    row: el.row ?? null,
    col: el.col ?? null,
    width: el.width ?? null,
    height: el.height ?? null,
  };

  // Text/markdown tile — no query needed
  if (el.type === 'text') {
    payload.body_text = el.body_text || '';
    return payload;
  }

  // Look-backed tile
  if (el.look_id) {
    payload.look_id = el.look_id;
    return payload;
  }

  // result_maker_id — most reliable for modern dashboards (numeric ID)
  if (el.result_maker_id) {
    payload.result_maker_id = el.result_maker_id;
    return payload;
  }

  // Fallback: use the numeric query id (el.query.id, not the slug)
  const queryId = el.result_maker?.query?.id || el.query?.id;
  if (queryId) {
    payload.query_id = queryId;
    return payload;
  }

  // Plain text body (non-type=text tiles with body content)
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

// ─── Dashboard Viewer API ──────────────────────────────────────────────────────

// Extract query body from a dashboard element's result_maker or query field.
// Falls back to el._resolvedQuery set by resolveElementQueries().
function extractQueryFromElement(el) {
  if (el.type === 'text') return null;
  const q = el._resolvedQuery || el.result_maker?.query || el.query;
  if (!q?.model) return null; // unusable without at least model+view
  return {
    model: q.model,
    view: q.view,
    fields: q.fields || [],
    pivots: q.pivots || null,
    fill_fields: q.fill_fields || null,
    filters: q.filters || null,
    filter_expression: q.filter_expression || null,
    sorts: q.sorts || null,
    limit: q.limit || '500',
    column_limit: q.column_limit || null,
    total: q.total ?? null,
    row_total: q.row_total || null,
    dynamic_fields: q.dynamic_fields || null,
    query_timezone: q.query_timezone || null,
  };
}

// Full dashboard definition for the viewer (layout + queries + filters)
app.get('/api/dashboard/:id/view', async (req, res) => {
  try {
    const { dashboard, elements, filters } = await fetchDashboard(req.params.id);

    // Ensure every vis tile has a full query body (fetches missing ones from API)
    await resolveElementQueries(elements);

    const withQuery = elements.filter(el => el.type === 'text' || extractQueryFromElement(el));
    const missing = elements.length - withQuery.length;
    if (missing > 0) {
      console.warn(`[view] ${missing}/${elements.length} tiles have no resolvable query`);
    }
    console.log(`[view] Dashboard ${dashboard.id}: ${elements.length} tiles, ${filters.length} filters, ${missing} without query`);

    // Build per-element filter map: elementId -> { filterName -> queryField }
    const elementFilterMap = {};
    for (const filter of filters) {
      for (const link of filter.listens_to_filters || []) {
        if (!elementFilterMap[link.dashboard_element_id]) {
          elementFilterMap[link.dashboard_element_id] = {};
        }
        elementFilterMap[link.dashboard_element_id][filter.name] =
          link.field || filter.dimension;
      }
    }

    const tiles = elements.map((el) => ({
      id: el.id,
      type: el.type,
      title: el.title || '',
      body_text: el.body_text || '',
      vis_config: el.vis_config || {},
      row: el.row ?? 0,
      col: el.col ?? 0,
      width: el.width ?? 8,
      height: el.height ?? 4,
      query: extractQueryFromElement(el),
      filterMap: elementFilterMap[el.id] || {},
    }));

    res.json({
      id: dashboard.id,
      title: dashboard.title,
      tiles,
      filters: filters.map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title || f.name,
        type: f.type,
        default_value: f.default_value || '',
        model: f.model,
        explore: f.explore,
        dimension: f.dimension,
        ui_config: f.ui_config || {},
        allow_multiple_values: f.allow_multiple_values ?? false,
      })),
    });
  } catch (err) {
    console.error('[GET /api/dashboard/view]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Run a Looker query with optional filter overrides, returns json_detail format
app.post('/api/run-query', async (req, res) => {
  try {
    const { query, filterOverrides = {} } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const queryBody = {
      ...query,
      filters: { ...(query.filters || {}), ...filterOverrides },
    };

    const data = await lookerRequest('POST', '/queries/run/json_detail', queryBody);
    res.json(data);
  } catch (err) {
    console.error('[POST /api/run-query]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Filter value suggestions from Looker
app.post('/api/filter-suggest', async (req, res) => {
  try {
    const { model, explore, field } = req.body;
    const data = await lookerRequest(
      'GET',
      `/looks/model/explore/fields?model_name=${encodeURIComponent(model)}&explore_name=${encodeURIComponent(explore)}&field_names=${encodeURIComponent(field)}&limit=100`
    );
    // Fall back to empty — suggest endpoint varies by Looker version
    res.json({ suggestions: data?.suggest_dimension?.suggestions || [] });
  } catch (_) {
    res.json({ suggestions: [] });
  }
});

// SPA fallback — must be after all API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${LOOKER_BASE_URL}`);
});
