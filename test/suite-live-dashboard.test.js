// The per-suite "live dashboard" (the sidebar LIVE button target): it must
// round-trip through create/update and default to '' so a suite without one
// simply shows no button.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('suite.liveDashboardId defaults to empty and round-trips through updateSuite', () => {
  const ent = h.makeEntity('Live Co', 'Live Org');
  const su = h.db.createSuite({ entityId: ent.id, name: 'KFF 26' });
  assert.equal(su.liveDashboardId, '', 'a new suite has no LIVE button by default');

  const updated = h.db.updateSuite(su.id, { liveDashboardId: 'dash-live-123' });
  assert.equal(updated.liveDashboardId, 'dash-live-123', 'the live dashboard is saved');
  assert.equal(h.db.getSuite(su.id).liveDashboardId, 'dash-live-123', 'and persists on re-read');

  // Editing an unrelated field must not wipe it.
  const renamed = h.db.updateSuite(su.id, { name: 'KFF 2026' });
  assert.equal(renamed.liveDashboardId, 'dash-live-123', 'untouched by an unrelated update');

  // Clearing it removes the button.
  assert.equal(h.db.updateSuite(su.id, { liveDashboardId: '' }).liveDashboardId, '');
});
