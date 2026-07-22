// Pins the idempotent Looker re-sync (server/convert.js → reconcileDashboard).
// The bug this guards: re-syncing an imported dashboard used to append every
// incoming tile because tiles carried no stable link to their Looker element, so
// "some tiles duplicated". reconcileDashboard now matches on that link (with a
// title+vis signature fallback for legacy tiles) and updates in place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convertDashboard, reconcileDashboard } = require('../server/convert');

// Minimal Looker element/source fixtures. Queries carry `model` inline so no
// query resolution (network) is needed.
const el = (id, title, vis = 'looker_bar') => ({
  id, type: 'vis', title,
  query: { model: 'm', view: 'v', fields: ['v.count'] },
  vis_config: { type: vis },
});
const source = (elements, filters = []) => ({ dashboard: { id: 'D1', title: 'Dash' }, elements, filters, layouts: [] });

test('re-sync is idempotent: same source twice adds nothing, updates in place', () => {
  const src = source([el('e1', 'Sales'), el('e2', 'Refunds')]);
  const imported = convertDashboard(src); // first import — tiles gain sourceElementId

  const r1 = reconcileDashboard(imported, src);
  assert.equal(r1.tiles.length, 2, 'no duplicates on first re-sync');
  assert.equal(r1.stats.added, 0);
  assert.equal(r1.stats.updated, 2);
  assert.deepEqual(imported.tiles.map((t) => t.id).sort(), r1.tiles.map((t) => t.id).sort(), 'local tile ids preserved');

  const r2 = reconcileDashboard(r1, src); // run it again — still a no-op
  assert.equal(r2.tiles.length, 2);
  assert.equal(r2.stats.added, 0);
});

test('a genuinely new Looker tile is appended once, not duplicated', () => {
  const imported = convertDashboard(source([el('e1', 'Sales')]));
  const withNew = reconcileDashboard(imported, source([el('e1', 'Sales'), el('e2', 'New')]));
  assert.equal(withNew.tiles.length, 2);
  assert.equal(withNew.stats.added, 1);
  // Running the same expanded source again adds nothing further.
  const again = reconcileDashboard(withNew, source([el('e1', 'Sales'), el('e2', 'New')]));
  assert.equal(again.tiles.length, 2);
  assert.equal(again.stats.added, 0);
});

test('legacy tiles (no sourceElementId) match by title+vis signature, not duplicated', () => {
  const legacy = {
    tiles: [{ id: 'old1', type: 'vis', title: 'Sales', vis: { type: 'looker_bar' }, layout: { x: 0, y: 0, w: 8, h: 6 } }],
    carousels: [], filters: [],
  };
  const r = reconcileDashboard(legacy, source([el('e1', 'Sales')]));
  assert.equal(r.tiles.length, 1, 'signature match — no duplicate');
  assert.equal(r.tiles[0].id, 'old1', 'local id kept');
  assert.equal(r.tiles[0].sourceElementId, 'e1', 'now stamped with the source id for future syncs');
  assert.equal(r.stats.added, 0);
});

test('a tile living inside a carousel updates in place (not re-added to the grid)', () => {
  const imported = convertDashboard(source([el('e1', 'Sales')]));
  const withCarousel = {
    tiles: [],
    carousels: [{ id: 'c1', title: 'Row', tiles: imported.tiles, layout: { x: 0, y: 0, w: 24, h: 8 } }],
    filters: [],
  };
  const r = reconcileDashboard(withCarousel, source([el('e1', 'Sales')]));
  assert.equal(r.tiles.length, 0, 'not appended to the grid');
  assert.equal(r.carousels[0].tiles.length, 1, 'carousel tile refreshed in place');
  assert.equal(r.stats.updated, 1);
  assert.equal(r.stats.added, 0);
});

test('filters reconcile by name: refresh in place, no duplicates', () => {
  const src = source([el('e1', 'Sales')], [{ name: 'date', title: 'Date', type: 'date', dimension: 'v.date' }]);
  const imported = convertDashboard(src);
  const r = reconcileDashboard(imported, src);
  assert.equal(r.filters.length, 1);
  assert.equal(r.stats.addedFilters, 0);
  assert.equal(r.stats.updatedFilters, 1);
});
