// Pulse Pixel — the loader (per-entity pixel injection + consent gate), the
// event collector (whitelist, truncation, unknown entities), install status,
// the integrations slice (applyPatch/view), and the Meta/TikTok audience packs
// (idempotency, partial failure). All platform traffic is stubbed via fetchImpl.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const pixel = require('../server/pixel');

// ── integrations slice ─────────────────────────────────────────────────────────

test('applyPatch writes trimmed pixel fields and normalises consent', () => {
  const got = {};
  pixel.applyPatch({ pixel: { metaPixelId: ' 123 ', googleTagId: 'AW-9', tiktokPixelId: '', consentMode: 'gated' } }, (k, v) => { got[k] = v; });
  assert.deepEqual(got, { pixelMetaId: '123', pixelGoogleId: 'AW-9', pixelTiktokId: '', pixelConsent: 'gated' });
  const got2 = {};
  pixel.applyPatch({ pixel: { consentMode: 'whatever' } }, (k, v) => { got2[k] = v; });
  assert.equal(got2.pixelConsent, 'auto', 'unknown consent modes fall back to auto');
  const got3 = {};
  pixel.applyPatch({}, (k, v) => { got3[k] = v; });
  assert.deepEqual(got3, {}, 'no pixel section → no writes');
});

test('view reports ids + configured flag, never anything secret-shaped', () => {
  const v = pixel.view({ pixelMetaId: '123', pixelGoogleId: '', pixelTiktokId: '', pixelConsent: 'gated' });
  assert.deepEqual(v, { metaPixelId: '123', googleTagId: '', tiktokPixelId: '', consentMode: 'gated', configured: true });
  assert.equal(pixel.view({}).configured, false);
});

// ── harness ────────────────────────────────────────────────────────────────────

function makeHarness({ integrations = {}, entities = ['e1'], metaConn, tiktokConn, responses } = {}) {
  const sqlite = new Database(':memory:');
  const db = {
    db: sqlite,
    getEntity: (id) => (entities.includes(id) ? { id, name: id } : null),
    getEntityIntegrations: (id) => integrations[id] || {},
  };
  const meta = { connection: () => metaConn || { accessToken: '', adAccountId: '' } };
  const tiktok = { connection: () => tiktokConn || { accessToken: '', advertiserId: '' } };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const r = responses ? responses(url, calls.length) : { ok: true, json: { id: `aud_${calls.length}` } };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json };
  };
  const routes = {};
  const capture = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  const auth = {
    requireAdmin: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'admin' })),
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'auth' })),
  };
  const rateLimit = () => (_req, _res, next) => next(); // no-op limiter in tests
  const api = pixel.mount(app, { db, auth, rateLimit, meta, tiktok, fetchImpl });

  async function invoke(key, { params = {}, body = {}, query = {}, user = { id: 'u1', role: 'admin', entityIds: ['e1'] }, headers = {} } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { params, body, query, user, headers, protocol: 'https', get: () => 'pulse.test', ip: '1.2.3.4', on: () => {} };
    const out = { status: 200, body: null, headers: {}, text: null };
    const res = {
      setHeader: (k, v) => { out.headers[k] = v; },
      status: (s) => { out.status = s; return res; },
      json: (b) => { out.body = b; return res; },
      send: (t) => { out.text = t; return res; },
      end: () => res,
    };
    for (const h of handlers) {
      let called = false;
      await h(req, res, () => { called = true; });
      if (!called) break;
    }
    return out;
  }
  return { invoke, sqlite, api, calls };
}

// ── loader ─────────────────────────────────────────────────────────────────────

test('loader inlines the entity config and is public JS', async () => {
  const h = makeHarness({ integrations: { e1: { pixelMetaId: '111', pixelGoogleId: 'AW-22', pixelTiktokId: 'C4A7' } } });
  const out = await h.invoke('GET /px.js', { query: { e: 'e1' }, user: null });
  assert.match(out.headers['Content-Type'], /javascript/);
  assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
  assert.ok(out.text.includes('"m":"111"') && out.text.includes('"g":"AW-22"') && out.text.includes('"t":"C4A7"'), 'pixel ids are inlined');
  assert.ok(out.text.includes('"e":"e1"') && out.text.includes('https://pulse.test'), 'entity + beacon origin inlined');
  assert.ok(out.text.includes("'auto'") || out.text.includes('"auto"'), 'default consent mode is auto');
});

test('loader for an unknown entity is an inert comment, never an error', async () => {
  const h = makeHarness();
  const out = await h.invoke('GET /px.js', { query: { e: 'nope' }, user: null });
  assert.equal(out.status, 200);
  assert.match(out.text, /^\/\* Pulse Pixel/);
});

test('gated consent mode ships the consent gate', async () => {
  const h = makeHarness({ integrations: { e1: { pixelMetaId: '111', pixelConsent: 'gated' } } });
  const out = await h.invoke('GET /px.js', { query: { e: 'e1' }, user: null });
  assert.ok(out.text.includes('"consent":"gated"') && out.text.includes('pulseGrantConsent'), 'gated loader waits for consent');
});

// ── event collection ───────────────────────────────────────────────────────────

test('collector inserts whitelisted events and ignores junk', async () => {
  const h = makeHarness();
  const post = (body) => h.invoke('POST /px', { body, user: null });
  await post({ e: 'e1', ev: 'PageView', url: 'https://site/x', r: 'https://google.com', vid: 'v1' });
  await post({ e: 'e1', ev: 'Purchase', url: 'https://site/done', vid: 'v1', v: '150.5', c: 'EUR' });
  await post({ e: 'e1', ev: 'DropTables' });        // unknown event → dropped
  await post({ e: 'ghost', ev: 'PageView' });        // unknown entity → dropped
  const rows = h.sqlite.prepare('SELECT * FROM pixel_events ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'PageView');
  assert.equal(rows[1].value, 150.5);
  assert.equal(rows[1].currency, 'EUR');
});

test('collector truncates oversized fields', async () => {
  const h = makeHarness();
  await h.invoke('POST /px', { body: { e: 'e1', ev: 'PageView', url: 'x'.repeat(2000), r: 'y'.repeat(2000), vid: 'z'.repeat(200) }, user: null });
  const r = h.sqlite.prepare('SELECT * FROM pixel_events').get();
  assert.equal(r.url.length, 500);
  assert.equal(r.referrer.length, 300);
  assert.equal(r.visitor.length, 64);
});

// ── status ─────────────────────────────────────────────────────────────────────

test('status reports last event + 24h count + 7d breakdown, admin + my surfaces', async () => {
  const h = makeHarness({ integrations: { e1: { pixelMetaId: '111' } } });
  await h.invoke('POST /px', { body: { e: 'e1', ev: 'PageView' }, user: null });
  await h.invoke('POST /px', { body: { e: 'e1', ev: 'Purchase' }, user: null });
  const admin = await h.invoke('GET /api/admin/entities/:id/pixel/status', { params: { id: 'e1' } });
  assert.equal(admin.body.events24h, 2);
  assert.deepEqual(admin.body.events7d, { PageView: 1, Purchase: 1 });
  assert.ok(admin.body.lastEventAt);
  assert.equal(admin.body.metaPixelId, '111');
  const mine = await h.invoke('GET /api/my/pixel/:entityId/status', { params: { entityId: 'e1' }, user: { id: 'u2', role: 'member', entityIds: ['e1'] } });
  assert.equal(mine.body.events24h, 2);
  const foreign = await h.invoke('GET /api/my/pixel/:entityId/status', { params: { entityId: 'e1' }, user: { id: 'u3', role: 'member', entityIds: ['other'] } });
  assert.equal(foreign.status, 403, 'entity ownership is enforced');
});

// ── audience packs ─────────────────────────────────────────────────────────────

test('Meta pack creates the 5 standard audiences and is idempotent', async () => {
  const h = makeHarness({
    integrations: { e1: { pixelMetaId: '111' } },
    metaConn: { accessToken: 'tok', adAccountId: 'act_1' },
  });
  const r1 = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.equal(r1.body.created, pixel.PACK.length);
  assert.equal(r1.body.errors, 0);
  assert.equal(h.calls.length, pixel.PACK.length, 'one Graph call per audience');
  // Every call targets the ad account's customaudiences edge with a WEBSITE rule on the pixel.
  for (const c of h.calls) {
    assert.match(c.url, /act_1\/customaudiences/);
    assert.equal(c.body.subtype, 'WEBSITE');
    assert.ok(c.body.rule.includes('"id":"111"'), 'rule targets the configured pixel');
  }
  // Abandoners carry an exclusion (Purchase), plain packs don't.
  const abandoners = h.calls.find((c) => c.body.name.includes('no purchase'));
  assert.ok(abandoners.body.rule.includes('exclusions') && abandoners.body.rule.includes('Purchase'));
  // Re-click: nothing new is created.
  const r2 = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.equal(r2.body.created, 0);
  assert.equal(r2.body.existed, pixel.PACK.length);
  assert.equal(h.calls.length, pixel.PACK.length, 'no extra API calls on re-click');
});

test('Meta pack fails clearly when pixel id or connection is missing', async () => {
  const noPixel = makeHarness({ metaConn: { accessToken: 'tok', adAccountId: 'act_1' } });
  const r1 = await noPixel.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.match(r1.body.error, /Pixel ID/i);
  const noConn = makeHarness({ integrations: { e1: { pixelMetaId: '111' } } });
  const r2 = await noConn.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.match(r2.body.error, /not connected/i);
});

test('a partially failing Meta pack records errors and retries only the failures', async () => {
  let n = 0;
  const h = makeHarness({
    integrations: { e1: { pixelMetaId: '111' } },
    metaConn: { accessToken: 'tok', adAccountId: 'act_1' },
    responses: () => { n++; return n === 2 ? { ok: false, status: 400, json: { error: { message: 'rule rejected' } } } : { json: { id: `aud_${n}` } }; },
  });
  const r1 = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.equal(r1.body.errors, 1);
  assert.equal(r1.body.created, pixel.PACK.length - 1);
  const r2 = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'meta' } });
  assert.equal(r2.body.created, 1, 'only the failed audience is retried');
  assert.equal(r2.body.existed, pixel.PACK.length - 1);
});

test('TikTok pack hits the rule endpoint and respects code!==0 errors', async () => {
  const h = makeHarness({
    integrations: { e1: { pixelTiktokId: 'C4A7' } },
    tiktokConn: { accessToken: 'tok', advertiserId: 'adv1' },
    responses: (url, i) => ({ json: i === 1 ? { code: 40001, message: 'bad rule' } : { code: 0, data: { custom_audience_id: `tt_${i}` } } }),
  });
  const r = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'tiktok' } });
  assert.equal(r.body.errors, 1);
  assert.equal(r.body.created, pixel.PACK.length - 1);
  assert.match(h.calls[0].url, /dmp\/custom_audience\/rule\/create/);
  assert.equal(h.calls[0].body.advertiser_id, 'adv1');
  // Purchase maps to TikTok's CompletePayment in the purchasers rule.
  const purchasers = h.calls.find((c) => c.body.custom_audience_name.includes('Purchasers'));
  assert.ok(JSON.stringify(purchasers.body.rule_spec).includes('CompletePayment'));
});

test('unknown channel and unknown entity are rejected', async () => {
  const h = makeHarness();
  const bad = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'e1' }, body: { channel: 'google' } });
  assert.match(bad.body.error, /Unknown channel/);
  const ghost = await h.invoke('POST /api/admin/entities/:id/pixel/audiences', { params: { id: 'ghost' }, body: { channel: 'meta' } });
  assert.equal(ghost.status, 404);
});
