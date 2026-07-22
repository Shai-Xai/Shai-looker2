// Client-defined nav categories: storage, validation, and tenant isolation.
// Driven over real HTTP against the mounted routes so the entity-ownership guard
// and the save-time sanitising (entity-scoped suite ids, dedupe across categories,
// name/length caps) are exercised exactly as in production.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

let app, entA, entB, userA, userB, s1, s2, sOther;
before(async () => {
  entA = h.makeEntity('Cat Co A', 'Org A');
  entB = h.makeEntity('Cat Co B', 'Org B');
  userA = h.makeClient('a@cat.test', [entA.id]);
  userB = h.makeClient('b@cat.test', [entB.id]);
  s1 = h.db.createSuite({ entityId: entA.id, name: 'Event 1' });
  s2 = h.db.createSuite({ entityId: entA.id, name: 'Event 2' });
  sOther = h.db.createSuite({ entityId: entB.id, name: 'Other-tenant event' });
  app = await startApp((a) => require('../server/suiteCategories').mount(a, { db: h.db, auth: h.auth }));
});
after(async () => { if (app) await app.close(); });

test('a client saves + reads their own categories', async () => {
  const put = await app.req('PUT', `/api/my/suite-categories/${entA.id}`, { as: userA, body: { categories: [{ id: 'c1', name: 'Festivals', suiteIds: [s1.id, s2.id] }] } });
  assert.equal(put.status, 200);
  assert.equal(put.body.categories.length, 1);
  assert.deepEqual(put.body.categories[0].suiteIds, [s1.id, s2.id]);
  const get = await app.req('GET', `/api/my/suite-categories/${entA.id}`, { as: userA });
  assert.equal(get.body.categories[0].name, 'Festivals');
});

test('save drops foreign-entity suites, dedupes across categories, caps the name', async () => {
  const longName = 'x'.repeat(200);
  const r = await app.req('PUT', `/api/my/suite-categories/${entA.id}`, { as: userA, body: { categories: [
    { id: 'c1', name: longName, suiteIds: [s1.id, sOther.id, s1.id] }, // foreign + duplicate id
    { id: 'c2', name: 'Second', suiteIds: [s1.id, s2.id] },            // s1 already filed in c1
  ] } });
  assert.equal(r.status, 200);
  const [c1, c2] = r.body.categories;
  assert.equal(c1.name.length, 60, 'name capped at 60');
  assert.deepEqual(c1.suiteIds, [s1.id], 'foreign + duplicate suite dropped');
  assert.deepEqual(c2.suiteIds, [s2.id], 's1 not double-filed (first category wins)');
});

test('empty categories (no name, no members) are dropped', async () => {
  const r = await app.req('PUT', `/api/my/suite-categories/${entA.id}`, { as: userA, body: { categories: [{ id: 'x', name: '', suiteIds: [] }, { id: 'y', name: 'Keep', suiteIds: [] }] } });
  assert.deepEqual(r.body.categories.map((c) => c.name), ['Keep']);
});

test('a client cannot read or write another tenant\'s categories', async () => {
  assert.equal((await app.req('GET', `/api/my/suite-categories/${entB.id}`, { as: userA })).status, 403);
  assert.equal((await app.req('PUT', `/api/my/suite-categories/${entB.id}`, { as: userA, body: { categories: [] } })).status, 403);
});
