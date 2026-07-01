// Tenant data-isolation tests — the security boundary.
//
// Pulse talks to Looker through ONE service account, so client data isolation is
// enforced entirely in `auth.scopeForQuery`: it forces each client's organiser
// filter onto every query and FAILS CLOSED when it can't. These tests pin that
// behaviour so a future change can't silently widen one client's view to another's.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// One shared org-scoped dashboard, seeded before any scope call, so the resolver
// can map `ticketing::core` → organiser field from the saved dashboards.
before(() => { h.seedOrganiserDashboard({ model: 'ticketing', explore: 'core' }); });

const Q = (over = {}) => ({ model: 'ticketing', view: 'core', fields: ['core.count'], ...over });

test('a client query is forced to their own organiser scope', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('a@client.test', [ent.id]);
  const scope = await h.auth.scopeForQuery(Q(), user);
  assert.deepEqual(scope, { [h.ORG_FIELD]: 'Ultra South Africa' });
});

test('a client cannot override their organiser scope from the browser', async () => {
  // A malicious client sends another organiser's value in the query filters.
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('b@client.test', [ent.id]);
  const clientQuery = Q({ filters: { [h.ORG_FIELD]: 'Rocking the Daisies' } });
  const scope = await h.auth.scopeForQuery(clientQuery, user);
  // The server merges the forced scope LAST (see applyScope in server/index.js:
  //   query.filters = { ...query.filters, ...scope }), so the forced value wins.
  const finalFilters = { ...clientQuery.filters, ...scope };
  assert.equal(finalFilters[h.ORG_FIELD], 'Ultra South Africa');
  assert.notEqual(finalFilters[h.ORG_FIELD], 'Rocking the Daisies');
});

test('two clients never resolve to the same organiser scope', async () => {
  const a = h.makeClient('c1@client.test', [h.makeEntity('A', 'A-org').id]);
  const b = h.makeClient('c2@client.test', [h.makeEntity('B', 'B-org').id]);
  const sa = await h.auth.scopeForQuery(Q(), a);
  const sb = await h.auth.scopeForQuery(Q(), b);
  assert.deepEqual(sa, { [h.ORG_FIELD]: 'A-org' });
  assert.deepEqual(sb, { [h.ORG_FIELD]: 'B-org' });
  assert.notDeepEqual(sa, sb);
});

test('fails CLOSED when a client has no organiser configured', async () => {
  const ent = h.makeEntity('Misconfigured Co', null); // no organiser lock
  const user = h.makeClient('d@client.test', [ent.id]);
  const scope = await h.auth.scopeForQuery(Q(), user);
  assert.equal(scope, false); // false = deny, NOT "{} = see everything"
});

test('an admin with no suite is unscoped (sees all data)', async () => {
  const admin = h.makeAdmin('e@admin.test');
  const scope = await h.auth.scopeForQuery(Q(), admin);
  assert.deepEqual(scope, {});
});

test('an "all organisers" internal client is deliberately unscoped', async () => {
  const ent = h.makeEntity('Howler Internal', 'Ultra SA', { allOrganisers: true });
  const user = h.makeClient('f@client.test', [ent.id]);
  const scope = await h.auth.scopeForQuery(Q(), user);
  assert.deepEqual(scope, {}); // the allOrganisers flag wins over the org lock
});

test('a client cannot view through another client\'s suite', async () => {
  const entA = h.makeEntity('A', 'A-org');
  const entB = h.makeEntity('B', 'B-org');
  const suiteB = h.db.createSuite({ entityId: entB.id, name: 'B Suite' });
  const userA = h.makeClient('g@client.test', [entA.id]);
  const scope = await h.auth.scopeForQuery(Q(), userA, suiteB.id);
  assert.equal(scope, false); // no access to that suite → blocked
});

test('an admin previewing a client suite is scoped to THAT client', async () => {
  const entB = h.makeEntity('B', 'B-org');
  const suiteB = h.db.createSuite({ entityId: entB.id, name: 'B Suite' });
  const admin = h.makeAdmin('h@admin.test');
  const scope = await h.auth.scopeForQuery(Q(), admin, suiteB.id);
  // Even a global admin is constrained to the previewed client's organiser.
  assert.deepEqual(scope, { [h.ORG_FIELD]: 'B-org' });
});

test('fails CLOSED on an explore with no resolvable organiser field (no Looker)', async () => {
  const ent = h.makeEntity('A', 'A-org');
  const user = h.makeClient('i@client.test', [ent.id]);
  // Guarantee the live-Looker last resort cannot resolve a field or hit a network.
  const looker = require('../server/looker');
  const orig = looker.lookerRequest;
  looker.lookerRequest = async () => { throw new Error('looker disabled in tests'); };
  try {
    const scope = await h.auth.scopeForQuery({ model: 'mystery_model', view: 'mystery_view' }, user);
    assert.equal(scope, false);
  } finally {
    looker.lookerRequest = orig;
  }
});
