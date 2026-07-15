// Re-sync merge: refresh Looker content while preserving every Pulse edit. Tests
// the pure mergeDef (no Looker I/O) — matching by element id and by fallback
// signature, tile preservation, carousels, removed/added tiles, and filters.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createResync = require('../server/resync');

const { mergeDef } = createResync({ looker: {}, fetchDashboard: () => {}, convertDashboard: () => {} });

// A current Pulse def that layered edits on top of a 2-tile Looker import.
const current = () => ({
  title: 'KFF Overview', theme: { brand: '#000' }, aiContext: 'be concise',
  ownerEntityId: 'ent-9', folder: 'KFF/27', keepImportedFilters: true,
  daysBeforeSync: { mode: 'apply', sourceTileId: 't-sales' },
  filters: [{ id: 'f1', name: 'Event', title: 'Event', type: 'field', field: 'core_events.name', default_value: 'KFF27' }],
  tiles: [
    { id: 't-sales', sourceElementId: '100', type: 'vis', title: 'Sales', query: { model: 'm', view: 'v', fields: ['a'] }, vis: { type: 'single' }, layout: { x: 0, y: 0, w: 4, h: 3 }, hidden: false },
    { id: 't-note', type: 'text', title: 'Note', body_text: 'Pulse-only note' }, // added in Pulse (no sourceElementId)
  ],
  carousels: [{ id: 'c1', title: 'Trends', tiles: [
    { id: 't-trend', sourceElementId: '101', type: 'vis', title: 'Trend', query: { model: 'm', view: 'v', fields: ['b'] }, vis: { type: 'line' }, layout: { x: 0, y: 0, w: 8, h: 4 } },
  ] }],
  source: { lookerDashboardId: '555' },
});

test('matched tiles refresh Looker content but keep id, layout and Pulse-only fields', () => {
  const fresh = {
    title: 'KFF Overview (Looker)', filters: current().filters,
    tiles: [
      { id: 'x', sourceElementId: '100', type: 'vis', title: 'Sales (updated)', query: { model: 'm', view: 'v', fields: ['a', 'a2'] }, vis: { type: 'single', big: true }, layout: { x: 9, y: 9, w: 1, h: 1 } },
      { id: 'y', sourceElementId: '101', type: 'vis', title: 'Trend', query: { model: 'm', view: 'v2', fields: ['b'] }, vis: { type: 'area' }, layout: { x: 0, y: 0, w: 8, h: 4 } },
    ],
    source: { lookerDashboardId: '555' },
  };
  const { def, summary } = mergeDef(current(), fresh);
  assert.equal(summary.updated, 2);
  assert.equal(summary.added, 0);

  const sales = def.tiles.find((t) => t.id === 't-sales');
  assert.ok(sales, 'tile id preserved (so days-to-go sync + locks keep working)');
  assert.deepEqual(sales.query.fields, ['a', 'a2'], 'query refreshed from Looker');
  assert.equal(sales.title, 'Sales (updated)', 'title refreshed');
  assert.equal(sales.vis.big, true, 'vis refreshed');
  assert.deepEqual(sales.layout, { x: 0, y: 0, w: 4, h: 3 }, 'Pulse arrangement preserved (not Looker layout)');

  // The carousel tile updates IN PLACE, keeping its id and carousel membership.
  const carTile = def.carousels[0].tiles.find((t) => t.id === 't-trend');
  assert.ok(carTile && carTile.query.view === 'v2', 'carousel tile refreshed in place');

  // Dashboard-level Pulse state survives.
  assert.equal(def.daysBeforeSync.sourceTileId, 't-sales');
  assert.equal(def.aiContext, 'be concise');
  assert.equal(def.ownerEntityId, 'ent-9');
  assert.equal(def.keepImportedFilters, true);
  assert.equal(def.title, 'KFF Overview', 'Pulse title kept (not overwritten by Looker)');
});

test('new Looker tiles are added; removed ones are kept + reported; Pulse tiles untouched', () => {
  const fresh = {
    filters: current().filters,
    tiles: [
      { id: 'x', sourceElementId: '100', type: 'vis', title: 'Sales', query: { model: 'm', view: 'v', fields: ['a'] }, vis: {}, layout: {} },
      // element 101 (Trend) is GONE from Looker; a brand-new element 102 appears.
      { id: 'z', sourceElementId: '102', type: 'vis', title: 'Refunds', query: { model: 'm', view: 'v', fields: ['r'] }, vis: {}, layout: { x: 0, y: 5, w: 4, h: 3 } },
    ],
    source: { lookerDashboardId: '555' },
  };
  const { def, summary } = mergeDef(current(), fresh);
  assert.equal(summary.added, 1);
  assert.equal(summary.removedInLooker, 1, 'the Trend tile is flagged as gone from Looker');
  assert.ok(summary.added_.includes('Refunds'));

  assert.ok(def.tiles.some((t) => t.title === 'Refunds'), 'new tile added top-level');
  assert.ok(def.carousels[0].tiles.some((t) => t.id === 't-trend'), 'removed-from-Looker tile is KEPT, not deleted');
  assert.ok(def.tiles.some((t) => t.id === 't-note' && t.body_text === 'Pulse-only note'), 'Pulse-added text tile untouched');
});

test('legacy tiles (no element id) match by signature and get stamped for next time', () => {
  const cur = current();
  delete cur.tiles[0].sourceElementId; // simulate a pre-element-id import
  const fresh = {
    filters: cur.filters,
    // same title+model+view+fields (signature matches) but a changed vis → a real update
    tiles: [{ id: 'x', sourceElementId: '100', type: 'vis', title: 'Sales', query: { model: 'm', view: 'v', fields: ['a'] }, vis: { type: 'single', big: true }, layout: {} }],
    source: { lookerDashboardId: '555' },
  };
  const { def, summary } = mergeDef(cur, fresh);
  assert.equal(summary.matched.bySignature, 1, 'matched by title+query signature, not duplicated');
  assert.equal(summary.updated, 1, 'a real content change is counted as updated');
  const sales = def.tiles.find((t) => t.id === 't-sales');
  assert.equal(sales.sourceElementId, '100', 'element id stamped so the next re-sync is exact');
});

test('a matched tile with identical content is a no-op, not a phantom "update"', () => {
  const cur = current();
  const fresh = {
    filters: cur.filters,
    tiles: [
      { id: 'x', sourceElementId: '100', type: 'vis', title: 'Sales', query: { model: 'm', view: 'v', fields: ['a'] }, vis: { type: 'single' }, layout: { x: 9, y: 9, w: 1, h: 1 } },
      { id: 'y', sourceElementId: '101', type: 'vis', title: 'Trend', query: { model: 'm', view: 'v', fields: ['b'] }, vis: { type: 'line' }, layout: {} },
    ],
    source: { lookerDashboardId: '555' },
  };
  const { summary } = mergeDef(cur, fresh);
  assert.equal(summary.updated, 0, 'identical Looker content → nothing to update');
  assert.equal(summary.unchanged, 2, 'both matched but unchanged');
  assert.equal(summary.added, 0);
});

test('a legacy query change matches by unique title (updates in place, not a duplicate)', () => {
  const cur = current();
  delete cur.tiles[0].sourceElementId; // legacy Sales tile
  const fresh = {
    filters: cur.filters,
    // Looker changed the measure → fields differ, so the signature no longer matches;
    // the unique title "Sales" still pairs them so it updates rather than duplicating.
    tiles: [{ id: 'x', sourceElementId: '100', type: 'vis', title: 'Sales', query: { model: 'm', view: 'v', fields: ['a', 'newmeasure'] }, vis: {}, layout: {} }],
    source: { lookerDashboardId: '555' },
  };
  const { def, summary } = mergeDef(cur, fresh);
  assert.equal(summary.matched.byTitle, 1, 'paired by unique title');
  assert.equal(summary.added, 0, 'not duplicated');
  const sales = def.tiles.find((t) => t.id === 't-sales');
  assert.deepEqual(sales.query.fields, ['a', 'newmeasure'], 'query change pulled in');
  assert.equal(sales.sourceElementId, '100', 'element id stamped for next time');
});

test('filters: matched refresh, new added, Pulse-only kept', () => {
  const fresh = {
    tiles: current().tiles.map((t) => ({ ...t, id: 'r' + t.id })), // same element ids
    filters: [
      { id: 'x', name: 'Event', title: 'Event (renamed)', type: 'field', field: 'core_events.name', default_value: 'KFF28' },
      { id: 'y', name: 'Ticket Type', title: 'Ticket Type', type: 'field', field: 'tickets.type', default_value: '' },
    ],
    source: { lookerDashboardId: '555' },
  };
  const cur = current();
  cur.filters.push({ id: 'fp', name: 'Pulse Only', title: 'Pulse Only', type: 'field', field: 'x.y' });
  const { def, summary } = mergeDef(cur, fresh);
  assert.equal(summary.filtersUpdated, 1);
  assert.equal(summary.filtersAdded, 1);
  const ev = def.filters.find((f) => f.name === 'Event');
  assert.equal(ev.id, 'f1', 'filter identity kept');
  assert.equal(ev.title, 'Event (renamed)', 'Looker fields refreshed');
  assert.ok(def.filters.some((f) => f.name === 'Ticket Type'), 'new Looker filter added');
  assert.ok(def.filters.some((f) => f.name === 'Pulse Only'), 'Pulse-only filter kept');
});
