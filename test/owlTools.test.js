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

const tools = () => createOwlTools({ query: queryEngine, auth: h.auth, db: h.db });
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

test('askData binds to the SINGLE client in context, not the union of a multi-entity user', async () => {
  // The WhatsApp door passes only entityId (no suiteId). A user who belongs to two
  // clients must NOT have their organisers unioned — that was a cross-entity leak.
  const entA = h.makeEntity('Client A', 'A-org');
  const entB = h.makeEntity('Client B', 'B-org');
  const user = h.makeClient('multi@client.test', [entA.id, entB.id]);
  const res = await tools().askData.run({ measure: M0 }, { user, entityId: entA.id }); // no suiteId
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'A-org');              // bound to the one client
  assert.ok(!String(res.queryBody.filters[h.ORG_FIELD]).includes('B-org')); // never the other
  // And the other way round → the other client only.
  const resB = await tools().askData.run({ measure: M0 }, { user, entityId: entB.id });
  assert.equal(resB.queryBody.filters[h.ORG_FIELD], 'B-org');
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

test('selecting an event applies the suite event lock (not just the organiser)', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26', lockedFilters: { 'core_events.name': 'Kappa FuturFestival 2026' } });
  const user = h.makeClient('owl-evt@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0 }, ctx(user, suite.id));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['core_events.name'], 'Kappa FuturFestival 2026'); // event lock applied
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa'); // organiser still forced
});

test('customer lookup: filtering by a known email is allowed (scoped)', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('owl-lk@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0, filters: { 'core_purchasers.email': 'john@example.com' } }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['core_purchasers.email'], 'john@example.com'); // lookup filter applied
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa'); // still scoped
});

test('customer lookup: listing/grouping by email is REFUSED (no enumeration)', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('owl-lk2@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0, dimensions: ['core_purchasers.email'] }, ctx(user));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown_dimension'); // filter-only field can't be grouped/returned
  assert.equal(lookerCalls, 0);
});

test('getGoals refuses without an event, and reads goals when scoped', async () => {
  const admin = h.makeAdmin('owl-goals@howler.test');
  const refused = await createOwlTools({ query: queryEngine, auth: h.auth, getGoalsApi: () => ({ listGoals: () => [] }) })
    .getGoals.run({}, { user: admin }); // no suiteId
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no_event');

  const suite = h.db.createSuite({ entityId: h.makeEntity('E', 'E-org').id, name: 'E' });
  const fakeApi = { listGoals: () => [{ id: 'g1', title: 'North Star', target: 1000, series: [1, 2, 3] }], attachProgress: async (g) => ({ ...g, percent: 42 }) };
  const res = await createOwlTools({ query: queryEngine, auth: h.auth, getGoalsApi: () => fakeApi })
    .getGoals.run({}, { user: admin, suiteId: suite.id });
  assert.equal(res.ok, true);
  assert.equal(res.goals.length, 1);
  assert.equal(res.goals[0].percent, 42);          // progress attached
  assert.equal(res.goals[0].series, undefined);    // bulky field stripped
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

// ── createAlert (the first act-tool): DRAFTS only — never writes, never queries ──

test('createAlert drafts a metric alert bound to the curated explore', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca1@client.test', [ent.id]);
  const res = await tools().createAlert.run({ measure: M0, operator: 'gte', threshold: 1000 }, ctx(user, suite.id));
  assert.equal(res.ok, true);
  assert.equal(res.confirm, true);            // surfaces a confirm card, doesn't create
  assert.equal(res.action.kind, 'createAlert');
  assert.equal(res.action.suiteId, suite.id);
  assert.equal(res.action.draft.source, 'metric');
  assert.equal(res.action.draft.model, catalogue.model);
  assert.equal(res.action.draft.view, catalogue.explore);
  assert.equal(res.action.draft.measure, M0);
  assert.equal(res.action.draft.operator, 'gte');
  assert.equal(res.action.draft.threshold, 1000);
  assert.ok(res.action.draft.name);           // a name is generated from the condition
  assert.equal(lookerCalls, 0);               // act-tool drafts; it never queries Looker
});

test('createAlert with no event auto-picks the client\'s only event', async () => {
  const ent = h.makeEntity('Solo Co', 'Solo-org');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'Only Event' });
  const user = h.makeClient('owl-ca2@client.test', [ent.id]);
  const res = await tools().createAlert.run({ measure: M0, operator: 'gte', threshold: 50 }, ctx(user)); // no suiteId
  assert.equal(res.ok, true);
  assert.equal(res.action.suiteId, suite.id); // resolved to the only event
  assert.equal(res.action.needsEvent, false);
});

test('createAlert with no event + several events offers an in-chat picker (no dead end)', async () => {
  const ent = h.makeEntity('Multi Co', 'Multi-org');
  const s1 = h.db.createSuite({ entityId: ent.id, name: 'Event One' });
  const s2 = h.db.createSuite({ entityId: ent.id, name: 'Event Two' });
  const user = h.makeClient('owl-ca2b@client.test', [ent.id]);
  const res = await tools().createAlert.run({ measure: M0, operator: 'gte', threshold: 50 }, ctx(user)); // no suiteId
  assert.equal(res.ok, true);          // drafts anyway — never dead-ends asking to go pick
  assert.equal(res.action.needsEvent, true);
  assert.equal(res.action.suiteId, '');
  const ids = (res.action.events || []).map((e) => e.id);
  assert.ok(ids.includes(s1.id) && ids.includes(s2.id)); // both offered as choices
});

test('createAlert refuses an off-catalogue measure', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca3@client.test', [ent.id]);
  const res = await tools().createAlert.run({ measure: 'core_users.email', operator: 'gte', threshold: 1 }, ctx(user, suite.id));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown_measure');
});

test('createAlert rejects a PII filter-only field as an alert filter', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca4@client.test', [ent.id]);
  const res = await tools().createAlert.run(
    { measure: M0, operator: 'gte', threshold: 1, filters: { 'core_purchasers.email': 'john@example.com' } },
    ctx(user, suite.id),
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unfilterable');
});

test('createAlert builds a metric label + filter for a curated dimension', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca5@client.test', [ent.id]);
  const res = await tools().createAlert.run(
    { measure: M0, operator: 'gte', threshold: 500, filters: { 'core_ticket_types.name': 'VIP' } },
    ctx(user, suite.id),
  );
  assert.equal(res.ok, true);
  assert.equal(res.action.draft.metricFilters['core_ticket_types.name'], 'VIP');
  assert.match(res.action.draft.metricLabel, /VIP/);
});

// Single source of truth: the tool schema is built FROM alerts.js's option lists, so
// adding an operator/channel/priority there automatically reaches the Owl. This guards
// against the two lists drifting apart.
const alertsMod = require('../server/alerts');
test('createAlert schema tracks the alerts module\'s option lists', () => {
  const props = tools().createAlert.schema.input_schema.properties;
  assert.deepEqual(props.operator.enum, alertsMod.OPERATORS);
  assert.deepEqual(props.channels.items.enum, alertsMod.CHANNELS);
  assert.deepEqual(props.priority.enum, alertsMod.PRIORITIES);
});

test('the "/" slash palette is sourced from the read tools (act tools excluded)', () => {
  const t = tools();
  const cmds = Object.values(t).filter((v) => v && v.menu).map((v) => v.menu.cmd);
  for (const c of ['data', 'goals', 'alerts', 'campaigns', 'dashboard', 'uploads']) assert.ok(cmds.includes(c), `missing /${c}`);
  assert.equal(t.createAlert.menu, undefined);   // act tools have no slash command
  assert.equal(t.createSegment.menu, undefined);
});

// ── createSegment (the audience act-tool): DRAFTS a query-segment from a cohort ──

test('createSegment drafts a query segment from a cohort of curated dimensions', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('seg1@client.test', [ent.id]);
  const res = await tools().createSegment.run({ name: 'VIP Cape Town', filters: { 'core_ticket_types.name': 'VIP', 'core_purchasers.city': 'Cape Town' } }, { user, entityId: ent.id });
  assert.equal(res.ok, true);
  assert.equal(res.confirm, true);
  assert.equal(res.action.kind, 'createSegment');
  assert.equal(res.action.entityId, ent.id);
  assert.equal(res.action.draft.mode, 'query');
  assert.equal(res.action.draft.model, catalogue.model);
  assert.equal(res.action.draft.view, catalogue.explore);
  assert.equal(res.action.draft.queryFilters['core_ticket_types.name'], 'VIP');
  assert.equal(res.action.draft.queryFilters['core_purchasers.city'], 'Cape Town');
});

test('createSegment supports guest list via the complimentary flag', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('seg-gl@client.test', [ent.id]);
  const res = await tools().createSegment.run({ filters: { 'core_tickets.is_complimentary': 'Yes' } }, { user, entityId: ent.id });
  assert.equal(res.ok, true);
  assert.equal(res.action.draft.queryFilters['core_tickets.is_complimentary'], 'Yes');
});

test('createSegment rejects a PII/contact field as a cohort driver', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('seg2@client.test', [ent.id]);
  const res = await tools().createSegment.run({ filters: { 'core_purchasers.email': 'x@y.com' } }, { user, entityId: ent.id });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'pii_filter');
});

test('createSegment refuses without a client in scope, and without a cohort', async () => {
  const admin = h.makeAdmin('seg-admin@howler.test');
  const noClient = await tools().createSegment.run({ filters: { 'core_ticket_types.name': 'VIP' } }, { user: admin });
  assert.equal(noClient.ok, false);
  assert.equal(noClient.reason, 'no_client');
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('seg3@client.test', [ent.id]);
  const noCohort = await tools().createSegment.run({ filters: {} }, { user, entityId: ent.id });
  assert.equal(noCohort.ok, false);
  assert.equal(noCohort.reason, 'no_cohort');
});

test('createAlert accepts any operator the alerts module defines', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca6@client.test', [ent.id]);
  for (const op of alertsMod.OPERATORS) {
    const res = await tools().createAlert.run({ measure: M0, operator: op, threshold: 10 }, ctx(user, suite.id));
    assert.equal(res.ok, true);
    assert.equal(res.action.draft.operator, op);
  }
});

test('createAlert carries channel + priority into the draft, defaulting sensibly', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('owl-ca7@client.test', [ent.id]);
  // Defaults: push channel, normal priority.
  const def = await tools().createAlert.run({ measure: M0, operator: 'gte', threshold: 1 }, ctx(user, suite.id));
  assert.deepEqual(def.action.draft.channels, ['push']);
  assert.equal(def.action.draft.priority, 'normal');
  // Explicit: a valid channel + priority pass through; an invalid channel is dropped.
  const set = await tools().createAlert.run(
    { measure: M0, operator: 'gte', threshold: 1, channels: ['email', 'carrier-pigeon'], priority: 'important' },
    ctx(user, suite.id),
  );
  assert.deepEqual(set.action.draft.channels, ['email']);
  assert.equal(set.action.draft.priority, 'important');
});
