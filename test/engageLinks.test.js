// Engage Links: per-entity links grouped into categories — the "App → Chotulink"
// seed, URL cleaning, category normalisation, CRUD, and the entity-ownership guard.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity } = require('./helpers');

function mountLinks() {
  const routes = {};
  const reg = (m) => (p, ...hs) => { routes[m + ' ' + p] = hs[hs.length - 1]; };
  require('../server/engageLinks').mount(
    { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') },
    { db, auth }
  );
  return routes;
}
const res = () => { const o = {}; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; o.code = o.code || 200; return o; }; return o; };

test('engageLinks: seeds App → Chotulink once per entity, and a delete stays deleted', async () => {
  const routes = mountLinks();
  const ent = makeEntity('LinkCo');
  const user = { id: 'u', email: 'u@test', role: 'client', entityIds: [ent.id] };
  const list = () => { const r = res(); routes['GET /api/engage-links/:entityId']({ params: { entityId: ent.id }, user }, r); return r.body; };

  const first = list();
  assert.equal(first.links.length, 1, 'seeded exactly one link');
  assert.equal(first.links[0].label, 'Chotulink');
  assert.equal(first.links[0].category, 'app');
  assert.ok(first.catalog.some((c) => c.key === 'app'), 'catalog exposes the App category');

  // Delete the seed, then re-list: it must NOT come back (seed is once-per-entity).
  const del = res();
  await routes['DELETE /api/engage-links/:entityId/:id']({ params: { entityId: ent.id, id: first.links[0].id }, user }, del);
  assert.equal(del.body.ok, true);
  assert.equal(list().links.length, 0, 'seed does not resurrect after delete');
});

test('engageLinks: create cleans the URL + normalises the category; bad input is rejected', async () => {
  const routes = mountLinks();
  const ent = makeEntity('CleanCo');
  const user = { id: 'u', email: 'u@test', role: 'client', entityIds: [ent.id] };
  const create = async (body) => { const r = res(); await routes['POST /api/engage-links/:entityId']({ params: { entityId: ent.id }, user, body }, r); return r; };

  const ok = await create({ label: 'Bare domain', url: 'example.com', category: 'My Apps!' });
  assert.equal(ok.code, 201);
  assert.equal(ok.body.link.url, 'https://example.com', 'bare domain gets https://');
  assert.equal(ok.body.link.category, 'my-apps', 'category slugified');

  const noLabel = await create({ label: '   ', url: 'https://x.com' });
  assert.equal(noLabel.code, 400, 'empty label rejected');

  const badScheme = await create({ label: 'Evil', url: 'javascript:alert(1)' });
  assert.equal(badScheme.code, 400, 'non-http(s) scheme rejected (empty url)');
});

test('engageLinks: a non-member is blocked; an admin may manage any entity', async () => {
  const routes = mountLinks();
  const ent = makeEntity('PrivateLinks');
  const outsider = { id: 'x', email: 'x@test', role: 'client', entityIds: ['other'] };
  const admin = { id: 'a', email: 'a@test', role: 'admin', entityIds: [] };

  const r = res();
  routes['GET /api/engage-links/:entityId']({ params: { entityId: ent.id }, user: outsider }, r);
  assert.equal(r.code, 403, 'outsider cannot read');

  const w = res();
  await routes['POST /api/engage-links/:entityId']({ params: { entityId: ent.id }, user: admin, body: { label: 'Docs', url: 'https://docs.test', category: 'docs' } }, w);
  assert.equal(w.code, 201, 'admin acts on the client’s behalf');
});
