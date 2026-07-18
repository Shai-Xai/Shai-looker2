// Community feed (Pulse ⇄ Howler app, docs/specs/SOCIAL_CONTRACT.md) — the
// Social+ replacement spike. Exercises the community model (organiser/event
// nesting, visibility), the draft→published post lifecycle, global-feed
// syndication + per-entity flag filtering, membership ring-fencing on the
// public surface, base64 media storage, entity-scope guards on the /api/my
// surface, and the presigned-PUT URL shape. Routes are invoked via captured
// handler CHAINS (middlewares included) so the auth/permission wiring is
// covered too, mirroring test/surveys.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const social = require('../server/social');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);
const setFlag = (entityId, value) => db.db
  .prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?, 'community', ?, 'test', ?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value")
  .run(entityId, value, new Date().toISOString());

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  social.mount(app, { db, auth, rateLimit });
  return routes;
}
const routes = mount();

// Run the FULL captured chain (middlewares + handler) like Express would; a
// sync throw or async rejection lands as errorMiddleware output.
async function call(key, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload, sent;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { sent = d; return res; },
    set() { return res; },
  };
  const req = { user, params, body, query, ip: '9.9.9.9', headers: {} };
  try {
    for (const h of routes[key]) {
      let nextCalled = false, nextErr = null;
      await h(req, res, (e) => { nextCalled = true; nextErr = e; });
      if (nextErr) throw nextErr;
      if (!nextCalled && payload === undefined && sent === undefined) continue; // handler responded or chain continues
      if (!nextCalled) break; // a response was written without next() → stop
    }
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.expose || (code >= 400 && code < 500) ? e.message : 'Something went wrong on our end.' };
  }
  return { code, body: payload, sent };
}

const admin = makeAdmin('social-admin@test.local');
const entity = makeEntity('Social Org', 'Social Org');
const other = makeEntity('Other Org', 'Other Org');
const owner = makeClient('owner@social.test', [entity.id], 'owner');
const outsider = makeClient('outsider@social.test', [other.id], 'owner');
setFlag(entity.id, 'on');

// PNG-ish bytes for media tests.
const PNG_B64 = Buffer.from('fake-png-bytes-for-test').toString('base64');

test('communities: create organiser + nested event, validation', async () => {
  const org = await call(`POST /api/admin/entities/:entityId/social/communities`, {
    user: admin, params: { entityId: entity.id }, body: { name: 'Social Org HQ', type: 'organiser', description: 'All our events' },
  });
  assert.equal(org.code, 200);
  assert.equal(org.body.type, 'organiser');
  assert.equal(org.body.memberCount, 0);

  const ev = await call(`POST /api/admin/entities/:entityId/social/communities`, {
    user: admin, params: { entityId: entity.id },
    body: { name: 'Big Fest 2026', type: 'event', eventId: '19203', parentId: org.body.id, visibility: 'members' },
  });
  assert.equal(ev.code, 200);
  assert.equal(ev.body.parentId, org.body.id);
  assert.equal(ev.body.eventId, '19203');

  const noEvent = await call(`POST /api/admin/entities/:entityId/social/communities`, {
    user: admin, params: { entityId: entity.id }, body: { name: 'Bad', type: 'event' },
  });
  assert.equal(noEvent.code, 400);

  const foreignParent = await call(`POST /api/admin/entities/:entityId/social/communities`, {
    user: admin, params: { entityId: other.id }, body: { name: 'Steal', type: 'organiser', parentId: org.body.id },
  });
  assert.equal(foreignParent.code, 400);
});

test('posts: draft → published lifecycle; only published reaches the app', async () => {
  const { body: comms } = await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');

  const draft = await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id },
    body: { communityId: orgComm.id, body: 'Coming soon 👀', global: true, media: [{ kind: 'image', url: '/api/app/social/media/x', width: 1080, height: 1350 }] },
  });
  assert.equal(draft.code, 200);
  assert.equal(draft.body.status, 'draft');
  assert.equal(draft.body.publishedAt, null);
  assert.equal(draft.body.media[0].width, 1080);

  // Draft is invisible in the app-wide feed…
  let feed = await call('GET /api/app/social/feed', {});
  assert.equal(feed.code, 200);
  assert.equal(feed.body.posts.length, 0);

  // …publish, and it appears (global=1 syndication).
  const pub = await call(`PUT /api/admin/entities/:entityId/social/posts/:id`, {
    user: admin, params: { entityId: entity.id, id: draft.body.id }, body: { status: 'published' },
  });
  assert.equal(pub.code, 200);
  assert.ok(pub.body.publishedAt);
  feed = await call('GET /api/app/social/feed', {});
  assert.equal(feed.body.posts.length, 1);
  assert.equal(feed.body.posts[0].body, 'Coming soon 👀');
  assert.equal(feed.body.posts[0].community.name, 'Social Org HQ');
  assert.equal(feed.body.contractVersion, 0);

  // Flag off → the entity's posts drop out of the app feed entirely.
  setFlag(entity.id, 'off');
  feed = await call('GET /api/app/social/feed', {});
  assert.equal(feed.body.posts.length, 0);
  setFlag(entity.id, 'on');
});

test('ring-fencing: members-only community requires membership; join opens it', async () => {
  const { body: comms } = await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } });
  const evComm = comms.communities.find((c) => c.type === 'event');

  await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id }, body: { communityId: evComm.id, body: 'Ticket-holder secret' },
  }).then(({ body: p }) => call(`PUT /api/admin/entities/:entityId/social/posts/:id`, {
    user: admin, params: { entityId: entity.id, id: p.id }, body: { status: 'published' },
  }));

  const locked = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, query: { howlerUserId: '661779' } });
  assert.equal(locked.code, 403);

  const join = await call('POST /api/app/social/communities/:id/join', { params: { id: evComm.id }, body: { howlerUserId: '661779' } });
  assert.equal(join.code, 200);
  assert.equal(join.body.memberCount, 1);

  const open = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, query: { howlerUserId: '661779' } });
  assert.equal(open.code, 200);
  assert.equal(open.body.posts.length, 1);
  assert.equal(open.body.posts[0].body, 'Ticket-holder secret');

  // Discovery by Howler eventId finds the community.
  const disco = await call('GET /api/app/social/communities', { query: { eventId: '19203' } });
  assert.equal(disco.body.communities.length, 1);
  assert.equal(disco.body.communities[0].memberCount, 1);
});

test('client self-service: own entity ok, foreign entity refused', async () => {
  const mine = await call('GET /api/my/social/posts', { user: owner, query: { entityId: entity.id } });
  assert.equal(mine.code, 200);
  assert.ok(Array.isArray(mine.body.posts));

  const foreign = await call('GET /api/my/social/posts', { user: outsider, query: { entityId: entity.id } });
  assert.equal(foreign.code, 403);

  const anon = await call('GET /api/my/social/posts', { query: { entityId: entity.id } });
  assert.equal(anon.code, 401);
});

test('media: base64 upload → served public + immutable; caps enforced', async () => {
  const up = await call(`POST /api/admin/entities/:entityId/social/media`, {
    user: admin, params: { entityId: entity.id }, body: { name: 'poster.png', mime: 'image/png', data: PNG_B64 },
  });
  assert.equal(up.code, 200);
  assert.ok(up.body.url.startsWith('/api/app/social/media/'));
  assert.equal(up.body.kind, 'image');

  const served = await call('GET /api/app/social/media/:id', { params: { id: up.body.id } });
  assert.equal(served.code, 200);
  assert.equal(String(served.sent), 'fake-png-bytes-for-test');

  const notMedia = await call(`POST /api/admin/entities/:entityId/social/media`, {
    user: admin, params: { entityId: entity.id }, body: { name: 'x.pdf', mime: 'application/pdf', data: PNG_B64 },
  });
  assert.equal(notMedia.code, 400);
});

test('presigned PUT: SigV4 URL shape', () => {
  const url = social._presignPut.call(null, { key: 'social/e1/abc.jpg', nowDate: new Date('2026-07-18T10:00:00Z') });
  // Uses whatever SOCIAL_S3_* env is set (none in tests) — assert the invariant
  // parts of the signed URL rather than the host.
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Date=20260718T100000Z/);
  assert.match(url, /X-Amz-Expires=900/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
});

test('kill switch: social_feed_enabled=0 hides the public surface', async () => {
  db.setSetting('social_feed_enabled', '0');
  const feed = await call('GET /api/app/social/feed', {});
  assert.equal(feed.code, 404);
  db.setSetting('social_feed_enabled', '1');
});

test('media: raw HEIC is refused with a clear message', async () => {
  const heic = await call(`POST /api/admin/entities/:entityId/social/media`, {
    user: admin, params: { entityId: entity.id }, body: { name: 'photo.heic', mime: 'image/heic', data: PNG_B64 },
  });
  assert.equal(heic.code, 400);
  assert.match(heic.body.error, /HEIC/);
});
