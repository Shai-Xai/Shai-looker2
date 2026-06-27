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
