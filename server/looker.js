// ─── Looker API client ───────────────────────────────────────────────────────
// Thin wrapper around the Looker 4.0 REST API: auth + token cache, a generic
// request helper, dashboard fetching/query-resolution, and LookML metadata
// browsing. Looker is used purely as a headless calculation engine — no embeds.

const fetch = require('node-fetch');

const LOOKER_BASE_URL = process.env.LOOKER_BASE_URL?.replace(/\/$/, '');
const API_BASE = `${LOOKER_BASE_URL}/api/4.0`;

// ─── Token Cache ────────────────────────────────────────────────────────────

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
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
  console.log('[auth] Obtained new Looker access token');
  return tokenCache.token;
}

// ─── Generic request helper (auto-refresh on 401) ────────────────────────────

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

// ─── Dashboard fetch + query resolution ──────────────────────────────────────

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

// Resolve the full query body for elements that don't carry it inline.
async function resolveElementQueries(elements) {
  await Promise.all(elements.map(async (el) => {
    if (el.type === 'text') return;
    const q = el.result_maker?.query || el.query;
    if (q?.model) return;

    try {
      if (el.result_maker_id) {
        const rm = await lookerRequest('GET', `/result_makers/${el.result_maker_id}`);
        el._resolvedQuery = rm.query;
      } else if (el.query_id) {
        el._resolvedQuery = await lookerRequest('GET', `/queries/${el.query_id}`);
      } else if (el.look_id) {
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

// Normalise a Looker query object down to a runnable inline-query body.
function extractQueryFromElement(el) {
  if (el.type === 'text') return null;
  const q = el._resolvedQuery || el.result_maker?.query || el.query;
  return normalizeQuery(q);
}

function normalizeQuery(q) {
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

// ─── LookML metadata (for building tiles from scratch) ────────────────────────

// List all LookML models and their explores (name + label only).
async function listModels() {
  const models = await lookerRequest('GET', '/lookml_models?fields=name,label,explores(name,label,description,hidden)');
  return (models || []).map((m) => ({
    name: m.name,
    label: m.label || m.name,
    explores: (m.explores || [])
      .filter((e) => !e.hidden)
      .map((e) => ({ name: e.name, label: e.label || e.name, description: e.description || '' })),
  }));
}

// Fields (dimensions + measures) for a single explore.
async function getExploreFields(model, explore) {
  const data = await lookerRequest(
    'GET',
    `/lookml_models/${encodeURIComponent(model)}/explores/${encodeURIComponent(explore)}?fields=fields(dimensions(name,label,label_short,type,description,hidden,group_label),measures(name,label,label_short,type,description,hidden,group_label))`
  );
  const f = data.fields || {};
  const pick = (arr) =>
    (arr || [])
      .filter((x) => !x.hidden)
      .map((x) => ({
        name: x.name,
        label: x.label || x.name,
        label_short: x.label_short || x.label || x.name,
        type: x.type,
        description: x.description || '',
        group_label: x.group_label || '',
      }));
  return { dimensions: pick(f.dimensions), measures: pick(f.measures) };
}

module.exports = {
  LOOKER_BASE_URL,
  lookerRequest,
  fetchDashboard,
  resolveElementQueries,
  extractQueryFromElement,
  normalizeQuery,
  listModels,
  getExploreFields,
};
