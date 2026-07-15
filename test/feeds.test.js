// PostHog warehouse bridge feed — token auth (timing-safe, write-only), the
// fail-closed organiser allowlist, Looker query shape (email included by
// decision, organiser filter, ascending created-time), row mapping, the
// incremental `since` cursor, and the once-only token generation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const feeds = require('../server/feeds');

function makeHarness({ lookerRows = [], dashboards = [{ id: 'd1', filters: [{ field: 'core_events.name', model: 'howler', explore: 'tickets' }] }] } = {}) {
  const settings = {};
  const db = {
    getSetting: (k, d = '') => (k in settings ? settings[k] : d),
    setSetting: (k, v) => { settings[k] = v; },
    listDashboards: () => dashboards,
    getDashboard: (id) => dashboards.find((d) => d.id === id) || null,
  };
  const auth = { requireAdmin: (q, s, n) => (q.user?.role === 'admin' ? n() : s.status(403).json({ error: 'admin' })) };
  const lookerCalls = [];
  const runLookerQuery = async (path, q) => { lookerCalls.push(q); return lookerRows; };
  const routes = {};
  const capture = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  const api = feeds.mount(app, { db, auth, runLookerQuery });
  async function invoke(key, { headers = {}, query = {}, body = {}, user } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { headers, query, body, user };
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    for (const h of handlers) {
      let nexted = false;
      await h(req, res, (e) => { nexted = !e; if (e) { out.status = e.status || 500; out.body = { error: e.message }; } });
      if (!nexted) break;
    }
    return out;
  }
  return { api, settings, invoke, lookerCalls };
}

const ROW = {
  'core_orders.id': 9001, 'core_orders.created_time': '2026-07-10 14:03:00', 'core_orders.status': 'completed',
  'core_events.id': 39450, 'core_events.name': 'Winter Fest', 'core_events.currency': 'ZAR',
  'core_purchasers.email': 'fan@example.com', 'core_tickets.sum_revenue_decimal': 850,
};

test('feed: token is required and timing-safe; allowlist fails closed', async () => {
  const h = makeHarness({ lookerRows: [ROW] });
  const noToken = await h.invoke('GET /api/feeds/orders');
  assert.equal(noToken.status, 401);
  h.settings.posthog_feed_token = 'hfeed_secret';
  const wrong = await h.invoke('GET /api/feeds/orders', { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const noOrgs = await h.invoke('GET /api/feeds/orders', { headers: { authorization: 'Bearer hfeed_secret' } });
  assert.equal(noOrgs.status, 403, 'an empty allowlist serves nothing');
  assert.equal(h.lookerCalls.length, 0, 'Looker is never queried without an allowlist');
});

test('feed: serves mapped order rows for allowlisted organisers, email included', async () => {
  const h = makeHarness({ lookerRows: [ROW] });
  h.settings.posthog_feed_token = 'hfeed_secret';
  h.settings.posthog_feed_orgs = JSON.stringify(['G&G Productions']);
  const out = await h.invoke('GET /api/feeds/orders', { headers: { authorization: 'Bearer hfeed_secret' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.orders[0], {
    order_id: '9001', created_at: '2026-07-10 14:03:00', status: 'completed',
    event_id: '39450', event_name: 'Winter Fest', currency: 'ZAR', email: 'fan@example.com', amount: 850,
  });
  assert.equal(out.body.nextSince, null, 'a short page ends the sweep');
  const q = h.lookerCalls[0];
  assert.equal(q.filters['core_organisers.name'], 'G&G Productions', 'only allowlisted organisers');
  assert.deepEqual(q.sorts, ['core_orders.created_time'], 'ascending time — cursorable');
  assert.ok(q.fields.includes('core_purchasers.email'), 'email rides (PostHog person join key)');
});

test('feed: incremental since cursor validates and reaches the query; full page hands back nextSince', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ ...ROW, 'core_orders.id': 9001 + i, 'core_orders.created_time': `2026-07-10 14:0${i}:00` }));
  const h = makeHarness({ lookerRows: rows });
  h.settings.posthog_feed_token = 't';
  h.settings.posthog_feed_orgs = JSON.stringify(['G&G Productions']);
  const out = await h.invoke('GET /api/feeds/orders', { headers: { authorization: 'Bearer t' }, query: { since: '2026-07-01', limit: '3' } });
  assert.equal(out.status, 200);
  assert.equal(h.lookerCalls[0].filters['core_orders.created_time'], 'after 2026-07-01');
  assert.equal(out.body.nextSince, '2026-07-10 14:02:00', 'a full page points at the boundary');
  const bad = await h.invoke('GET /api/feeds/orders', { headers: { authorization: 'Bearer t' }, query: { since: '1 OR 1=1' } });
  assert.equal(bad.status, 400, 'junk cursors are rejected, never interpolated');
});

test('feed admin: token generated once + write-only; allowlist round-trips; preview masks emails', async () => {
  const h = makeHarness({ lookerRows: [ROW] });
  const admin = { user: { role: 'admin' } };
  const gen = await h.invoke('POST /api/admin/feeds/token', admin);
  assert.equal(gen.status, 200);
  assert.match(gen.body.token, /^hfeed_/);
  assert.equal(h.settings.posthog_feed_token, gen.body.token);
  const put = await h.invoke('PUT /api/admin/feeds/settings', { ...admin, body: { orgs: ' G&G Productions \n\nUltra SA ' } });
  assert.equal(put.status, 200);
  const got = await h.invoke('GET /api/admin/feeds/settings', admin);
  assert.deepEqual(got.body.orgs, ['G&G Productions', 'Ultra SA']);
  assert.equal(got.body.tokenSet, true);
  assert.ok(!JSON.stringify(got.body).includes(gen.body.token), 'the token is never echoed back');
  const prev = await h.invoke('GET /api/admin/feeds/preview', admin);
  assert.equal(prev.status, 200);
  assert.ok(!JSON.stringify(prev.body).includes('fan@example.com'), 'preview masks emails');
  const denied = await h.invoke('GET /api/admin/feeds/preview', { user: { role: 'member' } });
  assert.equal(denied.status, 403);
});
