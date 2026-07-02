// Route-level pins for the extracted dashboards module (server/dashboards.js).
// The high-value behaviour to lock after the move: /api/run-query still forces
// the client's organiser scope onto the Looker query and fails CLOSED, and
// dashboard writes stay admin-only. run-query is wired to the REAL query engine
// (applyScope) with a stubbed Looker runner so we assert on the scoped query
// body without a network call.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

const store = require('../server/store');
const looker = require('../server/looker');
const query = require('../server/query')({ looker, auth: h.auth });

let lastRun = null; // captures the (path, body) the route hands to Looker
let runResult = { data: [], fields: {} };

let app;
before(async () => {
  h.seedOrganiserDashboard({ model: 'ticketing', explore: 'core' }); // lets applyScope resolve the org field
  app = await startApp((expressApp) => {
    require('../server/dashboards').mount(expressApp, {
      store,
      db: h.db,
      auth: h.auth,
      looker,
      convertDashboard: () => ({}),
      fetchDashboard: async () => ({}),
      parseDrillUrl: () => null,
      runLookerQuery: async (path, body) => { lastRun = { path, body }; return runResult; },
      applyScope: query.applyScope,
      stripAnyValue: query.stripAnyValue,
      currentFirstEventSort: query.currentFirstEventSort,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { lastRun = null; runResult = { data: [], fields: {} }; });

const Q = { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} };

test('run-query forces the client\'s organiser scope onto the Looker query', async () => {
  const user = h.makeClient('dash@test.local', [h.makeEntity('Dash Co', 'Dash-org').id]);
  const res = await app.req('POST', '/api/run-query', { as: user, body: { query: Q } });
  assert.equal(res.status, 200);
  assert.ok(lastRun, 'a Looker query was issued');
  assert.equal(lastRun.body.filters[h.ORG_FIELD], 'Dash-org', 'organiser scope was injected server-side');
});

test('run-query fails CLOSED (403) when the client has no organiser configured', async () => {
  const user = h.makeClient('dash2@test.local', [h.makeEntity('NoOrg Co', null).id]);
  const res = await app.req('POST', '/api/run-query', { as: user, body: { query: Q } });
  assert.equal(res.status, 403);
  assert.equal(lastRun, null, 'no Looker query is issued when scope is denied');
});

test('a client cannot override their organiser scope from the browser', async () => {
  const user = h.makeClient('dash3@test.local', [h.makeEntity('Real Co', 'Real-org').id]);
  // Malicious attempt to widen scope to another organiser via filterOverrides.
  const res = await app.req('POST', '/api/run-query', {
    as: user,
    body: { query: Q, filterOverrides: { [h.ORG_FIELD]: 'Someone-Else' } },
  });
  assert.equal(res.status, 200);
  assert.equal(lastRun.body.filters[h.ORG_FIELD], 'Real-org', 'forced scope wins over the client-sent override');
});

test('creating a dashboard is admin-only', async () => {
  const client = h.makeClient('dash4@test.local', [h.makeEntity('C Co', 'c-org').id], 'owner');
  assert.equal((await app.req('POST', '/api/dashboards', { as: client, body: { title: 'X', tiles: [] } })).status, 403);
  const created = await app.req('POST', '/api/dashboards', { as: h.makeAdmin('dash-admin@test.local'), body: { title: 'X', tiles: [] } });
  assert.equal(created.status, 201);
});

// ─── Folder move (atomic reparent of a subfolder + all nested contents) ─────────
const folderOf = (id) => store.get(id).folder;

test('moving a folder reparents it AND every nested subfolder/dashboard in one call', async () => {
  const admin = h.makeAdmin('mv-admin@test.local');
  // Tree: Festivals/MTNB, Festivals/MTNB/Cashless, plus a sibling Concerts.
  const top = h.db.createDashboard({ title: 'Overview', folder: 'Festivals/MTNB' });
  const nested = h.db.createDashboard({ title: 'Wallet', folder: 'Festivals/MTNB/Cashless' });
  const other = h.db.createDashboard({ title: 'Untouched', folder: 'Concerts' });

  const res = await app.req('POST', '/api/admin/folders/move', { as: admin, body: { from: 'Festivals/MTNB', parent: 'Concerts' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 2, 'both dashboards under the folder moved');
  assert.equal(res.body.newPath, 'Concerts/MTNB');
  assert.equal(folderOf(top.id), 'Concerts/MTNB', 'folder itself reparented');
  assert.equal(folderOf(nested.id), 'Concerts/MTNB/Cashless', 'nested structure preserved under new parent');
  assert.equal(folderOf(other.id), 'Concerts', 'unrelated folder untouched');
});

test('moving a folder to the top level works', async () => {
  const admin = h.makeAdmin('mv-admin2@test.local');
  const d = h.db.createDashboard({ title: 'Deep', folder: 'A/B/Target' });
  const res = await app.req('POST', '/api/admin/folders/move', { as: admin, body: { from: 'A/B/Target', parent: '' } });
  assert.equal(res.status, 200);
  assert.equal(folderOf(d.id), 'Target', 'lands at the top level under its own leaf name');
});

test('moving a folder into itself or a descendant is blocked with a clear message', async () => {
  const admin = h.makeAdmin('mv-admin3@test.local');
  h.db.createDashboard({ title: 'X', folder: 'Parent/Child' });
  const intoDesc = await app.req('POST', '/api/admin/folders/move', { as: admin, body: { from: 'Parent', parent: 'Parent/Child' } });
  assert.equal(intoDesc.status, 400);
  assert.match(intoDesc.body.error, /itself or one of its own subfolders/);
  const intoSelf = await app.req('POST', '/api/admin/folders/move', { as: admin, body: { from: 'Parent', parent: 'Parent' } });
  assert.equal(intoSelf.status, 400);
});

test('moving a folder onto a colliding name is blocked (409)', async () => {
  const admin = h.makeAdmin('mv-admin4@test.local');
  h.db.createDashboard({ title: 'S', folder: 'Src/Shared' });
  h.db.createDashboard({ title: 'D', folder: 'Dest/Shared' }); // destination already has a "Shared"
  const res = await app.req('POST', '/api/admin/folders/move', { as: admin, body: { from: 'Src/Shared', parent: 'Dest' } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('folder move is admin-only', async () => {
  const client = h.makeClient('mv-client@test.local', [h.makeEntity('MV Co', 'mv-org').id], 'owner');
  h.db.createDashboard({ title: 'Y', folder: 'Foo' });
  const res = await app.req('POST', '/api/admin/folders/move', { as: client, body: { from: 'Foo', parent: '' } });
  assert.equal(res.status, 403);
});
