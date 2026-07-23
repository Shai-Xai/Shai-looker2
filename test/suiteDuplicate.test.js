// Duplicating a suite must produce an INDEPENDENT copy that isn't born broken:
// client-owned dashboards are cloned (tile ids preserved so daysBeforeSync +
// tileId-keyed locks survive), shared templates are referenced, and every
// dashboard-id reference (set membership, dashboardLocks, liveDashboardId,
// exclusions) repoints onto the copies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createDuplicator = require('../server/suiteDuplicate');

const { duplicateSuite } = createDuplicator(h.db);

test('duplicateSuite clones owned dashboards, references shared ones, remaps every id', () => {
  const entity = h.makeEntity('Dupe Co', 'Org X');
  // A client-owned dashboard with a days-to-go sync pointing at one of its tiles…
  const owned = h.db.createDashboard({ title: 'Overview', ownerEntityId: entity.id,
    tiles: [{ id: 'tile-days', type: 'vis', title: 'Days To Go', query: { model: 'm', view: 'v', fields: ['core_events.days_before'] } }] });
  // daysBeforeSync isn't in createDashboard's whitelist — the editor saves it via
  // updateDashboard, so do the same here to persist it on the source.
  h.db.updateDashboard(owned.id, { daysBeforeSync: { mode: 'apply', sourceTileId: 'tile-days', filterName: 'Days Before Event', expr: '>={n}' } });
  // …and a SHARED template dashboard (no owner) that should be referenced, not copied.
  const shared = h.db.createDashboard({ title: 'Shared template', ownerEntityId: '' });
  const set = h.db.createSet({ name: 'Bundle', ownerEntityId: entity.id, dashboardIds: [owned.id, shared.id] });
  const suite = h.db.createSuite({ entityId: entity.id, name: 'M&C JHB', setIds: [set.id] });
  h.db.updateSuite(suite.id, { dashboardLocks: { [owned.id]: { 'Days Before Event': '>=-179' } }, liveDashboardId: owned.id, excludedDashboards: [] });

  const copy = duplicateSuite(suite.id, {});
  assert.ok(copy && copy.id !== suite.id, 'a new suite is created');
  assert.equal(copy.name, 'M&C JHB (copy)');
  assert.equal(copy.entityId, entity.id);

  // New set, new membership.
  assert.equal(copy.setIds.length, 1);
  assert.notEqual(copy.setIds[0], set.id);
  const copySet = h.db.getSet(copy.setIds[0]);
  const ids = copySet.dashboards.map((d) => d.id);
  assert.equal(ids.length, 2);

  // The owned dashboard was CLONED (new id, still owned), the shared one REFERENCED.
  assert.ok(ids.includes(shared.id), 'shared template is referenced as-is');
  const newOwnedId = ids.find((id) => id !== shared.id);
  assert.notEqual(newOwnedId, owned.id, 'owned dashboard got a fresh id');
  const clone = h.db.getDashboard(newOwnedId);
  assert.equal(clone.ownerEntityId, entity.id);
  // Tile ids preserved → the days-to-go sync source still resolves in the copy.
  assert.equal(clone.tiles[0].id, 'tile-days');
  assert.equal(clone.daysBeforeSync.sourceTileId, 'tile-days');

  // Dashboard-id-keyed structures repoint onto the clone, not the source.
  assert.deepEqual(copy.dashboardLocks, { [newOwnedId]: { 'Days Before Event': '>=-179' } });
  assert.equal(copy.liveDashboardId, newOwnedId);

  // The ORIGINAL is untouched (independent copy).
  const orig = h.db.getSuite(suite.id);
  assert.equal(orig.setIds[0], set.id);
  assert.equal(orig.liveDashboardId, owned.id);
});
