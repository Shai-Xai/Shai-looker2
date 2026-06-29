// Custom categories (tags) shared by goals & alerts: the per-entity list, trimming +
// case-insensitive dedupe, delete, and the entity-ownership guard on the routes.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity } = require('./helpers');

// Mount capturing the route handlers (no real express).
function mountCategories() {
  const routes = {};
  const reg = (m) => (p, ...hs) => { routes[m + ' ' + p] = hs[hs.length - 1]; };
  require('../server/categories').mount({ get: reg('GET'), post: reg('POST'), delete: reg('DELETE') }, { db, auth });
  return routes;
}
const res = () => { const o = {}; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; o.code = o.code || 200; return o; }; return o; };

test('categories: add (trimmed) + case-insensitive dedupe, list, and delete', async () => {
  const routes = mountCategories();
  const ent = makeEntity('CatCo');
  const user = { id: 'u', email: 'u@test', role: 'client', entityIds: [ent.id] };
  const get = () => { const r = res(); return routes['GET /api/my/categories/:entityId']({ params: { entityId: ent.id }, user }, r), r; };
  const add = async (name) => { const r = res(); await routes['POST /api/my/categories/:entityId']({ params: { entityId: ent.id }, user, body: { name } }, r); return r; };
  const del = async (name) => { const r = res(); await routes['DELETE /api/my/categories/:entityId/:name']({ params: { entityId: ent.id, name }, user }, r); return r; };

  assert.deepEqual((await add('  Front gate  ')).body.categories, ['Front gate'], 'trimmed on add');
  assert.deepEqual((await add('FRONT GATE')).body.categories, ['Front gate'], 'case-insensitive dedupe');
  assert.deepEqual((await add('Parking')).body.categories, ['Front gate', 'Parking']);
  assert.deepEqual(get().body.categories, ['Front gate', 'Parking'], 'list persists');
  assert.deepEqual((await del('front gate')).body.categories, ['Parking'], 'delete is case-insensitive');
});

test('categories: a non-member cannot read or write another entity’s list', async () => {
  const routes = mountCategories();
  const ent = makeEntity('PrivateCo');
  const outsider = { id: 'x', email: 'x@test', role: 'client', entityIds: ['someone-else'] };
  const r = res();
  routes['GET /api/my/categories/:entityId']({ params: { entityId: ent.id }, user: outsider }, r);
  assert.equal(r.code, 403);
  const w = res();
  await routes['POST /api/my/categories/:entityId']({ params: { entityId: ent.id }, user: outsider, body: { name: 'Sneaky' } }, w);
  assert.equal(w.code, 403);
});

test('categories: an admin may manage any entity’s list (acts on a client’s behalf)', async () => {
  const routes = mountCategories();
  const ent = makeEntity('AdminCo');
  const admin = { id: 'a', email: 'a@test', role: 'admin', entityIds: [] };
  const r = res();
  await routes['POST /api/my/categories/:entityId']({ params: { entityId: ent.id }, user: admin, body: { name: 'VIP ops' } }, r);
  assert.deepEqual(r.body.categories, ['VIP ops']);
});
