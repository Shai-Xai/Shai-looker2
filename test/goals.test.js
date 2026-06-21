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
let tileColumns = null; // optional explicit columns for the all-columns resolver
let eventDate = null; // what the stubbed Looker event-date resolver returns
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
      resolveTileSeriesAll: async () => tileColumns || { columns: [{ key: 'one', series: tileSeries }] },
      resolveEventDate: async () => eventDate,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { tileValue = 4200; tileSeries = [{ t: '2025-01-01', v: 1000 }, { t: '2025-02-01', v: 3000 }]; tileColumns = null; eventDate = null; });

const create = (as, body) => app.req('POST', `/api/goals/suites/${suiteId}`, { as, body });
const list = (as) => app.req('GET', `/api/goals/suites/${suiteId}`, { as });

test('a goal can be saved as a reusable template, listed, applied and deleted', async () => {
  const sid = h.db.createSuite({ entityId, name: 'Template test' }).id;
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Monthly revenue', source: 'manual', targetValue: 30000, unit: 'ZAR', direction: 'at_least' } })).body.goal;
  // Save from the goal — server captures the reusable config.
  const made = await app.req('POST', '/api/goals/templates', { as: owner, body: { fromGoalId: g.id } });
  assert.equal(made.status, 201, 'template created');
  assert.equal(made.body.template.name, 'Monthly revenue');
  assert.equal(made.body.template.payload.targetValue, 30000, 'payload carries the reusable target');
  assert.equal(made.body.template.payload.unit, 'ZAR');
  // Listed for the entity, denied to an outsider.
  const list1 = await app.req('GET', `/api/goals/templates/${entityId}`, { as: owner });
  assert.ok(list1.body.templates.some((t) => t.id === made.body.template.id), 'template appears in the list');
  assert.equal((await app.req('GET', `/api/goals/templates/${entityId}`, { as: outsider })).status, 403, 'outsider blocked');
  // Delete it.
  assert.equal((await app.req('DELETE', `/api/goals/templates/${made.body.template.id}`, { as: owner })).status, 200);
  assert.equal((await app.req('GET', `/api/goals/templates/${entityId}`, { as: owner })).body.templates.filter((t) => t.id === made.body.template.id).length, 0, 'gone after delete');
});

test('an admin can publish a GLOBAL template available to every client', async () => {
  const sid = h.db.createSuite({ entityId, name: 'Global tmpl test' }).id;
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Std monthly', source: 'manual', targetValue: 5000, unit: 'ZAR', curveRef: { dashboardId: 'd', tileId: 't', cadence: 'monthly', compareKey: '2025' } } })).body.goal;
  // A client cannot publish a global template.
  assert.equal((await app.req('POST', '/api/goals/templates', { as: owner, body: { fromGoalId: g.id, global: true } })).status, 403, 'non-admin blocked from global');
  // An admin can — and it strips the client-specific tile refs to a portable scaffold.
  const made = await app.req('POST', '/api/goals/templates', { as: admin, body: { fromGoalId: g.id, global: true } });
  assert.equal(made.status, 201);
  assert.equal(made.body.template.global, true);
  // Global templates KEEP the dashboard/tile reference (re-resolved per client by name).
  assert.equal(made.body.template.payload.curveRef.tileId, 't', 'global keeps the curve tile reference');
  assert.equal(made.body.template.payload.curveRef.cadence, 'monthly');
  assert.equal(made.body.template.payload.targetValue, 5000, 'global keeps the measurable definition');
  // It shows in a client's template list.
  const listed = await app.req('GET', `/api/goals/templates/${entityId}`, { as: owner });
  assert.ok(listed.body.templates.some((t) => t.id === made.body.template.id && t.global), 'global shows for the client');
  // A client cannot delete a global; an admin can.
  assert.equal((await app.req('DELETE', `/api/goals/templates/${made.body.template.id}`, { as: owner })).status, 403, 'client cannot delete a global');
  assert.equal((await app.req('DELETE', `/api/goals/templates/${made.body.template.id}`, { as: admin })).status, 200, 'admin deletes the global');
});

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

test('checkpoint-suggestions align to days-before-event (same math as the live pace), not row position', async () => {
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Last time's curve on a days-before-event axis: cumulative 1000→10000 at 30,20,10,0 days out.
  tileColumns = { columns: [{ key: 'one', series: [
    { t: '30', v: 1000 }, { t: '20', v: 3000 }, { t: '10', v: 6000 }, { t: '0', v: 10000 },
  ] }] };
  const r = await app.req('POST', `/api/goals/suites/${suiteId}/checkpoint-suggestions`, { as: owner, body: {
    dashboardId: 'd', tileId: 't', cadence: 'weekly',
    startDate: iso(Date.now() - 30 * day), byDate: iso(Date.now() + 10 * day), // event in 10 days
  } });
  assert.equal(r.status, 200);
  assert.ok(r.body.checkpoints.length >= 2, 'produces checkpoints');
  // The checkpoint nearest the event lands 5 days out → days-before interp = 8000 (0.8),
  // NOT the naive row-position read (which would give 8500). That proves the alignment.
  const last = r.body.checkpoints[r.body.checkpoints.length - 1];
  assert.equal(last.lastValue, 8000, 'last time read by days-before-event, not row position');
  assert.ok(Math.abs(last.fraction - 0.8) < 1e-6, 'fraction is of last time’s total at that days-before point');
  assert.equal(last.basis, 'days-before', 'used the days-before axis');
  // Outsider is blocked.
  assert.equal((await app.req('POST', `/api/goals/suites/${suiteId}/checkpoint-suggestions`, { as: outsider, body: { dashboardId: 'd', tileId: 't' } })).status, 403);
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

test('a goal remembers its baseline tile and re-reads "last time" live from it', async () => {
  tileValue = 12345; // resolveTileValue stub → what the baseline tile reads live
  const g = (await create(owner, {
    name: 'Baseline link', source: 'manual', targetValue: 20000, unit: 'tickets',
    baselineRef: { dashboardId: 'dashB', tileId: 'kpiLastYear' },
  })).body.goal;
  assert.deepEqual(g.baselineRef, { dashboardId: 'dashB', tileId: 'kpiLastYear' }, 'baseline tile link is stored');
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 5000 } });
  const row = (await list(owner)).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.baselineFinal, 12345, 'last time is re-read live from the linked tile, not a stale snapshot');
  // Link survives an unrelated edit.
  const upd = (await app.req('PUT', `/api/goals/${g.id}`, { as: owner, body: { targetValue: 25000 } })).body.goal;
  assert.deepEqual(upd.baselineRef, { dashboardId: 'dashB', tileId: 'kpiLastYear' }, 'baseline link survives an edit');
});

test('a CURVE goal anchors days-to-go to the event date (briefing), not the typed by_date', async () => {
  const day = 86400000;
  const sid = h.db.createSuite({ entityId, name: 'Anchor test' }).id;
  // Event is 13 days out per the suite briefing; the goal's own by_date is 2 days early.
  const eventDate = new Date(Date.now() + 13 * day).toISOString().slice(0, 10);
  const byDate = new Date(Date.now() + 11 * day).toISOString().slice(0, 10);
  h.db.updateSuite(sid, { briefing: { eventStart: eventDate } });
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Anchored', source: 'manual', targetValue: 1000, unit: 'tickets', byDate, curveRef: { dashboardId: 'd', tileId: 't' } } })).body.goal;
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 500 } });
  const row = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.daysLeft, 13, 'curve goal: days-to-go follows the event date, not the goal by_date');
});

test('a NON-curve goal keeps its own deadline (the event date does not trample it)', async () => {
  const day = 86400000;
  const sid = h.db.createSuite({ entityId, name: 'Own deadline test' }).id;
  // Event is 13 days out, but this goal has its own 5-day deadline (e.g. early-bird).
  h.db.updateSuite(sid, { briefing: { eventStart: new Date(Date.now() + 13 * day).toISOString().slice(0, 10) } });
  const byDate = new Date(Date.now() + 5 * day).toISOString().slice(0, 10);
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Early bird', source: 'manual', targetValue: 1000, unit: 'tickets', byDate } })).body.goal;
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 500 } });
  const row = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.daysLeft, 5, 'non-curve goal keeps its own by_date, not the event date');
});

test('Looker’s event start date wins over the briefing and the typed by_date', async () => {
  const day = 86400000;
  const sid = h.db.createSuite({ entityId, name: 'Looker anchor test' }).id;
  // Briefing says 11 days; goal by_date says 9; Looker says 20 — Looker must win.
  h.db.updateSuite(sid, { briefing: { eventStart: new Date(Date.now() + 11 * day).toISOString().slice(0, 10) } });
  eventDate = new Date(Date.now() + 20 * day).toISOString().slice(0, 10);
  const byDate = new Date(Date.now() + 9 * day).toISOString().slice(0, 10);
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'Looker anchored', source: 'manual', targetValue: 1000, unit: 'tickets', byDate, curveRef: { dashboardId: 'd', tileId: 't' } } })).body.goal;
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 500 } });
  const row = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.daysLeft, 20, 'days-to-go uses the live Looker event date');
});

test('a day-of-month curve reads "last time at now" on the SAME calendar day (not proportional)', async () => {
  const day = 86400000;
  const sid = h.db.createSuite({ entityId, name: 'Calendar-day read test' }).id;
  // Window: started 20 days ago, deadline 10 days out → 30-day window, but the curve
  // spans 31 day-of-month points. "Now" = elapsed day 20 → calendar day 21.
  const startDate = new Date(Date.now() - 20 * day).toISOString().slice(0, 10);
  const byDate = new Date(Date.now() + 10 * day).toISOString().slice(0, 10);
  // Last year's cumulative-by-day-of-month: day d = d × 1000 (so day 21 = 21000).
  const series = Array.from({ length: 31 }, (_, i) => ({ t: String(i + 1), v: (i + 1) * 1000 }));
  tileColumns = { columns: [{ key: '2025', series }, { key: '2026', series: series.slice(0, 21).map((p) => ({ ...p, v: p.v * 1.5 })) }] };
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'MTD revenue', source: 'manual', targetValue: 60000, unit: 'ZAR', startDate, byDate, curveRef: { dashboardId: 'd', tileId: 't' } } })).body.goal;
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 31500 } });
  const row = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.find((x) => x.id === g.id);
  // Same calendar day (21) → 21000; proportional index over 31 pts would over-read ~21700.
  assert.ok(Math.abs(row.progress.lastAtNow - 21000) <= 200, `last time read on day 21 (~21000), got ${row.progress.lastAtNow}`);
});

test('a FORWARD/calendar curve (day-of-month) keeps the goal by_date, not the event date', async () => {
  const day = 86400000;
  const sid = h.db.createSuite({ entityId, name: 'Calendar curve test' }).id;
  // Event (briefing) is 40 days out, but this is a monthly goal with a 9-day by_date.
  h.db.updateSuite(sid, { briefing: { eventStart: new Date(Date.now() + 40 * day).toISOString().slice(0, 10) } });
  const byDate = new Date(Date.now() + 9 * day).toISOString().slice(0, 10);
  // Cumulative-by-day-of-month curve: value RISES as the axis number rises (forward).
  tileColumns = { columns: [{ key: '2025', series: [{ t: '1', v: 100 }, { t: '10', v: 1000 }, { t: '20', v: 2200 }, { t: '31', v: 3000 }] }] };
  const g = (await app.req('POST', `/api/goals/suites/${sid}`, { as: owner, body: { name: 'June revenue', source: 'manual', targetValue: 6000, unit: 'ZAR', byDate, curveRef: { dashboardId: 'd', tileId: 't' } } })).body.goal;
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 1500 } });
  const row = (await app.req('GET', `/api/goals/suites/${sid}`, { as: owner })).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.daysLeft, 9, 'a calendar/day-of-month curve keeps the goal by_date, not the 40-day event');
});

test('a linked curve drives baseline + vs-last-time-at-this-point, with pace over the window', async () => {
  const day = 86400000;
  const start = new Date(Date.now() - 10 * day).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 10 * day).toISOString().slice(0, 10);
  // Stubbed curve: cumulative [1000, 3000], total 3000. Midpoint of the window → ~2/3.
  const g = (await create(owner, {
    name: 'Curve pace', source: 'manual', targetValue: 6000, unit: 'tickets',
    startDate: start, byDate: end, curveRef: { dashboardId: 'd', tileId: 't', cadence: 'weekly' },
  })).body.goal;
  assert.equal(g.startDate, start, 'remembers the track-from date');
  await app.req('POST', `/api/goals/${g.id}/snapshot`, { as: owner, body: { value: 2500 } });
  const row = (await list(owner)).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.baselineFinal, 3000, 'baseline = the curve total');
  assert.ok(row.progress.lastAtNow > 1000 && row.progress.lastAtNow < 3000, 'last time read at a mid-window point of the curve');
  // expected-by-now rides the same curve fraction, scaled to the target (2× the curve total).
  assert.ok(Math.abs(row.progress.expected - 2 * row.progress.lastAtNow) <= 2, 'expected = target × the same curve fraction');
  // Forecast: the SHAPE signal = current ÷ fraction of last time's shape reached at
  // this point (current is the curve's this-year value; fraction = lastAtNow / total).
  assert.ok(row.progress.forecast && row.progress.forecast.projected != null, 'a curve goal carries a forecast');
  const expShape = Math.round(row.progress.value / (row.progress.lastAtNow / 3000));
  assert.ok(Math.abs(row.progress.forecast.shape - expShape) <= 2, 'shape projection = current ÷ fraction of last time’s shape reached');
  // projected blends shape with recent momentum, so it sits between the two signals.
  const lo = Math.min(row.progress.forecast.shape, row.progress.forecast.momentum);
  const hi = Math.max(row.progress.forecast.shape, row.progress.forecast.momentum);
  assert.ok(row.progress.forecast.projected >= lo - 2 && row.progress.forecast.projected <= hi + 2, 'projected sits between the shape and momentum signals');
});

test('a curve goal reads its CURRENT value from the curve tile (this-year), not a drifting KPI tile', async () => {
  // The KPI tile says 43 310, but the curve tile's own this-year running total is 44 810.
  // A curve-linked goal must show the curve number so the card == curve == dashboard.
  tileValue = 43310; // resolveMetric (the separate KPI tile) — should be IGNORED
  tileColumns = { columns: [
    { key: '2025', series: [{ t: '10', v: 20000 }, { t: '5', v: 40000 }, { t: '0', v: 55997 }] }, // last year (shape)
    { key: '2026', series: [{ t: '10', v: 18000 }, { t: '5', v: 36000 }, { t: '0', v: 44810 }] }, // this year (current)
  ] };
  const day = 86400000;
  const g = (await create(owner, {
    name: 'Curve current', source: 'tile', targetValue: 60500, unit: 'tickets',
    startDate: new Date(Date.now() - 10 * day).toISOString().slice(0, 10),
    byDate: new Date(Date.now() + 5 * day).toISOString().slice(0, 10),
    metricRef: { dashboardId: 'd', tileId: 'kpi' },
    curveRef: { dashboardId: 'd', tileId: 'trend' },
  })).body.goal;
  const row = (await list(owner)).body.goals.find((x) => x.id === g.id);
  assert.equal(row.progress.value, 44810, 'current = the curve tile this-year total, not the 43 310 KPI tile');
  assert.equal(row.progress.resolvedSource, 'curve-this-year', 'source reflects the curve anchor');
  assert.equal(row.progress.baselineFinal, 55997, 'baseline still = last year’s curve total');
});
