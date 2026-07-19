// Event chat (Pulse ⇄ Howler app, docs/specs/SOCIAL_CONTRACT.md §chat) —
// channels + fan groups + messages. Covers: official channel access modes
// (public / segment-locked with ticket CTA / manual), broadcast mode posting
// rules, fan groups with invite codes (join grants THAT group only), replies,
// multi-emoji reactions, pin/report/soft-delete, unread counts via read marks,
// organiser broadcast to all official channels with pin + per-message push
// flags, and moderation. Same captured-handler-chain harness as social.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeAdmin } = require('./helpers');
const chat = require('../server/chat');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);
const setFlag = (entityId, flag, value) => db.db
  .prepare('INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,\'test\',?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value')
  .run(entityId, flag, value, new Date().toISOString());

const verifyAppToken = async (token) => {
  if (token === 'tok-down') throw new Error('backend unreachable');
  const m = token.match(/^tok-(\d+)$/);
  return m ? { id: m[1], name: `Fan ${m[1]}` } : null;
};

function mountRoutes() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  chat.mount(app, { db, auth, rateLimit, verifyAppToken });
  return routes;
}
const routes = mountRoutes();

async function call(key, { user, params = {}, body = {}, query = {}, token } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, send(d) { payload = d; return res; }, set() { return res; } };
  const req = { user, params, body, query, ip: '9.9.9.9', headers: token ? { authorization: `Bearer ${token}` } : {} };
  try {
    for (const h of routes[key]) {
      let nextCalled = false, nextErr = null;
      await h(req, res, (e) => { nextCalled = true; nextErr = e; });
      if (nextErr) throw nextErr;
      if (!nextCalled) break;
    }
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.expose || (code >= 400 && code < 500) ? e.message : 'Something went wrong on our end.' };
  }
  return { code, body: payload };
}

const admin = makeAdmin('chat-admin@test.local');
const entity = makeEntity('Chat Org', 'Chat Org');
setFlag(entity.id, 'community', 'on'); // community.chat inherits def:true under it
const EVENT = '19203';
const state = {};

test('official channels: create (public, segment, manual, broadcast mode)', async () => {
  const mk = (body) => call('POST /api/admin/entities/:entityId/social/chat/channels', { user: admin, params: { entityId: entity.id }, body });
  state.main = (await mk({ eventId: EVENT, name: 'Main', emoji: '📣' })).body;
  state.lineup = (await mk({ eventId: EVENT, name: 'Line-up', emoji: '🎤', mode: 'broadcast' })).body;
  state.vip = (await mk({ eventId: EVENT, name: 'VIP Lounge', access: 'segment', segmentId: 'seg_vip' })).body;
  state.crew = (await mk({ eventId: EVENT, name: 'Crew', access: 'manual' })).body;
  assert.equal(state.main.access, 'public');
  assert.equal(state.lineup.mode, 'broadcast');
  assert.equal((await mk({ eventId: 'nope', name: 'X' })).code, 400);
});

test('channel list: locked reasons drive the app UI (tickets vs private)', async () => {
  const list = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  assert.equal(list.code, 200);
  const byName = Object.fromEntries(list.body.channels.map((c) => [c.name, c]));
  assert.equal(byName['Main'].locked, false);
  assert.equal(byName['VIP Lounge'].locked, true);
  assert.equal(byName['VIP Lounge'].lockedReason, 'tickets'); // → "get tickets" CTA
  assert.equal(byName['Crew'].lockedReason, 'private');
  assert.equal((await call('GET /api/app/social/chat/channels', { query: { eventId: EVENT } })).code, 401);
});

test('messaging: send, reply, reactions, unread, read marks', async () => {
  const send = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, body: { text: 'Anyone at gate B?' } });
  assert.equal(send.code, 200);
  assert.equal(send.body.author.name, 'Fan 661779'); // verified name, not spoofable
  const reply = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: state.main.id }, body: { text: 'Me!', parentId: send.body.id } });
  assert.equal(reply.body.parentId, send.body.id);

  // Multi-emoji reactions; mine flagged.
  await call('POST /api/app/social/chat/messages/:id/react', { token: 'tok-662076', params: { id: send.body.id }, body: { emoji: '🔥' } });
  const r2 = await call('POST /api/app/social/chat/messages/:id/react', { token: 'tok-661779', params: { id: send.body.id }, body: { emoji: '🔥' } });
  assert.deepEqual(r2.body.reactions, [{ emoji: '🔥', count: 2, mine: true }]);

  // Unread: 661779 sent one + read-marked; 662076's reply is unread for them
  // until they mark the channel read.
  let list = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  assert.equal(list.body.channels.find((c) => c.id === state.main.id).unread, 1);
  await call('POST /api/app/social/chat/channels/:id/read', { token: 'tok-661779', params: { id: state.main.id } });
  list = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  assert.equal(list.body.channels.find((c) => c.id === state.main.id).unread, 0);

  // Poll with after= returns only newer messages.
  const all = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  assert.equal(all.body.messages.length, 2);
  const newer = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, query: { after: all.body.messages[0].createdAt } });
  assert.equal(newer.body.messages.length, 1);
});

test('broadcast-mode channel: fans read/react but cannot post', async () => {
  const fanPost = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.lineup.id }, body: { text: 'first!' } });
  assert.equal(fanPost.code, 403);
  const read = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.lineup.id } });
  assert.equal(read.code, 200);
  assert.equal(read.body.canPost, false);
});

test('segment/manual channels: admin-add unlocks; others stay locked', async () => {
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.vip.id } })).code, 403);
  await call('POST /api/admin/entities/:entityId/social/chat/channels/:id/members', { user: admin, params: { entityId: entity.id, id: state.vip.id }, body: { howlerUserId: '661779', name: 'Shai' } });
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.vip.id } })).code, 200);
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: state.vip.id } })).code, 403);
  // Sync reports pending until the resolver is wired.
  const sync = await call('POST /api/admin/entities/:entityId/social/chat/channels/:id/sync-segment', { user: admin, params: { entityId: entity.id, id: state.vip.id } });
  assert.equal(sync.body.pending, true);
});

test('fan groups: create, invite code joins THAT group only, owner tools', async () => {
  const grp = await call('POST /api/app/social/chat/channels', { token: 'tok-661779', body: { eventId: EVENT, name: 'Squad Goals' } });
  assert.equal(grp.code, 200);
  assert.equal(grp.body.kind, 'group');
  assert.ok(grp.body.inviteCode);
  state.group = grp.body;

  // Not listed to non-members; joining by code lists it.
  let list = await call('GET /api/app/social/chat/channels', { token: 'tok-662076', query: { eventId: EVENT } });
  assert.ok(!list.body.channels.some((c) => c.id === grp.body.id));
  const join = await call('POST /api/app/social/chat/join', { token: 'tok-662076', body: { code: grp.body.inviteCode } });
  assert.equal(join.code, 200);
  list = await call('GET /api/app/social/chat/channels', { token: 'tok-662076', query: { eventId: EVENT } });
  assert.ok(list.body.channels.some((c) => c.id === grp.body.id));
  // …but the group membership does NOT open other gated channels.
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: state.vip.id } })).code, 403);

  // Owner revokes the link → old code dies; non-owner cannot revoke.
  assert.equal((await call('POST /api/app/social/chat/channels/:id/revoke-link', { token: 'tok-662076', params: { id: grp.body.id } })).code, 403);
  const revoked = await call('POST /api/app/social/chat/channels/:id/revoke-link', { token: 'tok-661779', params: { id: grp.body.id } });
  assert.notEqual(revoked.body.inviteCode, grp.body.inviteCode);
  assert.equal((await call('POST /api/app/social/chat/join', { token: 'tok-663000', body: { code: grp.body.inviteCode } })).code, 404);

  // Owner removes a member.
  const kick = await call('POST /api/app/social/chat/channels/:id/remove-member', { token: 'tok-661779', params: { id: grp.body.id }, body: { howlerUserId: '662076' } });
  assert.equal(kick.body.memberCount, 1);
});

test('delete, report, pin, organiser broadcast with push flag', async () => {
  const msg = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: state.main.id }, body: { text: 'regret this' } });
  // Someone else cannot delete; author soft-deletes → placeholder remains.
  assert.equal((await call('DELETE /api/app/social/chat/messages/:id', { token: 'tok-661779', params: { id: msg.body.id } })).code, 403);
  await call('DELETE /api/app/social/chat/messages/:id', { token: 'tok-662076', params: { id: msg.body.id } });
  const after = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  const ghost = after.body.messages.find((m) => m.id === msg.body.id);
  assert.equal(ghost.deleted, true);
  assert.equal(ghost.text, undefined);

  // Report → moderation view sorts it up; organiser pins a message.
  const keep = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, body: { text: 'meet at the flag 🏁' } });
  await call('POST /api/app/social/chat/messages/:id/report', { token: 'tok-662076', params: { id: keep.body.id } });
  await call('POST /api/admin/entities/:entityId/social/chat/messages/:id/:action(delete|pin|unpin)', { user: admin, params: { entityId: entity.id, id: keep.body.id, action: 'pin' } });
  const listed = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  assert.equal(listed.body.channels.find((c) => c.id === state.main.id).pinnedMessage.id, keep.body.id);

  // Broadcast lands in every official channel (not the fan group), pin + push flags stored.
  const bc = await call('POST /api/admin/entities/:entityId/social/chat/broadcast', { user: admin, params: { entityId: entity.id }, body: { eventId: EVENT, text: 'Rain incoming — ponchos at Gate B', pin: true, push: true } });
  assert.equal(bc.body.channels, 4); // Main, Line-up, VIP, Crew — group excluded
  const inGroup = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.group.id } });
  assert.ok(!inGroup.body.messages.some((m) => m.text?.includes('Rain incoming')));
  const inMain = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  const bcMsg = inMain.body.messages.find((m) => m.text?.includes('Rain incoming'));
  assert.equal(bcMsg.authorType, 'organiser');
  assert.equal(bcMsg.pinned, true);
  assert.equal(db.db.prepare('SELECT push FROM social_chat_messages WHERE id=?').get(bcMsg.id).push, 1);
});

test('flag off / kill switch hide everything', async () => {
  setFlag(entity.id, 'community.chat', 'off');
  const list = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  assert.equal(list.body.channels.length, 0);
  setFlag(entity.id, 'community.chat', 'on');
  db.setSetting('social_chat_enabled', '0');
  assert.equal((await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } })).code, 404);
  db.setSetting('social_chat_enabled', '1');
});

test('organiser CTA message: clickable button data, validated destination', async () => {
  const msg = await call('POST /api/admin/entities/:entityId/social/chat/channels/:id/messages', {
    user: admin, params: { entityId: entity.id, id: state.main.id },
    body: { text: 'Final release live now 🎟', ctaLabel: 'Get tickets', ctaDestination: 'explore_tickets:19203' },
  });
  assert.equal(msg.code, 200);
  assert.equal(msg.body.ctaLabel, 'Get tickets');
  assert.equal(msg.body.ctaDestination, 'explore_tickets:19203');
  const seen = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  const got = seen.body.messages.find((m) => m.id === msg.body.id);
  assert.equal(got.ctaLabel, 'Get tickets');

  // Broadcast can carry a CTA too; bad destinations are refused.
  const bc = await call('POST /api/admin/entities/:entityId/social/chat/broadcast', {
    user: admin, params: { entityId: entity.id },
    body: { eventId: EVENT, text: 'Afterparty tickets moving fast', ctaLabel: 'Afterparty', ctaDestination: 'open_url:https://howler.co.za/afterparty' },
  });
  assert.equal(bc.code, 200);
  const bad = await call('POST /api/admin/entities/:entityId/social/chat/channels/:id/messages', {
    user: admin, params: { entityId: entity.id, id: state.main.id },
    body: { text: 'x', ctaLabel: 'Nope', ctaDestination: 'javascript:alert(1)' },
  });
  assert.equal(bad.code, 400);
});

test('history paging: before= returns older messages chronologically, hasOlder flags more', async () => {
  // Small pages over Main's messages (several exist from earlier tests).
  const latest = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, query: { limit: '2' } });
  assert.equal(latest.body.messages.length, 2);
  assert.equal(latest.body.hasOlder, true);
  const older = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, query: { limit: '50', before: latest.body.messages[0].createdAt } });
  assert.ok(older.body.messages.length >= 1);
  assert.ok(older.body.messages.every((m) => m.createdAt < latest.body.messages[0].createdAt));
  assert.equal(older.body.hasOlder, false);
  // Chronological within the page.
  const times = older.body.messages.map((m) => m.createdAt);
  assert.deepEqual(times, [...times].sort());
});
