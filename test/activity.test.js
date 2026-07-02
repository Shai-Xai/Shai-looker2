// Activity module (extracted from db.js) + the P1-D perf changes:
// user_views prune/index, listUsers batching, listDashboards projection cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('recordView + reports survive the db.js → activity.js extraction', () => {
  const ent = h.makeEntity('Act Co', 'act-org');
  const d = h.seedOrganiserDashboard();
  const user = h.makeClient('act@test.local', [ent.id]);
  // Attribute the view to a suite of this entity so usageByClientForUser can map it.
  const suite = h.db.createSuite ? h.db.createSuite({ entityId: ent.id, name: 'Event' }) : null;
  h.db.recordView(user.id, suite ? suite.id : '', d.id);
  const prof = h.db.viewProfile(user.id);
  assert.ok(prof.top.some((t) => t.dashboardId === d.id), 'view is recorded and profiled');
  const report = h.db.adminActivityReport({ days: 30 });
  assert.ok(report.totals.views >= 1);
});

test('user_views is scanned by an index on `at` (not a full table scan)', () => {
  const plan = h.db.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM user_views WHERE at>=?').all("2020-01-01");
  assert.match(JSON.stringify(plan), /idx_user_views_at/);
});

test('user_entities has an entity_id index (teamMembers / scoped lookups)', () => {
  const plan = h.db.db.prepare('EXPLAIN QUERY PLAN SELECT user_id FROM user_entities WHERE entity_id=?').all('x');
  assert.match(JSON.stringify(plan), /idx_user_entities_entity/);
});

test('listUsers returns memberships correctly via the batched (non-N+1) path', () => {
  const entA = h.makeEntity('LU A', 'lua-org');
  const entB = h.makeEntity('LU B', 'lub-org');
  const u = h.makeClient('lu-multi@test.local', [entA.id, entB.id], 'owner');
  const listed = h.db.listUsers().find((x) => x.id === u.id);
  assert.ok(listed, 'user present in listUsers');
  assert.deepEqual([...listed.entityIds].sort(), [entA.id, entB.id].sort());
});

test('listDashboards projection cache reflects updates (invalidates on updated_at)', () => {
  const d = h.db.createDashboard({ title: 'Cache Me', tiles: [{ id: 't1', type: 'vis' }] });
  let row = h.db.listDashboards().find((x) => x.id === d.id);
  assert.equal(row.title, 'Cache Me');
  assert.equal(row.tileCount, 1);
  // Update → updated_at bumps → the cache must not serve the stale projection.
  h.db.updateDashboard(d.id, { title: 'Renamed', tiles: [{ id: 't1', type: 'vis' }, { id: 't2', type: 'vis' }] });
  row = h.db.listDashboards().find((x) => x.id === d.id);
  assert.equal(row.title, 'Renamed');
  assert.equal(row.tileCount, 2, 'projection refreshed after update');
});
