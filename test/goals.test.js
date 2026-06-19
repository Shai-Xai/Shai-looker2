// Pins for the Goals module (server/goals.js) — the Results pillar foundation.
// Locks the behaviour that matters for P1: the source-aware resolver (manual
// snapshot + tile-sourced via the injected query path), exactly-one-North-Star,
// progress math, and the dual-surface access guards (goals.manage to write,
// suite membership to view).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

let tileValue = 4200; // what the stubbed tile resolver returns
let app, suiteId, entityId;
let owner, viewer, outsider, admin;

before(async () => {
  const ent = h.makeEntity('Goals Co', 'Goals-org');
  entityId = ent.id;
  suiteId = h.db.createSuite({ entityId, name: 'Bushfire 2026' }).id;
  owner = h.makeClient('g-owner@test.local', [entityId], 'owner');     // has goals.manage
  viewer = h.makeClient('g-viewer@test.local', [entityId], 'viewer');  // no goals.manage
  outsider = h.makeClient('g-out@test.local', [h.makeEntity('Other', 'o-org').id], 'owner');
  admin = h.makeAdmin('g-admin@test.local');
  app = await startApp((expressApp) => {
    require('../server/goals').mount(expressApp, {
      db: h.db,
      auth: h.auth,
      resolveTileValue: async () => tileValue,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { tileValue = 4200; });

const create = (as, body) => app.req('POST', `/api/goals/suites/${suiteId}`, { as, body });
const list = (as) => app.req('GET', `/api/goals/suites/${suiteId}`, { as });

test('the first event goal becomes the North Star automatically', async () => {
  const r = await create(owner, { name: 'Sell-through', source: 'manual', targetValue: 25000, unit: 'tickets' });
  assert.equal(r.status, 201);
  const got = await list(owner);
  assert.equal(got.status, 200);
  assert.equal(got.body.goals.length, 1);
  assert.equal(got.body.goals[0].isNorthStar, true, 'first goal leads as North Star');
});

test('exactly one North Star — setting a new one clears the previous', async () => {
  const second = (await create(owner, { name: 'Bar revenue', source: 'manual', targetValue: 500000, unit: 'ZAR' })).body.goal;
  assert.equal(second.isNorthStar, false, 'a later goal is not the North Star by default');
  const moved = await app.req('PUT', `/api/goals/${second.id}`, { as: owner, body: { isNorthStar: true } });
  assert.equal(moved.status, 200);
  const stars = (await list(owner)).body.goals.filter((g) => g.isNorthStar);
  assert.equal(stars.length, 1, 'still exactly one North Star');
  assert.equal(stars[0].id, second.id, 'the star moved to the new goal');
});

test('a manual goal resolves from its latest snapshot, with progress %', async () => {
  const g = (await create(owner, { name: 'Sponsorship secured', source: 'manual', targetValue: 200000, unit: 'ZAR' })).body.goal;
  assert.equal((await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 100000 } })).status, 201);
  const row = (await list(owner)).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.value, 100000);
  assert.equal(row.progress.pct, 50, 'halfway to a 200k target');
});

test('a tile-sourced goal reads the live tile number through the resolver', async () => {
  tileValue = 4200;
  const g = (await create(owner, {
    name: 'Tickets sold', source: 'ticketing', targetValue: 5000, unit: 'tickets',
    metricRef: { dashboardId: 'dash1', tileId: 'tileA' },
  })).body.goal;
  const row = (await list(owner)).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.value, 4200, 'value comes from the (stubbed) tile resolver');
  assert.equal(row.progress.pct, 84);
});

test('writes need goals.manage; views need suite membership', async () => {
  // A viewer (no goals.manage) can SEE goals but not create them.
  assert.equal((await list(viewer)).status, 200);
  assert.equal((await create(viewer, { name: 'Nope', source: 'manual', targetValue: 1 })).status, 403);
  // A non-member of the suite's entity can't even view.
  assert.equal((await list(outsider)).status, 403);
  // Admin can manage any suite.
  assert.equal((await create(admin, { name: 'Admin goal', source: 'manual', targetValue: 1 })).status, 201);
});

test('deleting the North Star promotes the next goal so one always leads', async () => {
  // Fresh suite to isolate the invariant.
  const sid = h.db.createSuite({ entityId, name: 'Promote test' }).id;
  const a = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'A', source: 'manual', targetValue: 1 } })).body.goal;
  const b = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'B', source: 'manual', targetValue: 1 } })).body.goal;
  assert.equal(a.isNorthStar, true);
  assert.equal((await app.req('DELETE', `/api/goals/${a.id}`, { as: owner })).status, 204);
  const after = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, b.id);
  assert.equal(after[0].isNorthStar, true, 'B was promoted to North Star');
});

test('the editor can preview a tile\'s live value before the goal is saved', async () => {
  tileValue = 1234;
  const r = await app.req('POST', `/api/goals/suites/${suiteId}/tile-value`, { as: owner, body: { dashboardId: 'd', tileId: 't' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.value, 1234);
  // A non-member can't preview another tenant's tile value.
  assert.equal((await app.req('POST', `/api/goals/suites/${suiteId}/tile-value`, { as: outsider, body: { dashboardId: 'd', tileId: 't' } })).status, 403);
});

test('a goal remembers its chosen display (bar / ring / dial)', async () => {
  const g = (await create(owner, { name: 'Dial goal', source: 'manual', targetValue: 10, display: 'dial' })).body.goal;
  assert.equal(g.display, 'dial');
  const upd = (await app.req('PUT', `/api/goals/${g.id}`, { as: owner, body: { display: 'ring' } })).body.goal;
  assert.equal(upd.display, 'ring', 'display change persists through update');
});

test('goals list in position order; updating position reorders them (drag-reorder)', async () => {
  const sid = h.db.createSuite({ entityId, name: 'Order test' }).id;
  const mk = (name) => app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name, source: 'manual', targetValue: 1 } });
  const a = (await mk('A')).body.goal;
  const b = (await mk('B')).body.goal;
  const c = (await mk('C')).body.goal;
  const namesNow = async () => (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.map((g) => g.name);
  assert.deepEqual(await namesNow(), ['A', 'B', 'C'], 'defaults to creation order');
  // Drag C to the front: persist new positions (what the widget does).
  await app.req('PUT', `/api/goals/${c.id}`, { as: owner, body: { position: 0 } });
  await app.req('PUT', `/api/goals/${a.id}`, { as: owner, body: { position: 1 } });
  await app.req('PUT', `/api/goals/${b.id}`, { as: owner, body: { position: 2 } });
  assert.deepEqual(await namesNow(), ['C', 'A', 'B'], 'order follows position, not North-Star-first');
});
