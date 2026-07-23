// Goal comparison: pinning the CURRENT event on a current-vs-past pivot tile by the
// suite's "Current Event" lock — so a smaller/lower-sorting current edition isn't
// mistaken for the prior one (the actual↔last-time swap). Guards the two pure helpers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Minimal stubs — the factory only needs these shapes to construct.
const tv = require('../server/tileValues')({
  db: { getDashboard: () => null, getSuite: () => null, lockedFiltersForSuite: () => ({}), getFilterView: () => ({}) },
  query: { runLookerQuery: async () => ({}), applyScope: async () => true, primaryTileValue: () => null, tileQueryBody: async () => null, expandLockMap: (m) => m },
});

test('currentEventValue: reads the "Current Event" lock (by name), else "Event Name"; first value', () => {
  assert.equal(tv.currentEventValue({ 'Current Event': 'Shimza and Friends | 2026' }), 'Shimza and Friends | 2026');
  assert.equal(tv.currentEventValue({ 'current event': 'A, B' }), 'A');          // case-insensitive + first of a list
  assert.equal(tv.currentEventValue({ 'Event Name': 'Fallback Fest' }), 'Fallback Fest');
  assert.equal(tv.currentEventValue({ 'Organiser Name': 'x' }), '');              // no event lock → blank
  assert.equal(tv.currentEventValue(null), '');
});

test('matchPivotKey: matches a pivot column to the current event (case/space-insensitive), else null', () => {
  const pivots = [{ key: 'Shimza and Friends | 2025' }, { key: 'Shimza and Friends | 2026' }];
  assert.equal(tv.matchPivotKey(pivots, 'shimza and friends | 2026'), 'Shimza and Friends | 2026');
  assert.equal(tv.matchPivotKey(pivots, '  Shimza and Friends | 2026 '), 'Shimza and Friends | 2026');
  assert.equal(tv.matchPivotKey(pivots, 'Some Other Event'), null); // no match → caller falls back to the heuristic
  assert.equal(tv.matchPivotKey(pivots, ''), null);
});
