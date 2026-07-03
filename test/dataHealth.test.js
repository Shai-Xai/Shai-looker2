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

test('clean() bounds thresholds and drops junk filters', () => {
  const h = mountHealth();
  const c = h.mod.clean({
    name: 'x'.repeat(300), warnMin: -5, staleMin: 999999999, checkEveryMin: 0,
    filters: { good: 'v', empty: '  ', [`${'k'.repeat(300)}`]: 'kept' }, channels: ['push', 'nope', 'email'],
  });
  assert.equal(c.name.length, 120);
  assert.equal(c.warnMin, 1);
  assert.equal(c.staleMin, 10080);
  assert.equal(c.checkEveryMin, 1);
  assert.deepEqual(c.channels, ['push', 'email']);
  assert.equal(Object.keys(c.filters).length, 2);
  assert.ok(!('empty' in c.filters));
});
