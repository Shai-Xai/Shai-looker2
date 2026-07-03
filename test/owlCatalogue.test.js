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
  assert.equal(db.getSetting('owl_catalogue_cashless_seeded_v3', ''), '', 'flag not set');
  // Next boot, Looker is back → it seeds.
  const r2 = await cat.seedCashlessFields(db, async () => ({ measures: [], dimensions: [{ name: 'cashless_check_ins.station_name', label: 'Station', type: 'string' }] }));
  assert.equal(r2.ok, true);
  assert.equal(r2.added, 1);
});

// ── seedCashlessEventName: enables the explore's own event-name dimension ────
// Inventive's reliable check-in recipe keys on cashless_combine_data.name — the
// explore's OWN event field — which the check-in family seed can't reach.

test('seedCashlessEventName adds <view>.name once, then respects admin unticks', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_check_ins.station_name', label: 'Station Name', kind: 'dimension', type: 'string' },
  ] }));
  let lookerCalls = 0;
  const getExploreFields = async () => { lookerCalls++; return { measures: [], dimensions: [{ name: 'cashless_x.name', label: 'Event Name', type: 'string' }] }; };
  const r = await cat.seedCashlessEventName(db, getExploreFields);
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  const saved = JSON.parse(db.getSetting('owl_catalogue_expfields', '{}'))[KEY];
  assert.ok(saved.some((x) => x.name === 'cashless_x.name'), 'event-name dimension enabled');
  // The effective catalogue now carries the full check-in recipe as a usage note.
  const eff = cat.effective(db);
  assert.ok(eff.extras[0].dimensions.some((d) => d.name === 'cashless_x.name'));
  const note = (eff.extras[0].notes || []).join(' ');
  assert.ok(/cashless_check_ins\.count/.test(note), 'note names the check-in count measure');
  assert.ok(/cashless_check_ins\.station_name/.test(note), 'note names the station dimension');
  assert.ok(/cashless_x\.name/.test(note), 'note names the explore\'s own event field');
  assert.ok(/NEVER answer check-in questions from sales/i.test(note), 'note warns off sales rows');
  // Admin unticks it → the seeder never re-adds (flag set).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: saved.filter((x) => x.name !== 'cashless_x.name') }));
  const again = await cat.seedCashlessEventName(db, getExploreFields);
  assert.equal(again.skipped, 'already seeded');
  assert.equal(lookerCalls, 1, 'Looker not consulted again');
});

test('seedCashlessEventName: Looker down → no flag (retries); missing field → flag set, nothing added', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  const down = await cat.seedCashlessEventName(db, async () => { throw new Error('looker down'); });
  assert.equal(down.ok, false);
  assert.equal(db.getSetting('owl_catalogue_cashless_eventname_seeded', ''), '', 'flag not set — retried next boot');
  const noField = await cat.seedCashlessEventName(db, async () => ({ measures: [], dimensions: [] }));
  assert.equal(noField.ok, true);
  assert.equal(noField.added, 0);
  assert.notEqual(db.getSetting('owl_catalogue_cashless_eventname_seeded', ''), '', 'flag set — explore has no such field');
});

test('check-in usage note warns about missing timestamps only when a check-in time field exists', () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  // Without a check-in date field: recipe note only — no time caveat (time questions
  // aren't answerable at all, so there's nothing to cross-check).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_check_ins.station_name', label: 'Station Name', kind: 'dimension', type: 'string' },
  ] }));
  let note = (cat.effective(db).extras[0].notes || []).join(' ');
  assert.ok(!/TIME-FILTERED CHECK-INS/.test(note), 'no time caveat without a time field');
  // With only a sparse time field: the caveat appears, names it, and forces the
  // unfiltered cross-check + disclosure (the 687-vs-8,132 bug).
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_check_ins.station_name', label: 'Station Name', kind: 'dimension', type: 'string' },
    { name: 'cashless_check_ins.date_time', label: 'Check-in Time', kind: 'dimension', type: 'date_time' },
  ] }));
  note = (cat.effective(db).extras[0].notes || []).join(' ');
  assert.ok(/TIME-FILTERED CHECK-INS/.test(note));
  assert.ok(/cashless_check_ins\.date_time/.test(note), 'caveat names the check-in time field');
  assert.ok(/without the time filter/i.test(note), 'caveat forces the unfiltered cross-check');
  assert.ok(/never present a time-filtered check-in count alone/i.test(note));
  // With BOTH a created-at and the sparse date_time: created-at wins (it's on every
  // row), and the note explicitly warns off the sparse field by name.
  db.setSetting('owl_catalogue_expfields', JSON.stringify({ [KEY]: [
    { name: 'cashless_check_ins.count', label: 'Check-Ins Count', kind: 'measure', type: 'count' },
    { name: 'cashless_check_ins.date_time', label: 'Check-in Time', kind: 'dimension', type: 'date_time' },
    { name: 'cashless_check_ins.created_date', label: 'Checkin Created Date', kind: 'dimension', type: 'date' },
  ] }));
  note = (cat.effective(db).extras[0].notes || []).join(' ');
  assert.ok(/filter\/group cashless_check_ins\.created_date/.test(note), 'created-at preferred for time filters');
  assert.ok(/created-at timestamp, present on every row/.test(note));
  assert.ok(/Do NOT time-filter on cashless_check_ins\.date_time/.test(note), 'sparse field warned off by name');
});

test('seedCashlessFields without a registered cashless explore is a safe no-op', async () => {
  const db = fakeDb();
  const r = await cat.seedCashlessFields(db, async () => ({ measures: [], dimensions: [] }));
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_cashless_seeded_v3', ''), '', 'flag not set — seeds when the explore is registered later');
});

// ── seedCheckinExplore: register the dashboard-proven check-in explore (v3) ───

const dashDb = () => {
  const m = new Map(); let dashboards = [];
  return {
    getSetting: (k, d = '') => (m.has(k) ? m.get(k) : d),
    setSetting: (k, v) => m.set(k, v),
    listDashboards: () => dashboards,
    _setDashboards: (d) => { dashboards = d; },
  };
};

test('seedCheckinExplore registers the explore behind a Gates-checkin dashboard and ticks its non-PII fields', async () => {
  const db = dashDb();
  db._setDashboards([{
    id: 'd1', title: 'KFF26 Gates Checkin by Device',
    tiles: [{ id: 't1', query: { model: 'combined', view: 'access_control_x', fields: ['cashless_check_ins.device_id', 'Check_in_operators.handler', 'cashless_check_ins.count'] } }],
  }, {
    id: 'd2', title: 'Ticketing', // unrelated explore, no check-in fields → ignored
    tiles: [{ id: 't2', query: { model: 'combined', view: 'all_tickets_x', fields: ['core_tickets.count'] } }],
  }]);
  const getExploreFields = async (model, view) => {
    assert.equal(`${model}::${view}`, 'combined::access_control_x', 'reads the discovered explore');
    return {
      measures: [{ name: 'cashless_check_ins.count', label: 'Check-Ins', type: 'count' }],
      dimensions: [
        { name: 'cashless_check_ins.station_name', label: 'Station Name', type: 'string' },
        { name: 'Check_in_operators.handler', label: 'Operator Name', type: 'string' },
        { name: 'cashless_check_ins.device_id', label: 'Device ID', type: 'string' },
        { name: 'cashless_check_ins.ticket_type', label: 'Ticket Type', type: 'string' },
        { name: 'cashless_check_ins.date_time', label: 'Check-in Time', type: 'date_time' },
        { name: 'cashless_check_ins.customer_first_name', label: 'First Name', type: 'string' }, // PII → never
      ],
    };
  };
  const r = await cat.seedCheckinExplore(db, getExploreFields);
  assert.equal(r.ok, true);
  assert.deepEqual(r.registered, [{ explore: 'combined::access_control_x', fields: 6 }]);
  // The explore is registered and queryable with the ticked fields.
  assert.ok(cat.explores(db).some((e) => e.view === 'access_control_x'));
  const eff = cat.effective(db);
  const ex = eff.extras.find((e) => e.explore === 'access_control_x');
  assert.ok(ex, 'the Owl gets a tool for it');
  assert.ok(ex.dimensions.some((d) => d.name === 'cashless_check_ins.station_name'));
  assert.ok(ex.dimensions.some((d) => d.name === 'Check_in_operators.handler'));
  assert.ok(!ex.dimensions.some((d) => d.name === 'cashless_check_ins.customer_first_name'), 'person-name fields never auto-enabled');
  // One-shot: a second run is a no-op.
  assert.equal((await cat.seedCheckinExplore(db, getExploreFields)).skipped, 'already seeded');
});

test('seedCheckinExplore skips explores already registered (the combined cashless source)', async () => {
  const db = dashDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  db._setDashboards([{ id: 'd1', tiles: [{ id: 't1', query: { model: 'combined', view: 'cashless_x', fields: ['cashless_check_ins.count', 'cashless_check_ins.device_id'] } }] }]);
  let lookerCalls = 0;
  const r = await cat.seedCheckinExplore(db, async () => { lookerCalls++; return { measures: [], dimensions: [] }; });
  assert.equal(r.ok, true);
  assert.deepEqual(r.registered, [], 'nothing new to register');
  assert.equal(lookerCalls, 0, 'Looker never consulted');
});

test('seedCheckinExplore does NOT set its flag when Looker is unreachable (retries next boot)', async () => {
  const db = dashDb();
  db._setDashboards([{ id: 'd1', tiles: [{ id: 't1', query: { model: 'combined', view: 'access_control_x', fields: ['cashless_check_ins.count'] } }] }]);
  const r = await cat.seedCheckinExplore(db, async () => { throw new Error('looker down'); });
  assert.equal(r.ok, false);
  assert.equal(db.getSetting('owl_catalogue_checkin_explore_seeded_v2', ''), '', 'flag not set');
  const r2 = await cat.seedCheckinExplore(db, async () => ({ measures: [{ name: 'cashless_check_ins.count', label: 'Check-Ins', type: 'count' }], dimensions: [] }));
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.registered, [{ explore: 'combined::access_control_x', fields: 1 }]);
});

test('seedCashlessFields ticks HIDDEN check-in fields too (hidden is a UI nicety, not a restriction)', async () => {
  const db = fakeDb();
  cat.registerExplore(db, { model: 'combined', view: 'cashless_x', label: 'Cashless' });
  const r = await cat.seedCashlessFields(db, async () => ({
    measures: [],
    dimensions: [
      { name: 'cashless_check_ins.station_name', label: 'Station', type: 'string', hidden: true },
      { name: 'cashless_check_ins.date_date', label: 'Check-in Date', type: 'date', hidden: true },
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, 'hidden fields are ticked like any other');
});

test('listFields surfaces hidden fields flagged so an admin can tick them', async () => {
  const db = fakeDb();
  const fields = await cat.listFields(db, async () => ({
    measures: [{ name: 'cashless_check_ins.count', label: 'Check-Ins', type: 'count' }],
    dimensions: [{ name: 'cashless_check_ins.station_name', label: 'Station', type: 'string', hidden: true }],
  }), 'combined', 'cashless_x');
  const hiddenRow = fields.dimensions.find((d) => d.name === 'cashless_check_ins.station_name');
  assert.ok(hiddenRow, 'hidden dimension is listed');
  assert.equal(hiddenRow.hidden, true, 'and flagged as hidden');
});
