// Staff alerts phase 1: the board-station ↔ ops-station bridge (auto match +
// manual override) and the dark-station rule (half dark → alert the assigned
// crew, edge-detected; recovery under a quarter). Test mode captures emails.

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers');

function fakeApp() { return { get() {}, post() {}, put() {}, patch() {}, delete() {} }; }

function mountAlerts() {
  const sql = db.db;
  const testEmails = [];
  const pushes = [];
  const rawSends = [];
  const waSends = [];
  const auth = { requireAuth: (_req, _res, next) => next && next(), requireAdmin: (_req, _res, next) => next && next() };
  // The bridge reads the REAL eventops_* and data_monitors tables — mount those
  // modules (stubbed deps) so their schemas exist, exactly as in production.
  require('../server/eventops').mount(fakeApp(), { db, auth });
  require('../server/dataHealth').mount(fakeApp(), {
    db, auth, looker: { listModels: async () => [], getExploreFields: async () => ({ dimensions: [], measures: [] }) },
    runLookerQuery: async () => [], applyScope: async () => true,
    os: { announce: () => ({ id: 't' }) }, ops: { alert: () => {} }, mailer: { send: async () => ({ ok: true }) },
  });
  db.setSetting('data_health_test_mode', '1');
  db.setSetting('data_health_test_email', 'shai@test');
  const mod = require('../server/staffAlerts').mount(fakeApp(), {
    db, auth,
    mailer: { send: async (m) => { testEmails.push(m); return { ok: true }; } },
    push: { isEnabled: () => true, sendToUser: async (u, p) => { pushes.push({ u, p }); return 1; }, sendToEntity: async (e, p) => { pushes.push({ e, p }); return 1; }, sendRaw: async (rows) => { rawSends.push(rows); return rows.length; }, vapidPublicKey: () => 'k' },
    messaging: { normaliseMsisdn: (n) => String(n || '').replace(/[^\d]/g, ''), sendWhatsapp: async (m) => { waSends.push(m); return { ok: true }; }, waFrom: () => '27110001111', waConfigured: () => true },
  });
  return { mod, sql, testEmails, pushes, rawSends, waSends };
}

// Seed one suite: an ops station + a staffer at it, and a monitor whose
// snapshot carries the same-named board station in the given on/off state.
function seed(h, { on, off, health = 'FUTUR BAR', ops = 'Futur Bar' }) {
  const sql = h.sql;
  sql.prepare('DELETE FROM eventops_stations').run(); sql.prepare('DELETE FROM eventops_staff').run();
  sql.prepare('DELETE FROM data_monitors').run(); sql.prepare('DELETE FROM staff_alert_state').run(); sql.prepare('DELETE FROM staff_alert_log').run();
  sql.prepare('DELETE FROM eventops_staff_push').run(); sql.prepare('DELETE FROM eventops_staff_wa').run();
  sql.prepare("INSERT INTO eventops_stations (id, entity_id, suite_id, name, kind, created_at) VALUES ('st1','ent1','su1',?, 'bar', '2026-01-01')").run(ops);
  sql.prepare("INSERT INTO eventops_staff (id, entity_id, suite_id, name, number, role, station_id, created_at) VALUES ('sf1','ent1','su1','Thabo','+2782','bars','st1','2026-01-01')").run();
  sql.prepare(`INSERT INTO data_monitors (id, name, area, entity_id, suite_id, model, view, time_field, station_field, detail_fields, warn_min, stale_min, check_every_min, cooldown_min, status, state, filters, roster_snapshot, created_at, updated_at)
    VALUES ('m1','Bars','Bar','ent1','su1','m','v','v.t','v.s','[]',15,30,5,60,'active','ok','{}',?, '2026-01-01', '2026-01-01')`)
    .run(JSON.stringify({ stations: [{ station: health, on, off, txnH: 9, spark: [0, 0, 0, 0, 0, 0] }] }));
}

test('auto name-match bridges FUTUR BAR to the Futur Bar ops station', () => {
  const h = mountAlerts();
  seed(h, { on: 4, off: 0 });
  const opsStations = h.sql.prepare('SELECT id, name FROM eventops_stations').all();
  const map = h.mod.resolveStation('su1', 'FUTUR BAR', opsStations);
  assert.equal(map.id, 'st1');
  assert.equal(map.manual, false);
});

test('half the devices dark fires ONE test-mode alert naming the crew, then recovery logs', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  h.mod.tick();
  h.mod.tick(); // second tick must not re-fire (edge-detected)
  assert.equal(h.testEmails.length, 1);
  assert.match(h.testEmails[0].subject, /FUTUR BAR/);
  assert.match(h.testEmails[0].text, /Thabo/);
  assert.match(h.testEmails[0].text, /TEST MODE/);
  // recovery: back above three-quarters online
  seed(h, { on: 4, off: 0 });
  h.sql.prepare("INSERT INTO staff_alert_state (k, status, at) VALUES ('su1|FUTUR BAR','alerting','2026-01-01')").run();
  h.mod.tick();
  const kinds = h.sql.prepare('SELECT kind FROM staff_alert_log ORDER BY at').all().map((r) => r.kind);
  assert.ok(kinds.includes('recovered'));
});

test('storm guard: many stations crossing together send ONE site-wide note', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  // five stations half-dark in the same snapshot — a pipe stall signature
  h.sql.prepare('UPDATE data_monitors SET roster_snapshot=?').run(JSON.stringify({
    stations: [1, 2, 3, 4, 5].map((i) => ({ station: `BAR ${i}`, on: 2, off: 2, txnH: 0, spark: [0, 0, 0, 0, 0, 0] })),
  }));
  h.mod.tick();
  h.mod.tick(); // 15-min site cooldown: no second combined note either
  assert.equal(h.testEmails.length, 1);
  assert.match(h.testEmails[0].subject, /5 stations went dark together/);
  assert.match(h.testEmails[0].text, /BAR 1 2\/4 dark/);
});

test('after go-live, a subscribed crew member is pushed on their own phone', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  db.setSetting('data_health_test_mode', '0'); // go live
  // The eventops_staff_push table is created by eventops.mount in the harness.
  h.sql.prepare("INSERT INTO eventops_staff_push (staff_id, suite_id, endpoint, p256dh, auth, created_at) VALUES ('sf1','su1','https://push/ep','p','a','2026-01-01')").run();
  h.mod.tick();
  // sendRaw receives the subscription rows; assert one carried our endpoint.
  assert.ok(h.rawSends.some((rows) => rows.some((r) => r.endpoint === 'https://push/ep')));
  db.setSetting('data_health_test_mode', '1');
});

test('staffInbound captures a known staff number (kept off the Owl) and ignores others', async () => {
  const h = mountAlerts();
  seed(h, { on: 4, off: 0 }); // staffer Thabo, number +2782, at su1
  // A message from Thabo's number → intercepted (returns true), captured, replied.
  const handled = await h.mod.staffInbound('+2782', 'hi');
  assert.equal(handled, true);
  assert.equal(h.waSends.length, 1);
  assert.match(h.waSends[0].text, /station alerts on WhatsApp/);
  const row = h.sql.prepare("SELECT * FROM eventops_staff_wa WHERE staff_id='sf1'").get();
  assert.ok(row && row.msisdn === '2782');
  // An unknown number → NOT handled (falls through to the Owl).
  const other = await h.mod.staffInbound('+9999', 'hello');
  assert.equal(other, false);
});

test('after go-live, a WhatsApp-window staffer gets the alert on WhatsApp', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  db.setSetting('data_health_test_mode', '0');
  h.sql.prepare("INSERT INTO eventops_staff_wa (msisdn, staff_id, suite_id, last_in_at, last_msg, opted_out) VALUES ('2782','sf1','su1',?, 'hi', 0)").run(new Date().toISOString());
  h.mod.tick();
  assert.ok(h.waSends.some((m) => m.to === '2782' && /devices dark/.test(m.text)));
  db.setSetting('data_health_test_mode', '1');
});

test('the master all-off switch silences every event', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  db.setSetting('staff_alerts_all_off', '1');
  h.mod.tick();
  assert.equal(h.testEmails.length, 0);
  db.setSetting('staff_alerts_all_off', '0');
  h.mod.tick();
  assert.equal(h.testEmails.length, 1);
});

test('a paused event fires nothing until resumed', () => {
  const h = mountAlerts();
  seed(h, { on: 2, off: 2 });
  db.setSetting('staff_alerts_paused_su1', '1');
  h.mod.tick();
  assert.equal(h.testEmails.length, 0);
  db.setSetting('staff_alerts_paused_su1', '0');
  h.mod.tick();
  assert.equal(h.testEmails.length, 1);
});

test('a manual bridge override beats the name match; single devices never page', () => {
  const h = mountAlerts();
  seed(h, { on: 0, off: 1, health: 'MYSTERY STAND', ops: 'Totally Different' });
  h.mod.tick(); // 1 device dark — below the 2-device floor, no alert
  assert.equal(h.testEmails.length, 0);
  h.sql.prepare("INSERT INTO staff_alert_bridge (suite_id, health_station, ops_station_id) VALUES ('su1','MYSTERY STAND','st1')").run();
  const opsStations = h.sql.prepare('SELECT id, name FROM eventops_stations').all();
  const map = h.mod.resolveStation('su1', 'MYSTERY STAND', opsStations);
  assert.equal(map.id, 'st1');
  assert.equal(map.manual, true);
});
