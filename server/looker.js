// ─── Looker API client ───────────────────────────────────────────────────────
// Thin wrapper around the Looker 4.0 REST API: auth + token cache, a generic
// request helper, dashboard fetching/query-resolution, and LookML metadata
// browsing. Looker is used purely as a headless calculation engine — no embeds.

const db = require('./db');

// The primary Looker account is configurable in Admin → Integrations (stored in
// the DB) and falls back to the .env values. Resolved fresh per request so an
// admin edit takes effect without a restart.
function creds() {
  const baseUrl = (db.getSetting('looker_base_url') || process.env.LOOKER_BASE_URL || '').replace(/\/$/, '');
  const clientId = db.getSetting('looker_client_id') || process.env.LOOKER_CLIENT_ID || '';
  const clientSecret = db.getSetting('looker_client_secret') || process.env.LOOKER_CLIENT_SECRET || '';
  return { baseUrl, clientId, clientSecret, apiBase: `${baseUrl}/api/4.0` };
}
function isConfigured() {
  const c = creds();
  return !!(c.baseUrl && c.clientId && c.clientSecret);
}

// ─── Token Cache (keyed by account so changing creds re-authenticates) ────────

const tokenCacheByKey = new Map();   // key -> { token, expiresAt }
const tokenPromiseByKey = new Map(); // key -> in-flight login promise

async function getAccessToken() {
  const { apiBase, clientId, clientSecret, baseUrl } = creds();
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error('Looker is not configured. Set the primary Looker account in Admin → Integrations (or .env).');
  }
  const key = `${baseUrl}|${clientId}`;
  const cached = tokenCacheByKey.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (tokenPromiseByKey.has(key)) return tokenPromiseByKey.get(key);

  const p = (async () => {
    const res = await fetch(`${apiBase}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Looker auth failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    tokenCacheByKey.set(key, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 30) * 1000 });
    console.log('[auth] Obtained new Looker access token');
    return data.access_token;
  })().finally(() => { tokenPromiseByKey.delete(key); });

  tokenPromiseByKey.set(key, p);
  return p;
}

// ─── Generic request helper (auto-refresh on 401) ────────────────────────────

// Cap concurrent outbound Looker requests so a traffic spike (many clients
// loading dashboards at once) can't exceed Looker's query concurrency — excess
// requests queue here instead of failing. Tune with LOOKER_MAX_CONCURRENCY.
const LOOKER_MAX = Number(process.env.LOOKER_MAX_CONCURRENCY) || 8;
let activeRequests = 0;
const requestQueue = [];
function acquireSlot() {
  if (activeRequests < LOOKER_MAX) { activeRequests++; return Promise.resolve(); }
  return new Promise((resolve) => requestQueue.push(resolve)).then(() => { activeRequests++; });
}
function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = requestQueue.shift();
  if (next) next();
}

// Public entry point: gate one concurrency slot, then run (with 401-retry inside).
async function lookerRequest(method, path, body = null) {
  await acquireSlot();
  try {
    return await _request(method, path, body, true);
  } finally {
    releaseSlot();
  }
}

async function _request(method, path, body = null, retry = true) {
  const token = await getAccessToken();
  const { apiBase, baseUrl, clientId } = creds();

  const options = {
    method,
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(120000), // fail a stuck query after 2 min instead of hanging forever
  };
  if (body) options.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${apiBase}${path}`, options);
  } catch (err) {
    if (err.type === 'request-timeout') {
      throw new Error(`Looker request timed out after 120s (${method} ${path}) — the query may be too slow or Looker is overloaded.`);
    }
    throw err;
  }

  if (res.status === 401 && retry) {
    console.log('[auth] Token expired, refreshing...');
    tokenCacheByKey.delete(`${baseUrl}|${clientId}`);
    return _request(method, path, body, false); // same concurrency slot
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Looker API ${method} ${path} failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  try {
    return contentType.includes('application/json') ? await res.json() : await res.text();
  } catch (e) {
    // A huge result (millions of rows / json_detail bloat) can exceed Node's max
    // string length while reading the body — surface a fixable message instead.
    if (/string longer than/i.test(e?.message || '')) throw new Error(`Looker result too large to load (${method} ${path}) — narrow the query's filters or lower its row limit.`);
    throw e;
  }
}

// ─── Dashboard fetch + query resolution ──────────────────────────────────────

const ELEMENT_FIELDS = [
  'id', 'type', 'title', 'body_text', 'rich_content_json', 'vis_config',
  'row', 'col', 'width', 'height',
  'look_id', 'query_id', 'result_maker_id',
  'result_maker(vis_config,filterables(listen(dashboard_filter_name,field)),query(id,model,view,fields,pivots,fill_fields,filters,filter_expression,sorts,limit,column_limit,total,row_total,dynamic_fields,query_timezone,vis_config))',
  'query(id,model,view,fields,pivots,fill_fields,filters,filter_expression,sorts,limit,column_limit,total,row_total,dynamic_fields,query_timezone,vis_config)',
  'note_text', 'note_display', 'note_state',
].join(',');

async function fetchDashboard(dashboardId) {
  const [dashboard, elements, filters, layouts] = await Promise.all([
    lookerRequest('GET', `/dashboards/${dashboardId}`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_elements?fields=${encodeURIComponent(ELEMENT_FIELDS)}`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_filters`),
    lookerRequest('GET', `/dashboards/${dashboardId}/dashboard_layouts`).catch(() => []),
  ]);
  return { dashboard, elements, filters, layouts };
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

// Find a tile's visualization config. On this Looker version it lives on the
// result_maker (or its query), not on the dashboard element itself.
function extractVisFromElement(el) {
  return (
    el.vis_config ||
    el.result_maker?.vis_config ||
    el.result_maker?.query?.vis_config ||
    el.query?.vis_config ||
    el._resolvedQuery?.vis_config ||
    { type: 'looker_column' }
  );
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
  lookerRequest,
  fetchDashboard,
  resolveElementQueries,
  extractQueryFromElement,
  extractVisFromElement,
  normalizeQuery,
  listModels,
  getExploreFields,
  isConfigured,
  creds,
  lookerBaseUrl: () => creds().baseUrl,
};
