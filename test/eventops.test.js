// Event Ops (device + station logistics) — exercises the state-machine helper, the
// per-client pilot toggle gate, hive↔station moves with the append-only audit trail,
// the scope guards, and the issue/liaison-check flow. Routes are invoked directly via
// captured handlers (no HTTP), mirroring test/vanity.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const eventops = require('../server/eventops');

// Capture registered route handlers (last middleware = the handler) so we can call them.
function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  eventops.mount(app, { db, auth });
  return routes;
}
function call(handler, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, end() { code = code === 200 ? 204 : code; return res; } };
  handler({ user, params, body, query }, res);
  return { code, body: payload };
}

// A pilot event: an entity, a suite (the event), an owner-role client user, plus an
// outsider who belongs to a different client. Event Ops is OFF until we toggle it on.
function seedEvent() {
  const entity = makeEntity('Bushfire', 'bushfire');
  const suite = db.createSuite({ entityId: entity.id, name: 'Bushfire 2026' });
  const owner = makeClient(`owner-${entity.id}@test.local`, [entity.id], 'owner');
  const other = makeClient(`other-${entity.id}@test.local`, [makeEntity('Rival', 'rival').id], 'owner');
  const admin = makeAdmin(`admin-${entity.id}@test.local`);
  return { entity, suite, owner, other, admin };
}

test('isUnusual: only re-activating a written-off device is flagged', () => {
  assert.equal(eventops.isUnusual('in_stock', 'deployed'), false); // normal deploy
  assert.equal(eventops.isUnusual('deployed', 'in_stock'), false); // normal return to hive
  assert.equal(eventops.isUnusual('lost', 'deployed'), true);      // a "lost" unit reappears → flag
  assert.equal(eventops.isUnusual('damaged', 'in_stock'), true);
  assert.equal(eventops.isUnusual('lost', 'damaged'), false);      // terminal→terminal, not a re-activation
});

test('per-client toggle gates everything: OFF → 404, ON → works; only admins can flip it', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();

  // OFF by default: a member still gets the disabled shape, and the nav-gate list is empty.
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: { suiteId: suite.id } }).code, 404);
  assert.deepEqual(call(r['GET /api/eventops/enabled'], { user: owner }).body.entities, []);

  // (Non-admins are blocked from flipping the pilot by the auth.requireAdmin middleware,
  // which is the real boundary; this captured-handler harness bypasses middleware, so that
  // guard is covered by auth's own tests, not re-asserted here.)

  // Admin turns it on for this client.
  const flip = call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  assert.equal(flip.body.enabled, true);

  // Now the member sees it, and the nav gate lists their entity.
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: { suiteId: suite.id } }).code, 200);
  assert.deepEqual(call(r['GET /api/eventops/enabled'], { user: owner }).body.entities, [entity.id]);
});

test('enabling an unknown client 404s (not a 500) — db.getEntity must not throw on a miss', () => {
  const r = mount();
  const { admin } = seedEvent();
  // Regression: rowToEntity used to dereference a missing row before its null-guard, so
  // db.getEntity('nope') threw → the route 500'd instead of returning a clean 404.
  assert.equal(require('../server/db').getEntity('does-not-exist'), undefined);
  const res = call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: 'does-not-exist' }, body: { enabled: true } });
  assert.equal(res.code, 404);
});

test('scope guard: a member of another client cannot view this event (403)', () => {
  const r = mount();
  const { entity, suite, other, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const res = call(r['GET /api/eventops/suites/:suiteId/overview'], { user: other, params: { suiteId: suite.id } });
  assert.equal(res.code, 403);
});

test('full workflow: add devices → station → scan → move hive↔station → audit trail', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };

  // Bulk-create 3 devices by prefix → SL001..SL003, all start at the Hive (in_stock).
  const bulk = call(r['POST /api/eventops/suites/:suiteId/devices/bulk'], { user: owner, params: P, body: { count: 3, prefix: 'SL', pad: 3 } });
  assert.equal(bulk.code, 201);
  assert.equal(bulk.body.created, 3);
  assert.ok(bulk.body.devices.every((d) => d.state === 'in_stock' && d.location === 'Hive'));

  // Create a station.
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Main Bar', kind: 'bar' } });
  assert.equal(station.code, 201);
  const stationId = station.body.station.id;

  // Scan SL001 → resolves the device by its qr_code.
  const scan = call(r['POST /api/eventops/suites/:suiteId/scan'], { user: owner, params: P, body: { code: 'SL001' } });
  assert.equal(scan.code, 200);
  const dev = scan.body.device;
  assert.equal(dev.qrCode, 'SL001');

  // Move it Hive → Main Bar: becomes deployed at that station.
  const toBar = call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId } });
  assert.equal(toBar.body.device.state, 'deployed');
  assert.equal(toBar.body.device.stationId, stationId);
  assert.equal(toBar.body.unusual, false);

  // Station board now shows 1 deployed device there.
  const board = call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: P });
  assert.equal(board.body.totals.deployed, 1);
  assert.equal(board.body.stations.find((s) => s.id === stationId).deviceCount, 1);

  // Move it back to the Hive.
  const toHive = call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: 'hive' } });
  assert.equal(toHive.body.device.state, 'in_stock');
  assert.equal(toHive.body.device.stationId, null);

  // The append-only audit trail recorded: create, deploy(move), return(move).
  const detail = call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } });
  const kinds = detail.body.events.map((e) => e.kind);
  assert.ok(kinds.includes('create') && kinds.filter((k) => k === 'move').length === 2);
});

test('scan resolves by label and is case-insensitive (code entered in the label field still scans)', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  // Device added with the code ONLY in the label (qrCode/serial left blank) — the common
  // data-entry case that used to read as "no match" on scan.
  call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'SL002' } });
  assert.equal(call(r['POST /api/eventops/suites/:suiteId/scan'], { user: owner, params: P, body: { code: 'SL002' } }).body.device.label, 'SL002');
  // ...and case-insensitively.
  assert.equal(call(r['POST /api/eventops/suites/:suiteId/scan'], { user: owner, params: P, body: { code: 'sl002' } }).body.device.label, 'SL002');
  // A real QR/serial match still wins and is case-insensitive too.
  call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'Handheld 7', qrCode: 'QR-7' } });
  assert.equal(call(r['POST /api/eventops/suites/:suiteId/scan'], { user: owner, params: P, body: { code: 'qr-7' } }).body.device.qrCode, 'QR-7');
});

test('a lost device scanned back into deployment is flagged unusual in the trail', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const made = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'R1', qrCode: 'R1', type: 'radio' } }).body.device;
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Gate 1', kind: 'gate' } }).body.station;

  // Mark it lost, then redeploy it → the redeploy is flagged unusual.
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: made.id, state: 'lost' } });
  const back = call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: made.id, stationId: station.id } });
  assert.equal(back.body.unusual, true);
});

test('liaison logs an issue on a device, then resolves it', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'H9', qrCode: 'H9' } }).body.device;

  const logged = call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'battery', note: 'Won’t hold charge' } });
  assert.equal(logged.code, 201);
  assert.equal(logged.body.issue.status, 'open');

  // Shows up in the open-issues list and bumps the overview count.
  const open = call(r['GET /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, query: { status: 'open' } });
  assert.equal(open.body.issues.length, 1);
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: P }).body.totals.openIssues, 1);

  // Resolve it.
  const resolved = call(r['PATCH /api/eventops/suites/:suiteId/issues/:id'], { user: owner, params: { ...P, id: logged.body.issue.id }, body: { resolution: 'Swapped battery pack' } });
  assert.equal(resolved.body.issue.status, 'resolved');
  assert.equal(resolved.body.issue.resolution, 'Swapped battery pack');
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: P }).body.totals.openIssues, 0);
});

test('staff: create + attribute a move and an issue to a staff member', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };

  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Gate', kind: 'gate' } }).body.station;
  const staff = call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Jane', number: '101', stationId: station.id } }).body.staff;
  assert.equal(staff.number, '101');
  assert.equal(staff.stationName, 'Gate'); // optional posting resolved

  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'D1', qrCode: 'D1' } }).body.device;

  // Move attributed to staff → the audit event carries the denormalised staff label.
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: station.id, staffId: staff.id } });
  const detail = call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } });
  assert.ok(detail.body.events.some((e) => e.staffLabel === '#101 Jane'), 'move event attributed to #101 Jane');

  // Issue attributed to staff → the issue row carries the label too.
  const issue = call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'battery', staffId: staff.id } }).body.issue;
  assert.equal(issue.staffLabel, '#101 Jane');
  assert.equal(issue.stationLabel, 'Gate'); // the device was at Gate when the issue was raised

  // Attribution is optional — a move with no staffId still works (blank label).
  const moved = call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: 'hive' } });
  assert.equal(moved.body.device.state, 'in_stock');

  // Deleting the staff member keeps the historical label on the issue (denormalised).
  call(r['DELETE /api/eventops/suites/:suiteId/staff/:id'], { user: owner, params: { ...P, id: staff.id } });
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/staff'], { user: owner, params: P }).body.staff.length, 0);
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, query: { status: 'all' } }).body.issues[0].staffLabel, '#101 Jane');
});

test('staff portal: token gates access; staff log in by number, then move + log attributed', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  const staff = call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Sam', number: '7', stationId: station.id } }).body.staff;
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'P1', qrCode: 'P1' } }).body.device;

  // Get the kiosk token (auto-created), then exercise the PUBLIC routes (no user).
  const kiosk = call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body;
  assert.ok(kiosk.token && kiosk.path.includes(kiosk.token));
  const KP = { suiteId: suite.id, token: kiosk.token };

  // Wrong token → 403.
  assert.equal(call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: { suiteId: suite.id, token: 'nope' }, body: { number: '7' } }).code, 403);

  // Login by number (public).
  const login = call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: KP, body: { number: '7' } });
  assert.equal(login.body.staff.name, 'Sam');
  const staffId = login.body.staff.id;
  assert.equal(call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: KP, body: { number: '999' } }).code, 404);

  // Staff moves a device via the portal → attributed to them in the audit trail.
  call(r['POST /api/eventops/portal/:suiteId/:token/move'], { params: KP, body: { deviceId: dev.id, stationId: station.id, staffId } });
  const detail = call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } });
  assert.ok(detail.body.events.some((e) => e.staffLabel === '#7 Sam'), 'portal move attributed to #7 Sam');

  // Their "me" view shows their station's deployed device + lets them see issues.
  call(r['POST /api/eventops/portal/:suiteId/:token/issue'], { params: KP, body: { deviceId: dev.id, category: 'battery', staffId } });
  const me = call(r['GET /api/eventops/portal/:suiteId/:token/me/:staffId'], { params: { ...KP, staffId } });
  assert.equal(me.body.stations.length, 1);
  assert.equal(me.body.stations[0].name, 'Bar');
  assert.equal(me.body.stations[0].devices.length, 1);
  assert.equal(me.body.stations[0].issues.length, 1);

  // Rotating the token revokes the old link.
  call(r['POST /api/eventops/suites/:suiteId/kiosk/rotate'], { user: owner, params: P });
  assert.equal(call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: KP, body: { number: '7' } }).code, 403);
});

test('map: stations carry scale/rotation + an open-issue marker count', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  assert.equal(station.scale, 1); assert.equal(station.rotation, 0); assert.equal(station.openIssues, 0);

  // Resize + rotate persist (rotation normalises into 0..360).
  const up = call(r['PUT /api/eventops/suites/:suiteId/stations/:id'], { user: owner, params: { ...P, id: station.id }, body: { scale: 1.6, rotation: 375 } }).body.station;
  assert.equal(up.scale, 1.6); assert.equal(up.rotation, 15);

  // Deploy a device there and open an issue → the station shows an open-issue marker.
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'M1', qrCode: 'M1' } }).body.device;
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: station.id } });
  call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'battery' } });
  const stations = call(r['GET /api/eventops/suites/:suiteId/stations'], { user: owner, params: P }).body.stations;
  assert.equal(stations.find((s) => s.id === station.id).openIssues, 1);
});

test('deleting a station sends its deployed devices back to the Hive', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'K1', qrCode: 'K1' } }).body.device;
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Booth', kind: 'booth' } }).body.station;
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: station.id } });

  const del = call(r['DELETE /api/eventops/suites/:suiteId/stations/:id'], { user: owner, params: { ...P, id: station.id } });
  assert.equal(del.code, 204);
  const after = call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } });
  assert.equal(after.body.device.state, 'in_stock');
  assert.equal(after.body.device.stationId, null);
});
