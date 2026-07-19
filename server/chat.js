// ─── Event chat: channels, fan groups, messages (Pulse ⇄ Howler app) ─────────────
// SELF-CONTAINED, DISPOSABLE MODULE — phase 2 of the Social+ replacement
// (docs/SOCIAL_PLATFORM_INVESTIGATION.md; mockup approved by Shai 2026-07-18).
// Owns the `social_chat_*` tables and every route. Wire contract:
// docs/specs/SOCIAL_CONTRACT.md §chat.
//
// Model: a CHANNEL belongs to an organiser (entity) and a Howler event.
//   kind   'official' — created by the organiser (Main, Transport, Line-up…)
//          'group'    — fan-made, joined via invite link, creator moderates
//   access 'public'   — any verified app user at the event
//          'segment'  — gated by a Pulse segment (ticket types/categories);
//                       members arrive via segment sync or admin-add
//          'manual'   — admin-added members only (e.g. Crew)
//          'invite'   — fan groups: membership via invite code only
//   mode   'chat'     — everyone talks
//          'broadcast'— organiser posts, fans read/react/reply
//
// Ring-fencing rules (Shai): an invite link joins THAT GROUP ONLY — the other
// channels still check their own access, and locked segment channels tell the
// app to show a "get tickets" CTA. Messages support replies (one level),
// multi-emoji reactions, pin (organiser), report, soft delete (author or
// organiser). Broadcast writes one organiser message into every official
// channel of the event, optionally pinned, with a per-message push flag —
// the flag is RECORDED now; actual push delivery arrives with the Firebase
// key (server/push door, phase next).
//
// Identity: every chat route requires the verified Howler JWT (appAuth).
// Flag: community.chat (kid of `community`). Kill switch: social_chat_enabled.
// TO REMOVE: delete this file + mount line + flag rows, drop social_chat_*.

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');
const flags = require('./flags');
const appAuth = require('./appAuth');

const ACCESS = ['public', 'segment', 'manual', 'invite'];
const MODES = ['chat', 'broadcast'];
const MAX_TEXT = 2000;
const PAGE_MAX = 100;

function mount(app, { db, auth, rateLimit, verifyAppToken = appAuth.defaultVerifyAppToken, resolveSegmentMembers = null }) {
  const sql = db.db;
  // Strictly monotonic timestamps: unread counts and `after=` polling compare
  // ISO strings, so two writes in the same millisecond must never tie.
  let lastTs = 0;
  const now = () => {
    let t = Date.now();
    if (t <= lastTs) t = lastTs + 1;
    lastTs = t;
    return new Date(t).toISOString();
  };
  const uuid = () => crypto.randomUUID();
  const { requireAppUser } = appAuth.helpers(verifyAppToken);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS social_chat_channels (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      emoji        TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'official',  -- official | group
      access       TEXT NOT NULL DEFAULT 'public',    -- public | segment | manual | invite
      mode         TEXT NOT NULL DEFAULT 'chat',      -- chat | broadcast
      segment_id   TEXT NOT NULL DEFAULT '',
      invite_code  TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL DEFAULT '',          -- howler user id (fan groups)
      creator_name TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'active',    -- active | closed
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scc_event ON social_chat_channels(event_id, status);
    CREATE INDEX IF NOT EXISTS idx_scc_entity ON social_chat_channels(entity_id);
    CREATE INDEX IF NOT EXISTS idx_scc_code ON social_chat_channels(invite_code);

    CREATE TABLE IF NOT EXISTS social_chat_members (
      channel_id     TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      member_name    TEXT NOT NULL DEFAULT '',
      role           TEXT NOT NULL DEFAULT 'member',  -- member | owner
      source         TEXT NOT NULL DEFAULT 'join',    -- join | invite | admin | segment
      created_at     TEXT NOT NULL,
      PRIMARY KEY (channel_id, howler_user_id)
    );

    CREATE TABLE IF NOT EXISTS social_chat_messages (
      id             TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      howler_user_id TEXT NOT NULL DEFAULT '',
      author_type    TEXT NOT NULL DEFAULT 'fan',     -- fan | organiser
      author_name    TEXT NOT NULL DEFAULT '',
      body           TEXT NOT NULL DEFAULT '',
      parent_id      TEXT NOT NULL DEFAULT '',        -- reply → quoted message id
      pinned         INTEGER NOT NULL DEFAULT 0,
      reported       INTEGER NOT NULL DEFAULT 0,
      deleted        INTEGER NOT NULL DEFAULT 0,      -- soft: placeholder in the app
      push           INTEGER NOT NULL DEFAULT 0,      -- organiser per-message push flag
      cta_label      TEXT NOT NULL DEFAULT '',        -- organiser CTA → clickable button in chat
      cta_destination TEXT NOT NULL DEFAULT '',       -- app's screen-keyword vocabulary / open_url:
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scm_channel ON social_chat_messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scm_entity ON social_chat_messages(entity_id, reported);

    CREATE TABLE IF NOT EXISTS social_chat_reactions (
      message_id     TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      emoji          TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (message_id, howler_user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS social_chat_reads (
      channel_id     TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      last_read_at   TEXT NOT NULL,
      PRIMARY KEY (channel_id, howler_user_id)
    );

    -- Personal pins in OFFICIAL channels: visible only to the pinner (their
    -- own "pinned by you" banner). In fan groups the shared message.pinned
    -- flag is used instead (any member can pin, WhatsApp-style).
    CREATE TABLE IF NOT EXISTS social_chat_user_pins (
      message_id     TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (message_id, howler_user_id)
    );
  `);

  const enabled = () => db.getSetting('social_chat_enabled', '1') !== '0';
  const flagOn = (entityId) => { try { return !!flags.enabled(entityId, 'community.chat'); } catch { return false; } };
  const gone = (res) => res.status(404).json({ error: 'Not available' });

  // ── helpers ──
  const getChannel = (id) => sql.prepare('SELECT * FROM social_chat_channels WHERE id=?').get(String(id));
  const memberRow = (chId, uid) => sql.prepare('SELECT * FROM social_chat_members WHERE channel_id=? AND howler_user_id=?').get(chId, String(uid));
  const memberCount = (chId) => sql.prepare('SELECT COUNT(*) n FROM social_chat_members WHERE channel_id=?').get(chId).n;
  const inviteCode = () => crypto.randomBytes(6).toString('base64url');

  // Can this verified user READ the channel? Returns { ok, lockedReason }.
  function accessFor(c, userId) {
    if (c.status !== 'active') return { ok: false, lockedReason: 'closed' };
    if (c.access === 'public') return { ok: true };
    const m = memberRow(c.id, userId);
    if (m) return { ok: true, member: m };
    if (c.access === 'segment') return { ok: false, lockedReason: 'tickets' }; // app shows "get tickets"
    return { ok: false, lockedReason: 'private' };
  }
  const canPost = (c, user, isOrganiser) => (c.mode !== 'broadcast' || isOrganiser);

  function reactionsFor(messageIds, viewerId) {
    if (!messageIds.length) return {};
    const ph = messageIds.map(() => '?').join(',');
    const rows = sql.prepare(`SELECT message_id, emoji, COUNT(*) n, SUM(howler_user_id=?) mine FROM social_chat_reactions WHERE message_id IN (${ph}) GROUP BY message_id, emoji`).all(String(viewerId || ''), ...messageIds);
    const out = {};
    for (const r of rows) (out[r.message_id] = out[r.message_id] || []).push({ emoji: r.emoji, count: r.n, mine: !!r.mine });
    return out;
  }
  function messageRow(r, { reactions = [], viewerId = null } = {}) {
    if (r.deleted) {
      return { id: r.id, channelId: r.channel_id, deleted: true, authorType: r.author_type, parentId: r.parent_id || null, createdAt: r.created_at };
    }
    return {
      id: r.id, channelId: r.channel_id,
      author: { id: r.howler_user_id, name: r.author_name || (r.author_type === 'organiser' ? 'Organiser' : 'Howler fan') },
      authorType: r.author_type, text: r.body, parentId: r.parent_id || null,
      pinned: !!r.pinned, reported: !!r.reported, reactions,
      ctaLabel: r.cta_label || null, ctaDestination: r.cta_destination || null,
      ...(viewerId ? { isOwner: r.author_type !== 'organiser' && r.howler_user_id === String(viewerId) } : {}),
      createdAt: r.created_at,
    };
  }
  // Same CTA vocabulary as feed posts (validated: screen keyword or open_url:https).
  function validCta(body) {
    const ctaLabel = String(body.ctaLabel || '').trim().slice(0, 40);
    const dest = String(body.ctaDestination || '').trim().slice(0, 500);
    if (!ctaLabel) return { cta_label: '', cta_destination: '' };
    if (!dest) throw new HttpError(400, 'A button needs a destination');
    if (!/^(open_url:https?:\/\/.+|[a-z][a-z0-9_]*(:\d+)?)$/.test(dest)) {
      throw new HttpError(400, 'Button destination must be a screen keyword (e.g. explore_tickets:19203) or open_url:https://…');
    }
    return { cta_label: ctaLabel, cta_destination: dest };
  }
  function channelRow(c, { userId = null } = {}) {
    const acc = userId ? accessFor(c, userId) : { ok: c.access === 'public' };
    const out = {
      id: c.id, eventId: c.event_id, name: c.name, emoji: c.emoji, kind: c.kind,
      access: c.access, mode: c.mode, status: c.status, memberCount: memberCount(c.id),
      locked: !acc.ok, ...(acc.ok ? {} : { lockedReason: acc.lockedReason }),
    };
    if (acc.ok && userId) {
      const lastRead = sql.prepare('SELECT last_read_at FROM social_chat_reads WHERE channel_id=? AND howler_user_id=?').get(c.id, String(userId))?.last_read_at || '';
      out.unread = sql.prepare('SELECT COUNT(*) n FROM social_chat_messages WHERE channel_id=? AND deleted=0 AND created_at>? AND howler_user_id!=?').get(c.id, lastRead, String(userId)).n;
      const pin = sql.prepare('SELECT * FROM social_chat_messages WHERE channel_id=? AND pinned=1 AND deleted=0 ORDER BY created_at DESC LIMIT 1').get(c.id);
      if (pin) out.pinnedMessage = messageRow(pin);
      const myPin = sql.prepare('SELECT m.* FROM social_chat_messages m JOIN social_chat_user_pins u ON u.message_id=m.id AND u.howler_user_id=? WHERE m.channel_id=? AND m.deleted=0 ORDER BY u.created_at DESC LIMIT 1').get(String(userId), c.id);
      if (myPin) out.myPinnedMessage = messageRow(myPin);
    }
    if (c.kind === 'group' && userId && (memberRow(c.id, userId)?.role === 'owner')) {
      out.inviteCode = c.invite_code;
      out.isOwner = true;
    }
    return out;
  }
  const eventChannels = (eventId) => sql.prepare("SELECT * FROM social_chat_channels WHERE event_id=? AND status='active' ORDER BY kind='group', position, created_at").all(String(eventId));

  // ── APP SURFACE (all JWT-verified) ──
  const readLimit = rateLimit({ windowMs: 60_000, max: 240, by: 'ip', scope: 'chat_read' });
  const writeLimit = rateLimit({ windowMs: 60_000, max: 40, by: 'ip', scope: 'chat_write' });

  // Channel list for an event: official channels (locked ones included, with
  // the reason so the app can show the ticket CTA) + the user's own fan groups.
  app.get('/api/app/social/chat/channels', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const eventId = String(req.query.eventId || '').trim();
    if (!/^\d+$/.test(eventId)) throw new HttpError(400, 'eventId required');
    const all = eventChannels(eventId).filter((c) => flagOn(c.entity_id));
    const visible = all.filter((c) => c.kind === 'official' || memberRow(c.id, user.id));
    res.json({ contractVersion: 1, channels: visible.map((c) => channelRow(c, { userId: user.id })) });
  }));

  // Fan creates a group for an event (invite-access, they become owner).
  app.post('/api/app/social/chat/channels', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const body = req.body || {};
    const eventId = String(body.eventId || '').trim();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!/^\d+$/.test(eventId) || !name) throw new HttpError(400, 'eventId and a group name are required');
    // The event must have chat enabled (an official channel from a flag-on entity).
    const host = eventChannels(eventId).find((c) => c.kind === 'official' && flagOn(c.entity_id));
    if (!host) throw new HttpError(400, 'Chat isn’t enabled for this event yet');
    const id = `ch_${uuid().slice(0, 12)}`;
    const displayName = (user.name || String(body.displayName || '')).trim().slice(0, 80);
    sql.prepare(`INSERT INTO social_chat_channels (id, entity_id, event_id, name, emoji, kind, access, mode, invite_code, created_by, creator_name, created_at, updated_at)
                 VALUES (?,?,?,?,?, 'group', 'invite', 'chat', ?,?,?,?,?)`)
      .run(id, host.entity_id, eventId, name, String(body.emoji || '👥').slice(0, 8), inviteCode(), user.id, displayName, now(), now());
    sql.prepare("INSERT INTO social_chat_members (channel_id, howler_user_id, member_name, role, source, created_at) VALUES (?,?,?, 'owner', 'join', ?)")
      .run(id, user.id, displayName, now());
    res.json(channelRow(getChannel(id), { userId: user.id }));
  }));

  // Join a fan group via invite code. Joins THAT GROUP ONLY (Shai's rule) —
  // every other channel still checks its own access.
  app.post('/api/app/social/chat/join', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const code = String((req.body || {}).code || '').trim();
    const c = code && sql.prepare("SELECT * FROM social_chat_channels WHERE invite_code=? AND status='active'").get(code);
    if (!c || !flagOn(c.entity_id)) throw new HttpError(404, 'That invite link is no longer valid');
    const displayName = (user.name || String((req.body || {}).displayName || '')).trim().slice(0, 80);
    sql.prepare("INSERT OR IGNORE INTO social_chat_members (channel_id, howler_user_id, member_name, source, created_at) VALUES (?,?,?, 'invite', ?)")
      .run(c.id, user.id, displayName, now());
    res.json(channelRow(getChannel(c.id), { userId: user.id }));
  }));

  // Messages — chronological; poll with ?after=<iso> for new ones.
  app.get('/api/app/social/chat/channels/:id/messages', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const c = getChannel(req.params.id);
    if (!c || !flagOn(c.entity_id)) return gone(res);
    const acc = accessFor(c, user.id);
    if (!acc.ok) throw new HttpError(403, acc.lockedReason === 'tickets' ? 'This channel is for specific ticket holders' : 'This channel is private');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), PAGE_MAX);
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const before = typeof req.query.before === 'string' ? req.query.before : '';
    // after= → newer than (polling); before= → older than (history paging);
    // neither → the latest page. Always returned chronologically.
    const rows = after
      ? sql.prepare('SELECT * FROM social_chat_messages WHERE channel_id=? AND created_at>? ORDER BY created_at LIMIT ?').all(c.id, after, limit)
      : before
        ? sql.prepare('SELECT * FROM (SELECT * FROM social_chat_messages WHERE channel_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at').all(c.id, before, limit)
        : sql.prepare('SELECT * FROM (SELECT * FROM social_chat_messages WHERE channel_id=? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at').all(c.id, limit);
    const reacts = reactionsFor(rows.map((r) => r.id), user.id);
    const hasOlder = rows.length > 0 && !!sql.prepare('SELECT 1 FROM social_chat_messages WHERE channel_id=? AND created_at<? LIMIT 1').get(c.id, rows[0].created_at);
    const myPins = new Set(sql.prepare('SELECT u.message_id FROM social_chat_user_pins u JOIN social_chat_messages m ON m.id=u.message_id WHERE m.channel_id=? AND u.howler_user_id=?').all(c.id, String(user.id)).map((r) => r.message_id));
    res.json({
      contractVersion: 1,
      channel: channelRow(c, { userId: user.id }),
      canPost: canPost(c, user, false),
      hasOlder,
      messages: rows.map((r) => ({ ...messageRow(r, { reactions: reacts[r.id] || [], viewerId: user.id }), pinnedByMe: myPins.has(r.id) })),
    });
  }));

  app.post('/api/app/social/chat/channels/:id/messages', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const c = getChannel(req.params.id);
    if (!c || !flagOn(c.entity_id)) return gone(res);
    const acc = accessFor(c, user.id);
    if (!acc.ok) throw new HttpError(403, 'Join this channel first');
    if (!canPost(c, user, false)) throw new HttpError(403, 'Only the organiser posts here — you can react and reply in threads');
    const body = req.body || {};
    const text = String(body.text || '').trim().slice(0, MAX_TEXT);
    if (!text) throw new HttpError(400, 'Write something first');
    let parentId = '';
    if (body.parentId) {
      const parent = sql.prepare('SELECT * FROM social_chat_messages WHERE id=? AND channel_id=?').get(String(body.parentId), c.id);
      if (!parent) throw new HttpError(400, 'That message isn’t in this channel');
      parentId = parent.id;
    }
    const id = `msg_${uuid().slice(0, 12)}`;
    const displayName = (user.name || String(body.displayName || '')).trim().slice(0, 80);
    sql.prepare('INSERT INTO social_chat_messages (id, channel_id, entity_id, howler_user_id, author_name, body, parent_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, c.id, c.entity_id, user.id, displayName, text, parentId, now());
    sql.prepare('INSERT OR REPLACE INTO social_chat_reads (channel_id, howler_user_id, last_read_at) VALUES (?,?,?)').run(c.id, user.id, now());
    res.json(messageRow(sql.prepare('SELECT * FROM social_chat_messages WHERE id=?').get(id), { viewerId: user.id }));
  }));

  // Soft delete own message ("message deleted" placeholder in the app).
  app.delete('/api/app/social/chat/messages/:id', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const r = sql.prepare('SELECT * FROM social_chat_messages WHERE id=?').get(String(req.params.id));
    if (!r) return gone(res);
    if (r.author_type === 'organiser' || r.howler_user_id !== String(user.id)) throw new HttpError(403, 'You can only delete your own messages');
    sql.prepare('UPDATE social_chat_messages SET deleted=1, body=\'\', pinned=0 WHERE id=?').run(r.id);
    sql.prepare('DELETE FROM social_chat_user_pins WHERE message_id=?').run(r.id);
    res.json({ ok: true });
  }));

  app.post('/api/app/social/chat/messages/:id/react', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const r = sql.prepare('SELECT * FROM social_chat_messages WHERE id=? AND deleted=0').get(String(req.params.id));
    const c = r && getChannel(r.channel_id);
    if (!r || !c || !flagOn(c.entity_id)) return gone(res);
    if (!accessFor(c, user.id).ok) throw new HttpError(403, 'Join this channel first');
    const emoji = String((req.body || {}).emoji || '').trim().slice(0, 8);
    if (!emoji) throw new HttpError(400, 'emoji required');
    sql.prepare('INSERT OR IGNORE INTO social_chat_reactions (message_id, howler_user_id, emoji, created_at) VALUES (?,?,?,?)').run(r.id, user.id, emoji, now());
    res.json({ ok: true, reactions: reactionsFor([r.id], user.id)[r.id] || [] });
  }));
  app.delete('/api/app/social/chat/messages/:id/react', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const emoji = String((req.body || {}).emoji || req.query.emoji || '').trim();
    sql.prepare('DELETE FROM social_chat_reactions WHERE message_id=? AND howler_user_id=? AND emoji=?').run(String(req.params.id), user.id, emoji);
    res.json({ ok: true, reactions: reactionsFor([String(req.params.id)], user.id)[String(req.params.id)] || [] });
  }));

  // Fan pin/unpin. In a fan GROUP the shared pinned flag toggles (any member,
  // WhatsApp-style — everyone sees it). In an OFFICIAL channel it's a personal
  // pin: only the pinner sees it (their own banner); the organiser's global
  // pin (Pulse) is untouched.
  app.post('/api/app/social/chat/messages/:id/pin', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const r = sql.prepare('SELECT * FROM social_chat_messages WHERE id=? AND deleted=0').get(String(req.params.id));
    const c = r && getChannel(r.channel_id);
    if (!r || !c || !flagOn(c.entity_id)) return gone(res);
    if (!accessFor(c, user.id).ok) throw new HttpError(403, 'Join this channel first');
    const pinned = (req.body || {}).pinned !== false;
    if (c.kind === 'group') {
      if (!memberRow(c.id, user.id)) throw new HttpError(403, 'Join this group first');
      sql.prepare('UPDATE social_chat_messages SET pinned=? WHERE id=?').run(pinned ? 1 : 0, r.id);
      return res.json({ ok: true, pinned, shared: true });
    }
    if (pinned) sql.prepare('INSERT OR IGNORE INTO social_chat_user_pins (message_id, howler_user_id, created_at) VALUES (?,?,?)').run(r.id, user.id, now());
    else sql.prepare('DELETE FROM social_chat_user_pins WHERE message_id=? AND howler_user_id=?').run(r.id, user.id);
    res.json({ ok: true, pinnedByMe: pinned, shared: false });
  }));

  app.post('/api/app/social/chat/messages/:id/report', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    await requireAppUser(req);
    sql.prepare('UPDATE social_chat_messages SET reported=1 WHERE id=?').run(String(req.params.id));
    res.json({ ok: true });
  }));

  // Mark a channel read (clears the unread badge).
  app.post('/api/app/social/chat/channels/:id/read', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare('INSERT OR REPLACE INTO social_chat_reads (channel_id, howler_user_id, last_read_at) VALUES (?,?,?)').run(String(req.params.id), user.id, now());
    res.json({ ok: true });
  }));

  // Group owner tools: leave, remove a member, revoke/regenerate the link.
  app.post('/api/app/social/chat/channels/:id/leave', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare('DELETE FROM social_chat_members WHERE channel_id=? AND howler_user_id=?').run(String(req.params.id), user.id);
    res.json({ ok: true });
  }));
  app.post('/api/app/social/chat/channels/:id/remove-member', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const c = getChannel(req.params.id);
    if (!c || c.kind !== 'group') return gone(res);
    if (memberRow(c.id, user.id)?.role !== 'owner') throw new HttpError(403, 'Only the group owner can remove members');
    sql.prepare("DELETE FROM social_chat_members WHERE channel_id=? AND howler_user_id=? AND role!='owner'").run(c.id, String((req.body || {}).howlerUserId || ''));
    res.json({ ok: true, memberCount: memberCount(c.id) });
  }));
  app.post('/api/app/social/chat/channels/:id/revoke-link', writeLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const c = getChannel(req.params.id);
    if (!c || c.kind !== 'group') return gone(res);
    if (memberRow(c.id, user.id)?.role !== 'owner') throw new HttpError(403, 'Only the group owner can revoke the link');
    sql.prepare('UPDATE social_chat_channels SET invite_code=?, updated_at=? WHERE id=?').run(inviteCode(), now(), c.id);
    res.json(channelRow(getChannel(c.id), { userId: user.id }));
  }));

  // ── MANAGEMENT (organiser/admin) ──
  function listChannels(entityId, eventId) {
    const rows = eventId
      ? sql.prepare('SELECT * FROM social_chat_channels WHERE entity_id=? AND event_id=? ORDER BY kind=\'group\', position, created_at').all(entityId, String(eventId))
      : sql.prepare('SELECT * FROM social_chat_channels WHERE entity_id=? ORDER BY event_id, kind=\'group\', position, created_at').all(entityId);
    return rows.map((c) => ({ ...channelRow(c), inviteCode: c.kind === 'group' ? c.invite_code : undefined, segmentId: c.segment_id || null, createdBy: c.creator_name || null, status: c.status }));
  }
  function createChannel(entityId, body) {
    const eventId = String(body.eventId || '').trim();
    const name = String(body.name || '').trim().slice(0, 60);
    if (!/^\d+$/.test(eventId) || !name) throw new HttpError(400, 'eventId and name required');
    const access = ACCESS.includes(body.access) && body.access !== 'invite' ? body.access : 'public';
    const mode = MODES.includes(body.mode) ? body.mode : 'chat';
    const id = `ch_${uuid().slice(0, 12)}`;
    sql.prepare(`INSERT INTO social_chat_channels (id, entity_id, event_id, name, emoji, access, mode, segment_id, position, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entityId, eventId, name, String(body.emoji || '').slice(0, 8), access, mode, String(body.segmentId || ''), Number(body.position) || 0, now(), now());
    return channelRow(getChannel(id));
  }
  function updateChannel(entityId, id, body) {
    const c = getChannel(id);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    const v = {};
    if (body.name !== undefined) v.name = String(body.name || '').trim().slice(0, 60) || c.name;
    if (body.emoji !== undefined) v.emoji = String(body.emoji || '').slice(0, 8);
    if (body.mode !== undefined && MODES.includes(body.mode)) v.mode = body.mode;
    if (body.access !== undefined && ACCESS.includes(body.access) && c.kind === 'official' && body.access !== 'invite') v.access = body.access;
    if (body.segmentId !== undefined) v.segment_id = String(body.segmentId || '');
    if (body.status !== undefined && ['active', 'closed'].includes(body.status)) v.status = body.status;
    if (body.position !== undefined) v.position = Number(body.position) || 0;
    const sets = Object.keys(v).map((k) => `${k}=?`).join(', ');
    if (sets) sql.prepare(`UPDATE social_chat_channels SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(v), now(), id);
    return channelRow(getChannel(id));
  }
  function addMember(entityId, channelId, howlerUserId, name) {
    const c = getChannel(channelId);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    if (!/^\d+$/.test(String(howlerUserId))) throw new HttpError(400, 'A numeric Howler user id is required');
    sql.prepare("INSERT OR IGNORE INTO social_chat_members (channel_id, howler_user_id, member_name, source, created_at) VALUES (?,?,?, 'admin', ?)")
      .run(channelId, String(howlerUserId), String(name || '').slice(0, 80), now());
    return { ok: true, memberCount: memberCount(channelId) };
  }
  // Segment sync: resolve the channel's Pulse segment to app users. Injected
  // resolver (segments × appMatch) lands in the next phase; until then this
  // reports what's missing instead of pretending.
  async function syncSegment(entityId, channelId) {
    const c = getChannel(channelId);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    if (c.access !== 'segment' || !c.segment_id) throw new HttpError(400, 'This channel isn’t segment-gated');
    if (!resolveSegmentMembers) return { ok: false, pending: true, message: 'Segment→app-user sync isn’t wired yet — members can be added manually meanwhile' };
    const members = await resolveSegmentMembers(entityId, c.segment_id);
    const ins = sql.prepare("INSERT OR IGNORE INTO social_chat_members (channel_id, howler_user_id, member_name, source, created_at) VALUES (?,?,?, 'segment', ?)");
    let added = 0;
    for (const m of members || []) { if (/^\d+$/.test(String(m.id))) { ins.run(channelId, String(m.id), String(m.name || '').slice(0, 80), now()); added += 1; } }
    return { ok: true, added, memberCount: memberCount(channelId) };
  }
  function channelMessages(entityId, channelId) {
    const c = getChannel(channelId);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    return sql.prepare('SELECT * FROM social_chat_messages WHERE channel_id=? ORDER BY reported DESC, created_at DESC LIMIT 500').all(channelId)
      .map((r) => messageRow(r, { reactions: reactionsFor([r.id], null)[r.id] || [] }));
  }
  function organiserMessage(entityId, channelId, body, authorName) {
    const c = getChannel(channelId);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    const text = String(body.text || '').trim().slice(0, MAX_TEXT);
    if (!text) throw new HttpError(400, 'Write something first');
    const cta = validCta(body);
    const id = `msg_${uuid().slice(0, 12)}`;
    sql.prepare("INSERT INTO social_chat_messages (id, channel_id, entity_id, author_type, author_name, body, pinned, push, cta_label, cta_destination, created_at) VALUES (?,?,?, 'organiser', ?,?,?,?,?,?,?)")
      .run(id, channelId, entityId, authorName, text, body.pin ? 1 : 0, body.push ? 1 : 0, cta.cta_label, cta.cta_destination, now());
    return messageRow(sql.prepare('SELECT * FROM social_chat_messages WHERE id=?').get(id));
  }
  // Broadcast: one organiser message into every ACTIVE OFFICIAL channel of the
  // event (fan groups stay theirs). Optional pin + per-message push flag.
  function broadcast(entityId, body, authorName) {
    const eventId = String(body.eventId || '').trim();
    if (!/^\d+$/.test(eventId)) throw new HttpError(400, 'eventId required');
    const targets = sql.prepare("SELECT * FROM social_chat_channels WHERE entity_id=? AND event_id=? AND status='active' AND kind='official'").all(entityId, eventId);
    if (!targets.length) throw new HttpError(400, 'No channels to broadcast to');
    const sent = targets.map((c) => organiserMessage(entityId, c.id, body, authorName));
    return { ok: true, channels: targets.length, messages: sent.map((m) => m.id) };
  }
  function moderateMessage(entityId, messageId, action) {
    const r = sql.prepare('SELECT * FROM social_chat_messages WHERE id=?').get(messageId);
    if (!r || r.entity_id !== entityId) throw new HttpError(404, 'Message not found');
    if (action === 'delete') { sql.prepare('UPDATE social_chat_messages SET deleted=1, body=\'\', pinned=0 WHERE id=?').run(messageId); sql.prepare('DELETE FROM social_chat_user_pins WHERE message_id=?').run(messageId); }
    if (action === 'pin') sql.prepare('UPDATE social_chat_messages SET pinned=1 WHERE id=?').run(messageId);
    if (action === 'unpin') sql.prepare('UPDATE social_chat_messages SET pinned=0 WHERE id=?').run(messageId);
    return { ok: true };
  }
  function closeGroup(entityId, channelId) {
    const c = getChannel(channelId);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Channel not found');
    sql.prepare("UPDATE social_chat_channels SET status='closed', updated_at=? WHERE id=?").run(now(), channelId);
    return { ok: true };
  }

  const A = '/api/admin/entities/:entityId/social/chat';
  const aEid = (req) => req.params.entityId;
  app.get(`${A}/channels`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ channels: listChannels(aEid(req), req.query.eventId) })));
  app.post(`${A}/channels`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(createChannel(aEid(req), req.body || {}))));
  app.put(`${A}/channels/:id`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(updateChannel(aEid(req), req.params.id, req.body || {}))));
  app.post(`${A}/channels/:id/close`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(closeGroup(aEid(req), req.params.id))));
  app.get(`${A}/channels/:id/messages`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ messages: channelMessages(aEid(req), req.params.id) })));
  app.post(`${A}/channels/:id/messages`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(organiserMessage(aEid(req), req.params.id, req.body || {}, db.getEntity(aEid(req))?.name || 'Organiser'))));
  app.post(`${A}/channels/:id/members`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(addMember(aEid(req), req.params.id, (req.body || {}).howlerUserId, (req.body || {}).name))));
  app.post(`${A}/channels/:id/sync-segment`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await syncSegment(aEid(req), req.params.id))));
  app.post(`${A}/broadcast`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(broadcast(aEid(req), req.body || {}, db.getEntity(aEid(req))?.name || 'Organiser'))));
  app.post(`${A}/messages/:id/:action(delete|pin|unpin)`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(moderateMessage(aEid(req), req.params.id, req.params.action))));

  const M = '/api/my/social/chat';
  const mEid = (req) => String(req.query.entityId || (req.body || {}).entityId || '');
  const view = auth.requirePermission('campaigns.view', mEid);
  const manage = auth.requirePermission('campaigns.approve', mEid);
  app.get(`${M}/channels`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ channels: listChannels(mEid(req), req.query.eventId) })));
  app.post(`${M}/channels`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(createChannel(mEid(req), req.body || {}))));
  app.put(`${M}/channels/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(updateChannel(mEid(req), req.params.id, req.body || {}))));
  app.post(`${M}/channels/:id/close`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(closeGroup(mEid(req), req.params.id))));
  app.get(`${M}/channels/:id/messages`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ messages: channelMessages(mEid(req), req.params.id) })));
  app.post(`${M}/channels/:id/messages`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(organiserMessage(mEid(req), req.params.id, req.body || {}, db.getEntity(mEid(req))?.name || 'Organiser'))));
  app.post(`${M}/channels/:id/members`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(addMember(mEid(req), req.params.id, (req.body || {}).howlerUserId, (req.body || {}).name))));
  app.post(`${M}/channels/:id/sync-segment`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(await syncSegment(mEid(req), req.params.id))));
  app.post(`${M}/broadcast`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(broadcast(mEid(req), req.body || {}, db.getEntity(mEid(req))?.name || 'Organiser'))));
  app.post(`${M}/messages/:id/:action(delete|pin|unpin)`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(moderateMessage(mEid(req), req.params.id, req.params.action))));

  return { listChannels, createChannel, broadcast };
}

module.exports = { mount };
