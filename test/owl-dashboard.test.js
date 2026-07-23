// getDashboard + queryDashboard — the Owl reading and deep-querying the dashboard
// the user is viewing. Mocked end-to-end (db/getExploreFields/scope stubbed) so it
// pins the tool's own logic: it exposes the dashboard's data surface, validates
// fields against the real explore, blocks PII from group-by, and stays scoped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createOwlTools = require('../server/owlTools');

const DASH = 'dash-1';
const def = {
  id: DASH, title: 'Sales Dashboard', ownerEntityId: '',
  tiles: [
    { id: 't1', type: 'vis', title: 'Tickets by Type', vis: { type: 'looker_bar' },
      query: { model: 'combined', view: 'tickets_purchased', fields: ['core_ticket_types.name', 'core_tickets.count'], filters: {} } },
    { id: 't2', type: 'text', title: 'Note', body_text: 'Hello' },
  ],
  carousels: [],
};
const exploreFields = {
  'combined::tickets_purchased': {
    measures: [{ name: 'core_tickets.count', label: 'Tickets Sold', type: 'count_distinct' }, { name: 'core_tickets.sum_revenue', label: 'Revenue', type: 'sum' }],
    dimensions: [
      { name: 'core_ticket_types.name', label: 'Ticket Type', type: 'string', group_label: 'Ticket' },
      { name: 'core_events.city', label: 'City', type: 'string', group_label: 'Event' },
      { name: 'core_purchasers.email', label: 'Email', type: 'string', group_label: 'Buyer' },
    ],
  },
};

function makeTools(onRun) {
  return createOwlTools({
    query: {
      applyScope: async (body) => { body.filters = { ...(body.filters || {}), 'core_organisers.name': 'Kappa' }; return true; },
      runLookerQuery: async (_p, body) => { if (onRun) onRun(body); return [{ 'core_events.city': 'CT', 'core_tickets.sum_revenue': 5 }]; },
    },
    auth: { canAccessSuite: () => true, lockedFiltersForSuite: () => ({}), accessibleOrgFilters: () => ({ 'core_organisers.name': 'Kappa' }) },
    db: { getDashboard: (id) => (id === DASH ? def : null) },
    resolveTileValue: async () => 42,
    getExploreFields: async (m, v) => exploreFields[`${m}::${v}`] || null,
  });
}
const user = { id: 'u1', role: 'admin', email: 'a@b.com' };
const ctx = { user, suiteId: 's1', entityId: 'e1', dashboardId: DASH };

test('getDashboard exposes the full explore surface, PII as lookup-only', async () => {
  const g = await makeTools().getDashboard.run({}, ctx);
  assert.equal(g.ok, true);
  assert.equal(g.tiles.length, 1); // text tile excluded
  const mNames = g.fields.measures.map((m) => m.name);
  assert.ok(mNames.includes('core_tickets.sum_revenue')); // a measure NOT on any tile is still offered
  const dNames = g.fields.dimensions.map((d) => d.name);
  assert.ok(dNames.includes('core_events.city'));
  assert.ok(!dNames.includes('core_purchasers.email')); // PII never groupable
  assert.deepEqual(g.fields.lookupOnly, ['core_purchasers.email']);
});

test('getDashboard refuses when no dashboard is open', async () => {
  const g = await makeTools().getDashboard.run({}, { user, suiteId: 's1' });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'no_dashboard');
});

test('queryDashboard runs a scoped query over the dashboard data', async () => {
  let body = null;
  const q = await makeTools((b) => { body = b; }).queryDashboard.run({ measure: 'core_tickets.sum_revenue', dimensions: ['core_events.city'] }, ctx);
  assert.equal(q.ok, true);
  assert.equal(q.explore, 'tickets_purchased');
  assert.deepEqual(body.fields, ['core_events.city', 'core_tickets.sum_revenue']);
  assert.equal(body.filters['core_organisers.name'], 'Kappa'); // forced scope present
});

test('queryDashboard blocks grouping by PII and rejects unknown fields', async () => {
  const t = makeTools();
  const pii = await t.queryDashboard.run({ measure: 'core_tickets.count', dimensions: ['core_purchasers.email'] }, ctx);
  assert.equal(pii.ok, false);
  assert.equal(pii.reason, 'unknown_dimension');
  const bad = await t.queryDashboard.run({ measure: 'core_tickets.nope' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown_measure');
});

test('queryDashboard allows a PII field as a lookup FILTER (not grouped)', async () => {
  let body = null;
  const q = await makeTools((b) => { body = b; }).queryDashboard.run({ measure: 'core_tickets.count', filters: { 'core_purchasers.email': 'x@y.com' } }, ctx);
  assert.equal(q.ok, true);
  assert.equal(body.filters['core_purchasers.email'], 'x@y.com');
});
