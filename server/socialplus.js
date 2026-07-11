// ─── Social+ (social.plus, formerly Amity) INBOUND connector — disposable module ─
// Pulls a client's IN-APP community analytics INTO Pulse: communities (members,
// posts), chat channels (members, messages), and post-level engagement
// (reactions, comments, impressions, reach) — the numbers behind the Social+
// console, queried directly so they land next to everything else Pulse knows.
//
// Credentials layer like every other integration (platform default → client
// override): per-client `socialplusApiKey` + `socialplusRegion` live in the
// entity integrations blob (the key auto-seals via secretbox.isSecretName);
// blank client fields fall back to the platform settings `socialplus_api_key` /
// `socialplus_region` (Admin → Integrations) — Howler runs ONE Social+ network
// (the Howler app), so most clients ride the shared platform key.
//
// Community scoping: when a client rides the PLATFORM key they sync ONLY the
// communities an admin explicitly linked to them (`socialplusCommunityIds` —
// community ids and/or `event_<howlerEventId>` chat-group prefixes) — never the
// whole network. A client with their OWN key syncs everything unless the list
// narrows it. Auth: POST /api/v3/sessions with x-api-key mints a user access
// token for a read-only service identity; cached in-memory well inside its
// 30-day life. Endpoints verified live against apix.eu.amity.co.
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
const JOIN_WINDOW_DAYS = 90;           // how far back the member-growth backfill reaches
const MEMBER_PAGES = 40;               // membership pagination cap per community per sync
const REFRESH_MAX_AGE_MIN = 30;        // page-open refresh: skip when synced this recently
const QUICK_JOIN_DAYS = 7;             // page-open refresh only re-walks recent joins

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
    -- Joins per community per day, reconstructed from membership join dates.
    -- Powers the "New members" metric AND the members-curve backfill, so the
    -- growth trend has history from the very first sync.
    CREATE TABLE IF NOT EXISTS socialplus_joins (
      entity_id    TEXT NOT NULL,
      community_id TEXT NOT NULL,
      date         TEXT NOT NULL,               -- YYYY-MM-DD (join day)
      joins        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (entity_id, community_id, date)
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

// ── connection (client override → platform default, like queueit) ──
function connection(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  const clientKey = (i.socialplusApiKey || '').trim();
  if (clientKey) return { apiKey: clientKey, region: REGIONS[i.socialplusRegion] ? i.socialplusRegion : 'eu', source: 'client' };
  const platformKey = (db ? db.getSetting('socialplus_api_key') || '' : '').trim();
  const platformRegion = db ? db.getSetting('socialplus_region') || '' : '';
  if (platformKey) return { apiKey: platformKey, region: REGIONS[platformRegion] ? platformRegion : 'eu', source: 'platform' };
  return { apiKey: '', region: 'eu', source: null };
}
function isConfigured(entityId) { return !!connection(entityId).apiKey; }

// The per-client scope list: community ids and/or `event_<id>` channel-group
// prefixes. Accepts an array or a comma/space-separated string.
function idList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  return [...new Set(arr.map((s) => String(s || '').trim()).filter(Boolean))];
}
function assignedIds(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  return idList(i.socialplusCommunityIds);
}
// What may THIS client sync/see? Assigned list → exactly that. No list: their
// own key → everything; the shared platform key → NOTHING (never leak another
// client's communities). Mirrors queueit.visibleRooms.
function scopeFor(entityId) {
  const ids = assignedIds(entityId);
  if (ids.length) return { all: false, ids };
  return { all: connection(entityId).source === 'client', ids: [] };
}
const communityInScope = (scope, communityId) => scope.all || scope.ids.includes(String(communityId));
// A channel is in scope when it IS an assigned id (community feed channels share
// the community's id) or sits under an assigned `event_<id>` prefix.
const channelInScope = (scope, channelId) => scope.all
  || scope.ids.some((id) => String(channelId) === id || String(channelId).startsWith(`${id}_`));

function status(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  const c = connection(entityId);
  return {
    configured: !!c.apiKey, source: c.source, region: c.region,
    clientKeySet: !!(i.socialplusApiKey || '').trim(),
    communityIds: assignedIds(entityId),
  };
}

// ── integration plumbing (kept here so index.js stays thin) ──
// Translate an inbound integrations payload (body.socialplus) into stored keys.
function applyPatch(body, set) {
  const sp = (body || {}).socialplus || {};
  if (sp.apiKey) set('socialplusApiKey', String(sp.apiKey).trim());
  if (sp.clearApiKey) set('socialplusApiKey', '');
  if (sp.region !== undefined) set('socialplusRegion', REGIONS[sp.region] ? String(sp.region) : 'eu');
  if (sp.communityIds !== undefined) set('socialplusCommunityIds', idList(sp.communityIds).join(','));
}
// Masked, write-only view for the settings UI (the key is reported set + hint only).
const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
function view(i) {
  return {
    keySet: !!i.socialplusApiKey,
    keyHint: mask(i.socialplusApiKey),
    region: REGIONS[i.socialplusRegion] ? i.socialplusRegion : 'eu',
    configured: !!i.socialplusApiKey,
    communityIds: idList(i.socialplusCommunityIds),
  };
}

// ── session + fetch helpers ──
// Mint (and cache) an access token for the Pulse service identity. Cached per
// key+region (NOT per entity) so every client on the shared platform key reuses
// one session; a changed key naturally misses the cache and re-mints.
const sessions = new Map(); // `${region}:${apiKey}` → { token, base, key, at }
async function session(entityId) {
  const c = connection(entityId);
  if (!c.apiKey) { const e = new Error('Social+ isn’t connected for this client.'); e.httpStatus = 400; throw e; }
  const cacheKey = `${c.region}:${c.apiKey}`;
  const cached = sessions.get(cacheKey);
  if (cached && (Date.now() - cached.at) < TOKEN_TTL_MS) return cached;
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
  sessions.set(cacheKey, s);
  if (sessions.size > 50) sessions.clear(); // bound the cache; re-mints are cheap
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
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

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
function upsertDailyMembers(entityId, date, members) {
  // Members-only restate for backfilled days — never touches the other columns.
  db.db.prepare(`INSERT INTO socialplus_daily (entity_id, date, members) VALUES (?,?,?)
    ON CONFLICT(entity_id, date) DO UPDATE SET members=excluded.members`).run(entityId, date, members);
}
function setSyncState(entityId, status, error = '') {
  db.db.prepare(`INSERT INTO socialplus_sync (entity_id, last_status, last_error, last_synced) VALUES (?,?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET last_status=excluded.last_status, last_error=excluded.last_error, last_synced=excluded.last_synced`)
    .run(entityId, status, String(error).slice(0, 300), new Date().toISOString());
}

// Walk a community's membership list newest-first, counting joins per day back
// to windowStart. Returns { joinsByDate, coveredFrom }: coveredFrom is the
// earliest day with COMPLETE data — when the page cap truncates a big community
// the half-fetched earliest day is dropped so the curve never lies.
async function fetchJoins(s, communityId, windowStart) {
  const joinsByDate = {};
  let token = '';
  let capped = true; // stays true unless we walk past the window (or run out of members)
  outer: for (let page = 0; page < MEMBER_PAGES; page++) {
    const url = `/api/v3/communities/${encodeURIComponent(communityId)}/users?memberships%5B%5D=member&options%5BsortBy%5D=lastCreated&options%5Blimit%5D=${PAGE_LIMIT}${token ? `&options%5Btoken%5D=${encodeURIComponent(token)}` : ''}`;
    const data = await apiGet(s, url);
    for (const u of (data.communityUsers || [])) {
      const day = String(u.createdAt || '').slice(0, 10);
      if (!day) continue;
      if (day < windowStart) { capped = false; break outer; }
      joinsByDate[day] = (joinsByDate[day] || 0) + 1;
    }
    token = data.paging?.next || '';
    if (!token) { capped = false; break; } // reached the very first member
  }
  let coveredFrom = windowStart;
  if (capped) {
    const days = Object.keys(joinsByDate).sort();
    const partial = days[0];
    if (partial) { delete joinsByDate[partial]; coveredFrom = addDays(partial, 1); }
    else coveredFrom = today();
  }
  return { joinsByDate, coveredFrom };
}

// Members on day d = members now − everyone who joined after d. Leavers make
// this an approximation — it's a growth curve, not an audit. Pure; exported
// for tests.
function buildMembersCurve(totalNow, joinsByDate, fromDate, toDate) {
  const days = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) days.push(d);
  const out = [];
  let joinsAfter = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    out.unshift({ date: days[i], members: totalNow - joinsAfter });
    joinsAfter += joinsByDate[days[i]] || 0; // joins ON day d roll into earlier days
  }
  return out;
}

// ── the sync chokepoint — NEVER throws ──
// Pulls communities + channels (filtered to this client's scope), post detail
// for the most active in-scope communities, then restates today's totals row.
// A failure is recorded on the sync row; whatever landed before the failure stays.
// Concurrent calls per entity share ONE run (page-opens auto-refresh — see
// syncIfStale — so simultaneous viewers must not stack syncs).
const syncing = new Map(); // entityId → in-flight promise
function syncEntity(entityId, opts = {}) {
  if (syncing.has(entityId)) return syncing.get(entityId);
  const p = doSyncEntity(entityId, opts).finally(() => syncing.delete(entityId));
  syncing.set(entityId, p);
  return p;
}
// Refresh-on-open: skip when fresh, quick-window when it's a routine top-up,
// full window on the very first pull. Never throws (syncEntity doesn't).
async function syncIfStale(entityId, { maxAgeMinutes = REFRESH_MAX_AGE_MIN } = {}) {
  if (!isConfigured(entityId)) return { ok: false, error: 'not_configured', refreshed: false };
  const row = db.db.prepare('SELECT last_synced FROM socialplus_sync WHERE entity_id=?').get(entityId);
  const last = row?.last_synced ? Date.parse(row.last_synced) : 0;
  if (last && Date.now() - last < maxAgeMinutes * 60 * 1000) return { ok: true, refreshed: false, lastAt: row.last_synced };
  const r = await syncEntity(entityId, { joinWindowDays: last ? QUICK_JOIN_DAYS : JOIN_WINDOW_DAYS });
  return { ...r, refreshed: true };
}
async function doSyncEntity(entityId, { joinWindowDays = JOIN_WINDOW_DAYS } = {}) {
  if (!isConfigured(entityId)) return { ok: false, error: 'not_configured' };
  const scope = scopeFor(entityId);
  // Shared platform key with nothing linked yet: sync NOTHING (and clear any
  // rows from a previous, wider assignment) — never leak other clients' data.
  if (!scope.all && !scope.ids.length) {
    for (const t of ['socialplus_communities', 'socialplus_channels', 'socialplus_posts', 'socialplus_daily', 'socialplus_joins']) {
      db.db.prepare(`DELETE FROM ${t} WHERE entity_id=?`).run(entityId);
    }
    setSyncState(entityId, 'ok');
    return { ok: true, totals: totals(entityId), communities: 0, channels: 0, unassigned: true };
  }
  try {
    const s = await session(entityId);
    const now = new Date().toISOString();

    const { items: allComms, complete: commsComplete } = await pagedList(s, '/api/v3/communities?filter=all', 'communities');
    const comms = allComms.filter((c) => communityInScope(scope, String(c.communityId || c._id)));
    for (const c of comms) {
      upsertCommunity({
        entity_id: entityId, community_id: String(c.communityId || c._id),
        display_name: c.displayName || '', is_public: c.isPublic === false ? 0 : 1,
        members: num(c.membersCount), posts: num(c.postsCount), created_at: c.createdAt || '', last_synced: now,
      });
    }
    // Prune rows that vanished (or fell out of scope) — only on a full listing.
    if (commsComplete) db.db.prepare('DELETE FROM socialplus_communities WHERE entity_id=? AND last_synced<>?').run(entityId, now);

    const { items: allChans, complete: chansComplete } = await pagedList(s, '/api/v3/channels?filter=all', 'channels');
    const chans = allChans.filter((ch) => channelInScope(scope, String(ch.channelId || ch._id)));
    for (const ch of chans) {
      upsertChannel({
        entity_id: entityId, channel_id: String(ch.channelId || ch._id),
        display_name: ch.displayName || '', type: ch.type || '',
        members: num(ch.memberCount), messages: num(ch.messageCount),
        last_activity: ch.lastActivity || '', created_at: ch.createdAt || '', last_synced: now,
      });
    }
    if (chansComplete) db.db.prepare('DELETE FROM socialplus_channels WHERE entity_id=? AND last_synced<>?').run(entityId, now);

    // Post-level detail for the most active in-scope communities.
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

    // Posts + joins from communities that fell out of scope go too (full listing only).
    if (commsComplete) {
      const keep = new Set(comms.map((c) => String(c.communityId || c._id)));
      for (const table of ['socialplus_posts', 'socialplus_joins']) {
        for (const row of db.db.prepare(`SELECT DISTINCT community_id AS cid FROM ${table} WHERE entity_id=?`).all(entityId)) {
          if (!keep.has(row.cid)) db.db.prepare(`DELETE FROM ${table} WHERE entity_id=? AND community_id=?`).run(entityId, row.cid);
        }
      }
    }

    // Member-growth backfill: reconstruct joins-per-day from membership join
    // dates so the trend has history from the FIRST sync (a flat just-started
    // snapshot line was the alternative). Best-effort per community.
    const windowStart = addDays(today(), -joinWindowDays);
    const allJoins = {};
    let coveredFrom = windowStart;
    for (const c of comms) {
      const cid = String(c.communityId || c._id);
      try {
        const { joinsByDate, coveredFrom: cf } = await fetchJoins(s, cid, windowStart);
        if (cf > coveredFrom) coveredFrom = cf;
        db.db.prepare('DELETE FROM socialplus_joins WHERE entity_id=? AND community_id=? AND date>=?').run(entityId, cid, cf);
        const ins = db.db.prepare('INSERT INTO socialplus_joins (entity_id, community_id, date, joins) VALUES (?,?,?,?) ON CONFLICT(entity_id, community_id, date) DO UPDATE SET joins=excluded.joins');
        for (const [d, n] of Object.entries(joinsByDate)) {
          if (d >= cf) ins.run(entityId, cid, d, n);
          allJoins[d] = (allJoins[d] || 0) + n;
        }
      } catch { /* joins are an enrichment — a failure never breaks the sync */ }
    }

    // Restate today's totals from the fresh snapshots, then overwrite the
    // members column across the covered window with the reconstructed curve.
    const t = totals(entityId);
    for (const p of buildMembersCurve(t.members, allJoins, coveredFrom, today())) {
      upsertDailyMembers(entityId, p.date, p.members);
    }
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
// 'new_members' reads the reconstructed join dates (zero-filled so quiet days
// show as zero, not as a gap the line glides over).
function series(entityId, { metric = 'members', days = 30 } = {}) {
  const limit = Math.min(Math.max(Number(days) || 30, 1), 365);
  if (metric === 'new_members') {
    const from = addDays(today(), -(limit - 1));
    const byDate = Object.fromEntries(
      db.db.prepare('SELECT date, SUM(joins) AS n FROM socialplus_joins WHERE entity_id=? AND date>=? GROUP BY date').all(entityId, from)
        .map((r) => [r.date, num(r.n) || 0]),
    );
    const dates = Object.keys(byDate).sort();
    if (!dates.length) return [];
    const out = [];
    for (let d = dates[0]; d <= today(); d = addDays(d, 1)) out.push({ date: d, value: byDate[d] || 0 });
    return out;
  }
  const col = ['communities', 'members', 'posts', 'channels', 'chat_members', 'messages', 'comments', 'reactions'].includes(metric) ? metric : 'members';
  const rows = db.db.prepare(`SELECT date, ${col} AS value FROM socialplus_daily WHERE entity_id=? ORDER BY date DESC LIMIT ?`)
    .all(entityId, limit);
  return rows.reverse();
}
function topPosts(entityId, { sort = 'reactions', limit = 10 } = {}) {
  const col = ['reactions', 'comments', 'impressions', 'reach', 'shares'].includes(sort) ? sort : 'reactions';
  return db.db.prepare(`SELECT post_id AS postId, community_id AS communityId, community_name AS communityName, data_type AS dataType, text, reactions, comments, shares, flags, impressions, reach, posted_at AS postedAt
    FROM socialplus_posts WHERE entity_id=? ORDER BY ${col} DESC NULLS LAST LIMIT ?`).all(entityId, Math.min(Number(limit) || 10, 50));
}

// Per-client health summary (admin monitoring + the App page header).
function summary(entityId) {
  const sync = db.db.prepare('SELECT last_status AS lastStatus, last_error AS lastError, last_synced AS lastSynced FROM socialplus_sync WHERE entity_id=?').get(entityId) || {};
  const st = status(entityId);
  return {
    channel: 'socialplus', configured: st.configured, source: st.source, region: st.region,
    communityIds: st.communityIds,
    // On the shared platform key a client only has data once communities are linked.
    assigned: st.source === 'client' || st.communityIds.length > 0,
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
  // Refresh-on-open: any viewer of the page may trigger it (no integrations.manage
  // — it's a read-side top-up, throttled by REFRESH_MAX_AGE_MIN and deduped so
  // simultaneous opens share one sync).
  app.post('/api/admin/entities/:id/socialplus/refresh', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(await syncIfStale(req.params.id));
  }));
  app.post('/api/my/socialplus/:entityId/refresh', auth.requireAuth, asyncHandler(async (req, res) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    if (!database.getEntity(id)) return res.status(404).json({ error: 'Not found' });
    res.json(await syncIfStale(id));
  }));

  // ── community → client linking (the guardrail that makes the shared platform
  // key safe to reuse, mirroring queueit's waiting-room assignment) ──
  // The directory lists EVERYTHING on the resolved key — every community, plus
  // chat channels rolled up into `event_<id>` groups — so an admin can tick what
  // belongs to this client. Live read; nothing is stored.
  async function directory(entityId) {
    const s = await session(entityId);
    const { items: comms } = await pagedList(s, '/api/v3/communities?filter=all', 'communities');
    const { items: chans } = await pagedList(s, '/api/v3/channels?filter=all', 'channels');
    const communities = comms.map((c) => ({
      id: String(c.communityId || c._id), name: c.displayName || '(unnamed)',
      members: num(c.membersCount), posts: num(c.postsCount), createdAt: c.createdAt || '',
    })).sort((a, b) => (b.members || 0) - (a.members || 0));
    // Channels grouped by their `event_<id>` prefix; community feed channels
    // (id === a community id) ride along with the community tick automatically.
    const groups = new Map();
    const commIds = new Set(communities.map((c) => c.id));
    for (const ch of chans) {
      const id = String(ch.channelId || ch._id);
      if (commIds.has(id)) continue;
      const m = id.match(/^(event_\d+)_/);
      const key = m ? m[1] : id;
      const g = groups.get(key) || { id: key, name: '', channels: 0, members: 0, messages: 0 };
      g.channels += 1;
      g.members += num(ch.memberCount) || 0;
      g.messages += num(ch.messageCount) || 0;
      if (!g.name || /announcement|main/i.test(String(ch.displayName))) g.name = String(ch.displayName || key).replace(/\s*[-–—·|]?\s*(announcements?|main chat|main|line-?up.*|faq.*)\s*$/i, '').trim() || key;
      groups.set(key, g);
    }
    const channelGroups = [...groups.values()].sort((a, b) => (b.members || 0) - (a.members || 0));
    return { communities, channelGroups };
  }
  // Directory + assignment are ADMIN-ONLY (no /api/my/ twin, deliberately): the
  // directory lists EVERY organiser's communities, so it must never be readable
  // from the client surface — not even for a client with their own pasted key
  // (which in practice is often just the shared platform key pasted per client).
  app.get('/api/admin/entities/:id/socialplus/directory', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ ...(await directory(req.params.id)), assignedIds: assignedIds(req.params.id), source: connection(req.params.id).source });
  }));
  app.put('/api/admin/entities/:id/socialplus/assign', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!database.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    database.setEntityIntegrations(req.params.id, { socialplusCommunityIds: idList((req.body || {}).ids).join(',') });
    const sync = await syncEntity(req.params.id); // re-scope the data right away
    res.json({ ...status(req.params.id), sync });
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
  idList, assignedIds, scopeFor, communityInScope, channelInScope, buildMembersCurve,
  syncEntity, syncIfStale, totals, communities, channels, series, topPosts, summary, verify,
  startDailySync, stopDailySync,
};
