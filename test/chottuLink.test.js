// ChottuLink deep links (server/chottuLink.js) over real HTTP: credential
// layering (platform key → client override), link create/update/status against
// a mocked upstream, import upsert keeping Pulse-side fields, stats refresh,
// tenancy (a client can never touch another client's links) and permission
// gates. The upstream API is stubbed at global.fetch — only api2.chottulink.com
// calls are intercepted; the test harness's own local HTTP passes through.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');
const rateLimit = require('../server/ratelimit');

let app, chottu, entityA, entityB, suiteA, admin, ownerA, viewerA, ownerB;

// ── upstream mock ──
const upstream = { calls: [], nextLinks: [], failCreateWith: null };
const realFetch = global.fetch;
function mockUpstream() {
  global.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api2.chottulink.com')) return realFetch(url, opts);
    const path = String(url).replace('https://api2.chottulink.com/chotuCore/pa/v1', '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    upstream.calls.push({ path, method: opts.method || 'GET', body, key: opts.headers['API-KEY'] });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (path === '/create-link') {
      if (upstream.failCreateWith) return json(400, { code: 101, error: { errorMessage: upstream.failCreateWith } });
      return json(201, { status: 'success', short_url: `https://${body.domain}/${body.selected_path || 'auto123'}` });
    }
    if (path === '/links/info') return json(200, { id: `ext-${body.shortUrl.split('/').pop()}`, short_url: body.shortUrl, is_enabled: true });
    if (path.startsWith('/links/page')) return json(200, { links: upstream.nextLinks, pagination: { total_pages: 1, total_items: upstream.nextLinks.length } });
    if (path.startsWith('/update-link/')) return json(200, { status: 'success' });
    if (path.startsWith('/links/change-status/')) return json(200, { status: 'success' });
    if (path === '/analytics') return json(200, { total_clicks: 42, clicks_last_7_days: 7, clicks_last_30_days: 30 });
    return json(404, {});
  };
}

before(async () => {
  entityA = h.makeEntity('Client A', 'Org A');
  entityB = h.makeEntity('Client B', 'Org B');
  suiteA = h.db.createSuite({ entityId: entityA.id, name: 'Festival A 2026' });
  admin = h.makeAdmin();
  ownerA = h.makeClient('owner-a@test.local', [entityA.id], 'owner');
  viewerA = h.makeClient('viewer-a@test.local', [entityA.id], 'viewer'); // no campaigns.approve
  ownerB = h.makeClient('owner-b@test.local', [entityB.id], 'owner');
  h.db.setSetting('chottu_api_key', 'c_api_platform_key');
  h.db.setSetting('chottu_domain', 'howler.chottu.link');
  mockUpstream();
  app = await startApp((a) => {
    chottu = require('../server/chottuLink').mount(a, { db: h.db, auth: h.auth, rateLimit });
    a.use(require('../server/http').errorMiddleware);
  });
});
after(async () => { global.fetch = realFetch; await app.close(); });

test('credentials layer: platform default, client override wins', () => {
  assert.deepEqual(chottu.configFor(entityA.id), { key: 'c_api_platform_key', domain: 'howler.chottu.link', source: 'platform' });
  h.db.setEntityIntegrations(entityB.id, { chottuApiKey: 'c_api_client_b', chottuDomain: 'b.chottu.link' });
  assert.deepEqual(chottu.configFor(entityB.id), { key: 'c_api_client_b', domain: 'b.chottu.link', source: 'client' });
});

test('client owner creates a link — upstream called with the platform key, UTMs cleaned, row stored', async () => {
  const r = await app.req('POST', `/api/my/chottu/${entityA.id}/links`, {
    as: ownerA,
    body: { linkName: 'Tickets — IG', destinationUrl: 'https://howler.co.za/event/1', path: 'fest-a-ig', suiteId: suiteA.id, utm: { source: 'instagram', medium: '', junk: 'x' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.link.shortUrl, 'https://howler.chottu.link/fest-a-ig');
  assert.equal(r.body.link.suiteId, suiteA.id);
  assert.deepEqual(r.body.link.utm, { source: 'instagram' }); // blank + unknown keys dropped
  const create = upstream.calls.find((c) => c.path === '/create-link');
  assert.equal(create.key, 'c_api_platform_key');
  assert.equal(create.body.utm_source, 'instagram');
  // The list carries it, and never exposes the API key anywhere.
  const list = await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA });
  assert.equal(list.body.links.length, 1);
  assert.ok(!JSON.stringify(list.body).includes('c_api_'), 'API key must never reach a response');
});

test('upstream validation errors surface as client-safe 400s (path collision)', async () => {
  upstream.failCreateWith = "Path 'fest-a-ig' is already in use or conflicts with an existing link.";
  const r = await app.req('POST', `/api/my/chottu/${entityA.id}/links`, {
    as: ownerA, body: { linkName: 'Dup', destinationUrl: 'https://howler.co.za/x', path: 'fest-a-ig' },
  });
  upstream.failCreateWith = null;
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already in use/);
});

test('tenancy + permissions: other clients and viewer roles are locked out', async () => {
  const mine = await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA });
  const linkId = mine.body.links[0].id;
  assert.equal((await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerB })).status, 403);
  assert.equal((await app.req('PATCH', `/api/my/chottu/${entityA.id}/links/${linkId}`, { as: ownerB, body: { linkName: 'pwn' } })).status, 403);
  assert.equal((await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: viewerA })).status, 403); // viewer lacks campaigns.approve
  // A link can't be reached through another entity's admin path either.
  assert.equal((await app.req('PATCH', `/api/admin/entities/${entityB.id}/chottu/links/${linkId}`, { as: admin, body: { linkName: 'x' } })).status, 404);
});

test('update: upstream gets only upstream fields; event assignment stays Pulse-side', async () => {
  const mine = await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA });
  const link = mine.body.links[0];
  upstream.calls.length = 0;
  const r = await app.req('PATCH', `/api/my/chottu/${entityA.id}/links/${link.id}`, { as: ownerA, body: { suiteId: '' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.link.suiteId, null);
  assert.equal(upstream.calls.length, 0, 'moving a link between events must not call ChottuLink');
  const r2 = await app.req('PATCH', `/api/my/chottu/${entityA.id}/links/${link.id}`, { as: ownerA, body: { linkName: 'Renamed', suiteId: suiteA.id } });
  assert.equal(r2.body.link.linkName, 'Renamed');
  assert.equal(upstream.calls.at(-1).path, `/update-link/${link.chottuLinkId}`);
});

test('disable flips upstream and locally', async () => {
  const mine = await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA });
  const r = await app.req('PATCH', `/api/my/chottu/${entityA.id}/links/${mine.body.links[0].id}/status`, { as: ownerA, body: { enabled: false } });
  assert.equal(r.body.link.enabled, false);
  assert.match(upstream.calls.at(-1).path, /\/links\/change-status\//);
});

test('import upserts by ChottuLink id and keeps Pulse-side fields on re-import', async () => {
  upstream.nextLinks = [
    { id: 'ext-a', short_url: 'https://howler.chottu.link/a', link_name: 'A', destination_url: 'https://h/1', is_enabled: true, createdTime: '2026-01-01T00:00:00' },
    { id: 'ext-b', short_url: 'https://howler.chottu.link/b', link_name: 'B', destination_url: 'https://h/2', is_enabled: true, createdTime: '2026-01-02T00:00:00' },
  ];
  const first = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/import`, { as: admin });
  assert.deepEqual({ imported: first.body.imported, refreshed: first.body.refreshed }, { imported: 2, refreshed: 0 });
  // Assign one to an event, then re-import with a renamed upstream link.
  const links = (await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/links`, { as: admin })).body.links;
  const a = links.find((l) => l.chottuLinkId === 'ext-a');
  await app.req('PATCH', `/api/admin/entities/${entityA.id}/chottu/links/${a.id}`, { as: admin, body: { suiteId: suiteA.id } });
  upstream.nextLinks[0].link_name = 'A renamed';
  const second = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/import`, { as: admin });
  assert.deepEqual({ imported: second.body.imported, refreshed: second.body.refreshed }, { imported: 0, refreshed: 2 });
  const after2 = (await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/links`, { as: admin })).body.links.find((l) => l.chottuLinkId === 'ext-a');
  assert.equal(after2.linkName, 'A renamed');            // upstream truth refreshed
  assert.equal(after2.suiteId, suiteA.id);               // Pulse assignment survives
  assert.equal(after2.source, 'imported');
});

test('stats refresh writes the click counters', async () => {
  const r = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/refresh-stats`, { as: admin, body: {} });
  assert.equal(r.status, 200);
  assert.ok(r.body.updated >= 3);
  const links = (await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/links`, { as: admin })).body.links;
  assert.deepEqual({ total: links[0].clicks.total, last7: links[0].clicks.last7, last30: links[0].clicks.last30 }, { total: 42, last7: 7, last30: 30 });
  assert.ok(links[0].clicks.at, 'stats timestamp recorded');
});

test('unconfigured client gets a clear 400, not an upstream call', async () => {
  h.db.setEntityIntegrations(entityB.id, {}); // still has its own key — clear it
  h.db.setEntityIntegrations(entityB.id, { chottuApiKey: '', chottuDomain: '' });
  h.db.setSetting('chottu_api_key', '');
  const r = await app.req('POST', `/api/my/chottu/${entityB.id}/links`, { as: ownerB, body: { linkName: 'X', destinationUrl: 'https://h/x' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not connected/i);
  h.db.setSetting('chottu_api_key', 'c_api_platform_key'); // restore for any later test
});
