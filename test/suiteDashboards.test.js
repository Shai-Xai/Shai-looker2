// Dashboards attached DIRECTLY to a suite (alongside its sets) — a suite can hold
// loose dashboards without wrapping them in a set. Covers the data model
// (persist + normalise), the reachability union, access control, and that a
// direct dashboard is independent of the sets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, auth, makeEntity, makeClient } = require('./helpers');

const mkDash = (title) => db.createDashboard({ title, ownerEntityId: '', filters: [], tiles: [] });

test('a new suite has no direct dashboards', () => {
  const e = makeEntity('Acme', 'Acme');
  const su = db.createSuite({ entityId: e.id, name: 'Fest 2026' });
  assert.deepEqual(su.directDashboards, []);
});

test('updateSuite persists and normalises direct dashboards', () => {
  const e = makeEntity('Beta', 'Beta');
  const su = db.createSuite({ entityId: e.id, name: 'Beta Fest' });
  const d1 = mkDash('Sales');
  const d2 = mkDash('Attendance');
  // Mix a bare id and a full entry; whitespace-only display name clears to ''.
  const out = db.updateSuite(su.id, { directDashboards: [d1.id, { id: d2.id, displayName: '  ' }] });
  assert.equal(out.directDashboards.length, 2);
  assert.equal(out.directDashboards[0].id, d1.id);
  assert.equal(out.directDashboards[0].displayName, '');
  assert.equal(out.directDashboards[1].id, d2.id);
  // Round-trips through getSuite.
  assert.deepEqual(db.getSuite(su.id).directDashboards.map((x) => x.id), [d1.id, d2.id]);
});

test('dashboardsInSuite unions set dashboards with direct ones', () => {
  const e = makeEntity('Gamma', 'Gamma');
  const inSet = mkDash('In a set');
  const set = db.createSet({ name: 'Ticketing', dashboardIds: [inSet.id] });
  const loose = mkDash('Loose');
  const su = db.createSuite({ entityId: e.id, name: 'Gamma Fest', setIds: [set.id] });
  db.updateSuite(su.id, { directDashboards: [loose.id] });
  const ids = db.dashboardsInSuite(su.id).sort();
  assert.deepEqual(ids, [inSet.id, loose.id].sort());
});

test('a member can open a directly-attached dashboard (no set needed)', () => {
  const e = makeEntity('Delta', 'Delta');
  const loose = mkDash('Direct only');
  const su = db.createSuite({ entityId: e.id, name: 'Delta Fest' });
  const user = makeClient('owner@delta.test', [e.id], 'owner');
  // Not reachable before it's attached…
  assert.equal(auth.canAccessDashboard(user, loose), false);
  db.updateSuite(su.id, { directDashboards: [loose.id] });
  // …and reachable once it is.
  assert.equal(auth.canAccessDashboard(db.getUser(user.id), loose), true);
});

test('removing a direct dashboard does not touch any set', () => {
  const e = makeEntity('Eps', 'Eps');
  const setDash = mkDash('Set dashboard');
  const set = db.createSet({ name: 'Cashless', dashboardIds: [setDash.id] });
  const loose = mkDash('Loose dashboard');
  const su = db.createSuite({ entityId: e.id, name: 'Eps Fest', setIds: [set.id] });
  db.updateSuite(su.id, { directDashboards: [loose.id] });
  // Detach the loose one.
  db.updateSuite(su.id, { directDashboards: [] });
  assert.deepEqual(db.getSuite(su.id).directDashboards, []);
  // The set is untouched.
  assert.deepEqual(db.getSet(set.id).dashboards.map((x) => x.id), [setDash.id]);
});
