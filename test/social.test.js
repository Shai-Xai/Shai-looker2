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
// Ticket holdings per token (for targeted-post tests): VIP holder, GA holder,
// no tickets. Unknown tokens -> null ("couldn't determine" — fail closed).
const TICKETS = {
  'tok-661779': [{ eventId: '19203', name: 'VIP' }],
  'tok-662076': [{ eventId: '19203', name: 'General Admission' }],
  'tok-555': [],
};
const fetchAppTickets = async (token) => TICKETS[token] ?? null;

const setFlagFor = (entityId) => setFlag(entityId, 'on');

const verifyAppToken = async (token) => {
  if (token === 'tok-down') throw new Error('backend unreachable');
  const m = token.match(/^tok-(\d+)$/);
  return m ? { id: m[1] } : null;
};

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  social.mount(app, { db, auth, rateLimit, verifyAppToken, fetchAppTickets });
  return routes;
}
const routes = mount();

// Run the FULL captured chain (middlewares + handler) like Express would; a
// sync throw or async rejection lands as errorMiddleware output.
async function call(key, { user, params = {}, body = {}, query = {}, token, headers = {} } = {}) {
  let code = 200, payload, sent;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { sent = d; return res; },
    set() { return res; },
  };
  const req = { user, params, body, query, ip: '9.9.9.9', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } };
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
    body: { communityId: orgComm.id, body: 'Coming soon 👀', global: true, media: [{ kind: 'image', url: '/api/app/social/media/x', width: 1080, height: 1350 }, { kind: 'video', url: '/api/app/social/media/v1', posterUrl: '/api/app/social/media/v1poster' }] },
  });
  assert.equal(draft.code, 200);
  assert.equal(draft.body.status, 'draft');
  assert.equal(draft.body.publishedAt, null);
  assert.equal(draft.body.media[0].width, 1080);
  // A video's poster (first-frame capture) rides the media item — feed cards
  // preview it instead of a black box.
  assert.equal(draft.body.media[1].posterUrl, '/api/app/social/media/v1poster');
  assert.equal(draft.body.media[0].posterUrl, undefined); // images never carry one

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

test('pins: organiser pin floats a strip; fan personal pins are private', async () => {
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  const mk = (text) => call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id }, body: { communityId: orgComm.id, body: text, global: true, publish: true },
  });
  const a = (await mk('Pinnable A')).body;
  const b = (await mk('Pinnable B')).body;

  // Organiser pins A → global feed first page carries a pinned strip for everyone.
  const pin = await call('POST /api/admin/entities/:entityId/social/posts/:id/pin', { user: admin, params: { entityId: entity.id, id: a.id }, body: { pinned: true } });
  assert.equal(pin.code, 200);
  assert.equal(pin.body.pinned, true);
  const feed = await call('GET /api/app/social/feed', {});
  assert.equal(feed.body.pinned.length, 1);
  assert.equal(feed.body.pinned[0].id, a.id);
  // …and pages (before=) do NOT repeat the strip.
  const page2 = await call('GET /api/app/social/feed', { query: { before: feed.body.posts[feed.body.posts.length - 1].publishedAt || new Date().toISOString() } });
  assert.equal(page2.body.pinned, undefined);

  // Fan personally pins B: visible to them only (pinnedByMe + myPins strip).
  const fpin = await call('POST /api/app/social/posts/:id/pin', { token: 'tok-661779', params: { id: b.id }, body: { pinned: true } });
  assert.equal(fpin.code, 200);
  assert.equal(fpin.body.pinnedByMe, true);
  const mine = await call('GET /api/app/social/feed', { token: 'tok-661779' });
  assert.equal(mine.body.myPins.length, 1);
  assert.equal(mine.body.myPins[0].id, b.id);
  assert.equal(mine.body.posts.find((p) => p.id === b.id).pinnedByMe, true);
  const others = await call('GET /api/app/social/feed', { token: 'tok-662076' });
  assert.equal(others.body.myPins.length, 0);
  assert.equal(others.body.posts.find((p) => p.id === b.id).pinnedByMe, false);
  // Anonymous feed has no myPins but still sees the organiser strip.
  const anon = await call('GET /api/app/social/feed', {});
  assert.equal(anon.body.myPins.length, 0);
  assert.equal(anon.body.pinned[0].id, a.id);

  // Unpin both ways.
  await call('POST /api/admin/entities/:entityId/social/posts/:id/pin', { user: admin, params: { entityId: entity.id, id: a.id }, body: { pinned: false } });
  await call('POST /api/app/social/posts/:id/pin', { token: 'tok-661779', params: { id: b.id }, body: { pinned: false } });
  const cleared = await call('GET /api/app/social/feed', { token: 'tok-661779' });
  assert.equal(cleared.body.pinned.length, 0);
  assert.equal(cleared.body.myPins.length, 0);
  // Client self-service scope can pin too (dual-surface rule).
  const myPin = await call('POST /api/my/social/posts/:id/pin', { user: owner, query: { entityId: entity.id }, params: { id: a.id }, body: { pinned: true } });
  assert.equal(myPin.code, 200);
  assert.equal(myPin.body.pinned, true);
  await call('POST /api/my/social/posts/:id/pin', { user: owner, query: { entityId: entity.id }, params: { id: a.id }, body: { pinned: false } });
});

test('app posters: organiser authorises a Howler account to post from the app', async () => {
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');

  // Not authorised yet → 403 with a helpful message.
  const denied = await call('POST /api/app/social/posts', { token: 'tok-661779', body: { communityId: orgComm.id, text: 'hello' } });
  assert.equal(denied.code, 403);

  // Admin adds the poster (both surfaces work; admin here).
  const added = await call('POST /api/admin/entities/:entityId/social/posters', {
    user: admin, params: { entityId: entity.id }, body: { howlerUserId: '661779', name: 'Shai from Howler' },
  });
  assert.equal(added.code, 200);
  assert.equal(added.body.posters.length, 1);
  assert.equal((await call('POST /api/admin/entities/:entityId/social/posters', { user: admin, params: { entityId: entity.id }, body: { howlerUserId: 'nope' } })).code, 400);

  // canPost now rides the app's community payloads for that verified user.
  const list = await call('GET /api/app/social/communities', { token: 'tok-661779', query: { entityId: entity.id } });
  assert.equal(list.body.communities.find((c) => c.id === orgComm.id).canPost, true);
  const other = await call('GET /api/app/social/communities', { token: 'tok-662076', query: { entityId: entity.id } });
  assert.equal(other.body.communities.find((c) => c.id === orgComm.id).canPost, false);

  // The poster publishes from the app — text + inline image, straight to live.
  const img = Buffer.from('jpeg-ish-bytes').toString('base64');
  const posted = await call('POST /api/app/social/posts', {
    token: 'tok-661779',
    body: { communityId: orgComm.id, text: 'Live from the venue 🎤', global: true, images: [{ data: img, mime: 'image/jpeg' }] },
  });
  assert.equal(posted.code, 200);
  assert.equal(posted.body.status, 'published');
  assert.equal(posted.body.source, 'app');
  assert.equal(posted.body.author.name, 'Shai from Howler');
  assert.equal(posted.body.media.length, 1);
  assert.ok(posted.body.media[0].url.startsWith('/api/app/social/media/'));

  // It's really in the global feed.
  const feed = await call('GET /api/app/social/feed', {});
  assert.ok(feed.body.posts.some((p) => p.id === posted.body.id));

  // Empty posts and bad payloads are refused.
  assert.equal((await call('POST /api/app/social/posts', { token: 'tok-661779', body: { communityId: orgComm.id } })).code, 400);

  // Remove the poster → posting stops.
  const removed = await call('DELETE /api/admin/entities/:entityId/social/posters/:userId', { user: admin, params: { entityId: entity.id, userId: '661779' } });
  assert.equal(removed.body.posters.length, 0);
  assert.equal((await call('POST /api/app/social/posts', { token: 'tok-661779', body: { communityId: orgComm.id, text: 'still me?' } })).code, 403);
});

test('targeting: ticket-type posts only reach matching holders (server-side)', async () => {
  // A PUBLIC event community so anonymous reads are possible.
  const pub = await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: entity.id },
    body: { name: 'Big Fest Public', type: 'event', eventId: '19203', visibility: 'public' },
  });
  const commId = pub.body.id;
  const mk = (body) => call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id }, body: { communityId: commId, publish: true, ...body },
  });
  const open = (await mk({ body: 'Everyone sees this' })).body;
  const holders = (await mk({ body: 'Holders only', audience: { type: 'holders' } })).body;
  const vip = (await mk({ body: 'VIP secret bar', audience: { type: 'ticketTypes', ticketTypes: ['vip'] }, global: true })).body;
  assert.deepEqual(holders.audience, { type: 'holders' });
  assert.equal(vip.global, false, 'targeted posts are forced OFF the global feed');

  const feedFor = async (token) => {
    const out = await call('GET /api/app/social/communities/:id/feed', { params: { id: commId }, ...(token ? { token } : {}) });
    assert.equal(out.code, 200);
    return out.body.posts.map((p) => p.id);
  };
  // Anonymous: only the untargeted post.
  assert.deepEqual(await feedFor(null), [vip, holders, open].filter((p) => p.id === open.id).map((p) => p.id));
  // VIP holder sees all three; GA holder misses the VIP post; ticketless
  // verified user sees only the open post.
  const vipSees = await feedFor('tok-661779');
  assert.ok(vipSees.includes(vip.id) && vipSees.includes(holders.id) && vipSees.includes(open.id));
  const gaSees = await feedFor('tok-662076');
  assert.ok(!gaSees.includes(vip.id) && gaSees.includes(holders.id) && gaSees.includes(open.id));
  const noneSees = await feedFor('tok-555');
  assert.deepEqual(noneSees, [open.id]);

  // Interactions on a targeted post are ring-fenced the same way.
  assert.equal((await call('POST /api/app/social/posts/:id/react', { token: 'tok-661779', params: { id: vip.id } })).code, 200);
  assert.equal((await call('POST /api/app/social/posts/:id/react', { token: 'tok-662076', params: { id: vip.id } })).code, 403);
  assert.equal((await call('GET /api/app/social/posts/:id/comments', { token: 'tok-662076', params: { id: vip.id } })).code, 403);
  assert.equal((await call('GET /api/app/social/posts/:id/comments', { token: 'tok-661779', params: { id: vip.id } })).code, 200);

  // Global feed never carries targeted posts.
  const global = await call('GET /api/app/social/feed', { token: 'tok-661779' });
  assert.ok(!global.body.posts.some((p) => p.id === vip.id));

  // Organiser-community targeting is refused (no event to match against);
  // empty type list refused.
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  assert.equal((await call('POST /api/admin/entities/:entityId/social/posts', { user: admin, params: { entityId: entity.id }, body: { communityId: orgComm.id, body: 'x', audience: { type: 'holders' } } })).code, 400);
  assert.equal((await mk({ body: 'x', audience: { type: 'ticketTypes', ticketTypes: [] } })).code, 400);
});

test('roll-up: event posts opt into the organiser feed (same mechanic as global)', async () => {
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  // A nested PUBLIC event community under the organiser.
  const ev = (await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: entity.id },
    body: { name: 'Rollup Fest', type: 'event', eventId: '19203', parentId: orgComm.id, visibility: 'public' },
  })).body;
  const mk = (body) => call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id }, body: { communityId: ev.id, publish: true, ...body },
  });
  const rolled = (await mk({ body: 'Rolls up to the brand', toParent: true })).body;
  const stays = (await mk({ body: 'Stays in the event' })).body;
  assert.equal(rolled.toParent, true);

  const orgFeed = await call('GET /api/app/social/communities/:id/feed', { params: { id: orgComm.id } });
  const ids = orgFeed.body.posts.map((p) => p.id);
  assert.ok(ids.includes(rolled.id), 'opted-in event post appears in the organiser feed');
  assert.ok(!ids.includes(stays.id), 'non-opted post stays event-only');
  // Rolled post is labelled with its HOME (event) community.
  assert.equal(orgFeed.body.posts.find((p) => p.id === rolled.id).community.name, 'Rollup Fest');
  // The event's own feed still shows both.
  const evFeed = await call('GET /api/app/social/communities/:id/feed', { params: { id: ev.id } });
  assert.ok(evFeed.body.posts.map((p) => p.id).includes(rolled.id));

  // Targeted + rolled: still ticket-checked against the EVENT in the
  // organiser feed (VIP holder sees it there; GA holder doesn't).
  const vipRolled = (await mk({ body: 'VIP rolled', toParent: true, audience: { type: 'ticketTypes', ticketTypes: ['VIP'] } })).body;
  const vipView = await call('GET /api/app/social/communities/:id/feed', { params: { id: orgComm.id }, token: 'tok-661779' });
  assert.ok(vipView.body.posts.some((p) => p.id === vipRolled.id));
  const gaView = await call('GET /api/app/social/communities/:id/feed', { params: { id: orgComm.id }, token: 'tok-662076' });
  assert.ok(!gaView.body.posts.some((p) => p.id === vipRolled.id));

  // toParent on a community with no parent is ignored.
  const orgPost = await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id }, body: { communityId: orgComm.id, body: 'x', publish: true, toParent: true },
  });
  assert.equal(orgPost.body.toParent, false);
});

test('global feed is personalised: house posts for everyone; organiser posts only for followers/ticket holders', async () => {
  // Designate a Howler house entity; its global posts reach EVERYONE.
  const house = makeEntity('Howler HQ', 'Howler HQ');
  setFlagFor(house.id);
  await call('PUT /api/admin/social/house', { user: admin, body: { entityId: house.id } });
  const hq = (await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: house.id }, body: { name: 'Howler HQ', type: 'organiser' },
  })).body;
  const housePost = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: house.id }, body: { communityId: hq.id, body: 'Welcome to Howler', global: true, publish: true },
  })).body;

  // A second organiser with a global post + an event community (event 19203).
  const org2 = makeEntity('Indie Fest Co', 'Indie Fest Co');
  setFlagFor(org2.id);
  const org2Comm = (await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: org2.id }, body: { name: 'Indie Fest', type: 'organiser' },
  })).body;
  await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: org2.id }, body: { name: 'Indie Fest Live', type: 'event', eventId: '19203', parentId: org2Comm.id },
  });
  const orgPost = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: org2.id }, body: { communityId: org2Comm.id, body: 'Indie lineup drop', global: true, publish: true },
  })).body;

  const ids = (out) => out.body.posts.map((p) => p.id);
  // Anonymous: house only.
  const anon = await call('GET /api/app/social/feed', {});
  assert.ok(ids(anon).includes(housePost.id));
  assert.ok(!ids(anon).includes(orgPost.id));
  // Ticket holder for event 19203 → connected to Indie Fest Co → sees both.
  const holder = await call('GET /api/app/social/feed', { token: 'tok-661779' });
  assert.ok(ids(holder).includes(housePost.id) && ids(holder).includes(orgPost.id));
  // No tickets, not joined → house only…
  const stranger = await call('GET /api/app/social/feed', { token: 'tok-555' });
  assert.ok(ids(stranger).includes(housePost.id));
  assert.ok(!ids(stranger).includes(orgPost.id));
  // …until they FOLLOW (join any of the organiser's communities).
  await call('POST /api/app/social/communities/:id/join', { token: 'tok-555', params: { id: org2Comm.id } });
  const follower = await call('GET /api/app/social/feed', { token: 'tok-555' });
  assert.ok(ids(follower).includes(orgPost.id));
});

test('story rail: active circles, joined/ticket ordering, unseen rings clear on seen', async () => {
  // Anonymous: rail renders (recency-ordered), no viewer state.
  const anon = await call('GET /api/app/social/rail', {});
  assert.equal(anon.code, 200);
  assert.ok(anon.body.rail.length > 0);
  assert.ok(anon.body.rail.every((i) => i.joined === false && i.unseen === false));
  assert.ok(anon.body.rail.every((i) => i.lastPostAt), 'quiet communities stay off the rail');

  // Ticket holder: their event's circle (and its organiser parent) rank above
  // unrelated circles, and organiser circles glow via child activity.
  const vip = await call('GET /api/app/social/rail', { token: 'tok-661779' });
  const withTicket = vip.body.rail.filter((i) => i.hasTicket);
  assert.ok(withTicket.length > 0, 'ticket holder sees ticket-held circles');
  const firstNoTicket = vip.body.rail.findIndex((i) => !i.hasTicket && !i.joined);
  const lastTicket = vip.body.rail.map((i) => i.hasTicket || i.joined).lastIndexOf(true);
  assert.ok(firstNoTicket === -1 || lastTicket < firstNoTicket || vip.body.rail[0].joined || vip.body.rail[0].hasTicket);

  // Unseen ring: fresh viewer sees unseen; opening the feed (seen mark) clears it.
  const target = vip.body.rail.find((i) => i.hasTicket) || vip.body.rail[0];
  assert.equal(target.unseen, true);
  await call('POST /api/app/social/communities/:id/seen', { token: 'tok-661779', params: { id: target.communityId } });
  const after = await call('GET /api/app/social/rail', { token: 'tok-661779' });
  assert.equal(after.body.rail.find((i) => i.communityId === target.communityId).unseen, false);

  // parentId scopes the rail to one organiser's events.
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  const scoped = await call('GET /api/app/social/rail', { query: { parentId: orgComm.id } });
  assert.ok(scoped.body.rail.every((i) => i.parentId === orgComm.id));

  // House circles anchor the rail for everyone: for a viewer with no joins
  // and no tickets (and for anonymous readers), Howler HQ ranks above every
  // other organiser's circle. (The house entity was designated in the
  // personalised-global-feed test above.)
  const strangerRail = await call('GET /api/app/social/rail', { token: 'tok-999777' });
  const anonRail = await call('GET /api/app/social/rail', {});
  for (const r of [strangerRail, anonRail]) {
    const names = r.body.rail.map((i) => i.name);
    assert.ok(names.length > 1, 'rail has house + other circles');
    assert.equal(r.body.rail[0].name, 'Howler HQ', 'house circle leads the rail');
  }
});

test('single-post endpoint + shareable /p/:id page (deep-link phase 1)', async () => {
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  const post = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id },
    body: { communityId: orgComm.id, body: 'Deep link me', global: true, publish: true, media: [{ kind: 'image', url: '/api/app/social/media/xyz' }] },
  })).body;

  // Single post JSON, visibility respected.
  const one = await call('GET /api/app/social/posts/:id', { params: { id: post.id } });
  assert.equal(one.code, 200);
  assert.equal(one.body.post.id, post.id);
  assert.equal(one.body.post.body, 'Deep link me');
  assert.equal((await call('GET /api/app/social/posts/:id', { params: { id: 'nope' } })).code, 404);

  // Public share page: OG tags + the caption + media, no auth.
  const page = await call('GET /p/:id', { params: { id: post.id } });
  assert.equal(page.code, 200);
  const html = page.sent || page.body;
  assert.match(html, /og:title/);
  assert.match(html, /Deep link me/);
  assert.match(html, /apps\.apple\.com/); // get-the-app gate (desktop UA shows both store buttons)
  assert.match(html, /og:image/); // has an image → rich preview

  // A ticket-targeted post must NOT leak its content on the public page.
  const vip = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id },
    body: { communityId: orgComm.id, body: 'VIP secret bar location', publish: true, audience: { type: 'ticketTypes', ticketTypes: ['VIP'] } },
  })).body;
  const vipPage = await call('GET /p/:id', { params: { id: vip.id } });
  const vipHtml = vipPage.sent || vipPage.body;
  assert.doesNotMatch(vipHtml, /VIP secret bar location/);
  assert.match(vipHtml, /apps\.apple\.com/); // still a get-the-app gate
});

test('community avatar + device-aware share buttons + watermark', async () => {
  const comm = (await call('POST /api/admin/entities/:entityId/social/communities', {
    user: admin, params: { entityId: entity.id }, body: { name: 'Avatar Org', type: 'organiser' },
  })).body;
  assert.equal(comm.avatarUrl, null);
  // Set an avatar URL.
  const up = await call('PUT /api/admin/entities/:entityId/social/communities/:id', {
    user: admin, params: { entityId: entity.id, id: comm.id }, body: { avatarUrl: '/api/app/social/media/av123' },
  });
  assert.equal(up.body.avatarUrl, '/api/app/social/media/av123');

  // A post's community object carries the avatar (feed cards show the brand).
  const post = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id }, body: { communityId: comm.id, body: 'Brand post', global: true, publish: true, media: [{ kind: 'image', url: '/api/app/social/media/x' }] },
  })).body;
  // A prior test designated a house entity, so the personalised global feed
  // only shows this organiser's post to a CONNECTED viewer — join, then read.
  await call('POST /api/app/social/communities/:id/join', { token: 'tok-555', params: { id: comm.id } });
  const feed = await call('GET /api/app/social/feed', { token: 'tok-555' });
  const mine = feed.body.posts.find((p) => p.id === post.id);
  assert.equal(mine.community.avatarUrl, '/api/app/social/media/av123');
  // The client's Pulse brand colour rides on the community so feed cards/share
  // links tint to the organiser's brand (platform default when unset).
  assert.match(mine.community.brandColor, /^#[0-9a-fA-F]{3,8}$/);
  assert.equal(comm.brandColor, mine.community.brandColor);

  // Share page: iOS UA → single "Open in the Howler app" (App Store), no Android button.
  const ios = await call('GET /p/:id', { params: { id: post.id }, headers: { 'user-agent': 'iPhone Safari' } });
  const iosHtml = ios.sent || ios.body;
  assert.match(iosHtml, /apps\.apple\.com/);
  assert.doesNotMatch(iosHtml, /play\.google\.com/);
  // Android UA → Play Store only.
  const and = await call('GET /p/:id', { params: { id: post.id }, headers: { 'user-agent': 'Android Chrome' } });
  const andHtml = and.sent || and.body;
  assert.match(andHtml, /play\.google\.com/);
  assert.doesNotMatch(andHtml, /apps\.apple\.com/);
  // Watermark on the media + avatar image in the header.
  assert.match(iosHtml, /class="wm"/);
  assert.match(iosHtml, /av123/); // community avatar rendered in the header
  // Share page tints its accent to the organiser's brand colour.
  assert.ok(iosHtml.includes(comm.brandColor), 'share page uses the brand accent');
});

test('whoami + poster suggestions (no Active Admin id hunt)', async () => {
  // whoami echoes the VERIFIED identity behind the JWT; 401 signed out.
  const me = await call('GET /api/app/social/whoami', { token: 'tok-661779' });
  assert.equal(me.code, 200);
  assert.equal(me.body.id, '661779');
  assert.equal((await call('GET /api/app/social/whoami', {})).code, 401);

  // Admin suggestions list recently active app users platform-wide — fans who
  // joined communities earlier in this file show up with their ids.
  const sug = await call('GET /api/admin/entities/:entityId/social/posters-suggestions', {
    user: admin, params: { entityId: entity.id },
  });
  assert.equal(sug.code, 200);
  const ids = sug.body.suggestions.map((s) => s.howlerUserId);
  assert.ok(ids.includes('661779'), 'active fan appears as a poster suggestion');
});

test('postable: lists communities the signed-in poster may post to', async () => {
  // 661779 was registered as a poster for `entity` in the app-posting test;
  // an unregistered fan gets an empty list, signed-out gets 401.
  await call('POST /api/admin/entities/:entityId/social/posters', {
    user: admin, params: { entityId: entity.id }, body: { howlerUserId: '661779', name: 'Shai' },
  });
  const mine = await call('GET /api/app/social/postable', { token: 'tok-661779' });
  assert.equal(mine.code, 200);
  assert.ok(mine.body.communities.length > 0, 'poster sees postable communities');
  assert.ok(mine.body.communities.every((c) => c.entityId === entity.id && c.canPost === true));
  const none = await call('GET /api/app/social/postable', { token: 'tok-999888' });
  assert.deepEqual(none.body.communities, []);
  assert.equal((await call('GET /api/app/social/postable', {})).code, 401);
});

test('app presign + direct-upload media: posters only; URL items ride app posts', async () => {
  // Registered poster (661779, from the postable test) reaches the presign
  // endpoint; without SOCIAL_S3_* configured it gets the client-safe 400, not
  // a 403 — proving the auth gate passed and only config is missing.
  const mine = await call('POST /api/app/social/presign', {
    token: 'tok-661779', body: { name: 'clip.mp4', mime: 'video/mp4' },
  });
  assert.equal(mine.code, 400);
  assert.match(mine.body.error, /not configured/);
  // Unregistered fan and signed-out callers are refused before any S3 work.
  assert.equal((await call('POST /api/app/social/presign', { token: 'tok-999888', body: { mime: 'video/mp4' } })).code, 403);
  assert.equal((await call('POST /api/app/social/presign', { body: { mime: 'video/mp4' } })).code, 401);

  // A direct-uploaded item (already in the bucket) is referenced by url in the
  // app create-post payload — no base64 — and its video poster carries through.
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  const posted = await call('POST /api/app/social/posts', {
    token: 'tok-661779',
    body: {
      communityId: orgComm.id, text: 'big video via R2',
      images: [{ url: 'https://media.example.com/social/e1/clip.mp4', kind: 'video', mime: 'video/mp4', posterUrl: 'https://media.example.com/social/e1/clip.jpg' }],
    },
  });
  assert.equal(posted.code, 200);
  assert.equal(posted.body.media[0].kind, 'video');
  assert.equal(posted.body.media[0].url, 'https://media.example.com/social/e1/clip.mp4');
  assert.equal(posted.body.media[0].posterUrl, 'https://media.example.com/social/e1/clip.jpg');
});

test('share page: CTA carries through, real logo, sharer attribution', async () => {
  const { body: comms } = await call('GET /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id } });
  const orgComm = comms.communities.find((c) => c.type === 'organiser');
  const post = (await call('POST /api/admin/entities/:entityId/social/posts', {
    user: admin, params: { entityId: entity.id },
    body: { communityId: orgComm.id, body: 'CTA share', global: true, publish: true, ctaLabel: 'Get tickets', ctaDestination: 'open_url:https://howler.co.za/e/x' },
  })).body;

  // The post's CTA leads on the share page; an open_url destination links out.
  const page = await call('GET /p/:id', { params: { id: post.id }, headers: { 'user-agent': 'iPhone Safari' } });
  const html = page.sent || page.body;
  assert.match(html, /Get tickets/);
  assert.match(html, /howler\.co\.za\/e\/x/);
  // Real Howler mark (email asset), not an emoji.
  assert.match(html, /email-howler\.png/);
  assert.doesNotMatch(html, /🐺/);

  // Attribution: ?s=<sharer> logs a human click; unfurl bots count as reach.
  await call('GET /p/:id', { params: { id: post.id }, query: { s: '661779' }, headers: { 'user-agent': 'iPhone Safari' } });
  await call('GET /p/:id', { params: { id: post.id }, query: { s: '661779' }, headers: { 'user-agent': 'WhatsApp/2.24.1' } });
  const stats = await call('GET /api/admin/entities/:entityId/social/share-stats', { user: admin, params: { entityId: entity.id } });
  const mine = stats.body.sharers.find((x) => x.howlerUserId === '661779');
  assert.ok(mine && mine.clicks >= 1, 'sharer credited with a human click');
  assert.equal(mine.name, 'Shai'); // best-known name from the posters registry
  assert.ok(stats.body.previewFetches >= 1, 'bot fetch counted as reach, not a click');
  assert.ok(stats.body.totalClicks >= 1);
});
