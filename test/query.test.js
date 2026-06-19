// Unit pins for the extracted query/scope engine (server/query.js) — the
// security-critical surface that index.js's /api/run-query, /api/drill, digests
// and briefings all funnel through. The extraction is behaviour-preserving only
// if applyScope still forces the organiser lock and fails closed; these lock that.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Seed a shared org-scoped dashboard so auth.scopeForQuery can resolve the
// organiser field from saved dashboards without calling Looker (same trick as
// scope.test.js).
before(() => { h.seedOrganiserDashboard({ model: 'ticketing', explore: 'core' }); });

function makeEngine(lookerStub) {
  return require('../server/query')({
    looker: lookerStub || { lookerRequest: async () => ({ ok: true }) },
    auth: h.auth,
  });
}

test('applyScope forces a client to their own organiser scope', async () => {
  const q = makeEngine();
  const ent = h.makeEntity('Q Co', 'Q-org');
  const user = h.makeClient('q@test.local', [ent.id]);
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} };
  assert.equal(await q.applyScope(query, user), true);
  assert.equal(query.filters[h.ORG_FIELD], 'Q-org');
});

test('applyScope fails CLOSED (false) when no organiser is configured', async () => {
  const q = makeEngine();
  const user = h.makeClient('ns@test.local', [h.makeEntity('NoScope', null).id]);
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'] };
  assert.equal(await q.applyScope(query, user), false);
});

test('applyScope leaves an admin unscoped', async () => {
  const q = makeEngine();
  const admin = h.makeAdmin('q-admin@test.local');
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} };
  assert.equal(await q.applyScope(query, admin), true);
  assert.equal(query.filters[h.ORG_FIELD], undefined); // unscoped
});

test('stripAnyValue drops only the ANY_VALUE sentinel', () => {
  const q = makeEngine();
  assert.deepEqual(q.stripAnyValue({ a: '1', b: q.ANY_VALUE, c: '' }), { a: '1', c: '' });
});

test('runLookerQuery caches by path+body; force bypasses the cache', async () => {
  let calls = 0;
  const q = makeEngine({ lookerRequest: async () => { calls += 1; return { n: calls }; } });
  const body = { model: 'm', fields: ['x'] };
  const a = await q.runLookerQuery('/queries/run/json_detail', body);
  const b = await q.runLookerQuery('/queries/run/json_detail', body); // identical → cached
  assert.equal(calls, 1, 'second identical query served from cache');
  assert.deepEqual(a, b);
  await q.runLookerQuery('/queries/run/json_detail', body, undefined, true); // force
  assert.equal(calls, 2, 'force skips the cache and re-fetches');
});

test('tileQueryBody scopes the body, and returns null when scope is denied', async () => {
  const q = makeEngine();
  const user = h.makeClient('tile@test.local', [h.makeEntity('Tile Co', 'Tile-org').id]);
  const def = { filters: [] };
  const tile = { type: 'vis', query: { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} } };
  const body = await q.tileQueryBody(tile, def, user, undefined);
  assert.ok(body, 'builds a body for a scoped user');
  assert.equal(body.filters[h.ORG_FIELD], 'Tile-org');
  // A user with no organiser configured → scope denied → null (tile renders nothing).
  const user2 = h.makeClient('tile2@test.local', [h.makeEntity('NoScope2', null).id]);
  assert.equal(await q.tileQueryBody(tile, def, user2, undefined), null);
});
