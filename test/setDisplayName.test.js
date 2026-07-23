// Per-Set dashboard display-name override: an admin can rename what a dashboard
// is called in the nav (sidebar/top-nav) without touching the source dashboard.
// The override lives on the set membership, so the same dashboard can carry a
// different label in each Set — and blank falls back to the native title.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');

function makeDash(title) {
  return db.createDashboard({ title, ownerEntityId: '', filters: [], tiles: [] });
}

test('display-name override persists per Set and defaults to blank (native)', () => {
  const d = makeDash('Ticketing sales');
  const set = db.createSet({ name: 'Ticketing', dashboardIds: [d.id] });
  // Defaults to blank → the native title is used downstream.
  assert.equal(db.getSet(set.id).dashboards[0].displayName, '');

  db.updateSet(set.id, { dashboards: [{ id: d.id, parentId: null, displayName: 'Sales overview' }] });
  assert.equal(db.getSet(set.id).dashboards[0].displayName, 'Sales overview');
});

test('clearing the override reverts to the native name', () => {
  const d = makeDash('Cashless topups');
  const set = db.createSet({ name: 'Cashless', dashboardIds: [{ id: d.id, parentId: null, displayName: 'Topups' }] });
  assert.equal(db.getSet(set.id).dashboards[0].displayName, 'Topups');

  db.updateSet(set.id, { dashboards: [{ id: d.id, parentId: null, displayName: '  ' }] });
  // Whitespace-only clears back to '' — the nav then falls back to the native title.
  assert.equal(db.getSet(set.id).dashboards[0].displayName, '');
});

test('the same dashboard can carry a different label in each Set', () => {
  const d = makeDash('Attendance');
  const a = db.createSet({ name: 'Set A', dashboardIds: [{ id: d.id, parentId: null, displayName: 'Foot traffic' }] });
  const b = db.createSet({ name: 'Set B', dashboardIds: [{ id: d.id, parentId: null, displayName: 'Gate scans' }] });
  assert.equal(db.getSet(a.id).dashboards[0].displayName, 'Foot traffic');
  assert.equal(db.getSet(b.id).dashboards[0].displayName, 'Gate scans');
});

test('cloning a set into a client-owned copy preserves the overrides (tenant-scoped)', () => {
  const d = makeDash('Revenue');
  const e = db.createEntity({ name: 'Acme', lockedFilters: {} });
  const shared = db.createSet({ name: 'Finance', dashboardIds: [{ id: d.id, parentId: null, displayName: 'Money in' }] });
  const copy = db.cloneSetForEntity(shared.id, e.id);
  assert.equal(copy.ownerEntityId, e.id);
  assert.equal(db.getSet(copy.id).dashboards[0].displayName, 'Money in');
  // Renaming the client copy does not touch the shared template.
  db.updateSet(copy.id, { dashboards: [{ id: d.id, parentId: null, displayName: 'Client label' }] });
  assert.equal(db.getSet(copy.id).dashboards[0].displayName, 'Client label');
  assert.equal(db.getSet(shared.id).dashboards[0].displayName, 'Money in');
});
