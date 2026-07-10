// ─── Social+ (social.plus, formerly Amity) INBOUND connector — disposable module ─
// Pulls a client's IN-APP community analytics INTO Pulse: communities (members,
// posts), chat channels (members, messages), and post-level engagement
// (reactions, comments, impressions, reach) — the numbers behind the Social+
// console, queried directly so they land next to everything else Pulse knows.
//
// Per-client connection (Admin → client → Integrations, or client self-service):
//   socialplusApiKey  — the app API key from the Social+ console (write-only,
//                       sealed at rest by the secret-name heuristic)
//   socialplusRegion  — 'eu' | 'us' | 'sg' (where the Social+ network lives)
// Auth: POST /api/v3/sessions with x-api-key mints a user access token for a
// dedicated read-only service identity; we cache it in-memory and refresh well
// inside its 30-day life. Endpoints verified live against apix.eu.amity.co.
//
// House conventions (mirrors socialMetrics.js / slack.js):
//   • graceful no-op until a client pastes their key,
//   • one sync chokepoint that NEVER throws — failures are recorded on the
//     per-entity sync row and the rest of the system carries on,
//   • upserts restate on re-pull (never duplicate), daily totals build a series,
//   • dual-surface routes mounted here so index.js stays one line.
// Uninstall: remove this file + its mount/startDailySync lines in server/index.js,
// the `socialplus` entries in the integrations plumbing there, and the Social+
// section in IntegrationsForm.jsx / SocialPage.jsx. Tables socialplus_* are ours.

const REGIONS = { eu: 'https://apix.eu.amity.co', us: 'https://apix.us.amity.co', sg: 'https://apix.sg.amity.co' };
const SYNC_USER = 'pulse-analytics';   // service identity sessions are minted for
const PAGE_LIMIT = 100;                // page size for list endpoints
const MAX_PAGES = 10;                  // pagination cap per list per sync
const POST_COMMUNITIES = 30;           // communities we pull post-level detail for
const TOKEN_TTL_MS = 12 * 3600 * 1000; // re-mint sessions well inside their 30 days

let db = null;
function init(deps) {
  db = deps.db;
  db.db.exec(`
    -- Snapshot: one row per community (restated each sync; vanished ones pruned).
    CREATE TABLE IF NOT EXISTS socialplus_communities (
      entity_id    TEXT NOT NULL,
      community_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      is_public    INTEGER NOT NULL DEFAULT 1,
      members      INTEGER,
      posts        INTEGER,
      created_at   TEXT NOT NULL DEFAULT '',
      last_synced  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, community_id)
    );
    -- Snapshot: one row per chat channel (announcements / lineup / FAQ / …).
    CREATE TABLE IF NOT EXISTS socialplus_channels (
      entity_id     TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT '',
      members       INTEGER,
      messages      INTEGER,
      last_activity TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT '',
      last_synced   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, channel_id)
    );
    -- Post-level engagement. Upsert on post id; counts restate on each pull.
    CREATE TABLE IF NOT EXISTS socialplus_posts (
      entity_id      TEXT NOT NULL,
      post_id        TEXT NOT NULL,
      community_id   TEXT NOT NULL DEFAULT '',
      community_name TEXT NOT NULL DEFAULT '',
      data_type      TEXT NOT NULL DEFAULT '',
      text           TEXT NOT NULL DEFAULT '',
      reactions      INTEGER,
      comments       INTEGER,
      shares         INTEGER,
      flags          INTEGER,
      impressions    INTEGER,
      reach          INTEGER,
      posted_at      TEXT NOT NULL DEFAULT '',
      updated_at     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, post_id)
    );
    -- Daily totals series (one row per entity per day; re-syncs restate the day).
    CREATE TABLE IF NOT EXISTS socialplus_daily (
      entity_id    TEXT NOT NULL,
      date         TEXT NOT NULL,               -- YYYY-MM-DD
      communities  INTEGER,
      members      INTEGER,
      posts        INTEGER,
      channels     INTEGER,
      chat_members INTEGER,
      messages     INTEGER,
      comments     INTEGER,
      reactions    INTEGER,
      PRIMARY KEY (entity_id, date)
    );
    -- Per-entity sync health (what the UI shows next to the refresh button).
    CREATE TABLE IF NOT EXISTS socialplus_sync (
      entity_id   TEXT PRIMARY KEY,
      last_status TEXT NOT NULL DEFAULT '',     -- 'ok' | 'error'
      last_error  TEXT NOT NULL DEFAULT '',
      last_synced TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_socialplus_daily ON socialplus_daily(entity_id, date);
    CREATE INDEX IF NOT EXISTS idx_socialplus_posts ON socialplus_posts(entity_id, posted_at);
  `);
}

// ── connection (per client, from entity integrations) ──
function connection(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  const region = REGIONS[i.socialplusRegion] ? i.socialplusRegion : 'eu';
  return { apiKey: (i.socialplusApiKey || '').trim(), region };
}
function isConfigured(entityId) { return !!connection(entityId).apiKey; }
function status(entityId) {
  const c = connection(entityId);
  return { configured: !!c.apiKey, region: c.region };
}

// ── integration plumbing (kept here so index.js stays thin) ──
// Translate an inbound integrations payload (body.socialplus) into stored keys.
function applyPatch(body, set) {
  const sp = (body || {}).socialplus || {};
  if (sp.apiKey) set('socialplusApiKey', String(sp.apiKey).trim());
  if (sp.clearApiKey) set('socialplusApiKey', '');
  if (sp.region !== undefined) set('socialplusRegion', REGIONS[sp.region] ? String(sp.region) : 'eu');
}
// Masked, write-only view for the settings UI (the key is reported set + hint only).
const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
function view(i) {
  return {
    keySet: !!i.socialplusApiKey,
    keyHint: mask(i.socialplusApiKey),
    region: REGIONS[i.socialplusRegion] ? i.socialplusRegion : 'eu',
    configured: !!i.socialplusApiKey,
  };
}

// ── session + fetch helpers ──
// Mint (and cache) an access token for the Pulse service identity. A changed
// API key invalidates the cache entry so a re-pasted key takes effect at once.
const sessions = new Map(); // entityId → { token, base, key, at }
async function session(entityId) {
  const c = connection(entityId);
  if (!c.apiKey) { const e = new Error('Social+ isn’t connected for this client.'); e.httpStatus = 400; throw e; }
  const cached = sessions.get(entityId);
  if (cached && cached.key === c.apiKey && (Date.now() - cached.at) < TOKEN_TTL_MS) return cached;
  const base = REGIONS[c.region];
  const res = await fetch(`${base}/api/v3/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey },
    body: JSON.stringify({ userId: SYNC_USER, deviceId: 'pulse-server', displayName: 'Pulse Analytics' }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    const err = new Error(data.message || `Social+ HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  const s = { token: data.accessToken, base, key: c.apiKey, at: Date.now() };
  sessions.set(entityId, s);
  return s;
}
async function apiGet(s, path) {
  const res = await fetch(`${s.base}${path}`, { headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    const err = new Error(data.message || `Social+ HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}
// Page through a list endpoint (paging.next is an opaque token → options[token]).
// Returns { items, complete } — complete=false when the page cap cut us short,
// in which case the sync skips pruning so untouched rows aren't lost.
async function pagedList(s, path, listKey) {
  const items = [];
  let token = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}options%5Blimit%5D=${PAGE_LIMIT}${token ? `&options%5Btoken%5D=${encodeURIComponent(token)}` : ''}`;
    const data = await apiGet(s, url);
    items.push(...(data[listKey] || []));
    token = data.paging?.next || '';
    if (!token) return { items, complete: true };
  }
  return { items, complete: false };
}

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' ? null : Number(v));

// ── upserts ──
function upsertCommunity(row) {
  db.db.prepare(`INSERT INTO socialplus_communities (entity_id, community_id, display_name, is_public, members, posts, created_at, last_synced)
    VALUES (@entity_id,@community_id,@display_name,@is_public,@members,@posts,@created_at,@last_synced)
    ON CONFLICT(entity_id, community_id) DO UPDATE SET
      display_name=excluded.display_name, is_public=excluded.is_public,
      members=COALESCE(excluded.members, socialplus_communities.members),
      posts=COALESCE(excluded.posts, socialplus_communities.posts),
      created_at=excluded.created_at, last_synced=excluded.last_synced`)
    .run({ display_name: '', is_public: 1, members: null, posts: null, created_at: '', last_synced: new Date().toISOString(), ...row });
}
function upsertChannel(row) {
  db.db.prepare(`INSERT INTO socialplus_channels (entity_id, channel_id, display_name, type, members, messages, last_activity, created_at, last_synced)
    VALUES (@entity_id,@channel_id,@display_name,@type,@members,@messages,@last_activity,@created_at,@last_synced)
    ON CONFLICT(entity_id, channel_id) DO UPDATE SET
      display_name=excluded.display_name, type=excluded.type,
      members=COALESCE(excluded.members, socialplus_channels.members),
      messages=COALESCE(excluded.messages, socialplus_channels.messages),
      last_activity=excluded.last_activity, created_at=excluded.created_at, last_synced=excluded.last_synced`)
    .run({ display_name: '', type: '', members: null, messages: null, last_activity: '', created_at: '', last_synced: new Date().toISOString(), ...row });
}
function upsertPost(row) {
  db.db.prepare(`INSERT INTO socialplus_posts (entity_id, post_id, community_id, community_name, data_type, text, reactions, comments, shares, flags, impressions, reach, posted_at, updated_at)
    VALUES (@entity_id,@post_id,@community_id,@community_name,@data_type,@text,@reactions,@comments,@shares,@flags,@impressions,@reach,@posted_at,@updated_at)
    ON CONFLICT(entity_id, post_id) DO UPDATE SET
      community_id=excluded.community_id, community_name=excluded.community_name,
      data_type=excluded.data_type, text=excluded.text,
      reactions=COALESCE(excluded.reactions, socialplus_posts.reactions),
      comments=COALESCE(excluded.comments, socialplus_posts.comments),
      shares=COALESCE(excluded.shares, socialplus_posts.shares),
      flags=COALESCE(excluded.flags, socialplus_posts.flags),
      impressions=COALESCE(excluded.impressions, socialplus_posts.impressions),
      reach=COALESCE(excluded.reach, socialplus_posts.reach),
      posted_at=excluded.posted_at, updated_at=excluded.updated_at`)
    .run({ community_id: '', community_name: '', data_type: '', text: '', reactions: null, comments: null, shares: null, flags: null, impressions: null, reach: null, posted_at: '', updated_at: new Date().toISOString(), ...row });
}
function upsertDaily(row) {
  db.db.prepare(`INSERT INTO socialplus_daily (entity_id, date, communities, members, posts, channels, chat_members, messages, comments, reactions)
    VALUES (@entity_id,@date,@communities,@members,@posts,@channels,@chat_members,@messages,@comments,@reactions)
    ON CONFLICT(entity_id, date) DO UPDATE SET
      communities=excluded.communities, members=excluded.members, posts=excluded.posts,
      channels=excluded.channels, chat_members=excluded.chat_members, messages=excluded.messages,
      comments=excluded.comments, reactions=excluded.reactions`)
    .run({ communities: null, members: null, posts: null, channels: null, chat_members: null, messages: null, comments: null, reactions: null, ...row });
}
function setSyncState(entityId, status, error = '') {
  db.db.prepare(`INSERT INTO socialplus_sync (entity_id, last_status, last_error, last_synced) VALUES (?,?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET last_status=excluded.last_status, last_error=excluded.last_error, last_synced=excluded.last_synced`)
    .run(entityId, status, String(error).slice(0, 300), new Date().toISOString());
}

// ── the sync chokepoint — NEVER throws ──
// Pulls communities + channels (full snapshots), post detail for the most active
// communities, then restates today's totals row. A failure is recorded on the
// sync row; whatever landed before the failure stays.
async function syncEntity(entityId) {
  if (!isConfigured(entityId)) return { ok: false, error: 'not_configured' };
  try {
    const s = await session(entityId);
    const now = new Date().toISOString();

    const { items: comms, complete: commsComplete } = await pagedList(s, '/api/v3/communities?filter=all', 'communities');
    for (const c of comms) {
      upsertCommunity({
        entity_id: entityId, community_id: String(c.communityId || c._id),
        display_name: c.displayName || '', is_public: c.isPublic === false ? 0 : 1,
        members: num(c.membersCount), posts: num(c.postsCount), created_at: c.createdAt || '', last_synced: now,
      });
    }
    // Prune communities that no longer exist — only when we saw the full list.
    if (commsComplete) db.db.prepare('DELETE FROM socialplus_communities WHERE entity_id=? AND last_synced<>?').run(entityId, now);

    const { items: chans, complete: chansComplete } = await pagedList(s, '/api/v3/channels?filter=all', 'channels');
    for (const ch of chans) {
      upsertChannel({
        entity_id: entityId, channel_id: String(ch.channelId || ch._id),
        display_name: ch.displayName || '', type: ch.type || '',
        members: num(ch.memberCount), messages: num(ch.messageCount),
        last_activity: ch.lastActivity || '', created_at: ch.createdAt || '', last_synced: now,
      });
    }
    if (chansComplete) db.db.prepare('DELETE FROM socialplus_channels WHERE entity_id=? AND last_synced<>?').run(entityId, now);

    // Post-level detail for the most active communities (engagement lives here).
    const active = comms.filter((c) => (c.postsCount || 0) > 0)
      .sort((a, b) => (b.postsCount || 0) - (a.postsCount || 0)).slice(0, POST_COMMUNITIES);
    for (const c of active) {
      const cid = String(c.communityId || c._id);
      const { items: posts } = await pagedList(s, `/api/v4/posts?targetType=community&targetId=${encodeURIComponent(cid)}&sortBy=lastCreated`, 'posts');
      for (const p of posts) {
        upsertPost({
          entity_id: entityId, post_id: String(p.postId || p._id), community_id: cid,
          community_name: c.displayName || '', data_type: p.dataType || '',
          text: String(p.data?.text || p.data?.title || '').slice(0, 500),
          reactions: num(p.reactionsCount), comments: num(p.commentsCount),
          shares: num(p.sharedCount), flags: num(p.flagCount),
          impressions: num(p.impression), reach: num(p.reach),
          posted_at: p.createdAt || '', updated_at: now,
        });
      }
    }

    // Restate today's totals from the fresh snapshots.
    const t = totals(entityId);
    upsertDaily({ entity_id: entityId, date: today(), ...t });
    setSyncState(entityId, 'ok');
    return { ok: true, totals: t, communities: comms.length, channels: chans.length };
  } catch (e) {
    setSyncState(entityId, 'error', e.message);
    return { ok: false, error: e.message };
  }
}

// ── query helpers (feed the Social page + summaries) ──
function totals(entityId) {
  const c = db.db.prepare('SELECT COUNT(*) AS n, SUM(members) AS members, SUM(posts) AS posts FROM socialplus_communities WHERE entity_id=?').get(entityId) || {};
  const ch = db.db.prepare('SELECT COUNT(*) AS n, SUM(members) AS members, SUM(messages) AS messages FROM socialplus_channels WHERE entity_id=?').get(entityId) || {};
  const p = db.db.prepare('SELECT SUM(comments) AS comments, SUM(reactions) AS reactions FROM socialplus_posts WHERE entity_id=?').get(entityId) || {};
  return {
    communities: num(c.n) || 0, members: num(c.members) || 0, posts: num(c.posts) || 0,
    channels: num(ch.n) || 0, chat_members: num(ch.members) || 0, messages: num(ch.messages) || 0,
    comments: num(p.comments) || 0, reactions: num(p.reactions) || 0,
  };
}
function communities(entityId, { limit = 50 } = {}) {
  return db.db.prepare(`SELECT community_id AS communityId, display_name AS displayName, is_public AS isPublic, members, posts, created_at AS createdAt, last_synced AS lastSynced
    FROM socialplus_communities WHERE entity_id=? ORDER BY members DESC NULLS LAST LIMIT ?`).all(entityId, limit);
}
function channels(entityId, { limit = 50 } = {}) {
  return db.db.prepare(`SELECT channel_id AS channelId, display_name AS displayName, type, members, messages, last_activity AS lastActivity
    FROM socialplus_channels WHERE entity_id=? ORDER BY messages DESC NULLS LAST, members DESC NULLS LAST LIMIT ?`).all(entityId, limit);
}
// Daily totals series for one metric, oldest→newest, last `days`.
function series(entityId, { metric = 'members', days = 30 } = {}) {
  const col = ['communities', 'members', 'posts', 'channels', 'chat_members', 'messages', 'comments', 'reactions'].includes(metric) ? metric : 'members';
  const rows = db.db.prepare(`SELECT date, ${col} AS value FROM socialplus_daily WHERE entity_id=? ORDER BY date DESC LIMIT ?`)
    .all(entityId, Math.min(Math.max(Number(days) || 30, 1), 365));
  return rows.reverse();
}
function topPosts(entityId, { sort = 'reactions', limit = 10 } = {}) {
  const col = ['reactions', 'comments', 'impressions', 'reach', 'shares'].includes(sort) ? sort : 'reactions';
  return db.db.prepare(`SELECT post_id AS postId, community_id AS communityId, community_name AS communityName, data_type AS dataType, text, reactions, comments, shares, flags, impressions, reach, posted_at AS postedAt
    FROM socialplus_posts WHERE entity_id=? ORDER BY ${col} DESC NULLS LAST LIMIT ?`).all(entityId, Math.min(Number(limit) || 10, 50));
}

// Per-client health summary (admin monitoring + the Social page header).
function summary(entityId) {
  const sync = db.db.prepare('SELECT last_status AS lastStatus, last_error AS lastError, last_synced AS lastSynced FROM socialplus_sync WHERE entity_id=?').get(entityId) || {};
  return {
    channel: 'socialplus', configured: isConfigured(entityId), region: connection(entityId).region,
    totals: totals(entityId),
    lastStatus: sync.lastStatus || '', lastError: sync.lastError || '', lastAt: sync.lastSynced || '',
  };
}

// Live check — can we mint a session and read one page right now? Never throws.
async function verify(entityId) {
  const checkedAt = new Date().toISOString();
  if (!isConfigured(entityId)) return { ok: false, status: 'not_configured', checkedAt };
  try {
    sessions.delete(entityId); // force a fresh mint so a revoked key is caught
    const s = await session(entityId);
    const data = await apiGet(s, '/api/v3/communities?filter=all&options%5Blimit%5D=1');
    return { ok: true, checkedAt, sample: (data.communities || []).length };
  } catch (e) {
    return { ok: false, status: e.httpStatus === 400 || e.httpStatus === 401 ? 'key_invalid' : 'error', detail: e.message, checkedAt };
  }
}

// ── routes (dual-surface, mounted here so index.js stays one line) ──
function mount(app, { db: database, auth }) {
  init({ db: database });
  const { asyncHandler } = require('./http');
  const ownsEntity = (req, id) => req.user.role === 'admin' || (req.user.entityIds || []).includes(id);
  const payload = (id, q = {}) => ({
    summary: summary(id),
    communities: communities(id),
    channels: channels(id),
    series: series(id, { metric: q.metric ? String(q.metric) : undefined, days: Number(q.days) || 30 }),
    topPosts: topPosts(id, { sort: q.sort ? String(q.sort) : undefined, limit: 12 }),
  });
  // Admin: any client.
  app.get('/api/admin/entities/:id/socialplus', auth.requireAdmin, (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(payload(req.params.id, req.query));
  });
  app.post('/api/admin/entities/:id/socialplus/sync', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(await syncEntity(req.params.id));
  }));
  app.post('/api/admin/entities/:id/socialplus/verify', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(await verify(req.params.id));
  }));
  // Client self-service: the caller's OWN entity (ownership enforced).
  app.get('/api/my/socialplus/:entityId', auth.requireAuth, (req, res) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    if (!database.getEntity(id)) return res.status(404).json({ error: 'Not found' });
    res.json(payload(id, req.query));
  });
  app.post('/api/my/socialplus/:entityId/sync', auth.requireAuth, auth.requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    res.json(await syncEntity(id));
  }));
  app.post('/api/my/socialplus/:entityId/verify', auth.requireAuth, asyncHandler(async (req, res) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    res.json(await verify(id));
  }));
  return module.exports;
}

// ── daily scheduler (started from index.js, NOT from init, so tests stay timer-free) ──
let timer = null;
let lastRunDay = '';
function startDailySync({ listEntities, hourUtc = 5 } = {}) {
  if (timer) return;
  async function tick() {
    const now = new Date();
    if (now.getUTCHours() !== hourUtc) return;         // run in a 1-hour window once/day
    const day = today();
    if (day === lastRunDay) return;                    // already ran today
    lastRunDay = day;
    for (const e of (listEntities ? listEntities() : [])) {
      if (isConfigured(e.id)) { try { await syncEntity(e.id); } catch { /* never throw */ } }
    }
  }
  timer = setInterval(() => { tick().catch(() => {}); }, 15 * 60 * 1000);
  if (timer.unref) timer.unref();
}
function stopDailySync() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  init, mount, connection, isConfigured, status, applyPatch, view,
  syncEntity, totals, communities, channels, series, topPosts, summary, verify,
  startDailySync, stopDailySync,
};
