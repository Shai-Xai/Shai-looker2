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

// ── seedCashlessFields: the one-shot check-in + sales enrichment (v2) ─────────

test('seedCashlessFields enables the check-in AND sales families from Looker (non-PII, additive, once)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  // Already-ticked selection: a check-in count + a sales station.
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_sales.station_name', label: 'Sales Station', kind: 'dimension', type: 'string' },
  ] }));
  let lookerCalls = 0;
  const getExploreFields = async () => { lookerCalls++; return {
    measures: [
      { name: 'cashless_check_ins.count', label: 'Check-Ins Count', type: 'count' },          // already ticked → skipped
      { name: 'cashless_sales.transaction_count', label: 'Transaction Count', type: 'count' },
    ],
    dimensions: [
      { name: 'cashless_check_ins.station_name', label: 'Station Name', type: 'string' },
      { name: 'cashless_check_ins.operator_name', label: 'Operator Name', type: 'string' },
      { name: 'cashless_check_ins.device_id', label: 'Device ID', type: 'string' },
      { name: 'cashless_check_ins.ticket_type', label: 'Ticket Type', type: 'string' },
      { name: 'cashless_access_control.station_name', label: 'AC Station', type: 'string' },
      { name: 'cashless_sales_operators.operator_id', label: 'Operator ID', type: 'string' },  // sales family — NEW in v2
      { name: 'cashless_sales.payment_type', label: 'Payment Type', type: 'string' },
      { name: 'cashless_stations.category', label: 'Station Category', type: 'string' },
      { name: 'cashless_products.name', label: 'Product Name', type: 'string' },
      { name: 'cashless_check_ins.customer_email', label: 'Email', type: 'string' },          // PII → never
      { name: 'cashless_sales.customer_first_name', label: 'First Name', type: 'string' },    // PII → never
      { name: 'core_events.name', label: 'Event', type: 'string' },                           // wrong family → skipped
      { name: 'cashless_gtags.active', label: 'Gtag Active', type: 'yesno' },                 // wrong family → skipped
    ],
  }; };
  const r = await cat.seedCashlessFields(db, getExploreFields);
  assert.equal(r.ok, true);
  assert.equal(r.added, 10, 'check-in + sales family fields (not the ticked, PII or foreign ones)');
  const saved = JSON.parse(db.getSetting('owl_catalogue_expfields', '{}'))[KEY];
  const names = saved.map((x) => x.name);
  assert.ok(names.includes('cashless_check_ins.station_name'));
  assert.ok(names.includes('cashless_sales_operators.operator_id'), 'sales operator id now available');
  assert.ok(names.includes('cashless_sales.payment_type'), 'closed-loop payment type now available');
  assert.ok(names.includes('cashless_stations.category'));
  assert.ok(names.includes('cashless_sales.transaction_count'));
  assert.ok(!names.includes('cashless_check_ins.customer_email'), 'PII never enters the catalogue');
  assert.ok(!names.includes('cashless_sales.customer_first_name'), 'PII never enters the catalogue');
  assert.ok(!names.includes('cashless_gtags.active'), 'non-target families untouched');
  assert.ok(names.includes('cashless_check_ins.count'), 'existing ticks preserved');
  // The enriched selection yields a queryable explore with the new dims.
  const eff = cat.effective(db);
  assert.ok(eff.extras[0].dimensions.some((d) => d.name === 'cashless_sales_operators.operator_id'));
  // Second run: flag set → no Looker call, nothing re-added (admin unticks respected).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: saved.filter((x) => x.name !== 'cashless_check_ins.device_id') }));
  const again = await cat.seedCashlessFields(db, getExploreFields);
  assert.equal(again.skipped, 'already seeded');
  assert.equal(lookerCalls, 1, 'Looker not consulted again');
  assert.ok(!JSON.parse(db.getSetting('owl_catalogue_expfields', '{}'))[KEY].some((x) => x.name === 'cashless_check_ins.device_id'), 'an admin untick stays unticked');
});

test('seedCashlessFields runs even where the v1 check-in seed already did (v2 flag is separate)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  db.setSetting('owl_catalogue_checkin_seeded', '2026-07-03T09:00:00Z'); // prod ran v1 this morning
  const r = await cat.seedCashlessFields(db, async () => ({ measures: [], dimensions: [
    { name: 'cashless_sales_operators.operator_id', label: 'Operator ID', type: 'string' },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.added, 1, 'the sales delta still lands');
});

test('seedCashlessFields does NOT set the done-flag when Looker is unreachable (retries next boot)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  const r = await cat.seedCashlessFields(db, async () => { throw new Error('looker down'); });
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_cashless_seeded_v2', ''), '', 'flag not set');
  // Next boot, Looker is back → it seeds.
  const r2 = await cat.seedCashlessFields(db, async () => ({ measures: [], dimensions: [{ name: 'cashless_check_ins.station_name', label: 'Station', type: 'string' }] }));
  assert.equal(r2.ok, true);
  assert.equal(r2.added, 1);
});

test('seedCashlessFields without a registered cashless explore is a safe no-op', async () => {
  const db = fakeDb();
  const r = await cat.seedCashlessFields(db, async () => ({ measures: [], dimensions: [] }));
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_cashless_seeded_v2', ''), '', 'flag not set — seeds when the explore is registered later');
});
