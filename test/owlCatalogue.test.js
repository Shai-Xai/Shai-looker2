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

test('legacy string field selections still yield a queryable extra explore', () => {
  // An early build saved ticked fields as plain names (no measure/dimension kind),
  // which silently produced zero measures → no tool. The normaliser now guesses the
  // kind from the name, so a measure-like field keeps the explore queryable.
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: ['cashless_x.sum_revenue', 'cashless_x.method'] }));
  const eff = cat.effective(db);
  assert.equal(eff.extras.length, 1, 'the explore survives despite legacy string storage');
  assert.deepEqual(eff.extras[0].measures.map((m) => m.name), ['cashless_x.sum_revenue']);
  assert.deepEqual(eff.extras[0].dimensions.map((d) => d.name), ['cashless_x.method']);
  // No measure-like name at all → still not queryable (needs a real measure ticked).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: ['cashless_x.method'] }));
  assert.equal(cat.effective(db).extras.length, 0);
});

test('the primary explore never appears as a registrable extra', () => {
  const db = fakeDb();
  const r = cat.registerExplore(db, { model: seed.model, view: seed.explore, label: 'dupe' });
  assert.equal(r.ok, false);
  assert.equal(cat.explores(db).length, 1);
});
