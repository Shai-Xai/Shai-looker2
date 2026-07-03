// Data health engine: per-station stream memory (silence detection), the
// fresh→stale edge-detection + cooldown, the recovery notice, and the scoped
// evaluation user. The Looker read is stubbed (runLookerQuery) so the tests drive
// the timestamps directly and assert WHEN an alert fires — the real deliverable.

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers');

function fakeApp() { return { get() {}, post() {}, put() {}, delete() {} }; }

// Mount with a controllable Looker feed + captured deliveries.
function mountHealth() {
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
    looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [] }) },
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
  assert.deepEqual(dyn, [{ measure: 'data_health_scans', based_on: 'scans.scanned_at', type: 'count_distinct' }]);
  assert.equal(t.devices[0].counts[11], 11);
  // The working mode is remembered — the next read goes straight to the dynamic measure.
  await h.mod.deviceTimeline(m, 12);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[2].fields.includes('data_health_scans'));
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
