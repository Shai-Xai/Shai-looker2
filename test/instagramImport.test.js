// Instagram → community feed import: lists the client's IG media via the
// Graph API (stubbed) and imports items as published posts with the media
// downloaded server-side and re-hosted (never hotlinking the IG CDN).
// Same captured-handler-chain harness as social.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeAdmin } = require('./helpers');
const social = require('../server/social');
const instagramImport = require('../server/instagramImport');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);

const JPEG = Buffer.from('jpeg-bytes-from-instagram');
// Graph + CDN stub: media list, single item lookups, and byte downloads.
const fetchImpl = async (url) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => 'application/json' } });
  if (u.includes('/ig-user-1/media?')) {
    return json({ data: [
      { id: 'igm_1', media_type: 'IMAGE', caption: 'Sunset set 🌅', media_url: 'https://cdn.ig/1.jpg', permalink: 'https://instagram.com/p/1', timestamp: '2026-07-18T20:00:00+0000' },
      { id: 'igm_2', media_type: 'CAROUSEL_ALBUM', caption: 'Weekend dump', media_url: 'https://cdn.ig/2a.jpg', children: { data: [{ media_url: 'https://cdn.ig/2a.jpg', media_type: 'IMAGE' }, { media_url: 'https://cdn.ig/2b.jpg', media_type: 'IMAGE' }] } },
    ] });
  }
  if (u.includes('/igm_1?')) return json({ id: 'igm_1', media_type: 'IMAGE', caption: 'Sunset set 🌅', media_url: 'https://cdn.ig/1.jpg' });
  if (u.includes('/igm_2?')) return json({ id: 'igm_2', media_type: 'CAROUSEL_ALBUM', caption: 'Weekend dump', children: { data: [{ media_url: 'https://cdn.ig/2a.jpg', media_type: 'IMAGE' }, { media_url: 'https://cdn.ig/2b.jpg', media_type: 'IMAGE' }] } });
  if (u.startsWith('https://cdn.ig/')) {
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength) };
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }), headers: { get: () => 'application/json' } };
};

function mountRoutes() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  const socialApi = social.mount(app, { db, auth, rateLimit, verifyAppToken: async () => null });
  instagramImport.mount(app, { db, auth, social: socialApi, fetchImpl });
  return routes;
}
const routes = mountRoutes();

async function call(key, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, send(d) { payload = d; return res; }, set() { return res; } };
  const req = { user, params, body, query, ip: '8.8.8.8', headers: {} };
  try {
    for (const h of routes[key]) {
      let nextCalled = false, nextErr = null;
      await h(req, res, (e) => { nextCalled = true; nextErr = e; });
      if (nextErr) throw nextErr;
      if (!nextCalled) break;
    }
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.message };
  }
  return { code, body: payload };
}

const admin = makeAdmin('ig-admin@test.local');
const entity = makeEntity('IG Org', 'IG Org');
const state = {};

test('not connected → gentle hint, no error', async () => {
  const out = await call('GET /api/admin/entities/:entityId/social/instagram/media', { user: admin, params: { entityId: entity.id } });
  assert.equal(out.code, 200);
  assert.equal(out.body.connected, false);
  const imp = await call('POST /api/admin/entities/:entityId/social/instagram/import', { user: admin, params: { entityId: entity.id }, body: { mediaId: 'igm_1' } });
  assert.equal(imp.code, 400);
});

test('connected: media list shaped for the picker grid', async () => {
  db.setEntityIntegrations(entity.id, { metaAccessToken: 'tok-meta', metaIgUserId: 'ig-user-1' });
  const comm = await call('POST /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id }, body: { name: 'IG Fans', type: 'organiser' } });
  state.communityId = comm.body.id;
  const out = await call('GET /api/admin/entities/:entityId/social/instagram/media', { user: admin, params: { entityId: entity.id } });
  assert.equal(out.body.connected, true);
  assert.equal(out.body.media.length, 2);
  assert.equal(out.body.media[0].caption, 'Sunset set 🌅');
  assert.equal(out.body.media[1].type, 'CAROUSEL_ALBUM');
  assert.equal(out.body.media[1].childCount, 2);
});

test('one-click import: re-hosted media, prefilled caption, published, source instagram', async () => {
  const out = await call('POST /api/admin/entities/:entityId/social/instagram/import', {
    user: admin, params: { entityId: entity.id },
    body: { mediaId: 'igm_1', communityId: state.communityId, global: true },
  });
  assert.equal(out.code, 200);
  assert.equal(out.body.status, 'published');
  assert.equal(out.body.source, 'instagram');
  assert.equal(out.body.body, 'Sunset set 🌅');
  assert.equal(out.body.media.length, 1);
  assert.ok(out.body.media[0].url.startsWith('/api/app/social/media/'), 're-hosted, not an IG CDN link');

  // Carousel → every child re-hosted on one post; custom caption wins.
  const car = await call('POST /api/admin/entities/:entityId/social/instagram/import', {
    user: admin, params: { entityId: entity.id },
    body: { mediaId: 'igm_2', communityId: state.communityId, caption: 'Best of the weekend' },
  });
  assert.equal(car.body.media.length, 2);
  assert.equal(car.body.body, 'Best of the weekend');
  assert.equal((await call('POST /api/admin/entities/:entityId/social/instagram/import', { user: admin, params: { entityId: entity.id }, body: { mediaId: 'igm_404', communityId: state.communityId } })).code, 502);
});
