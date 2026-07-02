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

test('pairing: a QR pairs one device per event; re-using it on another is rejected', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };

  // Create two unpaired devices (no QR yet).
  const a = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'Alpha' } }).body.device;
  const b = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'Bravo' } }).body.device;
  assert.equal(a.qrCode, '');

  // Pair a QR to device A via the update endpoint.
  const paired = call(r['PUT /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: a.id }, body: { qrCode: 'QR-100' } });
  assert.equal(paired.body.device.qrCode, 'QR-100');

  // The same QR on device B is rejected (409).
  const clash = call(r['PUT /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: b.id }, body: { qrCode: 'qr-100' } });
  assert.equal(clash.code, 409);

  // Unpair A (clear the QR), then B can take it.
  call(r['PUT /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: a.id }, body: { qrCode: '' } });
  const ok = call(r['PUT /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: b.id }, body: { qrCode: 'QR-100' } });
  assert.equal(ok.body.device.qrCode, 'QR-100');
});

test('device types: lazy-seeded defaults, add/rename/delete; rename re-tags devices', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };

  // First read lazy-seeds the defaults.
  const seeded = call(r['GET /api/eventops/suites/:suiteId/device-types'], { user: owner, params: P }).body.types;
  assert.ok(seeded.length >= 5 && seeded.some((t) => t.label === 'handheld'));

  // Add a custom type.
  const added = call(r['POST /api/eventops/suites/:suiteId/device-types'], { user: owner, params: P, body: { label: 'Scanner' } });
  assert.equal(added.code, 201);
  assert.ok(added.body.types.some((t) => t.label === 'Scanner'));
  // Duplicate (case-insensitive) is rejected.
  assert.equal(call(r['POST /api/eventops/suites/:suiteId/device-types'], { user: owner, params: P, body: { label: 'scanner' } }).code, 409);

  // A device on that type, then rename the type → the device is re-tagged.
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'S1', type: 'Scanner' } }).body.device;
  assert.equal(dev.type, 'Scanner');
  const scanner = added.body.types.find((t) => t.label === 'Scanner');
  call(r['PUT /api/eventops/suites/:suiteId/device-types/:id'], { user: owner, params: { ...P, id: scanner.id }, body: { label: 'Barcode gun' } });
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } }).body.device.type, 'Barcode gun');

  // Delete a type → gone from the catalogue (the device keeps its stored label).
  call(r['DELETE /api/eventops/suites/:suiteId/device-types/:id'], { user: owner, params: { ...P, id: scanner.id } });
  assert.ok(!call(r['GET /api/eventops/suites/:suiteId/device-types'], { user: owner, params: P }).body.types.some((t) => t.id === scanner.id));
});

test('issue categories: seed + default, add/rename (re-tags issues)/set-default/delete promotes', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };

  // Seeds with the built-ins; the first is the default.
  const seeded = call(r['GET /api/eventops/suites/:suiteId/issue-categories'], { user: owner, params: P }).body.categories;
  assert.ok(seeded.length >= 5);
  assert.equal(seeded.filter((c) => c.isDefault).length, 1);

  // Add a custom category as the new default.
  const added = call(r['POST /api/eventops/suites/:suiteId/issue-categories'], { user: owner, params: P, body: { label: 'Overheating', isDefault: true } });
  assert.equal(added.code, 201);
  const over = added.body.categories.find((c) => c.label === 'Overheating');
  assert.equal(over.isDefault, true);
  assert.equal(added.body.categories.filter((c) => c.isDefault).length, 1); // exactly one default
  // Case-insensitive duplicate rejected.
  assert.equal(call(r['POST /api/eventops/suites/:suiteId/issue-categories'], { user: owner, params: P, body: { label: 'overheating' } }).code, 409);

  // Log an issue on it, then rename the category → the issue is re-tagged.
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'D1', qrCode: 'D1' } }).body.device;
  const iss = call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'Overheating' } }).body.issue;
  assert.equal(iss.category, 'Overheating');
  call(r['PUT /api/eventops/suites/:suiteId/issue-categories/:id'], { user: owner, params: { ...P, id: over.id }, body: { label: 'Too hot' } });
  const issues = call(r['GET /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, query: { status: 'all' } }).body.issues;
  assert.equal(issues[0].category, 'Too hot');

  // Deleting the default promotes another so there's always a default.
  call(r['DELETE /api/eventops/suites/:suiteId/issue-categories/:id'], { user: owner, params: { ...P, id: over.id } });
  const after = call(r['GET /api/eventops/suites/:suiteId/issue-categories'], { user: owner, params: P }).body.categories;
  assert.ok(!after.some((c) => c.id === over.id));
  assert.equal(after.filter((c) => c.isDefault).length, 1);
});

test('staff link: a custom slug works and the old token is revoked', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Sam', number: '7' } });
  const old = call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body.token;

  // Set a friendly slug (sanitised).
  const set = call(r['PUT /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P, body: { slug: 'Summer Fest 2026!' } });
  assert.equal(set.body.token, 'summer-fest-2026');
  assert.ok(set.body.path.endsWith('/summer-fest-2026'));

  // The new slug gates the portal; the old token no longer works.
  assert.equal(call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: { suiteId: suite.id, token: 'summer-fest-2026' }, body: { number: '7' } }).code, 200);
  assert.equal(call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: { suiteId: suite.id, token: old }, body: { number: '7' } }).code, 403);

  // Too-short slugs are rejected.
  assert.equal(call(r['PUT /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P, body: { slug: 'ab' } }).code, 400);
});

test('deleting a device removes it and cascades its history + issues', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'Del1', qrCode: 'DEL1' } }).body.device;
  // Give it some history + an open issue.
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: station.id } });
  call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'battery' } });
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/overview'], { user: owner, params: P }).body.totals.openIssues, 1);

  // Delete it → 204, gone from the list, detail 404s, and its issue no longer counts.
  const delRes = call(r['DELETE /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } });
  assert.equal(delRes.code, 204);
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/devices'], { user: owner, params: P }).body.devices.length, 0);
  assert.equal(call(r['GET /api/eventops/suites/:suiteId/devices/:id'], { user: owner, params: { ...P, id: dev.id } }).code, 404);
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

test('portal reflects per-staff permissions: login returns canMove/canCheckpoint; move blocked when off', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  // A staffer who may NOT move, but MAY checkpoint.
  const staff = call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Nomove', number: '20', canMove: false, canCheckpoint: true } }).body.staff;
  assert.equal(staff.canMove, false);
  assert.equal(staff.canCheckpoint, true);
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'D9', qrCode: 'D9' } }).body.device;
  const KP = { suiteId: suite.id, token: call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body.token };

  // The portal login pulls those flags through verbatim.
  const login = call(r['POST /api/eventops/portal/:suiteId/:token/login'], { params: KP, body: { number: '20' } });
  assert.equal(login.body.staff.canMove, false);
  assert.equal(login.body.staff.canCheckpoint, true);

  // And the server actually enforces canMove=false on the portal move endpoint.
  const blocked = call(r['POST /api/eventops/portal/:suiteId/:token/move'], { params: KP, body: { deviceId: dev.id, stationId: station.id, staffId: staff.id } });
  assert.equal(blocked.code, 403);

  // Flip canMove on → the move now succeeds.
  call(r['PUT /api/eventops/suites/:suiteId/staff/:id'], { user: owner, params: { ...P, id: staff.id }, body: { canMove: true } });
  const ok = call(r['POST /api/eventops/portal/:suiteId/:token/move'], { params: KP, body: { deviceId: dev.id, stationId: station.id, staffId: staff.id } });
  assert.equal(ok.code, 200);
});

test('portal scan returns the device activity log', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'A1', qrCode: 'A1' } }).body.device;
  call(r['POST /api/eventops/suites/:suiteId/move'], { user: owner, params: P, body: { deviceId: dev.id, stationId: station.id } });
  const KP = { suiteId: suite.id, token: call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body.token };

  const scan = call(r['POST /api/eventops/portal/:suiteId/:token/scan'], { params: KP, body: { code: 'A1' } });
  assert.ok(Array.isArray(scan.body.events) && scan.body.events.length >= 2, 'scan returns the event history');
  assert.ok(scan.body.events.some((e) => e.kind === 'create'));
  assert.ok(scan.body.events.some((e) => e.kind === 'move' && e.toStation === 'Bar'));
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

test('checkpoints: define a type, submit one from the portal, and read it back in the log', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(r['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  const staff = call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Sam', number: '5', canCheckpoint: true } }).body.staff;
  const cp = call(r['POST /api/eventops/suites/:suiteId/checkpoints'], { user: owner, params: P, body: { name: 'Opening check' } }).body.checkpoint;
  assert.equal(cp.name, 'Opening check');

  const kiosk = call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body;
  const KP = { suiteId: suite.id, token: kiosk.token };
  // Portal info exposes the checkpoint types for the staff picker.
  assert.equal(call(r['GET /api/eventops/portal/:suiteId/:token'], { params: KP }).body.checkpoints[0].name, 'Opening check');

  // Staff submits the checkpoint with a comment.
  call(r['POST /api/eventops/portal/:suiteId/:token/checkpoint'], { params: KP, body: { stationId: station.id, checkpointId: cp.id, comment: 'All good', staffId: staff.id, photo: 'data:image/jpeg;base64,abc' } });
  const logs = call(r['GET /api/eventops/suites/:suiteId/checkpoint-logs'], { user: owner, params: P }).body.logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].checkpointName, 'Opening check');
  assert.equal(logs[0].stationLabel, 'Bar');
  assert.equal(logs[0].staffLabel, '#5 Sam');
  assert.equal(logs[0].comment, 'All good');
});

test('portal: staff can list + resolve issues', () => {
  const r = mount();
  const { entity, suite, owner, admin } = seedEvent();
  call(r['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const staff = call(r['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Sam', number: '5', canCheckpoint: true } }).body.staff;
  const dev = call(r['POST /api/eventops/suites/:suiteId/devices'], { user: owner, params: P, body: { label: 'X1', qrCode: 'X1' } }).body.device;
  const issue = call(r['POST /api/eventops/suites/:suiteId/issues'], { user: owner, params: P, body: { deviceId: dev.id, category: 'battery' } }).body.issue;
  const kiosk = call(r['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body;
  const KP = { suiteId: suite.id, token: kiosk.token };

  assert.equal(call(r['GET /api/eventops/portal/:suiteId/:token/issues'], { params: KP, query: { status: 'open' } }).body.issues.length, 1);
  call(r['PATCH /api/eventops/portal/:suiteId/:token/issues/:id'], { params: { ...KP, id: issue.id }, body: { staffId: staff.id, resolution: 'Swapped device' } });
  assert.equal(call(r['GET /api/eventops/portal/:suiteId/:token/issues'], { params: KP, query: { status: 'open' } }).body.issues.length, 0);
  const resolved = call(r['GET /api/eventops/portal/:suiteId/:token/issues'], { params: KP, query: { status: 'resolved' } }).body.issues;
  assert.equal(resolved[0].resolution, 'Swapped device');
});

test('owl read-only query API + a checkpoint requires a photo', () => {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  const eopApi = require('../server/eventops').mount(app, { db, auth });
  const { entity, suite, owner, admin } = seedEvent();
  call(routes['PUT /api/eventops/entities/:entityId/enabled'], { user: admin, params: { entityId: entity.id }, body: { enabled: true } });
  const P = { suiteId: suite.id };
  const station = call(routes['POST /api/eventops/suites/:suiteId/stations'], { user: owner, params: P, body: { name: 'Bar', kind: 'bar' } }).body.station;
  call(routes['POST /api/eventops/suites/:suiteId/devices/bulk'], { user: owner, params: P, body: { count: 2, prefix: 'OW', pad: 3 } });

  // Owl query API (what the eventOps Owl tool calls).
  const sum = eopApi.suiteSummary(suite.id);
  assert.equal(sum.devices.total, 2);
  assert.equal(sum.devices.atHive, 2);
  assert.equal(eopApi.locateDevice(suite.id, 'OW001').location, 'Hive');
  assert.equal(eopApi.listDevices(suite.id, { state: 'in_stock' }).length, 2);
  assert.equal(eopApi.locateDevice(suite.id, 'nope'), null);

  // Checkpoint requires a photo.
  const staff = call(routes['POST /api/eventops/suites/:suiteId/staff'], { user: owner, params: P, body: { name: 'Sam', number: '5', canCheckpoint: true } }).body.staff;
  const kiosk = call(routes['GET /api/eventops/suites/:suiteId/kiosk'], { user: owner, params: P }).body;
  const KP = { suiteId: suite.id, token: kiosk.token };
  assert.equal(call(routes['POST /api/eventops/portal/:suiteId/:token/checkpoint'], { params: KP, body: { stationId: station.id, staffId: staff.id, comment: 'x' } }).code, 400);
  assert.equal(call(routes['POST /api/eventops/portal/:suiteId/:token/checkpoint'], { params: KP, body: { stationId: station.id, staffId: staff.id, photo: 'data:image/jpeg;base64,abc' } }).code, 201);
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
