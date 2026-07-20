// Social moderation phase 1 (docs/specs/MODERATION_CONTRACT.md) — the rule
// engine on the app-facing social/chat write paths. Exercises the normalizer
// golden cases (leet, repeats, spacing, Scunthorpe boundary), 422-blocked vs
// 202-held outcomes on comments / app posts / chat messages, author-only
// visibility of held+removed rows on every read, banned-emoji reactions,
// block-only group names, the post-report parity endpoint, queue
// approve/decline transitions, platform ∪ client rule resolution, and the
// permission gates (moderation.manage / platform_moderator). Routes run via
// captured handler CHAINS (middlewares included), mirroring test/social.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const moderation = require('../server/moderation');
const social = require('../server/social');
const chat = require('../server/chat');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);
const setFlag = (entityId, flag, value = 'on') => db.db
  .prepare('INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,\'test\',?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value')
  .run(entityId, flag, value, new Date().toISOString());

// Howler-JWT introspection stub: "tok-<id>" verifies as user <id> (no verified
// name, so the fan-supplied displayName fallback is in play — and screened).
const verifyAppToken = async (token) => {
  const m = token.match(/^tok-(\d+)$/);
  return m ? { id: m[1] } : null;
};
const fetchAppTickets = async () => [];

function mountAll() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  moderation.mount(app, { db, auth }); // before social/chat, like index.js
  social.mount(app, { db, auth, rateLimit, verifyAppToken, fetchAppTickets });
  chat.mount(app, { db, auth, rateLimit, verifyAppToken, fetchAppTickets });
  return routes;
}
const routes = mountAll();

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
      if (!nextCalled && payload === undefined && sent === undefined) continue;
      if (!nextCalled) break;
    }
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.message };
  }
  return { code, body: payload, sent };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const admin = makeAdmin('mod-admin@test.local');
const platformMod = db.getUser(db.createUser({ email: 'platform-mod@test.local', password: 'pw-platform-mod', role: 'admin', roles: ['platform_moderator'] }).id);
const entity = makeEntity('Mod Org', 'Mod Org');
const other = makeEntity('Clean Org', 'Clean Org');
const owner = makeClient('owner@mod.test', [entity.id], 'owner');
const viewer = makeClient('viewer@mod.test', [entity.id], 'viewer');
setFlag(entity.id, 'community');
setFlag(entity.id, 'community.chat');
setFlag(other.id, 'community');

const AUTHOR = 'tok-101'; // user 101 — poster + comment/chat author
const OTHER = 'tok-202'; // user 202 — a different fan

let community, post, otherCommunity, otherPost, channel;
test.before(async () => {
  community = (await call('POST /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: entity.id }, body: { name: 'Main', type: 'organiser' } })).body;
  post = (await call('POST /api/admin/entities/:entityId/social/posts', { user: admin, params: { entityId: entity.id }, body: { communityId: community.id, body: 'welcome', global: true, publish: true } })).body;
  otherCommunity = (await call('POST /api/admin/entities/:entityId/social/communities', { user: admin, params: { entityId: other.id }, body: { name: 'Clean HQ', type: 'organiser' } })).body;
  otherPost = (await call('POST /api/admin/entities/:entityId/social/posts', { user: admin, params: { entityId: other.id }, body: { communityId: otherCommunity.id, body: 'hi', global: true, publish: true } })).body;
  channel = (await call('POST /api/admin/entities/:entityId/social/chat/channels', { user: admin, params: { entityId: entity.id }, body: { eventId: '19203', name: 'Main chat' } })).body;
  await call('POST /api/admin/entities/:entityId/social/posters', { user: admin, params: { entityId: entity.id }, body: { howlerUserId: '101' } });
  // Client rule for Mod Org + a platform emoji rule (applies to every client).
  const r = await call('POST /api/admin/entities/:entityId/moderation/rules', { user: admin, params: { entityId: entity.id }, body: { value: 'fuck' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.scope, 'client');
  const e = await call('POST /api/admin/moderation/rules', { user: platformMod, body: { value: '🖕' } });
  assert.equal(e.code, 200);
  assert.equal(e.body.kind, 'emoji');
});

// ── normalizer golden cases ─────────────────────────────────────────────────
test('normalizer defeats trivial evasion', () => {
  assert.equal(moderation.normalizeText('FÚçK'), 'fuck'); // case + diacritics
  assert.equal(moderation.normalizeText('sh1t'), 'shit'); // leetspeak
  assert.equal(moderation.normalizeText('fuuuuck'), 'fuck'); // repeat collapse (3+)
  assert.equal(moderation.normalizeText('cla​ss'), 'class'); // zero-width strip
  assert.deepEqual(moderation.joinedSingles('f u c k you'), ['fuck']); // spaced out
});

test('screenText: exact blocks, fuzzy holds, boundaries respected', async () => {
  const s = (t) => moderation.screenText(entity.id, t);
  assert.equal(s('well fuck that').outcome, 'block');
  assert.equal(s('well FuÚùuCK that').outcome, 'block'); // diacritics + repeats
  assert.equal(s('well fick that').outcome, 'hold'); // edit distance 1
  assert.equal(s('f u c k').outcome, 'hold'); // spaced out
  assert.equal(s('a fine day').outcome, 'pass');
  // Scunthorpe: ban 'ass' → 'class' must not trip; bare 'ass' must.
  await call('POST /api/admin/entities/:entityId/moderation/rules', { user: admin, params: { entityId: entity.id }, body: { value: 'ass' } });
  assert.equal(s('a great class').outcome, 'pass');
  assert.equal(s('you ass').outcome, 'block');
  // Other clients don't inherit Mod Org's CLIENT rules…
  assert.equal(moderation.screenText(other.id, 'well fuck that').outcome, 'pass');
  // …but the PLATFORM emoji rule reaches everyone, tone variants included.
  assert.equal(moderation.screenText(other.id, 'take this 🖕🏽').outcome, 'block');
  assert.equal(moderation.screenText(other.id, 'take this 🖕🏽').reason, 'banned_emoji');
});

// ── comments: 422 blocked / 202 held / author-only reads ────────────────────
test('comment with an exact hit is rejected 422 and never persisted', async () => {
  const r = await call('POST /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id }, body: { text: 'fuck this', displayName: 'Bob' } });
  assert.equal(r.code, 422);
  assert.equal(r.body.error, 'content_blocked');
  assert.equal(r.body.moderation.status, 'blocked');
  assert.equal(r.body.moderation.reason, 'banned_term');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM social_feed_comments WHERE post_id=?').get(post.id).n, 0);
  const audit = db.db.prepare("SELECT * FROM moderation_items WHERE status='auto_blocked' AND content_type='comment'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_id, entity.id);
});

test('banned fan displayName blocks the comment too', async () => {
  const r = await call('POST /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id }, body: { text: 'lovely evening', displayName: 'fuck' } });
  assert.equal(r.code, 422);
});

let heldComment;
test('fuzzy comment is held 202 — visible only to its author until approved', async () => {
  const r = await call('POST /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id }, body: { text: 'fick this', displayName: 'Bob' } });
  assert.equal(r.code, 202);
  assert.equal(r.body.moderation.status, 'held');
  assert.equal(r.body.moderation.reason, 'similar_match');
  heldComment = r.body;
  const mine = await call('GET /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id } });
  assert.equal(mine.body.comments.length, 1);
  assert.equal(mine.body.comments[0].moderation.status, 'held');
  assert.equal(mine.body.commentCount, 0); // public count excludes held
  const theirs = await call('GET /api/app/social/posts/:id/comments', { token: OTHER, params: { id: post.id } });
  assert.equal(theirs.body.comments.length, 0);
});

test('approve publishes the held comment for everyone', async () => {
  const q = await call('GET /api/my/moderation/queue', { user: owner, query: { entityId: entity.id } });
  assert.equal(q.code, 200);
  const item = q.body.items.find((i) => i.contentId === heldComment.id);
  assert.ok(item);
  assert.equal(item.trigger, 'similar_rule');
  assert.ok(item.snapshot.text.includes('fick'));
  const a = await call('POST /api/my/moderation/queue/:id/approve', { user: owner, params: { id: item.id }, query: { entityId: entity.id } });
  assert.equal(a.code, 200);
  assert.equal(a.body.status, 'approved');
  const theirs = await call('GET /api/app/social/posts/:id/comments', { token: OTHER, params: { id: post.id } });
  assert.equal(theirs.body.comments.length, 1);
  assert.equal(theirs.body.comments[0].moderation, undefined);
});

test('decline removes: author sees a moderation-removed stub, others nothing', async () => {
  const r = await call('POST /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id }, body: { text: 'fock that', displayName: 'Bob' } });
  assert.equal(r.code, 202);
  const q = await call('GET /api/admin/entities/:entityId/moderation/queue', { user: admin, params: { entityId: entity.id } });
  const item = q.body.items.find((i) => i.contentId === r.body.id);
  const d = await call('POST /api/admin/entities/:entityId/moderation/queue/:id/decline', { user: admin, params: { entityId: entity.id, id: item.id } });
  assert.equal(d.body.status, 'declined');
  const mine = await call('GET /api/app/social/posts/:id/comments', { token: AUTHOR, params: { id: post.id } });
  const stub = mine.body.comments.find((c) => c.id === r.body.id);
  assert.equal(stub.moderation.status, 'removed');
  assert.equal(stub.text, undefined); // stub carries no content
  const theirs = await call('GET /api/app/social/posts/:id/comments', { token: OTHER, params: { id: post.id } });
  assert.ok(!theirs.body.comments.find((c) => c.id === r.body.id));
});

// ── app posts ───────────────────────────────────────────────────────────────
test('app post: exact hit 422; fuzzy hit held + hidden from the global feed', async () => {
  const blocked = await call('POST /api/app/social/posts', { token: AUTHOR, body: { communityId: community.id, text: 'fuck everyone' } });
  assert.equal(blocked.code, 422);
  const held = await call('POST /api/app/social/posts', { token: AUTHOR, body: { communityId: community.id, text: 'fvck everyone', global: true } });
  assert.equal(held.code, 202);
  assert.equal(held.body.moderation.status, 'held');
  const mine = await call('GET /api/app/social/feed', { token: AUTHOR });
  const minePost = mine.body.posts.find((p) => p.id === held.body.id);
  assert.ok(minePost, 'author sees their held post in the feed');
  assert.equal(minePost.moderation.status, 'held');
  const theirs = await call('GET /api/app/social/feed', { token: OTHER });
  assert.ok(!theirs.body.posts.find((p) => p.id === held.body.id), 'held post invisible to others');
  // …and its single-post deep link 404s for others, opens for the author.
  assert.equal((await call('GET /api/app/social/posts/:id', { token: OTHER, params: { id: held.body.id } })).code, 404);
  assert.equal((await call('GET /api/app/social/posts/:id', { token: AUTHOR, params: { id: held.body.id } })).code, 200);
});

// ── chat ────────────────────────────────────────────────────────────────────
test('chat message: 422 exact / 202 held, author-only in the poll', async () => {
  const blocked = await call('POST /api/app/social/chat/channels/:id/messages', { token: AUTHOR, params: { id: channel.id }, body: { text: 'fuck this queue', displayName: 'Bob' } });
  assert.equal(blocked.code, 422);
  const held = await call('POST /api/app/social/chat/channels/:id/messages', { token: AUTHOR, params: { id: channel.id }, body: { text: 'fack this queue', displayName: 'Bob' } });
  assert.equal(held.code, 202);
  assert.equal(held.body.moderation.status, 'held');
  const ok = await call('POST /api/app/social/chat/channels/:id/messages', { token: OTHER, params: { id: channel.id }, body: { text: 'all good here', displayName: 'Sam' } });
  assert.equal(ok.code, 200);
  const mine = await call('GET /api/app/social/chat/channels/:id/messages', { token: AUTHOR, params: { id: channel.id } });
  assert.ok(mine.body.messages.find((m) => m.id === held.body.id));
  const theirs = await call('GET /api/app/social/chat/channels/:id/messages', { token: OTHER, params: { id: channel.id } });
  assert.ok(!theirs.body.messages.find((m) => m.id === held.body.id), 'held message invisible to the channel');
  assert.equal(theirs.body.channel.messageCount, 1); // held rows don't count
});

test('banned-emoji reaction is refused 422 (platform rule, tone variant)', async () => {
  const msg = (await call('GET /api/app/social/chat/channels/:id/messages', { token: OTHER, params: { id: channel.id } })).body.messages[0];
  const bad = await call('POST /api/app/social/chat/messages/:id/react', { token: AUTHOR, params: { id: msg.id }, body: { emoji: '🖕🏽' } });
  assert.equal(bad.code, 422);
  assert.equal(bad.body.moderation.reason, 'banned_emoji');
  const good = await call('POST /api/app/social/chat/messages/:id/react', { token: AUTHOR, params: { id: msg.id }, body: { emoji: '👍' } });
  assert.equal(good.code, 200);
});

test('fan group names are block-only — fuzzy hits reject too', async () => {
  const exact = await call('POST /api/app/social/chat/channels', { token: AUTHOR, body: { eventId: '19203', name: 'fuck squad' } });
  assert.equal(exact.code, 422);
  const fuzzy = await call('POST /api/app/social/chat/channels', { token: AUTHOR, body: { eventId: '19203', name: 'fvck squad' } });
  assert.equal(fuzzy.code, 422);
  const clean = await call('POST /api/app/social/chat/channels', { token: AUTHOR, body: { eventId: '19203', name: 'nice squad' } });
  assert.equal(clean.code, 200);
  const rename = await call('POST /api/app/social/chat/channels/:id/rename', { token: AUTHOR, params: { id: clean.body.id }, body: { name: 'a55 crew' } });
  assert.equal(rename.code, 422); // leet 'a55' → 'ass'
});

// ── post report (the parity gap) ────────────────────────────────────────────
test('post report files one idempotent queue item; approve dismisses it', async () => {
  const r1 = await call('POST /api/app/social/posts/:id/report', { token: OTHER, params: { id: post.id }, body: { reason: 'spam' } });
  assert.equal(r1.code, 200);
  await call('POST /api/app/social/posts/:id/report', { token: OTHER, params: { id: post.id } }); // duplicate → no-op
  const items = db.db.prepare("SELECT * FROM moderation_items WHERE trigger='user_report' AND content_id=?").all(post.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].content_type, 'post');
  const a = await call('POST /api/admin/entities/:entityId/moderation/queue/:id/approve', { user: admin, params: { entityId: entity.id, id: items[0].id } });
  assert.equal(a.body.status, 'approved');
  // The post never left the feed — reports hold nothing.
  assert.equal(db.db.prepare('SELECT moderation_status s FROM social_feed_posts WHERE id=?').get(post.id).s, 'visible');
});

// ── permissions + surfaces ──────────────────────────────────────────────────
test('client console needs moderation.manage; platform writes need the tag', async () => {
  assert.equal((await call('GET /api/my/moderation/rules', { user: owner, query: { entityId: entity.id } })).code, 200);
  assert.equal((await call('GET /api/my/moderation/rules', { user: viewer, query: { entityId: entity.id } })).code, 403);
  const modUser = makeClient('mod@mod.test', [entity.id], 'moderator');
  assert.equal((await call('GET /api/my/moderation/queue', { user: modUser, query: { entityId: entity.id } })).code, 200);
  // Platform surface: any admin reads; only platform_moderator writes.
  assert.equal((await call('GET /api/admin/moderation/rules', { user: admin })).code, 200);
  assert.equal((await call('POST /api/admin/moderation/rules', { user: admin, body: { value: 'nope' } })).code, 403);
  assert.equal((await call('POST /api/admin/moderation/rules', { user: platformMod, body: { value: 'scam link' } })).code, 200);
});

test('the rules test box reports outcome + matched entries (moderator-facing)', async () => {
  const r = await call('POST /api/admin/entities/:entityId/moderation/rules/test', { user: admin, params: { entityId: entity.id }, body: { text: 'well fuck that' } });
  assert.equal(r.body.outcome, 'block');
  assert.equal(r.body.matches[0].value, 'fuck');
});

test('client rules never leak to another client; platform queue sees everything', async () => {
  const clean = await call('POST /api/app/social/posts/:id/comments', { token: OTHER, params: { id: otherPost.id }, body: { text: 'fuck yeah', displayName: 'Sam' } });
  assert.equal(clean.code, 200, 'Mod Org’s client rule must not gate Clean Org');
  const platformQ = await call('GET /api/admin/moderation/queue', { user: admin, query: { status: '' } });
  assert.ok(platformQ.body.items.some((i) => i.entityId === entity.id), 'platform queue spans clients');
  // Entity scoping: Mod Org’s queue never shows another client’s items.
  const entQ = await call('GET /api/admin/entities/:entityId/moderation/queue', { user: admin, params: { entityId: entity.id }, query: { status: '' } });
  assert.ok(entQ.body.items.every((i) => i.entityId === entity.id));
});
