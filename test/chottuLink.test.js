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

test('import preview flags account links as new / imported / removed; selective import honours the picks', async () => {
  upstream.nextLinks = [
    { id: 'ext-c', short_url: 'https://howler.chottu.link/c', link_name: 'C', destination_url: 'https://h/3', is_enabled: true },
    { id: 'ext-d', short_url: 'https://howler.chottu.link/d', link_name: 'D', destination_url: 'https://h/4', is_enabled: true },
    { id: 'ext-a', short_url: 'https://howler.chottu.link/a', link_name: 'A renamed', destination_url: 'https://h/1', is_enabled: true },
  ];
  const p = await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/import/preview`, { as: admin });
  assert.equal(p.status, 200);
  assert.equal(p.body.links.find((l) => l.chottuLinkId === 'ext-c').status, 'new');
  assert.equal(p.body.links.find((l) => l.chottuLinkId === 'ext-a').status, 'imported');
  // Pick ONLY ext-c and attach it to the event in the same step.
  const r = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/import`, { as: admin, body: { ids: ['ext-c'], suiteId: suiteA.id } });
  assert.equal(r.body.imported, 1);
  const links = (await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/links`, { as: admin })).body.links;
  const c = links.find((l) => l.chottuLinkId === 'ext-c');
  assert.equal(c.suiteId, suiteA.id, 'picked import lands on the chosen event');
  assert.ok(!links.some((l) => l.chottuLinkId === 'ext-d'), 'unpicked link is not imported');
});

test('delete switches the link off upstream, hides it everywhere, and imports do not resurrect it', async () => {
  const links = (await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links;
  const victim = links.find((l) => l.chottuLinkId === 'ext-c');
  upstream.calls.length = 0;
  const del = await app.req('DELETE', `/api/my/chottu/${entityA.id}/links/${victim.id}`, { as: ownerA });
  assert.equal(del.status, 200);
  assert.match(upstream.calls.at(-1).path, /\/links\/change-status\/ext-c/, 'deleted link is switched off upstream');
  const after = (await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links;
  assert.ok(!after.some((l) => l.id === victim.id), 'deleted link is hidden');
  assert.equal((await app.req('PATCH', `/api/my/chottu/${entityA.id}/links/${victim.id}`, { as: ownerA, body: { linkName: 'x' } })).status, 404);
  // Bulk import (no ids) skips the tombstone…
  const bulk = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/import`, { as: admin, body: {} });
  assert.equal(bulk.body.restored, 0);
  assert.ok(!(await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links.some((l) => l.chottuLinkId === 'ext-c'));
  // …its preview status is 'removed', and explicitly re-picking it restores it.
  const p = await app.req('GET', `/api/admin/entities/${entityA.id}/chottu/import/preview`, { as: admin });
  assert.equal(p.body.links.find((l) => l.chottuLinkId === 'ext-c').status, 'removed');
  const restore = await app.req('POST', `/api/admin/entities/${entityA.id}/chottu/import`, { as: admin, body: { ids: ['ext-c'] } });
  assert.equal(restore.body.restored, 1);
  assert.ok((await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links.some((l) => l.chottuLinkId === 'ext-c'));
  // Another client can't delete A's links.
  const someA = (await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links[0];
  assert.equal((await app.req('DELETE', `/api/my/chottu/${entityA.id}/links/${someA.id}`, { as: ownerB })).status, 403);
});

// ── Phase 2: templates ──

test('starter template is seeded and visible to clients; platform templates are not client-editable', async () => {
  const r = await app.req('GET', `/api/my/chottu/${entityA.id}/templates`, { as: ownerA });
  assert.equal(r.status, 200);
  const starter = r.body.templates.find((t) => t.platform);
  assert.ok(starter, 'seeded platform starter template is listed');
  assert.equal(starter.items.length, 6);
  const edit = await app.req('PATCH', `/api/my/chottu/${entityA.id}/templates/${starter.id}`, { as: ownerA, body: { name: 'hijack', items: starter.items } });
  assert.equal(edit.status, 403);
  const del = await app.req('DELETE', `/api/my/chottu/${entityA.id}/templates/${starter.id}`, { as: ownerA });
  assert.equal(del.status, 403);
});

test('preview resolves placeholders per event and flags problems instead of blanking them', async () => {
  const starter = (await app.req('GET', `/api/my/chottu/${entityA.id}/templates`, { as: ownerA })).body.templates.find((t) => t.platform);
  const p = await app.req('POST', `/api/my/chottu/${entityA.id}/templates/${starter.id}/preview`, {
    as: ownerA, body: { suiteId: suiteA.id, base: 'https://www.howler.co.za/event/40848/' },
  });
  assert.equal(p.status, 200);
  const main = p.body.items.find((i) => i.key === 'main');
  assert.equal(main.name, 'Festival A 2026');
  assert.equal(main.path, 'Festival-A-2026');                                  // slugified event name
  assert.equal(main.destination, 'https://www.howler.co.za/event/40848');     // trailing slash trimmed
  assert.deepEqual(main.utm, { campaign: 'Festival-A-2026' });
  const wallet = p.body.items.find((i) => i.key === 'ticketwallet');
  assert.equal(wallet.destination, 'https://www.howler.co.za/event/40848?dest=my-tickets');
  assert.deepEqual(main.warnings, []);
  // Without the base URL, every {{base}} item warns rather than silently blanking.
  const noBase = await app.req('POST', `/api/my/chottu/${entityA.id}/templates/${starter.id}/preview`, { as: ownerA, body: { suiteId: suiteA.id } });
  assert.ok(noBase.body.items.every((i) => i.warnings.some((w) => /\{\{base\}\}/.test(w))));
  // Another client's event is rejected outright.
  const wrongSuite = await app.req('POST', `/api/my/chottu/${entityA.id}/templates/${starter.id}/preview`, { as: ownerA, body: { suiteId: 'nope', base: 'https://h' } });
  assert.equal(wrongSuite.status, 400);
});

test('apply creates the ticked links, survives per-item failures, and honours overrides', async () => {
  const starter = (await app.req('GET', `/api/my/chottu/${entityA.id}/templates`, { as: ownerA })).body.templates.find((t) => t.platform);
  upstream.failCreateWith = null;
  // Make exactly one item fail upstream (path collision on 'map'), keep the rest fine.
  const realFail = upstream.failCreateWith;
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/create-link') && opts.body && JSON.parse(opts.body).selected_path === 'Festival-A-2026-map') {
      return { ok: false, status: 400, json: async () => ({ error: { errorMessage: "Path 'Festival-A-2026-map' is already in use or conflicts with an existing link." } }) };
    }
    return origFetch(url, opts);
  };
  const r = await app.req('POST', `/api/my/chottu/${entityA.id}/templates/${starter.id}/apply`, {
    as: ownerA,
    body: {
      suiteId: suiteA.id, base: 'https://www.howler.co.za/event/40848',
      items: [
        { key: 'main', path: 'fest-a-main-override' },   // path override from the preview UI
        { key: 'ticketwallet' }, { key: 'map' },
      ],
    },
  });
  global.fetch = origFetch;
  upstream.failCreateWith = realFail;
  assert.equal(r.status, 200);
  assert.deepEqual({ created: r.body.created, failed: r.body.failed }, { created: 2, failed: 1 });
  const main = r.body.results.find((x) => x.key === 'main');
  assert.ok(main.ok);
  assert.equal(main.link.shortUrl, 'https://howler.chottu.link/fest-a-main-override');
  assert.equal(main.link.suiteId, suiteA.id, 'template links land on the event');
  const map = r.body.results.find((x) => x.key === 'map');
  assert.equal(map.ok, false);
  assert.match(map.error, /already in use/);
  // Unticked items were not created.
  const links = (await app.req('GET', `/api/my/chottu/${entityA.id}/links`, { as: ownerA })).body.links;
  assert.ok(!links.some((l) => l.shortUrl.endsWith('-lineup')), 'unticked lineup item must not be created');
});

test('clients manage their own templates; other clients cannot see or touch them', async () => {
  const created = await app.req('POST', `/api/my/chottu/${entityA.id}/templates`, {
    as: ownerA,
    body: { name: 'A-only set', items: [{ key: 'x', name: '{{event.name}} promo', destination: 'https://h/x', path: '{{event.slug}}-promo' }] },
  });
  assert.equal(created.status, 201);
  const tid = created.body.template.id;
  assert.equal(created.body.template.platform, false);
  const forB = await app.req('GET', `/api/my/chottu/${entityB.id}/templates`, { as: ownerB });
  assert.ok(!forB.body.templates.some((t) => t.id === tid), 'entity template hidden from other clients');
  assert.equal((await app.req('POST', `/api/my/chottu/${entityB.id}/templates/${tid}/apply`, { as: ownerB, body: { suiteId: suiteA.id } })).status, 404);
  assert.equal((await app.req('DELETE', `/api/my/chottu/${entityA.id}/templates/${tid}`, { as: ownerA })).status, 204);
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
