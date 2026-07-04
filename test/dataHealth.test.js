// Data health engine: per-station stream memory (silence detection), the
// fresh→stale edge-detection + cooldown, the recovery notice, and the scoped
// evaluation user. The Looker read is stubbed (runLookerQuery) so the tests drive
// the timestamps directly and assert WHEN an alert fires — the real deliverable.

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers');

function fakeApp() { return { get() {}, post() {}, put() {}, delete() {} }; }

// Mount with a controllable Looker feed + captured deliveries.
function mountHealth(over = {}) {
  const sql = db.db;
  let rows = [];                // what the next Looker pull returns
  let rowsFn = async () => rows; // body-aware override (fallback-path tests)
  let scopedUser = null;        // the user applyScope saw
  let scopeOk = true;
  const announced = [];         // OS-spine (client inbox) deliveries
  const opsAlerts = [];         // internal ops Slack deliveries
  const testEmails = [];        // test-mode direct emails
  // Test mode defaults ON in the module (trial phase); pin it OFF here so the
  // live-delivery tests exercise the real fan-out. The test-mode test flips it.
  db.setSetting('data_health_test_mode', '0');
  const mod = require('../server/dataHealth').mount(fakeApp(), {
    db,
    auth: { requireAdmin: (_req, _res, next) => next && next() },
    looker: over.looker || { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [] }) },
    runLookerQuery: async (_path, body) => rowsFn(body),
    applyScope: async (_body, user) => { scopedUser = user; return scopeOk; },
    os: { announce: (a) => { announced.push(a); return { id: 'thread' }; } },
    ops: { alert: (kind, msg) => opsAlerts.push({ kind, msg }) },
    mailer: { send: async (msg) => { testEmails.push(msg); return { ok: true }; } },
  });
  return {
    mod, sql, announced, opsAlerts, testEmails,
    setRows: (r) => { rows = r; rowsFn = async () => rows; },
    setRowsFn: (fn) => { rowsFn = fn; },
    setScopeOk: (v) => { scopeOk = v; },
    getScopedUser: () => scopedUser,
  };
}

// Insert a monitor through the module's own clean+upsert (the route path).
function makeMonitor(h, over = {}) {
  const c = h.mod.clean({
    name: 'Check-in scanners', area: 'Check-in', model: 'ticketing', view: 'scans',
    timeField: 'scans.scanned_at', stationField: 'scans.station_name',
    warnMin: 15, staleMin: 30, cooldownMin: 60, ...over,
  });
  return h.mod.upsert(null, c, 'test@howler');
}

const minsAgo = (n) => new Date(Date.now() - n * 60000).toISOString().replace('T', ' ').slice(0, 19);
const feedRow = (station, agoMin) => ({ 'scans.station_name': station, data_health_latest: minsAgo(agoMin) });
const streamRows = (h, id) => h.sql.prepare('SELECT * FROM data_monitor_streams WHERE monitor_id=? ORDER BY station').all(id);
const eventKinds = (h, id) => h.sql.prepare('SELECT kind FROM data_monitor_events WHERE monitor_id=? ORDER BY at').all(id).map((r) => r.kind);

test('fresh data → fresh streams, a logged pull, no alert', async () => {
  const h = mountHealth();
  const m = makeMonitor(h);
  h.setRows([feedRow('Gate A', 2), feedRow('Gate B', 5)]);
  const r = await h.mod.check(m);
  assert.equal(r.ok, true);
  assert.equal(r.stations, 2);
  assert.equal(r.stale, 0);
  const streams = streamRows(h, m.id);
  assert.deepEqual(streams.map((s) => s.status), ['fresh', 'fresh']);
  assert.equal(h.opsAlerts.length, 0);
  assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM data_monitor_checks WHERE monitor_id=? AND ok=1').get(m.id).n, 1);
});

test('a station going quiet fires ONE alert on the transition, not every tick', async () => {
  const h = mountHealth();
  const m = makeMonitor(h);
  h.setRows([feedRow('Gate A', 2), feedRow('Gate B', 45)]); // B past the 30m threshold
  await h.mod.check(m);
  assert.equal(h.opsAlerts.length, 1);
  assert.match(h.opsAlerts[0].msg, /Gate B/);
  assert.ok(eventKinds(h, m.id).includes('stale'));
  assert.equal(h.mod.monitorById(m.id).state, 'alerting');

  // Still stale on the next pull → no re-fire (edge, not level).
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(h.opsAlerts.length, 1);
});

test('silence detection: a station that VANISHES from results still goes stale', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { staleMin: 30 });
  // First pull: both alive, but Bar 2's latest record is already 25 min old.
  h.setRows([feedRow('Bar 1', 1), feedRow('Bar 2', 25)]);
  await h.mod.check(m);
  assert.equal(h.opsAlerts.length, 0);
  // Next pull: Bar 2 gone from the result entirely (device died / rows filtered).
  // Its remembered last_event_at keeps aging → stale, alert fires.
  h.setRows([feedRow('Bar 1', 1)]);
  const back = h.sql.prepare('UPDATE data_monitor_streams SET last_event_at=? WHERE monitor_id=? AND station=?');
  back.run(new Date(Date.now() - 40 * 60000).toISOString(), m.id, 'Bar 2'); // age it past threshold
  await h.mod.check(h.mod.monitorById(m.id));
  const bar2 = streamRows(h, m.id).find((s) => s.station === 'Bar 2');
  assert.equal(bar2.status, 'stale');
  assert.equal(h.opsAlerts.length, 1);
  assert.match(h.opsAlerts[0].msg, /Bar 2/);
});

test('recovery: when the last stale stream comes back, one all-clear is sent', async () => {
  const h = mountHealth();
  const m = makeMonitor(h);
  h.setRows([feedRow('Gate A', 45)]);
  await h.mod.check(m);
  assert.equal(h.mod.monitorById(m.id).state, 'alerting');
  h.setRows([feedRow('Gate A', 1)]); // data flowing again
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(h.mod.monitorById(m.id).state, 'ok');
  assert.ok(eventKinds(h, m.id).includes('recovered'));
  assert.ok(eventKinds(h, m.id).includes('recovery_alert'));
  assert.equal(h.opsAlerts.length, 2); // stale + recovery

  // notify_recovery off → transition recorded, no all-clear message.
  const m2 = makeMonitor(h, { name: 'Quiet one', notifyRecovery: false });
  h.setRows([feedRow('Gate A', 45)]);
  await h.mod.check(m2);
  h.setRows([feedRow('Gate A', 1)]);
  const before = h.opsAlerts.length;
  await h.mod.check(h.mod.monitorById(m2.id));
  assert.ok(eventKinds(h, m2.id).includes('recovered'));
  assert.ok(!eventKinds(h, m2.id).includes('recovery_alert'));
  assert.equal(h.opsAlerts.length, before);
});

test('cooldown: a second station going stale inside the window is logged, not re-alerted', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { cooldownMin: 60 });
  h.setRows([feedRow('Gate A', 45), feedRow('Gate B', 2)]);
  await h.mod.check(m);
  assert.equal(h.opsAlerts.length, 1);
  // B goes quiet minutes later — inside cooldown → the transition is recorded
  // (history stays truthful) but no second notification lands. (last_event_at
  // only moves forward, so "later silence" = age the stored timestamp.)
  h.sql.prepare('UPDATE data_monitor_streams SET last_event_at=? WHERE monitor_id=? AND station=?')
    .run(new Date(Date.now() - 40 * 60000).toISOString(), m.id, 'Gate B');
  h.setRows([]);
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(eventKinds(h, m.id).filter((k) => k === 'stale').length, 2);
  assert.equal(h.opsAlerts.length, 1);
});

test('whole-feed monitor (no station split) reads the newest row directly', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { stationField: '' });
  let body = null;
  h.setRowsFn(async (b) => { body = b; return [{ 'scans.scanned_at': minsAgo(3) }]; });
  const r = await h.mod.check(m);
  assert.equal(r.stations, 1);
  assert.equal(streamRows(h, m.id)[0].station, '');
  assert.equal(streamRows(h, m.id)[0].status, 'fresh');
  // No custom measure involved: plain newest-row query (the max() measure is
  // rejected on some Looker versions, so the whole-feed path never uses it).
  assert.equal(body.dynamic_fields, undefined);
  assert.deepEqual(body.sorts, ['scans.scanned_at desc']);
  assert.equal(body.limit, '1');
});

test('Looker rejecting the max() measure → sorted-scan fallback, memoised', async () => {
  const h = mountHealth();
  const m = makeMonitor(h);
  let dynAttempts = 0;
  const scanBodies = [];
  h.setRowsFn(async (body) => {
    if (body.dynamic_fields) {
      dynAttempts += 1;
      throw new Error('Looker API POST /queries/run/json failed (400): {"message":"Expressions for fields of type \\"max\\" must evaluate to \\"number\\", but the provided expression evaluates to \\"date\\"."}');
    }
    scanBodies.push(body);
    return [
      { 'scans.station_name': 'Gate A', 'scans.scanned_at': minsAgo(2) },
      { 'scans.station_name': 'Gate A', 'scans.scanned_at': minsAgo(9) },  // older row — first (newest) wins
      { 'scans.station_name': 'Gate B', 'scans.scanned_at': minsAgo(45) }, // past the 30m threshold
    ];
  });
  const r = await h.mod.check(m);
  assert.equal(r.ok, true);
  assert.equal(r.stations, 2);
  assert.deepEqual(scanBodies[0].sorts, ['scans.scanned_at desc']);
  const gateA = streamRows(h, m.id).find((s) => s.station === 'Gate A');
  assert.equal(gateA.status, 'fresh'); // 2m, not the older 9m row
  assert.equal(h.opsAlerts.length, 1); // Gate B stale → alert fired off fallback data
  assert.match(h.opsAlerts[0].msg, /Gate B/);

  // Second check skips the doomed max() attempt entirely (memoised).
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(dynAttempts, 1);
});

test('scoped reads: entity monitors run as a locked client, platform monitors as admin', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { entityId: 'ent42', suiteId: 'suite42' });
  h.setRows([feedRow('Gate A', 1)]);
  await h.mod.check(m);
  assert.equal(h.getScopedUser().role, 'client');
  assert.deepEqual(h.getScopedUser().entityIds, ['ent42']);

  const p = makeMonitor(h, { name: 'Platform', entityId: '', suiteId: '' });
  h.setRows([{ 'scans.scanned_at': minsAgo(1) }]);
  await h.mod.check(p);
  assert.equal(h.getScopedUser().role, 'admin');

  // Entity monitors also fan out to the client team via the OS spine on alert.
  h.sql.prepare('UPDATE data_monitor_streams SET last_event_at=? WHERE monitor_id=? AND station=?')
    .run(new Date(Date.now() - 90 * 60000).toISOString(), m.id, 'Gate A');
  h.setRows([]);
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(h.announced.length, 1);
  assert.equal(h.announced[0].entityId, 'ent42');
});

test('a failed pull is logged as a health signal, and fail-closed scope never reads', async () => {
  const h = mountHealth();
  const m = makeMonitor(h);
  h.setScopeOk(false); // scope resolver denies → fail closed
  const r = await h.mod.check(m);
  assert.equal(r.ok, false);
  const chk = h.sql.prepare('SELECT * FROM data_monitor_checks WHERE monitor_id=?').get(m.id);
  assert.equal(chk.ok, 0);
  assert.match(chk.error, /scope failed/);
  assert.match(h.mod.monitorById(m.id).lastError, /scope failed/);
  assert.ok(eventKinds(h, m.id).includes('error'));
  // The error event fires once, not every failing tick.
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(eventKinds(h, m.id).filter((k) => k === 'error').length, 1);
});

test('test mode routes every alert ONLY to the test address (ops + client muted)', async () => {
  const h = mountHealth();
  db.setSetting('data_health_test_mode', '1');
  db.setSetting('data_health_test_email', 'shai@test.local');
  try {
    const m = makeMonitor(h, { name: 'TM', entityId: 'entX', suiteId: 'sX' });
    h.setRows([feedRow('Gate A', 90)]); // straight to stale
    await h.mod.check(m);
    assert.equal(h.opsAlerts.length, 0);      // ops Slack muted
    assert.equal(h.announced.length, 0);      // client team muted (despite entityId)
    assert.equal(h.testEmails.length, 1);     // only the test address hears it
    assert.equal(h.testEmails[0].to, 'shai@test.local');
    assert.match(h.testEmails[0].subject, /^\[TEST\] /);
    // The event history records where the alert actually went.
    const ev = h.sql.prepare("SELECT message FROM data_monitor_events WHERE monitor_id=? AND kind='alert'").get(m.id);
    assert.match(ev.message, /test-email:shai@test\.local/);

    // Recovery notice honours test mode too.
    h.setRows([feedRow('Gate A', 1)]);
    await h.mod.check(h.mod.monitorById(m.id));
    assert.equal(h.testEmails.length, 2);
    assert.equal(h.opsAlerts.length, 0);
    assert.equal(h.announced.length, 0);
  } finally {
    db.setSetting('data_health_test_mode', '0');
  }
});

test('latestRecords: the raw feed tail, newest first, scoped and mapped', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, {
    detailFields: ['scans.record_type', 'scans.scanned_at'], // time field deduped out
    filters: { 'scans.event_name': 'Festival X', 'scans.pending': '' }, // one real, one "open"
  });
  let body = null;
  h.setRowsFn(async (b) => {
    body = b;
    return [
      { 'scans.station_name': 'Gate A', 'scans.scanned_at': minsAgo(1), 'scans.record_type': 'check-in' },
      { 'scans.station_name': 'Bar 3', 'scans.scanned_at': minsAgo(7), 'scans.record_type': 'sale' },
    ];
  });
  const recs = await h.mod.latestRecords(m, 20);
  assert.deepEqual(body.fields, ['scans.station_name', 'scans.scanned_at', 'scans.record_type']);
  // The "open" (blank-valued) filter is saved on the monitor but never sent to
  // Looker — an empty string would filter for blank values.
  assert.deepEqual(m.filters, { 'scans.event_name': 'Festival X', 'scans.pending': '' });
  assert.deepEqual(body.filters, { 'scans.event_name': 'Festival X' });
  assert.deepEqual(body.sorts, ['scans.scanned_at desc']);
  assert.equal(body.limit, '20');
  assert.equal(body.dynamic_fields, undefined); // plain rows, no aggregation
  assert.equal(recs.length, 2);
  assert.equal(recs[0].station, 'Gate A');
  assert.equal(recs[0].extra['scans.record_type'], 'check-in'); // detail column rides along
  assert.equal(recs[1].extra['scans.record_type'], 'sale');
  assert.ok(recs[0].agoMin >= 0.5 && recs[0].agoMin <= 2);
  assert.ok(recs[1].agoMin >= 6 && recs[1].agoMin <= 8);
  // Limit is clamped to a sane window (1..100).
  h.setRowsFn(async (b) => { body = b; return []; });
  await h.mod.latestRecords(m, 9999);
  assert.equal(body.limit, '100');
});

test('master cadence: monitors with no own cadence follow data_health_tick_min', async () => {
  const h = mountHealth();
  db.setSetting('data_health_tick_min', '7');
  try {
    const follows = makeMonitor(h, { name: 'Follows master', checkEveryMin: 0 });
    const own = makeMonitor(h, { name: 'Own cadence', checkEveryMin: 1 });
    let checked = [];
    h.setRowsFn(async (b) => { checked.push(b.filters ? 1 : 1); return [{ 'scans.scanned_at': minsAgo(1), 'scans.station_name': 'A', data_health_latest: minsAgo(1) }]; });
    // Both were checked 3 minutes ago.
    const threeAgo = new Date(Date.now() - 3 * 60000).toISOString();
    h.sql.prepare('UPDATE data_monitors SET last_checked_at=?').run(threeAgo);
    checked = [];
    await h.mod.tick();
    // 3m elapsed: own cadence (1m) is due; master follower (7m) is not.
    assert.equal(checked.length, 1);
    assert.equal(h.mod.monitorById(follows.id).lastCheckedAt, threeAgo); // untouched
    assert.notEqual(h.mod.monitorById(own.id).lastCheckedAt, threeAgo);  // re-checked
    // 8 minutes elapsed → the follower is due too.
    h.sql.prepare('UPDATE data_monitors SET last_checked_at=? WHERE id=?').run(new Date(Date.now() - 8 * 60000).toISOString(), follows.id);
    checked = [];
    await h.mod.tick();
    assert.notEqual(h.mod.monitorById(follows.id).lastCheckedAt, threeAgo);
  } finally {
    db.setSetting('data_health_tick_min', '5');
  }
});

test('fieldValues: distinct dimension values, deduped and scoped', async () => {
  const h = mountHealth();
  let body = null;
  h.setRowsFn(async (b) => {
    body = b;
    return [
      { 'scans.station_name': 'Bar 1' }, { 'scans.station_name': 'Bar 1' },
      { 'scans.station_name': 'Gate A' }, { 'scans.station_name': '' }, { 'scans.station_name': null },
    ];
  });
  const vals = await h.mod.fieldValues({ model: 'ticketing', view: 'scans', field: 'scans.station_name', entityId: 'entZ', suiteId: 'sZ' });
  assert.deepEqual(vals, ['Bar 1', 'Gate A']); // deduped, blanks dropped
  assert.deepEqual(body.fields, ['scans.station_name']);
  assert.equal(h.getScopedUser().role, 'client'); // entity given → scoped read
  assert.deepEqual(h.getScopedUser().entityIds, ['entZ']);

  await h.mod.fieldValues({ model: 'ticketing', view: 'scans', field: 'scans.station_name' });
  assert.equal(h.getScopedUser().role, 'admin'); // no entity → platform read
});

test('deviceRoster: linked vs online vs offline, learned from the baseline window', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterBaselineMin: 1440, rosterOnlineMin: 30 });
  let body = null;
  h.setRowsFn(async (b) => {
    // This LookML rejects the dynamic MAX read — the raw fallback serves.
    if (b.fields.includes('data_health_last')) throw new Error('Unknown field "data_health_last"');
    body = b;
    return [
      { 'scans.device_id': 'D-101', 'scans.scanned_at': minsAgo(2) },
      { 'scans.device_id': 'D-101', 'scans.scanned_at': minsAgo(500) }, // older row, same device
      { 'scans.device_id': 'D-102', 'scans.scanned_at': minsAgo(45) },  // silent past 30m → offline
      { 'scans.device_id': 'D-103', 'scans.scanned_at': minsAgo(700) }, // long silent → offline
      { 'scans.device_id': '', 'scans.scanned_at': minsAgo(1) },        // blank device ignored
    ];
  });
  const r = await h.mod.deviceRoster(m);
  assert.equal(r.configured, true);
  assert.equal(r.total, 3);
  assert.equal(r.online, 1);
  assert.deepEqual(r.offline.map((d) => d.device), ['D-103', 'D-102']); // longest silent first
  // The baseline window is enforced in Looker itself, newest rows first.
  assert.equal(body.filters['scans.scanned_at'], 'last 1440 minutes');
  assert.deepEqual(body.fields, ['scans.device_id', 'scans.scanned_at']);
  assert.deepEqual(body.sorts, ['scans.scanned_at desc']);

  // No roster field configured → explicitly unconfigured, no query.
  const plain = makeMonitor(h, { name: 'No roster' });
  assert.deepEqual(await h.mod.deviceRoster(plain), { configured: false });

  // A fixed start time anchors the roster ("since doors opened") and beats the
  // rolling window; the Looker filter is an UTC `after` expression.
  const startIso = new Date(Date.now() - 2 * 3600000).toISOString();
  const anchored = makeMonitor(h, { name: 'Anchored', rosterField: 'scans.device_id', rosterStart: startIso, rosterBaselineMin: 60 });
  assert.equal(anchored.rosterStart, startIso);
  const r2 = await h.mod.deviceRoster(anchored);
  assert.equal(body.filters['scans.scanned_at'], `after ${startIso.slice(0, 16).replace('T', ' ')}`);
  assert.equal(r2.startAt, startIso);
  // Junk start time is dropped at clean() — falls back to the rolling window.
  const junk = makeMonitor(h, { name: 'Junk start', rosterField: 'scans.device_id', rosterStart: 'not-a-date' });
  assert.equal(junk.rosterStart, '');
});

test('deviceRoster: aggregates last-seen per device in Looker when the MAX measure works', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterOnlineMin: 30 });
  const bodies = [];
  h.setRowsFn(async (b) => {
    bodies.push(b);
    if (!b.fields.includes('data_health_last')) throw new Error('raw fallback should not run');
    return [
      { 'scans.device_id': 'D-1', data_health_last: minsAgo(3) },
      { 'scans.device_id': 'D-2', data_health_last: minsAgo(90) }, // silent past 30m
    ];
  });
  const r = await h.mod.deviceRoster(m);
  assert.equal(r.total, 2);
  assert.equal(r.online, 1);
  assert.equal(r.truncated, false); // one row per device — the cap is out of reach
  assert.deepEqual(JSON.parse(bodies[0].dynamic_fields), [{ measure: 'data_health_last', based_on: 'scans.scanned_at_raw', type: 'max' }]);
  // Remembered — the next pull is still a single aggregated query.
  await h.mod.deviceRoster(m);
  assert.equal(bodies.length, 2);
});

test('withInfo: roster + timeline devices carry their latest station and operator', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterOnlineMin: 30, detailFields: ['scans.device_id', 'ops.handler'] });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    // The labels lookup is the only query that joins the station dimension in.
    if (b.fields.includes('scans.station_name')) {
      return [{ 'scans.device_id': 'D-9', 'scans.station_name': 'Gate B', 'ops.handler': 'Thabo', data_health_last: minsAgo(45) }];
    }
    if (b.fields.includes('data_health_last')) return [{ 'scans.device_id': 'D-9', data_health_last: minsAgo(45) }];
    return [{ 'scans.device_id': 'D-9', 'scans.scanned_at_hour': hourStr(), 'scans.count': 3 }];
  });
  const r = await h.mod.deviceRoster(m, true);
  assert.equal(r.offline[0].station, 'Gate B');
  assert.equal(r.offline[0].operator, 'Thabo');
  const t = await h.mod.deviceTimeline(m, 12, 60, '', true);
  assert.equal(t.devices[0].station, 'Gate B');
  assert.equal(t.devices[0].operator, 'Thabo');
  // Without the flag (scheduled checks) no labels query runs and none appear.
  const plain = await h.mod.deviceRoster(m);
  assert.equal(plain.offline[0].station, undefined);
});

test('deviceTimeline: station fallback filters the whole feed by the labels map', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.includes('data_health_last')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.station_name': 'Bar One', data_health_last: minsAgo(1) },
        { 'scans.device_id': 'D-2', 'scans.station_name': 'Bar Two', data_health_last: minsAgo(1) },
      ];
    }
    if (b.filters['scans.station_name']) return []; // the broken join path: the filtered count read finds nothing
    return [
      { 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 5 },
      { 'scans.device_id': 'D-2', 'scans.scanned_at_hour': hourStr(), 'scans.count': 7 },
    ];
  });
  const t = await h.mod.deviceTimeline(m, 12, 60, 'Bar One', true);
  assert.deepEqual(t.devices.map((d) => d.device), ['D-1']); // only the asked-for station's devices
  assert.equal(t.grandTotal, 5); // totals recomputed for the kept devices only
  assert.equal(t.station, 'Bar One');
  assert.equal(t.devices[0].station, 'Bar One');
});

test('labels: devices the timed read lost still get a station via the combo read', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    // Timed labels read: D-2 fell off the newest-first cap.
    if (b.fields.includes('data_health_last')) return [{ 'scans.device_id': 'D-1', 'scans.station_name': 'Bar One', data_health_last: minsAgo(2) }];
    // The no-timestamp combo read sees every device.
    if (b.fields.includes('scans.station_name')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.station_name': 'Bar One' },
        { 'scans.device_id': 'D-2', 'scans.station_name': 'Bar Two' },
      ];
    }
    return [
      { 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 2 },
      { 'scans.device_id': 'D-2', 'scans.scanned_at_hour': hourStr(), 'scans.count': 3 },
    ];
  });
  const t = await h.mod.deviceTimeline(m, 12, 60, '', true);
  assert.equal(t.devices.find((d) => d.device === 'D-1').station, 'Bar One');
  assert.equal(t.devices.find((d) => d.device === 'D-2').station, 'Bar Two'); // filled by the combo read
});

test('deviceTimeline: probes the explore catalogue for a real count measure', async () => {
  // Cumulative_topups_count sorts first alphabetically — the ranking must pick
  // transaction_count (the per-sale counter) and never query the topup one.
  const h = mountHealth({ looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [{ name: 'scans.Cumulative_topups_count' }, { name: 'scans.transaction_count' }, { name: 'other.count' }] }) } });
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  const bodies = [];
  h.setRowsFn(async (b) => {
    bodies.push(b);
    // The guessed native measure exists but counts another view — zero-only.
    if (b.fields.includes('scans.count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 0 }];
    if (b.fields.includes('scans.transaction_count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.transaction_count': 41 }];
    throw new Error('unexpected read');
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countBasis, 'native');
  assert.equal(t.countField, 'scans.transaction_count'); // exposed for the feed-total read
  assert.equal(t.devices[0].counts[11], 41); // the real per-sale volume
  assert.equal(t.grandTotal, 41);
  assert.ok(bodies.every((b) => !b.fields.includes('scans.Cumulative_topups_count'))); // the decoy never ran
  // Remembered — the next read goes straight to the probed measure.
  bodies.length = 0;
  await h.mod.deviceTimeline(m, 12);
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].fields.includes('scans.transaction_count'));
});

test('deviceTimeline: check-in monitors probe the attendance counter', async () => {
  // The check-ins family has no transaction_count — its per-scan counter is
  // Attendance_Check_Ins, and the plain .count is another zero-only row-counter.
  const h = mountHealth({ looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [{ name: 'scans.count' }, { name: 'scans.Attendance_Check_Ins' }] }) } });
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.Attendance_Check_Ins')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.Attendance_Check_Ins': 87 }];
    if (b.fields.includes('scans.count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 0 }];
    throw new Error('unexpected read');
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countField, 'scans.Attendance_Check_Ins');
  assert.equal(t.grandTotal, 87);
});

test('deviceTimeline: an EMPTY result from a counting mode falls through to the next', async () => {
  // A broken join can return zero rows for one measure while another works —
  // empty is as suspect as all-zeros for every mode except plain presence.
  const h = mountHealth({ looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [{ name: 'scans.Attendance_Check_Ins' }] }) } });
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.Attendance_Check_Ins')) return []; // dead join — no rows at all
    if (b.fields.includes('scans.count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 12 }];
    throw new Error('unexpected read');
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countField, 'scans.count');
  assert.equal(t.grandTotal, 12);
});

test('deviceTimeline: buckets by the RAW timeframe when minuteN is unknown', async () => {
  // The check-ins family has no created_at_minute10, and the picked _time
  // timeframe silently drops rows on this LookML — _raw is the working shape.
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const rawStr = new Date(Math.floor(Date.now() / 600000) * 600000).toISOString().replace('T', ' ').slice(0, 19);
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.scanned_at_minute10')) throw new Error('Unknown field "scans.scanned_at_minute10"');
    if (b.fields.includes('scans.scanned_at_raw')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_raw': rawStr, 'scans.count': 7 }];
    return []; // the _time bucket shape returns nothing — must never be accepted over raw
  });
  const t = await h.mod.deviceTimeline(m, 12, 10);
  assert.equal(t.bucketField, 'scans.scanned_at_raw');
  assert.equal(t.devices.length, 1);
  assert.equal(t.grandTotal, 7);
});

test('deviceTimeline: an hour bucket that reads empty falls through to raw', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const rawStr = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.scanned_at_hour')) return []; // hour shape drops every row
    if (b.fields.includes('scans.scanned_at_raw')) return [{ 'scans.device_id': 'D-9', 'scans.scanned_at_raw': rawStr, 'scans.count': 4 }];
    return [];
  });
  const t = await h.mod.deviceTimeline(m, 12, 60);
  assert.equal(t.bucketField, 'scans.scanned_at_raw');
  assert.equal(t.grandTotal, 4);
});

test('deviceTimeline: count_distinct falls back from _raw to the picked timeframe', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.count')) throw new Error('Unknown field "scans.count"');
    if (b.dynamic_fields && b.dynamic_fields.includes('_raw')) throw new Error('Unknown field "scans.scanned_at_raw"');
    return [{ 'scans.device_id': 'D-3', 'scans.scanned_at_hour': hourStr(), data_health_scans: 6 }];
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countBasis, 'distinct');
  assert.equal(t.devices[0].counts[11], 6);
});

test('deviceTimeline: a count measure that reads 0 for every row is a soft failure', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    // Combined-explore trap: scans.count exists but counts another view — 0s.
    if (b.fields.includes('scans.count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), 'scans.count': 0 }];
    if (b.fields.includes('data_health_scans')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(), data_health_scans: 9 }];
    return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr() }];
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countBasis, 'distinct'); // zero-only native rejected, real counts kept
  const d1 = t.devices[0];
  assert.equal(d1.counts[11], 9);
  assert.equal(d1.active[11], 1);
  assert.equal(t.grandTotal, 9);
});

test('rosterAnchor: daily SAST time beats fixed start; wraps to yesterday', () => {
  const h = mountHealth();
  const now = Date.parse('2026-07-03T10:00:00Z'); // 12:00 SAST
  const a = h.mod.rosterAnchor({ rosterDaily: '09:00', rosterStart: '2026-01-01T00:00:00.000Z' }, now);
  assert.equal(a.toISOString(), '2026-07-03T07:00:00.000Z'); // today 09:00 SAST (daily wins)
  const b = h.mod.rosterAnchor({ rosterDaily: '14:00' }, now); // today's 14:00 SAST still ahead
  assert.equal(b.toISOString(), '2026-07-02T12:00:00.000Z'); // → since yesterday 14:00 SAST
  assert.equal(h.mod.rosterAnchor({ rosterStart: '2026-01-01T00:00:00.000Z' }, now).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(h.mod.rosterAnchor({}, now), null);
});

test('deviceTimeline: per-device hour buckets over the window', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  let body = null;
  // Real Looker hour dims render "YYYY-MM-DD HH" (query_timezone UTC).
  const hourStr = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60000) / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  h.setRowsFn(async (b) => {
    body = b;
    return [
      { 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(0), 'scans.count': 42 },   // this hour
      { 'scans.device_id': 'D-1', 'scans.scanned_at_hour': hourStr(180), 'scans.count': 7 },  // 3 hours back
      { 'scans.device_id': 'D-2', 'scans.scanned_at_hour': hourStr(600), 'scans.count': 3 },  // 10 hours back
    ];
  });
  const t = await h.mod.deviceTimeline(m, 24);
  assert.equal(t.configured, true);
  assert.equal(t.hours, 24);
  assert.deepEqual(body.fields, ['scans.device_id', 'scans.scanned_at_hour', 'scans.count']); // hour sibling + native count measure
  assert.equal(body.filters['scans.scanned_at'], 'last 24 hours');
  const d1 = t.devices.find((d) => d.device === 'D-1');
  assert.equal(d1.active[23], 1);
  assert.equal(d1.active[20], 1);
  assert.equal(d1.active.filter(Boolean).length, 2);
  assert.equal(d1.counts[23], 42); // scans per block, straight from the count measure
  assert.equal(d1.total, 49);
  const d2 = t.devices.find((d) => d.device === 'D-2');
  assert.equal(d2.active[13], 1);
  assert.equal(t.bucketTotals[23], 42);
  assert.equal(t.grandTotal, 52);
  assert.equal(t.countBasis, 'native');
  // Hour-sibling derivation follows Looker's `${group}_${timeframe}` naming.
  const daily = makeMonitor(h, { name: 'Day level', rosterField: 'scans.device_id', timeField: 'scans.created_at_date' });
  assert.equal((await h.mod.deviceTimeline(daily, 12)).hourField, 'scans.created_at_hour');
  const timey = makeMonitor(h, { name: 'Timey', rosterField: 'scans.device_id', timeField: 'scans.created_at_time' });
  assert.equal((await h.mod.deviceTimeline(timey, 12)).hourField, 'scans.created_at_hour');
});

test('deviceTimeline: sub-hour blocks read the raw time dim and bucket by interval', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  let body = null;
  // Raw time dims render "YYYY-MM-DD HH:MM:SS" (query_timezone UTC).
  const tsStr = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString().slice(0, 19).replace('T', ' ');
  h.setRowsFn(async (b) => {
    // No minuteN (or _raw) timeframes in this LookML — the aggregate-bucket
    // probes 400 and the picked time dim takes over.
    const bad = b.fields.find((f) => f.includes('_minute') || f.endsWith('_raw'));
    if (bad) throw new Error(`Unknown field "${bad}"`);
    body = b;
    return [
      { 'scans.device_id': 'D-1', 'scans.scanned_at': tsStr(0), 'scans.count': 2 },  // current 10-min block
      { 'scans.device_id': 'D-1', 'scans.scanned_at': tsStr(95), 'scans.count': 5 }, // ~9 blocks back
    ];
  });
  const t = await h.mod.deviceTimeline(m, 12, 10);
  assert.equal(t.intervalMin, 10);
  assert.equal(t.buckets.length, 72); // 12h of 10-min blocks
  assert.deepEqual(body.fields, ['scans.device_id', 'scans.scanned_at', 'scans.count']); // raw dim + count, no hour sibling
  assert.equal(body.filters['scans.scanned_at'], 'last 12 hours');
  const d1 = t.devices.find((d) => d.device === 'D-1');
  assert.equal(d1.active[71], 1);
  assert.equal(d1.active.filter(Boolean).length, 2);
  assert.equal(d1.counts[71], 2); // per-second rows sum into their block
  assert.equal(d1.total, 7);
  // Junk interval falls back to hourly; tiny blocks cap the window at 288 blocks.
  assert.equal((await h.mod.deviceTimeline(m, 12, 7)).intervalMin, 60);
  const capped = await h.mod.deviceTimeline(m, 48, 5);
  assert.equal(capped.hours, 24); // 5-min blocks top out at 24h
  assert.equal(capped.buckets.length, 288);
});

test('deviceTimeline: minuteN bucket dim when the LookML has it; station narrows the read', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { name: 'Bars monitor', rosterField: 'scans.device_id' });
  // Looker minute10 dims render "YYYY-MM-DD HH:MM" floored to the block.
  const min10 = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60000) / 600000) * 600000).toISOString().slice(0, 16).replace('T', ' ');
  let body = null;
  h.setRowsFn(async (b) => { body = b; return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_minute10': min10(0), 'scans.count': 4 }]; });
  const t = await h.mod.deviceTimeline(m, 12, 10, 'Bar One');
  assert.ok(body.fields.includes('scans.scanned_at_minute10')); // aggregated in Looker — one row per device+block, not per scan
  assert.equal(body.filters['scans.station_name'], 'Bar One'); // plain value — same form as every other filter
  assert.equal(t.station, 'Bar One');
  assert.equal(t.devicesTotal, 1);
  const d1 = t.devices.find((d) => d.device === 'D-1');
  assert.equal(d1.counts[71], 4);
  // The working bucket dim is remembered — the next read goes straight to it.
  body = null;
  await h.mod.deviceTimeline(m, 12, 10);
  assert.ok(body.fields.includes('scans.scanned_at_minute10'));
  assert.equal(body.filters['scans.station_name'], undefined); // no station → whole monitor
  // Values carrying filter-syntax characters get quoted so they stay literal.
  await h.mod.deviceTimeline(m, 12, 10, 'Bar, The');
  assert.equal(body.filters['scans.station_name'], '"Bar, The"');
});

test('fleet alert: ≥ rosterAlertPct % of devices offline fires once, recovers once', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterOnlineMin: 30, rosterAlertPct: 20 });
  const roster = (offlineCount) => Array.from({ length: 10 }, (_, i) => (
    { 'scans.device_id': `D-${i}`, 'scans.scanned_at': minsAgo(i < offlineCount ? 120 : 5) }
  ));
  let rows = roster(3); // 30% offline ≥ 20% threshold
  h.setRowsFn(async (b) => (b.fields.includes('scans.device_id') ? rows : [feedRow('Gate B', 2)]));
  await h.mod.check(m);
  assert.equal(eventKinds(h, m.id).filter((k) => k === 'device_alert').length, 1);
  assert.equal(h.opsAlerts.length, 1);
  assert.match(h.opsAlerts[0].msg, /3 of 10 devices \(30%\)/);
  const snap = h.mod.monitorById(m.id).rosterSnapshot;
  assert.equal(snap.breach, true);
  // Still breaching → no re-fire (edge-detected).
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(eventKinds(h, m.id).filter((k) => k === 'device_alert').length, 1);
  // Fleet recovers → one recovery event, breach cleared.
  rows = roster(0);
  await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(eventKinds(h, m.id).filter((k) => k === 'device_recovered').length, 1);
  assert.equal(h.mod.monitorById(m.id).rosterSnapshot.breach, false);
  // Threshold off (0) → never fires, even fully offline.
  const off = makeMonitor(h, { name: 'No fleet alert', rosterField: 'scans.device_id', rosterAlertPct: 0 });
  rows = roster(10);
  await h.mod.check(off);
  assert.equal(eventKinds(h, off.id).filter((k) => k === 'device_alert').length, 0);
});

test('healthSummary scopes by entity and suite', () => {
  const h = mountHealth();
  const a = makeMonitor(h, { name: 'Client A gate', entityId: 'ent-a', suiteId: 'suite-1' });
  makeMonitor(h, { name: 'Client A wide', entityId: 'ent-a' });
  makeMonitor(h, { name: 'Client B gate', entityId: 'ent-b' });
  makeMonitor(h, { name: 'B bar', entityId: 'ent-b', area: 'Bar' });
  makeMonitor(h, { name: 'Platform', entityId: '' });
  // The suite shares one DB across tests — assert on THIS test's monitors only.
  const all = h.mod.healthSummary({});
  assert.equal(all.find((x) => x.name === 'B bar').unit, 'transactions'); // bars/vendors transact
  assert.equal(all.find((x) => x.name === 'Client B gate').unit, 'scans');
  assert.ok(['Client A gate', 'Client A wide', 'Client B gate', 'Platform'].every((n) => all.some((m) => m.name === n)));
  assert.ok(Array.isArray(all[0].streams));
  // entityIds = a caller's allowed set (drops platform-wide + other clients).
  const mine = h.mod.healthSummary({ entityIds: ['ent-a'] });
  assert.deepEqual(mine.map((m) => m.name).sort(), ['Client A gate', 'Client A wide']);
  // suiteId keeps that suite's monitors PLUS the client-wide ones.
  const forSuite = h.mod.healthSummary({ entityIds: ['ent-a'], suiteId: 'suite-1' });
  assert.deepEqual(forSuite.map((m) => m.name).sort(), ['Client A gate', 'Client A wide']);
  const otherSuite = h.mod.healthSummary({ entityIds: ['ent-a'], suiteId: 'suite-2' });
  assert.deepEqual(otherSuite.map((m) => m.name), ['Client A wide']);
  assert.equal(h.mod.healthSummary({ entityId: 'ent-b' })[0].id !== a.id, true);
});

test('check() stores a roster snapshot for collapsed cards', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterOnlineMin: 30 });
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.device_id')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.scanned_at': minsAgo(5) },
        { 'scans.device_id': 'D-2', 'scans.scanned_at': minsAgo(120) }, // silent past the online window
      ];
    }
    return [feedRow('Gate B', 3)];
  });
  await h.mod.check(m);
  const snap = h.mod.monitorById(m.id).rosterSnapshot;
  assert.equal(snap.total, 2);
  assert.equal(snap.online, 1);
  assert.equal(snap.offline, 1);
  assert.equal(snap.onlineMin, 30);
  // A roster read failure must not fail the check or wipe the last snapshot.
  h.setRowsFn(async (b) => {
    if (b.fields.includes('scans.device_id')) throw new Error('roster boom');
    return [feedRow('Gate B', 2)];
  });
  const r = await h.mod.check(h.mod.monitorById(m.id));
  assert.equal(r.ok, true);
  assert.equal(h.mod.monitorById(m.id).rosterSnapshot.total, 2);
});

test('deviceTimeline: hours="start" anchors the window to the roster start time', async () => {
  const h = mountHealth();
  // Once-off start 5 hours ago (stable regardless of wall clock, unlike a daily HH:MM).
  const start = new Date(Date.now() - 5 * 3600000);
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterStart: start.toISOString() });
  let body = null;
  h.setRowsFn(async (b) => { body = b; return []; });
  const t = await h.mod.deviceTimeline(m, 'start', 10);
  assert.equal(t.anchored, true);
  assert.equal(body.filters['scans.scanned_at'], `after ${start.toISOString().slice(0, 16).replace('T', ' ')}`);
  // First block is the one containing the start time; last is the current block.
  const first = Date.parse(t.buckets[0]);
  assert.ok(first <= start.getTime() && start.getTime() < first + 10 * 60000);
  const last = Date.parse(t.buckets[t.buckets.length - 1]);
  assert.ok(last <= Date.now() && Date.now() < last + 10 * 60000);
  // No anchor on the monitor → falls back to a rolling 24h.
  const plain = makeMonitor(h, { name: 'No anchor', rosterField: 'scans.device_id' });
  const f = await h.mod.deviceTimeline(plain, 'start', 60);
  assert.equal(f.anchored, false);
  assert.equal(f.hours, 24);
  assert.equal(body.filters['scans.scanned_at'], 'last 24 hours');
  // Long anchored windows keep the most recent 288 blocks and say so.
  const old = makeMonitor(h, { name: 'Old start', rosterField: 'scans.device_id', rosterStart: new Date(Date.now() - 60 * 3600000).toISOString() });
  const trimmed = await h.mod.deviceTimeline(old, 'start', 5);
  assert.equal(trimmed.buckets.length, 288);
  assert.equal(trimmed.trimmedStart, true);
});

test('deviceTimeline: falls back to a dynamic count when the view has no native count measure', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id' });
  const hourStr = () => new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13).replace('T', ' ');
  const bodies = [];
  h.setRowsFn(async (b) => {
    bodies.push(b);
    if (b.fields.includes('scans.count')) throw new Error('Unknown field "scans.count"'); // no native count on this view
    return [{ 'scans.device_id': 'D-9', 'scans.scanned_at_hour': hourStr(), data_health_scans: 11 }];
  });
  const t = await h.mod.deviceTimeline(m, 12);
  assert.equal(t.countBasis, 'distinct');
  const dyn = JSON.parse(bodies[1].dynamic_fields);
  assert.deepEqual(dyn, [{ measure: 'data_health_scans', based_on: 'scans.scanned_at_raw', type: 'count_distinct' }]);
  assert.equal(t.devices[0].counts[11], 11);
  // The working mode is remembered — the next read goes straight to the dynamic measure.
  await h.mod.deviceTimeline(m, 12);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[2].fields.includes('data_health_scans'));
});

test('check() stores the whole-feed day total with station narrowing dropped', async () => {
  const h = mountHealth({ looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [{ name: 'scans.transaction_count' }] }) } });
  const m = makeMonitor(h, {
    rosterField: 'scans.device_id',
    filters: { 'ev.name': 'KFF 26', 'scans.station_category': 'bar' },
  });
  const min10 = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60000) / 600000) * 600000).toISOString().slice(0, 16).replace('T', ' ');
  let feedBody = null;
  h.setRowsFn(async (b) => {
    // The feed-total read: ONLY the count measure, no device dimension.
    if (b.fields.length === 1 && b.fields[0] === 'scans.transaction_count') { feedBody = b; return [{ 'scans.transaction_count': 555 }]; }
    if (b.fields.includes('data_health_last')) return [{ 'scans.device_id': 'D-1', data_health_last: minsAgo(2) }];
    if (b.fields.includes('scans.count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_minute10': min10(0), 'scans.count': 0 }];
    if (b.fields.includes('scans.transaction_count')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at_minute10': min10(0), 'scans.transaction_count': 5 }];
    if (b.fields.includes('scans.device_id')) return [{ 'scans.device_id': 'D-1', 'scans.scanned_at': minsAgo(2) }];
    return [feedRow('Gate B', 2)];
  });
  await h.mod.check(m);
  const snap = h.mod.monitorById(m.id).rosterSnapshot;
  assert.equal(snap.feedTotal, 555);
  assert.ok(feedBody);
  assert.equal(feedBody.filters['scans.station_category'], undefined); // narrowing dropped
  assert.equal(feedBody.filters['scans.station_name'], undefined);
  assert.equal(feedBody.filters['ev.name'], 'KFF 26'); // event scope kept
});

test('check() stores a per-station roll-up for the signal board', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { rosterField: 'scans.device_id', rosterOnlineMin: 30 });
  const min10 = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60000) / 600000) * 600000).toISOString().slice(0, 16).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.length === 1) return [{ 'scans.count': 12 }];                       // whole-feed total
    if (b.fields.includes('data_health_latest')) return [feedRow('Gate B', 2)];      // stream read
    if (b.fields.includes('data_health_last')) {
      return [
        { 'scans.device_id': 'D-1', data_health_last: minsAgo(2) },
        { 'scans.device_id': 'D-2', data_health_last: minsAgo(120) },
      ];
    }
    if (b.fields.includes('scans.station_name') && b.fields.includes('scans.device_id')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.station_name': 'Bar One' },
        { 'scans.device_id': 'D-2', 'scans.station_name': 'Bar Two' },
      ];
    }
    if (b.fields.includes('scans.count')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.scanned_at_minute10': min10(0), 'scans.count': 5 },
        { 'scans.device_id': 'D-2', 'scans.scanned_at_minute10': min10(120), 'scans.count': 7 }, // quiet 2h → off
      ];
    }
    return [feedRow('Gate B', 2)];
  });
  await h.mod.check(m);
  const st = h.mod.monitorById(m.id).rosterSnapshot.stations;
  assert.ok(Array.isArray(st));
  const one = st.find((x) => x.station === 'Bar One');
  const two = st.find((x) => x.station === 'Bar Two');
  assert.equal(one.on, 1); assert.equal(one.off, 0); assert.equal(one.txnH, 5);
  assert.equal(two.on, 0); assert.equal(two.off, 1);
  assert.equal(one.spark.length, 6);
});

test('check() rolls a station-less monitor into one board entry', async () => {
  const h = mountHealth();
  const m = makeMonitor(h, { stationField: '', rosterField: 'scans.device_id', rosterOnlineMin: 30 });
  const min10 = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60000) / 600000) * 600000).toISOString().slice(0, 16).replace('T', ' ');
  h.setRowsFn(async (b) => {
    if (b.fields.length === 1) return [{ 'scans.count': 9 }];                        // whole-feed total
    if (b.fields.includes('data_health_latest')) return [{ data_health_latest: minsAgo(2) }];
    if (b.fields.includes('data_health_last')) {
      return [
        { 'scans.device_id': 'D-1', data_health_last: minsAgo(2) },
        { 'scans.device_id': 'D-2', data_health_last: minsAgo(120) },
      ];
    }
    if (b.fields.includes('scans.count')) {
      return [
        { 'scans.device_id': 'D-1', 'scans.scanned_at_minute10': min10(0), 'scans.count': 4 },
        { 'scans.device_id': 'D-2', 'scans.scanned_at_minute10': min10(120), 'scans.count': 3 },
      ];
    }
    return [{ data_health_latest: minsAgo(2) }];
  });
  await h.mod.check(m);
  const st = h.mod.monitorById(m.id).rosterSnapshot.stations;
  assert.ok(Array.isArray(st));
  assert.equal(st.length, 1);
  assert.equal(st[0].station, '');
  assert.equal(st[0].on, 1); assert.equal(st[0].off, 1); assert.equal(st[0].txnH, 4);
});

test('clean() bounds thresholds and drops junk filters', () => {
  const h = mountHealth();
  const c = h.mod.clean({
    name: 'x'.repeat(300), warnMin: -5, staleMin: 999999999, checkEveryMin: 0,
    filters: { good: 'v', empty: '  ', [`${'k'.repeat(300)}`]: 'kept' }, channels: ['push', 'nope', 'email'],
  });
  assert.equal(c.name.length, 120);
  assert.equal(c.warnMin, 1);
  assert.equal(c.staleMin, 10080);
  assert.equal(c.checkEveryMin, 0); // 0 = follow the master cadence
  assert.deepEqual(c.channels, ['push', 'email']);
  assert.equal(Object.keys(c.filters).length, 3);
  assert.equal(c.filters.empty, ''); // "open" filter: dimension kept, blank value
});
