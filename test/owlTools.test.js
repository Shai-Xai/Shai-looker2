// askData scope-gate tests — the security boundary for the agentic Owl.
//
// askData must NEVER reach another client's data. It builds a query over the
// curated "All Tickets" catalogue and runs it through the SAME applyScope gate
// every tile uses. These tests run against the REAL scope engine (server/query.js
// + server/auth.js) with Looker stubbed, so they pin the real behaviour:
//   1) the client's organiser lock is forced onto every askData query,
//   2) a client can't widen scope via a filter (ceiling, not override),
//   3) it FAILS CLOSED (never runs Looker) when no scope is configured,
//   4) off-catalogue fields are refused before Looker is ever touched.

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const looker = require('../server/looker');
const queryEngine = require('../server/query')({ looker, auth: h.auth });
const createOwlTools = require('../server/owlTools');
const catalogue = require('../server/owlCatalogueSeed');
const M0 = catalogue.measures[0].name; // the default "tickets sold" measure

// The Owl catalogue queries combined/all_tickets; seed a shared org-scoped
// dashboard on that explore so scopeForQuery can resolve the organiser field
// WITHOUT calling Looker (mirrors a real imported dashboard).
before(() => { h.seedOrganiserDashboard({ model: catalogue.model, explore: catalogue.explore }); });

// Stub Looker so a query never hits the network; count calls so refusal tests can
// prove they fail closed BEFORE any query runs. (Scope content is asserted on the
// returned res.queryBody, which is cache-independent.)
let lookerCalls = 0;
const origRequest = looker.lookerRequest;
beforeEach(() => {
  lookerCalls = 0;
  looker.lookerRequest = async (_method, _path, _body) => { lookerCalls++; return [{ [catalogue.measures[0].name]: 42 }]; };
});
afterEach(() => { looker.lookerRequest = origRequest; });

const tools = () => createOwlTools({ query: queryEngine, auth: h.auth });
const ctx = (user, suiteId) => ({ user, suiteId });

test('askData forces the client\'s organiser scope onto the query', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('owl-a@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0 }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa');
});

test('a client cannot widen scope via a filter on the organiser field', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('owl-b@client.test', [ent.id]);
  // Organiser IS a curated filterable dimension, so the filter is accepted — but
  // applyScope is a CEILING: a value outside the client's allowed organiser is
  // clamped back to their own. They can never widen to another organiser.
  const res = await tools().askData.run(
    { measure: M0, filters: { [h.ORG_FIELD]: 'Rocking the Daisies' } },
    ctx(user),
  );
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa');
  assert.notEqual(res.queryBody.filters[h.ORG_FIELD], 'Rocking the Daisies');
});

test('askData FAILS CLOSED when the client has no organiser configured', async () => {
  const ent = h.makeEntity('Misconfigured Co', null); // no organiser lock
  const user = h.makeClient('owl-c@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0 }, ctx(user));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_scope');
  assert.equal(lookerCalls, 0); // refused BEFORE any query ran
});

test('two clients resolve to different forced scopes', async () => {
  const a = h.makeClient('owl-d1@client.test', [h.makeEntity('A', 'A-org').id]);
  const b = h.makeClient('owl-d2@client.test', [h.makeEntity('B', 'B-org').id]);
  const bodyA = (await tools().askData.run({ measure: M0 }, ctx(a))).queryBody;
  const bodyB = (await tools().askData.run({ measure: M0 }, ctx(b))).queryBody;
  assert.equal(bodyA.filters[h.ORG_FIELD], 'A-org');
  assert.equal(bodyB.filters[h.ORG_FIELD], 'B-org');
  assert.notEqual(bodyA.filters[h.ORG_FIELD], bodyB.filters[h.ORG_FIELD]);
});

test('a client cannot view through another client\'s suite (fails closed)', async () => {
  const entA = h.makeEntity('A', 'A-org');
  const entB = h.makeEntity('B', 'B-org');
  const suiteB = h.db.createSuite({ entityId: entB.id, name: 'B Suite' });
  const userA = h.makeClient('owl-e@client.test', [entA.id]);
  const res = await tools().askData.run({ measure: M0 }, ctx(userA, suiteB.id));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_scope');
  assert.equal(lookerCalls, 0);
});

test('an admin with NO client/event context is refused, not run platform-wide', async () => {
  const admin = h.makeAdmin('owl-admin@howler.test'); // global admin, no memberships
  const res = await tools().askData.run({ measure: M0 }, ctx(admin)); // no suiteId, no entityId
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_scope');
  assert.equal(lookerCalls, 0); // never ran across all organisers
});

test('an admin IS scoped when given an accessible client (entityId)', async () => {
  const ent = h.makeEntity('Big Promoter', 'Big-Promoter-Org');
  const admin = h.makeAdmin('owl-admin2@howler.test');
  const res = await tools().askData.run({ measure: M0 }, { user: admin, entityId: ent.id });
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Big-Promoter-Org'); // bound to that organiser
});

test('off-catalogue measure is refused before Looker is touched', async () => {
  const user = h.makeClient('owl-f@client.test', [h.makeEntity('A', 'A-org').id]);
  const res = await tools().askData.run({ measure: 'core_users.email' }, ctx(user));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown_measure');
  assert.equal(lookerCalls, 0);
});

test('a valid filter on a curated dimension is passed through under scope', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('owl-g@client.test', [ent.id]);
  const res = await tools().askData.run(
    { measure: M0, dimensions: ['core_ticket_types.name'], filters: { 'core_ticket_types.name': 'VIP' }, dateRange: 'last 7 days' },
    ctx(user),
  );
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['core_ticket_types.name'], 'VIP');
  assert.equal(res.queryBody.filters[catalogue.dateDimension], 'last 7 days');
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa'); // scope still applied
  assert.deepEqual(res.queryBody.fields, ['core_ticket_types.name', M0]);
});
