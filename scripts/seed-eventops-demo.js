// Stand up a ready-to-click Event Ops PILOT on a real instance: switch the pilot ON for a
// client, then create sample stations + devices, deploy some, and log an issue — so opening
// the app shows a populated Live board, Devices list, Stations board and Issues feed.
//
// It drives the REAL server/eventops.js route handlers (captured, no HTTP) with a synthetic
// admin, so everything goes through the same validation + append-only audit trail the app uses.
//
// Run against whatever DB the env points at (same DATA_DIR/DB_FILE as the server):
//   node scripts/seed-eventops-demo.js                 # creates a "Pilot — Event Ops" demo client
//   node scripts/seed-eventops-demo.js <entityId>      # seed an EXISTING client by id
//   node scripts/seed-eventops-demo.js <entityId> <suiteId>   # ...and an existing event
//
// Idempotent-ish: re-running creates another batch of devices; delete the demo client to reset.

const db = require('../server/db');
const auth = require('../server/auth');

// Capture the eventops routes so we can invoke handlers directly (mounting also creates tables).
const routes = {};
const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
require('../server/eventops').mount(app, { db, auth });

const ADMIN = { role: 'admin', email: 'seed-script@howler.co.za' };
function call(key, { params = {}, body = {}, query = {} } = {}) {
  const handler = routes[key];
  if (!handler) throw new Error(`No route ${key}`);
  let code = 200; let payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, end() { code = 204; return res; } };
  handler({ user: ADMIN, params, body, query }, res);
  if (code >= 400) throw new Error(`${key} → ${code}: ${(payload && payload.error) || ''}`);
  return payload;
}

function main() {
  let [entityId, suiteId] = process.argv.slice(2);

  // 1) Client (entity) — use the one given, else spin up a clearly-labelled demo client.
  let entity = entityId ? db.getEntity(entityId) : null;
  if (entityId && !entity) throw new Error(`No client with id ${entityId}`);
  if (!entity) { entity = db.createEntity({ name: 'Pilot — Event Ops' }); console.log(`• created demo client "${entity.name}" (${entity.id})`); }
  entityId = entity.id;

  // 2) Event (suite) — use the one given, else the client's first, else create one.
  let suite = suiteId ? db.getSuite(suiteId) : (db.listSuitesForEntity(entityId)[0] || null);
  if (suiteId && (!suite || suite.entityId !== entityId)) throw new Error(`No event ${suiteId} for this client`);
  if (!suite) { suite = db.createSuite({ entityId, name: 'Summer Festival 2026' }); console.log(`• created event "${suite.name}" (${suite.id})`); }
  suiteId = suite.id;
  const P = { suiteId };

  // 3) Switch the pilot ON for this client.
  call('PUT /api/eventops/entities/:entityId/enabled', { params: { entityId }, body: { enabled: true } });
  console.log('• Event Ops switched ON for the client');

  // 4) Stations.
  const stationSpecs = [['Main Bar', 'bar'], ['North Gate', 'gate'], ['Top-up Booth', 'topup'], ['Food Court', 'vendor']];
  const stations = stationSpecs.map(([name, kind]) => call('POST /api/eventops/suites/:suiteId/stations', { params: P, body: { name, kind } }).station);
  console.log(`• created ${stations.length} stations: ${stations.map((s) => s.name).join(', ')}`);

  // 5) Devices — a bulk batch of handhelds + a couple of radios.
  const bulk = call('POST /api/eventops/suites/:suiteId/devices/bulk', { params: P, body: { count: 12, prefix: 'SL', pad: 3, type: 'handheld' } });
  const radios = ['R-01', 'R-02'].map((c) => call('POST /api/eventops/suites/:suiteId/devices', { params: P, body: { label: c, qrCode: c, type: 'radio' } }).device);
  const devices = [...bulk.devices, ...radios];
  console.log(`• created ${devices.length} devices (${bulk.created} handhelds + ${radios.length} radios), all at the Hive`);

  // 6) Deploy ~half of them across stations so the Live board isn't empty.
  let moved = 0;
  devices.forEach((d, i) => {
    if (i % 2 === 0) { const st = stations[i % stations.length]; call('POST /api/eventops/suites/:suiteId/move', { params: P, body: { deviceId: d.id, stationId: st.id } }); moved++; }
  });
  console.log(`• deployed ${moved} devices out to stations (rest left at the Hive)`);

  // 7) A liaison check + an open issue, so the Issues feed has content.
  call('POST /api/eventops/suites/:suiteId/issues', { params: P, body: { deviceId: devices[1].id, category: 'battery', note: "Won't hold charge past 2h" } });
  call('POST /api/eventops/suites/:suiteId/issues', { params: P, body: { deviceId: radios[0].id, category: 'connectivity', note: 'Dropouts near the gate', resolution: 'Swapped channel' } });
  console.log('• logged 2 liaison issues (1 open, 1 resolved)');

  const ov = call('GET /api/eventops/suites/:suiteId/overview', { params: P });
  console.log('\n✅ Pilot ready. Overview:', JSON.stringify(ov.totals));
  console.log(`   Client:  ${entity.name}  (${entityId})`);
  console.log(`   Event:   ${suite.name}  (${suiteId})`);
  console.log('\nOpen the app → Admin → this client → Event Ops, or sign in as a member of this');
  console.log('client (with the eventops.manage permission) and open the Event Ops nav item.');
}

main();
