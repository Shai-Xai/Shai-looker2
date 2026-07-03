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
before(() => {
  h.seedOrganiserDashboard({ model: catalogue.model, explore: catalogue.explore });
  h.seedOrganiserDashboard({ model: catalogue.model, explore: 'cashless_x' }); // for the extra-explore test (before the scope index is first built)
});

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

// ── Reporting timezone: relative date filters ("today") must resolve on the
//    client's LOCAL calendar day, not Looker's server default — the cashless
//    dateRange="today" = zero-rows bug. Fresh Owl query bodies now stamp
//    query_timezone (platform default, or the entity's override).
const reportingTz = require('../server/timezone');

test('askData stamps the platform reporting timezone so "today" resolves locally', async () => {
  const ent = h.makeEntity('TZ Co', 'TZ-org');
  const user = h.makeClient('owl-tz1@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0, dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters[catalogue.dateDimension], 'today');
  assert.equal(res.queryBody.query_timezone, reportingTz.PLATFORM_TIMEZONE); // no override → platform default
});

test('a per-entity reporting timezone override wins over the platform default', async () => {
  const ent = h.makeEntity('Euro Co', 'Euro-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'Europe/Rome' });
  const user = h.makeClient('owl-tz2@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0, dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.query_timezone, 'Europe/Rome');
});

test('an invalid reporting timezone is ignored (falls back to the platform default)', async () => {
  const ent = h.makeEntity('Bad TZ Co', 'BadTZ-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'Not/AZone' });
  assert.equal(h.db.getEntity(ent.id).reportingTimezone, ''); // rejected at write time
  const user = h.makeClient('owl-tz3@client.test', [ent.id]);
  const res = await tools().askData.run({ measure: M0, dateRange: 'today' }, ctx(user));
  assert.equal(res.queryBody.query_timezone, reportingTz.PLATFORM_TIMEZONE);
});

test('an extra explore (e.g. cashless) also stamps the reporting timezone', async () => {
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: 'cashless_x.date', measures: [{ name: 'cashless_x.revenue', label: 'Cashless Revenue', type: 'number' }], dimensions: [{ name: 'cashless_x.method', label: 'Method', type: 'string' }], notes: [] }] };
  const ent = h.makeEntity('Cashless TZ Co', 'CashlessTZ-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'Europe/Paris' });
  const user = h.makeClient('owl-tz4@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x.revenue', dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['cashless_x.date'], 'today');
  assert.equal(res.queryBody.query_timezone, 'Europe/Paris');
});

test('dateRange filters the MEASURED view\'s own date, not the catalogue default (issue #28 residual)', async () => {
  // Combined explore: catalogue dateDimension is the check-in date, but the
  // measured view (sales) has its own date_date — "today" must land THERE, or
  // it doesn't constrain sales rows at all (the €34.50-instead-of-€12 bug).
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: 'cashless_x_checkins.date_date', measures: [{ name: 'cashless_x_sales.revenue', label: 'Sales Revenue', type: 'number' }], dimensions: [{ name: 'cashless_x_sales.date_date', label: 'Sales Date', type: 'date' }, { name: 'cashless_x_checkins.date_date', label: 'Check-in Date', type: 'date' }], notes: [] }] };
  const ent = h.makeEntity('Cashless DD Co', 'CashlessDD-org');
  const user = h.makeClient('owl-dd@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x_sales.revenue', dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['cashless_x_sales.date_date'], 'today', 'filters the measured view\'s own date');
  assert.equal(res.queryBody.filters['cashless_x_checkins.date_date'], undefined, 'catalogue default not used when the measure has its own date');
});

test('a registered extra explore gets its own scoped, validated read tool', async () => {
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: '', measures: [{ name: 'cashless_x.revenue', label: 'Cashless Revenue', type: 'number' }], dimensions: [{ name: 'cashless_x.method', label: 'Method', type: 'string' }], notes: [] }] };
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const tool = t.ask_cashless_x;
  assert.ok(tool && tool.run && tool.schema, 'extra explore tool exists');
  assert.deepEqual(tool.schema.input_schema.properties.measure.enum, ['cashless_x.revenue']);
  const ent = h.makeEntity('Ultra CL', 'Ultra Cashless');
  const user = h.makeClient('owl-cl@client.test', [ent.id]);
  // off-catalogue measure (a ticketing field) refused before Looker is touched
  lookerCalls = 0;
  const bad = await tool.run({ measure: M0 }, ctx(user));
  assert.equal(bad.ok, false);
  assert.equal(lookerCalls, 0, 'failed closed before querying');
  // a valid query runs and is scoped to the client's organiser
  const res = await tool.run({ measure: 'cashless_x.revenue', dimensions: ['cashless_x.method'] }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.view, 'cashless_x');
  assert.equal(res.queryBody.filters[h.ORG_FIELD], 'Ultra Cashless');
});

test('exportRows (raw CSV): PII fields refused, scope forced, full row budget', async () => {
  const ent = h.makeEntity('Ultra EX', 'Ultra Exports');
  const user = h.makeClient('owl-ex@client.test', [ent.id]);
  const t = tools();
  // A round-tripped queryBody is untrusted: a PII field must refuse BEFORE Looker.
  lookerCalls = 0;
  const pii = await t.exportRows({ model: catalogue.model, view: catalogue.explore, fields: ['core_purchasers.email', M0] }, ctx(user));
  assert.equal(pii.ok, false);
  assert.equal(lookerCalls, 0, 'refused before any query ran');
  // A valid export re-applies the organiser scope and lifts the row budget to 5000.
  const res = await t.exportRows({ model: catalogue.model, view: catalogue.explore, fields: ['core_ticket_types.name', M0], filters: { [h.ORG_FIELD]: 'Someone Else' } }, ctx(user));
  assert.equal(res.ok, true);
  // The smuggled foreign organiser filter is clamped back inside the user's own scope.
  assert.equal((await t.exportRows({ model: catalogue.model, view: catalogue.explore, fields: [M0] }, ctx(user))).ok, true);
});

// ── fan-out guard: a grouped result repeating one identical value is flagged ──

test('a grouped result where every row repeats the same value carries a fan-out warning note', async () => {
  // Reproduces the KFF 26 check-ins bug: grouping cashless_check_ins.count by
  // cashless_stations.name (an unrelated view) returned 185 rows all showing "4"
  // — the ungrouped total repeated per station. The Owl must be told it's not real.
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: '', measures: [{ name: 'cashless_x_checkins.count', label: 'Check-Ins', type: 'number' }], dimensions: [{ name: 'cashless_x_stations.name', label: 'Station', type: 'string' }], notes: [] }] };
  looker.lookerRequest = async () => Array.from({ length: 20 }, (_, i) => ({ 'cashless_x_stations.name': `Station ${i}`, 'cashless_x_checkins.count': 4 }));
  const ent = h.makeEntity('Fanout Co', 'Fanout-org');
  const user = h.makeClient('owl-fo1@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x_checkins.count', dimensions: ['cashless_x_stations.name'] }, ctx(user));
  assert.equal(res.ok, true);
  assert.match(res.note || '', /SUSPECT RESULT/, 'the fan-out is flagged');
  assert.match(res.note || '', /cashless_x_checkins/, 'points at the measure\'s own family');
});

test('a genuinely varied breakdown carries NO fan-out note', async () => {
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: '', measures: [{ name: 'cashless_x_checkins.count', label: 'Check-Ins', type: 'number' }], dimensions: [{ name: 'cashless_x_stations.name', label: 'Station', type: 'string' }], notes: [] }] };
  looker.lookerRequest = async () => Array.from({ length: 20 }, (_, i) => ({ 'cashless_x_stations.name': `Station ${i}`, 'cashless_x_checkins.count': 100 - i }));
  const ent = h.makeEntity('Varied Co', 'Varied-org');
  const user = h.makeClient('owl-fo2@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x_checkins.count', dimensions: ['cashless_x_stations.name'] }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.note, undefined);
});

test('small uniform results and ungrouped totals are NOT flagged as fan-out', async () => {
  // 3 stations all on the same count is plausible real data; a single-row total
  // has no group-by to distrust. Neither should scare the Owl off.
  const ent = h.makeEntity('Small Co', 'Small-org');
  const user = h.makeClient('owl-fo3@client.test', [ent.id]);
  looker.lookerRequest = async () => Array.from({ length: 3 }, (_, i) => ({ 'core_ticket_types.name': `T${i}`, [M0]: 4 }));
  const small = await tools().askData.run({ measure: M0, dimensions: ['core_ticket_types.name'] }, ctx(user));
  assert.equal(small.ok, true);
  assert.equal(small.note, undefined, 'few rows → not flagged');
  looker.lookerRequest = async () => [{ [M0]: 4 }];
  const total = await tools().askData.run({ measure: M0 }, ctx(user));
  assert.equal(total.ok, true);
  assert.equal(total.note, undefined, 'ungrouped total → not flagged');
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

test('the "/" slash palette has one entry per domain (no duplicate alert/campaign rows)', () => {
  const t = tools();
  const cmds = Object.values(t).filter((v) => v && v.menu).map((v) => v.menu.cmd);
  for (const c of ['data', 'goals', 'alerts', 'campaigns', 'dashboard', 'uploads', 'segment']) assert.ok(cmds.includes(c), `missing /${c}`);
  // No duplicate singular rows — alerts/campaigns each cover both reading and the act-tool.
  assert.ok(!cmds.includes('alert'), 'should not have a duplicate /alert row');
  assert.ok(!cmds.includes('campaign'), 'should not have a duplicate /campaign row');
  assert.equal(new Set(cmds).size, cmds.length, 'palette commands must be unique');
  // createAlert/draftCampaign fold into /alerts and /campaigns; queryDashboard stays internal.
  assert.equal(t.createAlert.menu, undefined);
  assert.equal(t.draftCampaign.menu, undefined);
  assert.equal(t.queryDashboard.menu, undefined);
});

// ── draftCampaign (the flagship act-tool): DRAFTS a campaign to a cohort ─────────
const campaignTools = () => createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, draftCampaignCopy: async () => ({ subject: 'Come back, VIP', body: 'We miss you — grab your spot.', ctaText: 'Buy now' }) });

test('draftCampaign drafts copy + a query-cohort audience (PII rejected, never sends)', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('camp1@client.test', [ent.id]);
  const res = await campaignTools().draftCampaign.run({ goal: 'Win back lapsed VIP buyers', filters: { 'core_ticket_types.name': 'VIP' }, channel: 'email' }, { user, entityId: ent.id });
  assert.equal(res.ok, true);
  assert.equal(res.confirm, true);
  assert.equal(res.action.kind, 'draftCampaign');
  assert.equal(res.action.channel, 'email');
  assert.equal(res.action.audience.mode, 'query');
  assert.equal(res.action.audience.queryFilters['core_ticket_types.name'], 'VIP');
  assert.equal(res.action.subject, 'Come back, VIP');     // copy drafted
  assert.ok(res.action.body);
});

test('draftCampaign can target a SAVED segment by name', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('camp3@client.test', [ent.id]);
  const segApi = { listSegments: () => [{ id: 'seg-1', name: 'Lapsed VIPs' }], resolveSegment: async () => ({ reach: { total: 800, email: 760, sms: 500 } }) };
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, draftCampaignCopy: async () => ({ subject: 'We miss you', body: 'Come back.' }), getSegmentsApi: () => segApi });
  const res = await t.draftCampaign.run({ goal: 'Win them back', segmentName: 'lapsed vips' }, { user, entityId: ent.id });
  assert.equal(res.ok, true);
  assert.equal(res.action.audience.mode, 'segment');
  assert.equal(res.action.audience.segmentId, 'seg-1');
  assert.equal(res.action.reach.total, 800);
});

test('draftCampaign reports the available segments when the named one is not found', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('camp4@client.test', [ent.id]);
  const segApi = { listSegments: () => [{ id: 's1', name: 'VIPs' }], resolveSegment: async () => ({}) };
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, draftCampaignCopy: async () => ({ subject: 'x', body: 'y' }), getSegmentsApi: () => segApi });
  const res = await t.draftCampaign.run({ goal: 'g', segmentName: 'Nonexistent' }, { user, entityId: ent.id });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_segment');
  assert.match(res.message, /VIPs/);
});

test('draftCampaign rejects a PII field as the audience, and requires goal + cohort', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('camp2@client.test', [ent.id]);
  const pii = await campaignTools().draftCampaign.run({ goal: 'x', filters: { 'core_purchasers.email': 'a@b.com' } }, { user, entityId: ent.id });
  assert.equal(pii.ok, false); assert.equal(pii.reason, 'pii_filter');
  const noGoal = await campaignTools().draftCampaign.run({ filters: { 'core_ticket_types.name': 'VIP' } }, { user, entityId: ent.id });
  assert.equal(noGoal.ok, false); assert.equal(noGoal.reason, 'no_goal');
  const noCohort = await campaignTools().draftCampaign.run({ goal: 'x', filters: {} }, { user, entityId: ent.id });
  assert.equal(noCohort.ok, false); assert.equal(noCohort.reason, 'no_cohort');
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

test('createSegment bakes the event (suite) scope into the draft so it persists on re-resolution', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const suite = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  const user = h.makeClient('seg-scope@client.test', [ent.id]);
  const res = await tools().createSegment.run({ filters: { 'core_ticket_types.name': 'VIP' } }, ctx(user, suite.id));
  assert.equal(res.ok, true);
  // The suite is carried on the saved definition, not just applied at creation — so
  // reach checks + campaign binding re-resolve scoped to this event (regression: #18).
  assert.equal(res.action.draft.suiteId, suite.id);
  // No event in context → entity-wide (empty scope), unchanged behaviour.
  const wide = await tools().createSegment.run({ filters: { 'core_ticket_types.name': 'VIP' } }, { user, entityId: ent.id });
  assert.equal(wide.action.draft.suiteId, '');
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

test('a dateRange that falls back to ANOTHER view\'s date carries a CAUTION note (check-ins have no own date)', async () => {
  // The Inventive-vs-Owl mismatch: check-ins have no date field of their own, so
  // "today" rides the access-control date and may not constrain check-ins at all.
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: 'cashless_x_access.date_date', measures: [{ name: 'cashless_x_checkins.count', label: 'Check-Ins', type: 'number' }], dimensions: [{ name: 'cashless_x_access.date_date', label: 'AC Date', type: 'date' }], notes: [] }] };
  looker.lookerRequest = async () => [{ 'cashless_x_checkins.count': 4 }];
  const ent = h.makeEntity('XDate Co', 'XDate-org');
  const user = h.makeClient('owl-xd@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x_checkins.count', dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.queryBody.filters['cashless_x_access.date_date'], 'today', 'still filters (best available)');
  assert.match(res.note || '', /CAUTION/, 'but flags the cross-view date');
  assert.match(res.note || '', /cashless_x_checkins/, 'names the dateless view');
});

test('a dateRange on the measured view\'s OWN date carries no caution note', async () => {
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: 'cashless_x_access.date_date', measures: [{ name: 'cashless_x_sales.revenue', label: 'Revenue', type: 'number' }], dimensions: [{ name: 'cashless_x_sales.date_date', label: 'Sales Date', type: 'date' }, { name: 'cashless_x_access.date_date', label: 'AC Date', type: 'date' }], notes: [] }] };
  looker.lookerRequest = async () => [{ 'cashless_x_sales.revenue': 120 }];
  const ent = h.makeEntity('OwnDate Co', 'OwnDate-org');
  const user = h.makeClient('owl-od@client.test', [ent.id]);
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  const res = await t.ask_cashless_x.run({ measure: 'cashless_x_sales.revenue', dateRange: 'today' }, ctx(user));
  assert.equal(res.ok, true);
  assert.equal(res.note, undefined);
});

test('an explore with a category dimension advertises subset-filtering in its tool description', () => {
  const cat = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_x', label: 'Cashless', dateDimension: '', measures: [{ name: 'cashless_x_sales.sum_credit_amount', label: 'Sale Amount', type: 'number' }], dimensions: [{ name: 'cashless_x_sales.station_category', label: 'Station Category', type: 'string' }, { name: 'cashless_x_sales.station_name', label: 'Station', type: 'string' }], notes: [] }] };
  const t = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat });
  assert.match(t.ask_cashless_x.schema.description, /SUBSET QUESTIONS/, 'subset guidance present');
  assert.match(t.ask_cashless_x.schema.description, /cashless_x_sales\.station_category/, 'names the category field');
  // No category-style dimension → no subset hint.
  const cat2 = { ...catalogue, extras: [{ model: catalogue.model, explore: 'cashless_y', label: 'Cashless', dateDimension: '', measures: [{ name: 'cashless_y.revenue', label: 'Revenue', type: 'number' }], dimensions: [{ name: 'cashless_y.method', label: 'Method', type: 'string' }], notes: [] }] };
  const t2 = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue: cat2 });
  assert.doesNotMatch(t2.ask_cashless_y.schema.description, /SUBSET QUESTIONS/);
});
