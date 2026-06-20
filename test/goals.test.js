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
let tileSeries = [];  // what the stubbed time-series resolver returns
let app, suiteId, entityId, goalsApi;
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
    goalsApi = require('../server/goals').mount(expressApp, {
      db: h.db,
      auth: h.auth,
      resolveTileValue: async () => tileValue,
      resolveTileSeries: async () => tileSeries,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { tileValue = 4200; tileSeries = [{ t: '2025-01-01', v: 1000 }, { t: '2025-02-01', v: 3000 }]; });

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

test('a goal stores its baseline (last time) for vs-last-time + target suggestions', async () => {
  const prev = h.db.createSuite({ entityId, name: 'Bushfire 2025' }).id; // a comparable past event
  const g = (await create(owner, {
    name: 'Sell-through YoY', source: 'ticketing', targetValue: 20000, unit: 'tickets',
    metricRef: { dashboardId: 'd', tileId: 't' },
    baselineEventId: prev, baselineValue: 17500, baselineSource: 'looker',
  })).body.goal;
  assert.equal(g.baselineEventId, prev, 'remembers which event it was baselined against');
  assert.equal(g.baselineValue, 17500, 'remembers last time’s number');
  // The baseline persists (and can be revised) through an edit.
  const upd = (await app.req('PUT', `/api/goals/${g.id}`, { as: owner, body: { baselineValue: 18000 } })).body.goal;
  assert.equal(upd.baselineValue, 18000);
  assert.equal(upd.baselineEventId, prev, 'editing one field keeps the baseline event');
});

test('milestones persist in date order and survive an edit', async () => {
  const g = (await create(owner, {
    name: 'Sell-through curve', source: 'manual', targetValue: 25000, unit: 'tickets',
    milestones: [{ byDate: '2026-06-20', targetValue: 9000 }, { byDate: '2026-06-10', targetValue: 4000 }],
  })).body.goal;
  assert.equal(g.milestones.length, 2);
  assert.deepEqual(g.milestones.map((m) => m.byDate), ['2026-06-10', '2026-06-20'], 'kept in date order');
  const upd = (await app.req('PUT', `/api/goals/${g.id}`, { as: owner, body: { milestones: [{ byDate: '2026-06-15', targetValue: 6000 }] } })).body.goal;
  assert.equal(upd.milestones.length, 1);
  assert.equal(upd.milestones[0].targetValue, 6000);
});

test('pace is measured against the nearest checkpoint (milestone-aware)', () => {
  const day = 86400000, now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const goal = {
    createdAt: iso(now - 10 * day), byDate: iso(now + 10 * day),
    targetValue: 1000, direction: 'at_least',
    milestones: [{ byDate: iso(now), targetValue: 800 }], // a checkpoint due ~now at 800
  };
  // With the checkpoint, "expected by now" is ~800 (the checkpoint), not the linear ~500.
  const p = goalsApi.computeProgress(goal, 400);
  assert.ok(Math.abs(p.expected - 800) <= 5, `expected ≈ 800, got ${p.expected}`);
  assert.equal(p.status, 'behind', '400 is well under the 800 checkpoint → behind');
  // Comfortably above the expected-by-now line reads "ahead" even before hitting target.
  assert.equal(goalsApi.computeProgress(goal, 900).status, 'ahead', '900 vs ~800 expected (target 1000) → ahead of pace');
  // Without milestones the same goal sits on the straight line (~500 at the midpoint).
  const linear = goalsApi.computeProgress({ ...goal, milestones: [] }, 400);
  assert.ok(linear.expected < 600, `linear expected ~500, got ${linear.expected}`);
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

test('a member without goals.manage can create their OWN personal goal (not an event goal)', async () => {
  assert.equal((await create(viewer, { name: 'Nope event', source: 'manual', targetValue: 1, scope: 'event' })).status, 403, 'still cannot create an event goal');
  const r = await create(viewer, { name: 'My personal push', source: 'manual', targetValue: 100, scope: 'personal' });
  assert.equal(r.status, 201);
  assert.equal(r.body.goal.scope, 'personal');
  assert.equal(r.body.goal.ownerRef, 'g-viewer@test.local', 'owned by the creator');
});

test('personal-goal visibility: private is owner + admin only; team is shared', async () => {
  const sid = h.db.createSuite({ entityId, name: 'Visibility test' }).id;
  await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Secret', source: 'manual', targetValue: 1, scope: 'personal', visibility: 'private' } });
  await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Shared', source: 'manual', targetValue: 1, scope: 'personal', visibility: 'team' } });
  const seenBy = async (as) => (await app.req('GET', `/api/goals/suites/${sid}`, { as })).body.personalGoals.map((g) => g.name).sort();
  assert.deepEqual(await seenBy(owner), ['Secret', 'Shared'], 'owner sees both');
  assert.deepEqual(await seenBy(viewer), ['Shared'], 'another member sees only the team-visible one');
  assert.deepEqual(await seenBy(admin), ['Secret', 'Shared'], 'admin sees both');
});

test('a personal goal rolls up to an event goal; only its owner (or admin) can edit it', async () => {
  const sid = h.db.createSuite({ entityId, name: 'Rollup test' }).id;
  const event = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Event NS', source: 'manual', targetValue: 1000 } })).body.goal;
  const personal = (await app.req('POST', `/api/goals/suites/${sid}`, { as: viewer, body: { name: 'My bit', source: 'manual', targetValue: 200, scope: 'personal', rollsUpTo: event.id } })).body.goal;
  assert.equal(personal.rollsUpTo, event.id, 'remembers the parent event goal');
  assert.equal((await app.req('PUT', `/api/goals/${personal.id}`, { as: viewer, body: { targetValue: 250 } })).status, 200, 'owner can edit');
  assert.equal((await app.req('PUT', `/api/goals/${personal.id}`, { as: owner, body: { targetValue: 999 } })).status, 403, 'another member (even with goals.manage) cannot');
  assert.equal((await app.req('PUT', `/api/goals/${personal.id}`, { as: admin, body: { targetValue: 300 } })).status, 200, 'admin can');
});

test('tile-series returns last time’s curve to a member and is denied to outsiders', async () => {
  const ok = await app.req('POST', `/api/goals/suites/${suiteId}/tile-series`, { as: owner, body: { dashboardId: 'd', tileId: 't' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.series, [{ t: '2025-01-01', v: 1000 }, { t: '2025-02-01', v: 3000 }], 'returns the resolved series');
  assert.equal((await app.req('POST', `/api/goals/suites/${suiteId}/tile-series`, { as: outsider, body: { dashboardId: 'd', tileId: 't' } })).status, 403, 'outsider is blocked');
});

test('a goal remembers its linked checkpoint-curve tile across edits', async () => {
  const g = (await create(owner, {
    name: 'Curve link', source: 'manual', targetValue: 50000, unit: 'tickets',
    curveRef: { dashboardId: 'dash9', tileId: 'trend7', cadence: 'weekly' },
  })).body.goal;
  assert.deepEqual(g.curveRef, { dashboardId: 'dash9', tileId: 'trend7', cadence: 'weekly' }, 'curve link is stored');
  // Editing another field keeps the link.
  const upd = (await app.req('PUT', `/api/goals/${g.id}`, { as: owner, body: { targetValue: 60000 } })).body.goal;
  assert.deepEqual(upd.curveRef, { dashboardId: 'dash9', tileId: 'trend7', cadence: 'weekly' }, 'link survives an edit');
});
