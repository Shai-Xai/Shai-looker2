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
// Wire the mailer so branding (client + per-event suite override) resolves
// against the test db — chat channels expose the resolved brandColor.
require('../server/mailer').init({ db });
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
  chat.mount(app, {
    db, auth, rateLimit, verifyAppToken,
    // Verified holdings stub for tickets-gated channels (mirrors the social
    // tests): VIP holder, GA holder, everyone else empty-handed.
    fetchAppTickets: async (t) => (t === 'tok-661779'
      ? [{ eventId: EVENT, name: 'VIP' }]
      : t === 'tok-662076'
        ? [{ eventId: EVENT, name: 'General Admission' }]
        : []),
  });
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
  // Each channel carries the organiser's Pulse brand colour so the app can
  // tint chat accents to the client's brand (platform default when unset).
  assert.match(byName['Main'].brandColor, /^#[0-9a-fA-F]{3,8}$/);
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

test('tickets-gated channels: live verified holdings, typed narrowing, no sync', async () => {
  const mk = (body) => call('POST /api/admin/entities/:entityId/social/chat/channels', { user: admin, params: { entityId: entity.id }, body });
  const backstage = (await mk({ eventId: EVENT, name: 'VIP Backstage', access: 'tickets', ticketTypes: ['VIP'] })).body;
  const holders = (await mk({ eventId: EVENT, name: 'Holders Hall', access: 'tickets' })).body;

  // Management list carries the gate config for the UI chips.
  const listed = await call('GET /api/admin/entities/:entityId/social/chat/channels', { user: admin, params: { entityId: entity.id } });
  const cfg = Object.fromEntries(listed.body.channels.map((c) => [c.name, c]));
  assert.deepEqual(cfg['VIP Backstage'].ticketTypes, ['VIP']);
  assert.deepEqual(cfg['Holders Hall'].ticketTypes, []);

  // Typed channel: VIP holder in, GA holder + ticketless locked out — checked
  // LIVE against verified holdings, no segment sync, no member rows.
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: backstage.id } })).code, 200);
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: backstage.id } })).code, 403);
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-555', params: { id: backstage.id } })).code, 403);

  // Untyped ([]): ANY ticket holder for the event gets in.
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: holders.id } })).code, 200);
  assert.equal((await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-555', params: { id: holders.id } })).code, 403);

  // The app's channel list shows the lock with the tickets reason (→ CTA).
  const list = await call('GET /api/app/social/chat/channels', { token: 'tok-555', query: { eventId: EVENT } });
  const row = list.body.channels.find((c) => c.name === 'VIP Backstage');
  assert.equal(row.locked, true);
  assert.equal(row.lockedReason, 'tickets');
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
  assert.equal(bc.body.channels, 6); // Main, Line-up, VIP, Crew, VIP Backstage, Holders Hall — group excluded
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

test('fan pins: shared in groups, personal in official channels', async () => {
  // Personal pin in an official channel: only the pinner sees it.
  const send = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id }, body: { text: 'pin me' } });
  const pin = await call('POST /api/app/social/chat/messages/:id/pin', { token: 'tok-661779', params: { id: send.body.id }, body: { pinned: true } });
  assert.equal(pin.code, 200);
  assert.equal(pin.body.shared, false);
  const mine = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  assert.equal(mine.body.channel.myPinnedMessage.id, send.body.id);
  assert.equal(mine.body.messages.find((m) => m.id === send.body.id).pinnedByMe, true);
  const other = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: state.main.id } });
  assert.equal(other.body.channel.myPinnedMessage, undefined);
  assert.equal(other.body.messages.find((m) => m.id === send.body.id).pinnedByMe, false);
  // Unpin clears it.
  await call('POST /api/app/social/chat/messages/:id/pin', { token: 'tok-661779', params: { id: send.body.id }, body: { pinned: false } });
  const after = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: state.main.id } });
  assert.equal(after.body.channel.myPinnedMessage, undefined);

  // Shared pin in a fan group: any member toggles, everyone sees it.
  const group = (await call('POST /api/app/social/chat/channels', { token: 'tok-661779', body: { eventId: EVENT, name: 'Pin crew' } })).body;
  await call('POST /api/app/social/chat/join', { token: 'tok-662076', body: { code: group.inviteCode } });
  const gm = await call('POST /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: group.id }, body: { text: 'meet at gate B' } });
  const gpin = await call('POST /api/app/social/chat/messages/:id/pin', { token: 'tok-662076', params: { id: gm.body.id }, body: { pinned: true } });
  assert.equal(gpin.body.shared, true);
  const owner = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-661779', params: { id: group.id } });
  assert.equal(owner.body.channel.pinnedMessage.id, gm.body.id); // shared → visible to ALL members
  // Non-member of the group cannot pin in it.
  assert.equal((await call('POST /api/app/social/chat/messages/:id/pin', { token: 'tok-555', params: { id: gm.body.id }, body: { pinned: true } })).code, 403);
  // Member unpins for everyone (WhatsApp-style).
  await call('POST /api/app/social/chat/messages/:id/pin', { token: 'tok-661779', params: { id: gm.body.id }, body: { pinned: false } });
  const cleared = await call('GET /api/app/social/chat/channels/:id/messages', { token: 'tok-662076', params: { id: group.id } });
  assert.equal(cleared.body.channel.pinnedMessage, undefined);
});

test('my-channels, member list, group rename (chat-tab surface)', async () => {
  // tok-661779 holds a ticket for EVENT (fetchAppTickets stub below via mount?
  // chat mount uses default fetch — re-mount with a stub for this test).
  const routes2 = (() => {
    const r = {};
    const reg = (m) => (p, ...h) => { r[`${m} ${p}`] = h; };
    const app2 = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
    require('../server/chat').mount(app2, {
      db, auth, rateLimit, verifyAppToken,
      fetchAppTickets: async (t) => (t === 'tok-661779' ? [{ eventId: EVENT, name: 'VIP' }] : []),
    });
    return r;
  })();
  const call2 = async (key, opts) => {
    let code = 200, payload;
    const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; }, send(d) { payload = d; return res; }, set() { return res; } };
    const req = { user: opts.user, params: opts.params || {}, body: opts.body || {}, query: opts.query || {}, ip: '7.7.7.7', headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} };
    try {
      for (const h of routes2[key]) {
        let nextCalled = false, nextErr = null;
        await h(req, res, (e) => { nextCalled = true; nextErr = e; });
        if (nextErr) throw nextErr;
        if (!nextCalled) break;
      }
    } catch (e) { code = Number.isInteger(e.status) ? e.status : 500; payload = { error: e.message }; }
    return { code, body: payload };
  };

  // Ticket holder sees official channels across events + groups they joined;
  // ordered by last activity; last-message preview present where chat exists.
  const mine = await call2('GET /api/app/social/chat/my-channels', { token: 'tok-661779' });
  assert.equal(mine.code, 200);
  assert.ok(mine.body.channels.length > 0);
  assert.ok(mine.body.channels.some((c) => c.name === 'Main'));
  const main = mine.body.channels.find((c) => c.name === 'Main');
  assert.ok(main.lastMessage, 'last-message preview rides the channel list');
  assert.equal(main.eventId, EVENT);
  // Ticketless stranger with no memberships → empty list, not an error.
  const none = await call2('GET /api/app/social/chat/my-channels', { token: 'tok-999' });
  assert.deepEqual(none.body.channels, []);

  // Member list: readable by members/ticket holders, 403 for outsiders on groups.
  const members = await call2('GET /api/app/social/chat/channels/:id/members', { token: 'tok-661779', params: { id: state.main.id } });
  assert.equal(members.code, 200);
  assert.ok(Array.isArray(members.body.members));

  // Rename: owner only, groups only.
  const group = (await call2('POST /api/app/social/chat/channels', { token: 'tok-661779', body: { eventId: EVENT, name: 'Old name' } })).body;
  const renamed = await call2('POST /api/app/social/chat/channels/:id/rename', { token: 'tok-661779', params: { id: group.id }, body: { name: 'New name' } });
  assert.equal(renamed.body.name, 'New name');
  assert.equal((await call2('POST /api/app/social/chat/channels/:id/rename', { token: 'tok-662076', params: { id: group.id }, body: { name: 'Nope' } })).code, 403);
  assert.equal((await call2('POST /api/app/social/chat/channels/:id/rename', { token: 'tok-661779', params: { id: state.main.id }, body: { name: 'Nope' } })).code, 404);
});

test('chat channels tint to the per-EVENT Pulse brand override', async () => {
  // Link a Pulse suite to this Howler event and give it a distinct brand colour.
  // resolveBranding layers platform ← client ← event(suite); a channel finds its
  // suite by the event's howler_event_id, so the event override must win.
  const suite = db.createSuite({ entityId: entity.id, name: 'Chat Event Suite' });
  db.updateSuite(suite.id, { howlerEventId: EVENT });
  db.setSuiteMailBranding(suite.id, { brandColor: '#0A7E42' });
  const list = await call('GET /api/app/social/chat/channels', { token: 'tok-661779', query: { eventId: EVENT } });
  const main = list.body.channels.find((c) => c.name === 'Main');
  assert.equal(main.brandColor, '#0A7E42'); // per-event override, not the client/platform default
});
