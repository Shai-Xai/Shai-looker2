// Meta paid-performance connector — insight parsing (purchases + values), daily
// upsert sync, the report rollup (CPC / cost-per-purchase / ROAS), entity route
// scoping, the once-a-day tick guard, and the getPaidPerformance Owl tool.
// Graph traffic is stubbed via fetchImpl — no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const metaAds = require('../server/metaAds');
const createOwlTools = require('../server/owlTools');

test('pickPurchase prefers omni_purchase and falls back to pixel purchase', () => {
  assert.equal(metaAds.pickPurchase([{ action_type: 'link_click', value: '9' }, { action_type: 'omni_purchase', value: '4' }, { action_type: 'purchase', value: '99' }]), 4);
  assert.equal(metaAds.pickPurchase([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '7' }]), 7);
  assert.equal(metaAds.pickPurchase([]), 0);
  assert.equal(metaAds.pickPurchase(undefined), 0);
});

test('rowFromInsight maps fields and prefers inline link clicks', () => {
  const r = metaAds.rowFromInsight({
    date_start: '2026-06-30', campaign_id: 'c1', campaign_name: 'VIP push', spend: '120.5',
    impressions: '10000', clicks: '400', inline_link_clicks: '250', reach: '8000',
    actions: [{ action_type: 'omni_purchase', value: '12' }],
    action_values: [{ action_type: 'omni_purchase', value: '3600' }],
    account_currency: 'EUR',
  });
  assert.equal(r.spend, 120.5);
  assert.equal(r.clicks, 250, 'inline link clicks win over raw clicks');
  assert.equal(r.purchases, 12);
  assert.equal(r.purchaseValue, 3600);
  assert.equal(r.currency, 'EUR');
});

// ── harness ─────────────────────────────────────────────────────────────────────

function makeHarness({ pages, entities = [{ id: 'e1' }], configured = ['e1'] } = {}) {
  const sqlite = new Database(':memory:');
  const settings = {};
  const db = {
    db: sqlite,
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    setSetting: (k, v) => { settings[k] = v; },
    listEntities: () => entities,
  };
  const meta = {
    connection: (id) => (configured.includes(id) ? { accessToken: 'tok', adAccountId: 'act_1' } : { accessToken: '', adAccountId: '' }),
    isConfigured: (id) => configured.includes(id),
  };
  let call = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => (pages ? pages[Math.min(call++, pages.length - 1)] : { data: [] }) });
  const routes = {};
  const capture = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  const auth = { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => (q.user?.role === 'admin' ? n() : s.status(403).json({ error: 'admin' })) };
  const api = metaAds.mount(app, { db, auth, meta, fetchImpl, startTimer: false });
  async function invoke(key, { params = {}, body = {}, query = {}, user = { id: 'u1', role: 'member', entityIds: ['e1'] } } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { params, body, query, user };
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    for (const h of handlers) { let nexted = false; await h(req, res, () => { nexted = true; }); if (!nexted) break; }
    return out;
  }
  return { api, db, sqlite, invoke, settings };
}

const today = new Date().toISOString().slice(0, 10);
const INSIGHT = (over = {}) => ({
  date_start: today, campaign_id: 'c1', campaign_name: 'VIP push', spend: '100', impressions: '5000',
  clicks: '300', inline_link_clicks: '200', reach: '4000',
  actions: [{ action_type: 'omni_purchase', value: '10' }],
  action_values: [{ action_type: 'omni_purchase', value: '2500' }],
  account_currency: 'ZAR', ...over,
});

test('syncEntity upserts paged insights and report rolls up CPC/cost-per-purchase/ROAS', async () => {
  const h = makeHarness({ pages: [
    { data: [INSIGHT(), INSIGHT({ campaign_id: 'c2', campaign_name: 'Earlybird', spend: '50', inline_link_clicks: '100', actions: [], action_values: [] })], paging: { next: 'https://graph.facebook.com/page2' } },
    { data: [INSIGHT({ date_start: '2026-06-30', spend: '25' })] },
  ] });
  const r = await h.api.syncEntity('e1');
  assert.equal(r.ok, true);
  assert.equal(r.rows, 3);
  // re-sync updates in place (PK entity+date+campaign), no duplicates
  await h.api.syncEntity('e1');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM meta_ad_insights').get().n, 3);
  const rep = h.api.report('e1', 28);
  assert.equal(rep.currency, 'ZAR');
  assert.equal(rep.totals.spend, 175);
  assert.equal(rep.totals.purchases, 20);
  assert.equal(rep.totals.roas, +(5000 / 175).toFixed(2));
  const vip = rep.campaigns.find((c) => c.campaignId === 'c1');
  assert.equal(vip.spend, 125);
  assert.equal(vip.cpc, +(125 / 400).toFixed(2));
  assert.equal(vip.costPerPurchase, +(125 / 20).toFixed(2));
  const early = rep.campaigns.find((c) => c.campaignId === 'c2');
  assert.equal(early.roas, null, 'no purchase value → no ROAS, never invented');
  assert.equal(rep.series.length, 2);
});

test('sync fails cleanly when Meta is not connected; routes enforce entity scope', async () => {
  const h = makeHarness({ configured: [] });
  const r = await h.api.syncEntity('e1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_configured');
  const h2 = makeHarness({});
  const stranger = await h2.invoke('GET /api/my/meta-ads/:entityId', { params: { entityId: 'e1' }, user: { id: 'x', role: 'member', entityIds: ['e2'] } });
  assert.equal(stranger.status, 403);
  const own = await h2.invoke('GET /api/my/meta-ads/:entityId', { params: { entityId: 'e1' } });
  assert.equal(own.status, 200);
  assert.equal(own.body.configured, true);
});

test('the tick refreshes configured clients once per day and honours the kill switch', async () => {
  const h = makeHarness({ pages: [{ data: [INSIGHT()] }] });
  await h.api.tick();
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM meta_ad_insights').get().n, 1);
  h.sqlite.prepare('DELETE FROM meta_ad_insights').run();
  await h.api.tick(); // same day → guarded, no re-pull
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM meta_ad_insights').get().n, 0);
  const h3 = makeHarness({ pages: [{ data: [INSIGHT()] }] });
  h3.settings.meta_ads_sync_enabled = '0';
  await h3.api.tick();
  assert.equal(h3.sqlite.prepare('SELECT COUNT(*) n FROM meta_ad_insights').get().n, 0, 'kill switch respected');
});

test('getPaidPerformance tool: refuses without a client, reports when configured, honest when empty', async () => {
  const h = makeHarness({ pages: [{ data: [INSIGHT()] }] });
  await h.api.syncEntity('e1');
  const t = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, getMetaAdsApi: () => h.api });
  const noClient = await t.getPaidPerformance.run({}, { user: { id: 'u1' } });
  assert.equal(noClient.reason, 'no_client');
  const res = await t.getPaidPerformance.run({ days: 28 }, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(res.ok, true);
  assert.equal(res.totals.spend, 100);
  assert.equal(res.campaigns[0].name, 'VIP push');
  assert.match(res.note, /purchase value ÷ spend/);
  const h2 = makeHarness({ configured: [] });
  const t2 = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, getMetaAdsApi: () => h2.api });
  const nc = await t2.getPaidPerformance.run({}, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(nc.reason, 'not_configured');
});
