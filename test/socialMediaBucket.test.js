// Inline media uploads land in the BUCKET when SOCIAL_S3_* is configured
// (scale ④: image bytes must not live on the app disk). Env is set BEFORE
// social.js loads because its S3 config is read at module load; the bucket
// PUT is captured by stubbing global fetch.

process.env.SOCIAL_S3_ENDPOINT = 'https://test.r2.cloudflarestorage.com';
process.env.SOCIAL_S3_BUCKET = 'pulse-media';
process.env.SOCIAL_S3_ACCESS_KEY = 'k';
process.env.SOCIAL_S3_SECRET_KEY = 's';
process.env.SOCIAL_MEDIA_BASE_URL = 'https://media.test.cdn';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { db, auth, makeEntity, makeAdmin } = require('./helpers');
const social = require('../server/social');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);

const puts = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('r2.cloudflarestorage.com')) {
    puts.push({ url: String(url), method: opts.method, bytes: opts.body?.length || 0 });
    return { ok: true, status: 200 };
  }
  return realFetch(url, opts);
};

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  social.mount(app, { db, auth, rateLimit, verifyAppToken: async () => null, fetchAppTickets: async () => [] });
  return routes;
}
const routes = mount();

async function call(key, { user, params = {}, body = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, send(d) { payload = d; return res; }, set() { return res; } };
  const req = { user, params, body, query: {}, ip: '9.9.9.9', headers: {} };
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

const admin = makeAdmin('bucket-admin@test.local');
const entity = makeEntity('Bucket Org', 'Bucket Org');

test('inline upload goes to the bucket: public CDN url, nothing on disk', async () => {
  const img = Buffer.from('jpeg-ish-bytes').toString('base64');
  const saved = await call('POST /api/admin/entities/:entityId/social/media', {
    user: admin, params: { entityId: entity.id }, body: { name: 'photo.jpg', mime: 'image/jpeg', data: img },
  });
  assert.equal(saved.code, 200);
  assert.ok(saved.body.url.startsWith('https://media.test.cdn/social/'), saved.body.url);
  assert.equal(saved.body.kind, 'image');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].method, 'PUT');
  assert.ok(puts[0].url.includes('/pulse-media/social/'));
  assert.ok(puts[0].bytes > 0);
  // Nothing written to the local media dir, no media table row.
  const mediaDir = path.join(process.env.DATA_DIR, 'social_media');
  assert.equal(fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).length : 0, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM social_feed_media').get().n, 0);
});

test('bucket outage falls back to the disk path (upload never fails)', async () => {
  const failFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('r2.cloudflarestorage.com')) return { ok: false, status: 500 };
    return realFetch(url, opts);
  };
  try {
    const img = Buffer.from('more-jpeg-ish-bytes').toString('base64');
    const saved = await call('POST /api/admin/entities/:entityId/social/media', {
      user: admin, params: { entityId: entity.id }, body: { name: 'photo2.jpg', mime: 'image/jpeg', data: img },
    });
    assert.equal(saved.code, 200);
    assert.ok(saved.body.url.startsWith('/api/app/social/media/'), saved.body.url);
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM social_feed_media').get().n, 1);
  } finally {
    global.fetch = failFetch;
  }
});
