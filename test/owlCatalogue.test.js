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

// ── seedCheckinFields: the one-shot check-in/access-control enrichment ────────

test('seedCheckinFields enables the check-in family from Looker (non-PII, additive, once)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  // Already-ticked selection: a check-in count + an access-control date.
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_access_control.date_date', label: 'AC Date', kind: 'dimension', type: 'date' },
  ] }));
  let lookerCalls = 0;
  const getExploreFields = async () => { lookerCalls++; return {
    measures: [
      { name: 'cashless_check_ins.count', label: 'Check-Ins Count', type: 'count' },          // already ticked → skipped
      { name: 'cashless_sales.sum_credit_amount', label: 'Sale Amount', type: 'sum' },        // wrong family → skipped
    ],
    dimensions: [
      { name: 'cashless_check_ins.station_name', label: 'Station Name', type: 'string' },
      { name: 'cashless_check_ins.operator_name', label: 'Operator Name', type: 'string' },
      { name: 'cashless_check_ins.device_id', label: 'Device ID', type: 'string' },
      { name: 'cashless_check_ins.ticket_type', label: 'Ticket Type', type: 'string' },
      { name: 'cashless_check_ins.date_time', label: 'Check-in Time', type: 'date_time' },
      { name: 'cashless_access_control.station_name', label: 'AC Station', type: 'string' },
      { name: 'cashless_check_ins.customer_email', label: 'Email', type: 'string' },          // PII → never
      { name: 'cashless_sales.station_name', label: 'Sales Station', type: 'string' },        // wrong family → skipped
      { name: 'core_events.name', label: 'Event', type: 'string' },                           // wrong family → skipped
    ],
  }; };
  const r = await cat.seedCheckinFields(db, getExploreFields);
  assert.equal(r.ok, true);
  assert.equal(r.added, 6, 'the 6 new check-in family fields (not the ticked, PII or foreign ones)');
  const saved = JSON.parse(db.getSetting('owl_catalogue_expfields', '{}'))[KEY];
  const names = saved.map((x) => x.name);
  assert.ok(names.includes('cashless_check_ins.station_name'));
  assert.ok(names.includes('cashless_check_ins.operator_name'));
  assert.ok(names.includes('cashless_access_control.station_name'));
  assert.ok(!names.includes('cashless_check_ins.customer_email'), 'PII never enters the catalogue');
  assert.ok(!names.includes('cashless_sales.station_name'), 'other families untouched');
  assert.ok(names.includes('cashless_check_ins.count'), 'existing ticks preserved');
  // The enriched selection yields a queryable explore with the new dims.
  const eff = cat.effective(db);
  assert.ok(eff.extras[0].dimensions.some((d) => d.name === 'cashless_check_ins.station_name'));
  // Second run: flag set → no Looker call, nothing re-added (admin unticks respected).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: saved.filter((x) => x.name !== 'cashless_check_ins.device_id') }));
  const again = await cat.seedCheckinFields(db, getExploreFields);
  assert.equal(again.skipped, 'already seeded');
  assert.equal(lookerCalls, 1, 'Looker not consulted again');
  assert.ok(!JSON.parse(db.getSetting('owl_catalogue_expfields', '{}'))[KEY].some((x) => x.name === 'cashless_check_ins.device_id'), 'an admin untick stays unticked');
});

test('seedCheckinFields does NOT set the done-flag when Looker is unreachable (retries next boot)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  const r = await cat.seedCheckinFields(db, async () => { throw new Error('looker down'); });
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_checkin_seeded', ''), '', 'flag not set');
  // Next boot, Looker is back → it seeds.
  const r2 = await cat.seedCheckinFields(db, async () => ({ measures: [], dimensions: [{ name: 'cashless_check_ins.station_name', label: 'Station', type: 'string' }] }));
  assert.equal(r2.ok, true);
  assert.equal(r2.added, 1);
});

test('seedCheckinFields without a registered cashless explore is a safe no-op', async () => {
  const db = fakeDb();
  const r = await cat.seedCheckinFields(db, async () => ({ measures: [], dimensions: [] }));
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_checkin_seeded', ''), '', 'flag not set — seeds when the explore is registered later');
});
