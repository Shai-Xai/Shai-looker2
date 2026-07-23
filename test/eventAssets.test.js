// Event Media Assets (server/eventAssets.js) — the Phase-1 "app pulls event
// media from Pulse" slice. Exercises: suite access guards, upload → slot draft →
// publish lifecycle, the public by-event manifest (absolute URLs, flag kill
// switch, quiet 404 on misses), slot-URL sanitising, and unpublish. Routes are
// invoked directly via captured handlers (no HTTP), mirroring test/surveys.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const eventAssets = require('../server/eventAssets');
const flags = require('../server/flags');

flags.init(db);
const setFlag = (entityId, value) => db.db
  .prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?, 'eventassets', ?, 'test', ?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value")
  .run(entityId, value, new Date().toISOString());

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  eventAssets.mount(app, { db, auth });
  return routes;
}
const routes = mount();

async function call(key, { user, params = {}, body = {}, query = {}, headers = {} } = {}) {
  let code = 200, payload, ended = false;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { payload = payload ?? d; return res; },
    set() { return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = { user, params, body, query, headers, protocol: 'https', get: () => 'pulse.test' };
  try {
    await routes[key](req, res);
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.message };
  }
  return { code, body: payload, ended };
}

let seq = 0;
function seedClient({ howlerEventId = '' } = {}) {
  seq += 1;
  const entity = makeEntity(`Org ${seq}`, `org-${seq}`);
  setFlag(entity.id, 'on'); // eventassets defaults OFF — tests opt their client in
  const suite = db.createSuite({ entityId: entity.id, name: `Event ${seq}` });
  if (howlerEventId) db.updateSuite(suite.id, { howlerEventId });
  const owner = makeClient(`ea-owner-${seq}@test.local`, [entity.id], 'owner');
  const viewer = makeClient(`ea-viewer-${seq}@test.local`, [entity.id], 'viewer');
  return { entity, suite: db.getSuite(suite.id), owner, viewer };
}

const PNG64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'); // a few real PNG magic bytes

test('slot state: all pilot slots present and empty for a fresh suite', async () => {
  const { suite, owner } = seedClient();
  const r = await call('GET /api/eventassets/suites/:suiteId', { user: owner, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.slots.map((s) => s.key), ['header_image', 'header_video', 'logo']);
  assert.ok(r.body.slots.every((s) => !s.draftUrl && !s.publishedUrl && !s.dirty));
  assert.equal(r.body.canManage, true);
});

test('access: outsiders 403, unknown suite 404, viewer can look but not manage', async () => {
  const a = seedClient();
  const b = seedClient();
  const outsider = await call('GET /api/eventassets/suites/:suiteId', { user: b.owner, params: { suiteId: a.suite.id } });
  assert.equal(outsider.code, 403);
  const missing = await call('GET /api/eventassets/suites/:suiteId', { user: a.owner, params: { suiteId: 'nope' } });
  assert.equal(missing.code, 404);
  const viewer = await call('GET /api/eventassets/suites/:suiteId', { user: a.viewer, params: { suiteId: a.suite.id } });
  assert.equal(viewer.code, 200);
  assert.equal(viewer.body.canManage, false);
  const write = await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: a.viewer, params: { suiteId: a.suite.id, slot: 'logo' }, body: { url: 'https://x.test/a.png' } });
  assert.equal(write.code, 403);
});

test('upload → draft → publish → manifest, then unpublish', async () => {
  const { suite, owner } = seedClient({ howlerEventId: '19203' });

  const up = await call('POST /api/eventassets/suites/:suiteId/media', { user: owner, params: { suiteId: suite.id }, body: { name: 'hero.png', mime: 'image/png', data: PNG64 } });
  assert.equal(up.code, 200);
  assert.match(up.body.url, /^\/api\/app\/event-assets\/media\//);

  const draft = await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: owner, params: { suiteId: suite.id, slot: 'header_image' }, body: { url: up.body.url, mime: 'image/png' } });
  assert.equal(draft.code, 200);
  const slot = draft.body.slots.find((s) => s.key === 'header_image');
  assert.equal(slot.draftUrl, up.body.url);
  assert.equal(slot.dirty, true);
  assert.equal(slot.publishedUrl, '');

  // Draft alone must NOT reach the app.
  const pre = await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '19203' } });
  assert.equal(pre.code, 404);

  const pub = await call('POST /api/eventassets/suites/:suiteId/publish', { user: owner, params: { suiteId: suite.id } });
  assert.equal(pub.body.slots.find((s) => s.key === 'header_image').dirty, false);

  const man = await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '19203' } });
  assert.equal(man.code, 200);
  assert.equal(man.body.eventId, '19203');
  assert.equal(man.body.assets.header_image.url, `https://pulse.test${up.body.url}`); // relative URLs served absolute
  assert.equal(man.body.assets.header_image.mime, 'image/png');
  assert.equal(man.body.assets.header_video, undefined); // empty slots stay out of the manifest

  await call('POST /api/eventassets/suites/:suiteId/unpublish', { user: owner, params: { suiteId: suite.id } });
  const gone = await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '19203' } });
  assert.equal(gone.code, 404);
});

test('manifest kill switch: flag off → 404 even with published assets', async () => {
  const { entity, suite, owner } = seedClient({ howlerEventId: '31001' });
  await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: owner, params: { suiteId: suite.id, slot: 'logo' }, body: { url: 'https://cdn.test/logo.png', mime: 'image/png' } });
  await call('POST /api/eventassets/suites/:suiteId/publish', { user: owner, params: { suiteId: suite.id } });
  assert.equal((await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '31001' } })).code, 200);
  setFlag(entity.id, 'off');
  assert.equal((await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '31001' } })).code, 404);
  setFlag(entity.id, 'on');
});

test('manifest misses are quiet 404s: unknown event, no howler_event_id link', async () => {
  const { suite, owner } = seedClient(); // no howlerEventId
  await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: owner, params: { suiteId: suite.id, slot: 'logo' }, body: { url: 'https://cdn.test/logo.png' } });
  await call('POST /api/eventassets/suites/:suiteId/publish', { user: owner, params: { suiteId: suite.id } });
  assert.equal((await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: '99999999' } })).code, 404);
  assert.equal((await call('GET /api/app/event-assets/by-event/:eventId', { params: { eventId: 'abc' } })).code, 404);
});

test('slot writes are sanitised: unknown slot 400, unsafe URLs dropped', async () => {
  const { suite, owner } = seedClient();
  const bad = await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: owner, params: { suiteId: suite.id, slot: 'nope' }, body: { url: 'https://x.test/a.png' } });
  assert.equal(bad.code, 400);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://insecure.test/a.png']) {
    const r = await call('PUT /api/eventassets/suites/:suiteId/slots/:slot', { user: owner, params: { suiteId: suite.id, slot: 'logo' }, body: { url } });
    assert.equal(r.body.slots.find((s) => s.key === 'logo').draftUrl, '', `should drop ${url}`);
  }
});

test('upload validation: empty payload, non-media mime, HEIC all rejected', async () => {
  const { suite, owner } = seedClient();
  const cases = [
    { name: 'x.png', mime: 'image/png', data: '' },
    { name: 'x.pdf', mime: 'application/pdf', data: PNG64 },
    { name: 'x.heic', mime: 'image/heic', data: PNG64 },
  ];
  for (const body of cases) {
    const r = await call('POST /api/eventassets/suites/:suiteId/media', { user: owner, params: { suiteId: suite.id }, body });
    assert.equal(r.code, 400, body.mime);
  }
});

test('admin bypasses membership; enabled lists only flagged manageable entities', async () => {
  const { suite } = seedClient({ howlerEventId: '40848' });
  const admin = makeAdmin(`ea-admin-${seq}@test.local`);
  const r = await call('GET /api/eventassets/suites/:suiteId', { user: admin, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.equal(r.body.canManage, true);

  const off = seedClient();
  setFlag(off.entity.id, 'off');
  const en = await call('GET /api/eventassets/enabled', { user: off.owner });
  assert.ok(!en.body.entities.includes(off.entity.id), 'flag-off entity must not be listed');
});
