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

// Howler-JWT introspection stub (contract v1): token "tok-<id>" verifies as
// user <id>; "tok-down" simulates an unreachable Howler backend; all else is
// an invalid/expired token.
const verifyAppToken = async (token) => {
  if (token === 'tok-down') throw new Error('backend unreachable');
  const m = token.match(/^tok-(\d+)$/);
  return m ? { id: m[1] } : null;
};

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  social.mount(app, { db, auth, rateLimit, verifyAppToken });
  return routes;
}
const routes = mount();

// Run the FULL captured chain (middlewares + handler) like Express would; a
// sync throw or async rejection lands as errorMiddleware output.
async function call(key, { user, params = {}, body = {}, query = {}, token } = {}) {
  let code = 200, payload, sent;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { sent = d; return res; },
    set() { return res; },
  };
  const req = { user, params, body, query, ip: '9.9.9.9', headers: token ? { authorization: `Bearer ${token}` } : {} };
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
  assert.equal(feed.body.contractVersion, 1);

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

  // No token → asked to log in; a spoofed howlerUserId param changes nothing.
  const anon = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, query: { howlerUserId: '661779' } });
  assert.equal(anon.code, 401);

  // Valid token but not yet a member → still locked out.
  const locked = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, token: 'tok-661779' });
  assert.equal(locked.code, 403);

  // Join without a token → 401; expired token → 401; Howler backend down → 503.
  assert.equal((await call('POST /api/app/social/communities/:id/join', { params: { id: evComm.id } })).code, 401);
  assert.equal((await call('POST /api/app/social/communities/:id/join', { params: { id: evComm.id }, token: 'garbage' })).code, 401);
  assert.equal((await call('POST /api/app/social/communities/:id/join', { params: { id: evComm.id }, token: 'tok-down' })).code, 503);

  // Join with a verified token — identity comes from the token, not the body.
  const join = await call('POST /api/app/social/communities/:id/join', { params: { id: evComm.id }, token: 'tok-661779', body: { howlerUserId: '999999' } });
  assert.equal(join.code, 200);
  assert.equal(join.body.memberCount, 1);
  assert.ok(db.db.prepare("SELECT 1 FROM social_feed_members WHERE community_id=? AND howler_user_id='661779'").get(evComm.id), 'membership stored under the VERIFIED id');
  assert.ok(!db.db.prepare("SELECT 1 FROM social_feed_members WHERE community_id=? AND howler_user_id='999999'").get(evComm.id), 'spoofed body id ignored');

  const open = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, token: 'tok-661779' });
  assert.equal(open.code, 200);
  assert.equal(open.body.posts.length, 1);
  assert.equal(open.body.posts[0].body, 'Ticket-holder secret');

  // A DIFFERENT verified user is still not a member.
  const stranger = await call('GET /api/app/social/communities/:id/feed', { params: { id: evComm.id }, token: 'tok-662076' });
  assert.equal(stranger.code, 403);

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

test('likes: JWT-gated, idempotent, counted in feeds, ring-fenced', async () => {
  const feed0 = await call('GET /api/app/social/feed', {});
  const post = feed0.body.posts[0];
  assert.equal(post.reactionCount, 0);
  assert.equal(post.hasReacted, undefined); // anonymous read carries no per-user state

  // No token → 401; verified like → count 1; repeat like stays 1 (idempotent).
  assert.equal((await call('POST /api/app/social/posts/:id/react', { params: { id: post.id } })).code, 401);
  const like = await call('POST /api/app/social/posts/:id/react', { params: { id: post.id }, token: 'tok-661779' });
  assert.equal(like.code, 200);
  assert.equal(like.body.reactionCount, 1);
  assert.equal((await call('POST /api/app/social/posts/:id/react', { params: { id: post.id }, token: 'tok-661779' })).body.reactionCount, 1);

  // Second user → 2; feed shows the count, and hasReacted per viewer.
  await call('POST /api/app/social/posts/:id/react', { params: { id: post.id }, token: 'tok-662076' });
  const feed1 = await call('GET /api/app/social/feed', { token: 'tok-661779' });
  assert.equal(feed1.body.posts[0].reactionCount, 2);
  assert.equal(feed1.body.posts[0].hasReacted, true);

  // Unlike → back to 1; anonymous feed still shows the count.
  const unlike = await call('DELETE /api/app/social/posts/:id/react', { params: { id: post.id }, token: 'tok-661779' });
  assert.equal(unlike.body.reactionCount, 1);
  assert.equal((await call('GET /api/app/social/feed', {})).body.posts[0].reactionCount, 1);

  // Ring-fencing: a members-only, non-global post can't be liked by a non-member.
  const evComm = (await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } }))
    .body.communities.find((c) => c.type === 'event');
  const secret = (await call(`GET /api/admin/entities/:entityId/social/posts`, { user: admin, params: { entityId: entity.id } }))
    .body.posts.find((p) => p.communityId === evComm.id);
  const outsiderLike = await call('POST /api/app/social/posts/:id/react', { params: { id: secret.id }, token: 'tok-662076' });
  assert.equal(outsiderLike.code, 403);
});

test('CTA buttons: stored, validated, served with eventId', async () => {
  const evComm = (await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } }))
    .body.communities.find((c) => c.type === 'event');

  const withCta = await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id },
    body: { communityId: evComm.id, body: 'Last release 🎟', publish: true, global: true, ctaLabel: 'Get tickets', ctaDestination: 'explore_tickets:19203' },
  });
  assert.equal(withCta.code, 200);
  assert.equal(withCta.body.ctaLabel, 'Get tickets');
  assert.equal(withCta.body.ctaDestination, 'explore_tickets:19203');
  assert.equal(withCta.body.eventId, '19203'); // from the community

  const feed = await call('GET /api/app/social/feed', {});
  const served = feed.body.posts.find((p) => p.id === withCta.body.id);
  assert.equal(served.ctaLabel, 'Get tickets');
  assert.equal(served.eventId, '19203');

  const badDest = await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id },
    body: { communityId: evComm.id, ctaLabel: 'Nope', ctaDestination: 'javascript:alert(1)' },
  });
  assert.equal(badDest.code, 400);

  const labelNoDest = await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id },
    body: { communityId: evComm.id, ctaLabel: 'Lonely' },
  });
  assert.equal(labelNoDest.code, 400);

  const openUrl = await call(`POST /api/admin/entities/:entityId/social/posts`, {
    user: admin, params: { entityId: entity.id },
    body: { communityId: evComm.id, ctaLabel: 'Site', ctaDestination: 'open_url:https://howler.co.za' },
  });
  assert.equal(openUrl.code, 200);
});

test('comments: JWT-gated writes, ring-fenced reads, author + moderator delete, report', async () => {
  const feed = await call('GET /api/app/social/feed', {});
  const post = feed.body.posts.find((p) => p.body === 'Coming soon 👀');

  // Anonymous can read comments on a public/global post, but not write.
  assert.equal((await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id } })).code, 200);
  assert.equal((await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, body: { text: 'hi' } })).code, 401);

  // Verified write; name falls back to the app-supplied displayName.
  const c1 = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-661779', body: { text: 'Can’t wait 🔥', displayName: 'Shai' } });
  assert.equal(c1.code, 200);
  assert.equal(c1.body.author.name, 'Shai');
  assert.equal(c1.body.isOwner, true);
  assert.equal((await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-661779', body: { text: '' } })).code, 400);

  // Count rides the post shape; list returns the comment.
  const feed2 = await call('GET /api/app/social/feed', {});
  assert.equal(feed2.body.posts.find((p) => p.id === post.id).commentCount, 1);
  const list = await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-662076' });
  assert.equal(list.body.comments.length, 1);
  assert.equal(list.body.comments[0].isOwner, false);

  // Another user can't delete it, but can report it; the author can delete it.
  assert.equal((await call('DELETE /api/app/social/comments/:id', { params: { id: c1.body.id }, token: 'tok-662076' })).code, 403);
  assert.equal((await call('POST /api/app/social/comments/:id/report', { params: { id: c1.body.id }, token: 'tok-662076' })).code, 200);
  const adminList = await call(`GET /api/admin/entities/:entityId/social/posts/:id/comments`, { user: admin, params: { entityId: entity.id, id: post.id } });
  assert.equal(adminList.body.comments[0].reported, true);
  assert.equal((await call('DELETE /api/app/social/comments/:id', { params: { id: c1.body.id }, token: 'tok-661779' })).code, 200);

  // Moderator (admin surface) can delete any comment.
  const c2 = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-662076', body: { text: 'spam spam', displayName: 'Spammer' } });
  const modDel = await call(`DELETE /api/admin/entities/:entityId/social/comments/:id`, { user: admin, params: { entityId: entity.id, id: c2.body.id } });
  assert.equal(modDel.code, 200);
  assert.equal((await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id } })).body.comments.length, 0);

  // Ring-fencing: comments on a members-only non-global post need membership.
  const evComm = (await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } }))
    .body.communities.find((c) => c.type === 'event');
  const secret = (await call(`GET /api/admin/entities/:entityId/social/posts`, { user: admin, params: { entityId: entity.id } }))
    .body.posts.find((p) => p.communityId === evComm.id && !p.global && p.status === 'published');
  const outsiderRead = await call('GET /api/app/social/posts/:id/comments', { params: { id: secret.id }, token: 'tok-662076' });
  assert.equal(outsiderRead.code, 403);
});

test('comment settings, images, links, organiser replies + moderation inbox', async () => {
  const feed = await call('GET /api/app/social/feed', {});
  const post = feed.body.posts.find((p) => p.body === 'Coming soon 👀');
  const orgComm = (await call(`GET /api/admin/entities/:entityId/social/communities`, { user: admin, params: { entityId: entity.id } }))
    .body.communities.find((c) => c.type === 'organiser');

  // Defaults: links + images OFF → both refused with clear messages.
  assert.equal(orgComm.allowCommentImages, false);
  const linkBlocked = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-661779', body: { text: 'see https://spam.example' } });
  assert.equal(linkBlocked.code, 400);
  const imgBlocked = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-661779', body: { imageData: PNG_B64, imageMime: 'image/png' } });
  assert.equal(imgBlocked.code, 400);

  // Organiser flips the settings on → both work.
  await call(`PUT /api/admin/entities/:entityId/social/communities/:id`, { user: admin, params: { entityId: entity.id, id: orgComm.id }, body: { allowCommentImages: true, allowCommentLinks: true } });
  const withLink = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-661779', body: { text: 'tickets at https://howler.co.za', displayName: 'Shai' } });
  assert.equal(withLink.code, 200);
  const withImg = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-662076', body: { imageData: PNG_B64, imageMime: 'image/png', displayName: 'Fan Two' } });
  assert.equal(withImg.code, 200);
  assert.equal(withImg.body.media.length, 1);
  assert.ok(withImg.body.media[0].url.startsWith('/api/app/social/media/'));

  // The comments list reports the flags so the app knows to show the buttons.
  const list = await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id } });
  assert.equal(list.body.allowImages, true);

  // Organiser reply threads under the fan comment, authored as the brand.
  const reply = await call(`POST /api/admin/entities/:entityId/social/comments/:id/reply`, { user: admin, params: { entityId: entity.id, id: withLink.body.id }, body: { text: 'See you there! 🎉' } });
  assert.equal(reply.code, 200);
  assert.equal(reply.body.authorType, 'organiser');
  assert.equal(reply.body.author.name, 'Social Org');
  const nested = (await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id } }))
    .body.comments.find((c) => c.id === withLink.body.id);
  assert.equal(nested.replies.length, 1);
  assert.equal(nested.replies[0].text, 'See you there! 🎉');

  // Fan replying to the organiser's reply attaches to the top-level thread.
  const fanReply = await call('POST /api/app/social/posts/:id/comments', { params: { id: post.id }, token: 'tok-662076', body: { text: 'Can not wait', parentCommentId: reply.body.id, displayName: 'Fan Two' } });
  assert.equal(fanReply.body.parentCommentId, withLink.body.id);

  // Moderation inbox: all comments across posts, with post context.
  const inbox = await call(`GET /api/admin/entities/:entityId/social/comments`, { user: admin, params: { entityId: entity.id } });
  assert.ok(inbox.body.comments.length >= 4);
  assert.ok(inbox.body.comments.every((c) => c.post && c.post.id));

  // A fan cannot delete the organiser's reply; deleting the top-level comment
  // takes its thread with it (moderator path).
  assert.equal((await call('DELETE /api/app/social/comments/:id', { params: { id: reply.body.id }, token: 'tok-662076' })).code, 403);
  await call(`DELETE /api/admin/entities/:entityId/social/comments/:id`, { user: admin, params: { entityId: entity.id, id: withLink.body.id } });
  const after = await call('GET /api/app/social/posts/:id/comments', { params: { id: post.id } });
  assert.ok(!after.body.comments.some((c) => c.id === withLink.body.id));
  assert.ok(!after.body.comments.some((c) => c.replies.some((x) => x.id === reply.body.id)));
});
