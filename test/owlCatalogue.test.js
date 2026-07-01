// Owl data catalogue — per-client explore access (Slice 3). Pins the on/off
// resolution: platform default (on unless flipped) + per-client overrides, primary
// always on for everyone, and unregistering an explore clears its access config.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cat = require('../server/owlCatalogue');
const seed = require('../server/owlCatalogueSeed');

// The module only touches getSetting/setSetting, so a tiny in-memory db suffices.
const fakeDb = () => { const m = new Map(); return { getSetting: (k, d = '') => (m.has(k) ? m.get(k) : d), setSetting: (k, v) => m.set(k, v) }; };
const KEY = 'combined::cashless_x';

test('explore access: default on, per-client overrides, default-off flips inheritance', () => {
  const db = fakeDb();
  // Nothing configured → on for everyone (and for no-entity contexts).
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), true);
  assert.equal(cat.exploreEnabledFor(db, KEY, ''), true);
  // Turn it OFF for one client only.
  cat.setAccess(db, KEY, { defaultOn: true, clients: { 'ent-a': false } });
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), false);
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-b'), true, 'other clients inherit the on default');
  // Default OFF with one client opted in.
  cat.setAccess(db, KEY, { defaultOn: false, clients: { 'ent-a': true } });
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), true);
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-b'), false, 'others inherit the off default');
  // Non-boolean override values are dropped (treated as inherit).
  cat.setAccess(db, KEY, { defaultOn: true, clients: { 'ent-a': 'nope', 'ent-b': false } });
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), true);
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-b'), false);
});

test('unregistering an explore clears its field selection AND access config', () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  cat.setAccess(db, KEY, { defaultOn: false, clients: {} });
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), false);
  cat.unregisterExplore(db, 'combined', 'cashless_x');
  assert.equal(cat.exploreEnabledFor(db, KEY, 'ent-a'), true, 'stale access config is gone (back to the default)');
  assert.equal(cat.explores(db).length, 1, 'only the primary remains');
});

test('the primary explore never appears as a registrable extra', () => {
  const db = fakeDb();
  const r = cat.registerExplore(db, { model: seed.model, view: seed.explore, label: 'dupe' });
  assert.equal(r.ok, false);
  assert.equal(cat.explores(db).length, 1);
});
