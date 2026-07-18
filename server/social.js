// ─── Community feed: organiser/event communities + posts (Pulse ⇄ Howler app) ───
// SELF-CONTAINED, DISPOSABLE MODULE — the Phase-1 spike of the "build our own
// social" plan (docs/SOCIAL_PLATFORM_INVESTIGATION.md). Owns the `social_feed_*`
// tables and every route. Mounted from index.js with one line + injected deps
// ({ db, auth, rateLimit }). Wire contract: docs/specs/SOCIAL_CONTRACT.md (v0) —
// the Howler app's prototype repository reads these shapes; keep them in sync.
//
// Model: a COMMUNITY belongs to an organiser (entity) and is one of
//   organiser — the organiser's own community (one per entity is typical)
//   event     — an event community, keyed by the Howler eventId the app knows;
//               nests under an organiser community via parent_id
// Ring-fencing: `visibility` public|members. Members join explicitly from the
// app (POST .../join) or arrive via ticket-holder sync (Phase 1, source='ticket').
// The GLOBAL feed is not a community: a post with `global=1` is syndicated into
// GET /api/app/social/feed for every app user, alongside its home community.
//
// POSTS are organiser-authored (UGC is a later phase): draft → published.
// Media rides the post as an ordered list; bytes live on the persistent disk
// (DATA_DIR/social_media/<id>, like os.js attachments) and are served public +
// immutable from /api/app/social/media/:id. When SOCIAL_S3_* is configured
// (Cloudflare R2 / S3 — same env style as backup.js), POST .../media/presign
// hands the browser/phone a direct-to-bucket presigned PUT instead, so media
// bytes never transit Pulse — that is the production path; disk is the dev path.
//
// Three surfaces (surveys.js precedent):
//   • App-facing /api/app/social/... — public reads (global feed, discovery,
//     public communities, media) stay anonymous + rate-limited; anything
//     identity-bearing (joins, members-only feeds) requires the app's Howler
//     JWT, verified by introspection (see block below). Only PUBLISHED posts
//     ever leave.
//   • Admin /api/admin/entities/:id/social/... — Howler staff manage any client's.
//   • Client self-service /api/my/social/... — entity-scoped via campaign perms
//     (content sits with the campaign team): campaigns.view → read,
//     campaigns.approve → create/publish. Route-gated by flag `community`.
//
// Global kill switch: settings key `social_feed_enabled` ('0' → app routes 404).
// TO REMOVE: delete this file + its mount line + the `community` flag/gate rows,
// drop the social_feed_* tables, delete DATA_DIR/social_media.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError, asyncHandler } = require('./http');
const flags = require('./flags'); // per-client gate: `community` (default OFF, beta)

// ── Howler-JWT verification (contract v1) ────────────────────────────────────
// The app proves who it is with its existing Howler login JWT
// (Authorization: Bearer <token>). Pulse holds no signing secret, so it
// INTROSPECTS instead: asks the Howler GraphQL backend "who is this token?"
// ({ user { id } }) — production first, then staging (same backend list the
// surveys module uses) — and caches the verdict. Anything identity-bearing
// (joins, members-only feeds) runs on the VERIFIED id; a caller-supplied
// howlerUserId is never trusted. Public reads (global feed, discovery,
// public-community feeds, media) stay anonymous by design — they're public
// content and must stay CDN-cacheable.
const HOWLER_GQLS = (process.env.HOWLER_GRAPHQL_URLS
  || 'production=https://api.howlerapp.com/api/v6/graphql,staging=https://www.howlerstaging.co.za/api/v6/graphql')
  .split(',').map((s) => { const [source, ...u] = s.split('='); return { source: source.trim(), url: u.join('=').trim() }; });

async function introspectOnBackend(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: '{ user { id } }' }),
    });
    const gid = ((await r.json()) || {}).data?.user?.id || '';   // "gid://howler/User/661779"
    const id = String(gid).split('/').pop();
    return /^\d+$/.test(id) ? { id } : null;
  } finally { clearTimeout(t); }
}

// token → { user, at } (positive, 10 min) or { neg: true, at } (negative, 60 s).
const TOKEN_CACHE = new Map();
const TOKEN_TTL_POS = 10 * 60_000, TOKEN_TTL_NEG = 60_000, TOKEN_CACHE_MAX = 2000;
async function defaultVerifyAppToken(token) {
  const hit = TOKEN_CACHE.get(token);
  if (hit && Date.now() - hit.at < (hit.neg ? TOKEN_TTL_NEG : TOKEN_TTL_POS)) return hit.neg ? null : hit.user;
  let user = null, failures = 0, lastErr = null;
  for (const { url } of HOWLER_GQLS) {
    try { user = await introspectOnBackend(url, token); if (user) break; }
    catch (e) { failures += 1; lastErr = e; }
  }
  // Every backend unreachable → we cannot KNOW the token is bad; fail closed
  // with a retryable error rather than caching a false negative.
  if (!user && failures >= HOWLER_GQLS.length) throw lastErr || new Error('token introspection failed');
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.delete(TOKEN_CACHE.keys().next().value);
  TOKEN_CACHE.set(token, user ? { user, at: Date.now() } : { neg: true, at: Date.now() });
  return user;
}

const COMMUNITY_TYPES = ['organiser', 'event'];
const VISIBILITIES = ['public', 'members'];
const POST_STATUSES = ['draft', 'published', 'archived'];
const MEDIA_KINDS = ['image', 'video'];
const MAX_BODY = 5000;
const MAX_MEDIA_PER_POST = 10;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // dev disk path; presigned R2 has no Pulse-side cap
const PAGE_MAX = 50;

// S3/R2 config for direct-to-bucket media (production path). Public delivery
// needs SOCIAL_MEDIA_BASE_URL (the bucket's public/CDN base) too.
const S3 = {
  endpoint: (process.env.SOCIAL_S3_ENDPOINT || '').trim().replace(/\/+$/, ''),
  bucket: (process.env.SOCIAL_S3_BUCKET || '').trim(),
  accessKey: (process.env.SOCIAL_S3_ACCESS_KEY || '').trim(),
  secretKey: (process.env.SOCIAL_S3_SECRET_KEY || '').trim(),
  region: (process.env.SOCIAL_S3_REGION || 'auto').trim(),
  publicBase: (process.env.SOCIAL_MEDIA_BASE_URL || '').trim().replace(/\/+$/, ''),
};
const s3Configured = () => !!(S3.endpoint && S3.bucket && S3.accessKey && S3.secretKey && S3.publicBase);

// Presigned PUT (query-param SigV4) — hand-rolled like backup.js, zero deps.
// Exported for tests as _presignPut.
function presignPut({ key, expires = 900, nowDate = new Date() }) {
  const host = S3.endpoint.replace(/^https?:\/\//, '');
  const pathName = `/${S3.bucket}/${key}`;
  const amzDate = nowDate.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${S3.accessKey}/${dateStamp}/${S3.region}/s3/aws4_request`;
  const q = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalQuery = q.map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const canonicalRequest = ['PUT', pathName.split('/').map(enc).join('/'), canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${S3.region}/s3/aws4_request`,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${S3.secretKey}`, dateStamp), S3.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `https://${host}${pathName}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function mount(app, { db, auth, rateLimit, verifyAppToken = defaultVerifyAppToken }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const MEDIA_DIR = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), 'social_media');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  sql.exec(`
    CREATE TABLE IF NOT EXISTS social_feed_communities (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL DEFAULT '',
      parent_id   TEXT NOT NULL DEFAULT '',           -- event community → its organiser community
      type        TEXT NOT NULL DEFAULT 'organiser',  -- organiser | event
      event_id    TEXT NOT NULL DEFAULT '',           -- Howler eventId (type=event)
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      visibility  TEXT NOT NULL DEFAULT 'public',     -- public | members
      status      TEXT NOT NULL DEFAULT 'active',     -- active | archived
      avatar_media_id TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sfc_entity ON social_feed_communities(entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_sfc_event ON social_feed_communities(event_id);

    CREATE TABLE IF NOT EXISTS social_feed_members (
      community_id   TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,                   -- numeric Howler user id, as the app knows it
      source         TEXT NOT NULL DEFAULT 'join',    -- join | ticket
      created_at     TEXT NOT NULL,
      PRIMARY KEY (community_id, howler_user_id)
    );

    CREATE TABLE IF NOT EXISTS social_feed_posts (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      community_id TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      media        TEXT NOT NULL DEFAULT '[]',        -- JSON [{id,kind,url,mime,width,height}]
      link_url     TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'pulse',     -- pulse | instagram | tiktok (import provenance)
      status       TEXT NOT NULL DEFAULT 'draft',     -- draft | published | archived
      global       INTEGER NOT NULL DEFAULT 0,        -- 1 → also syndicated to the app-wide feed
      author_name  TEXT NOT NULL DEFAULT '',
      author_email TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sfp_comm ON social_feed_posts(community_id, status, published_at);
    CREATE INDEX IF NOT EXISTS idx_sfp_global ON social_feed_posts(global, status, published_at);

    -- Metadata for disk-stored media (dev path). Presigned-R2 media has no row;
    -- its public URL lives directly on the post's media JSON.
    CREATE TABLE IF NOT EXISTS social_feed_media (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  const enabled = () => db.getSetting('social_feed_enabled', '1') !== '0'; // global kill switch
  const flagOn = (entityId) => { try { return !!flags.enabled(entityId, 'community'); } catch { return false; } };

  // ── shapers (public wire shapes — SOCIAL_CONTRACT.md) ──
  const mediaList = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } };
  function communityRow(r, { memberCount = null } = {}) {
    const out = {
      id: r.id, entityId: r.entity_id, type: r.type, name: r.name, description: r.description,
      visibility: r.visibility, status: r.status, parentId: r.parent_id || null,
      eventId: r.event_id || null, suiteId: r.suite_id || null, createdAt: r.created_at,
    };
    if (memberCount != null) out.memberCount = memberCount;
    return out;
  }
  function postRow(r, community) {
    return {
      id: r.id, communityId: r.community_id,
      community: community ? { id: community.id, name: community.name, type: community.type } : undefined,
      body: r.body, media: mediaList(r.media), linkUrl: r.link_url || null, source: r.source,
      status: r.status, global: !!r.global,
      author: { name: r.author_name || community?.name || '' },
      createdAt: r.created_at, publishedAt: r.published_at || null,
    };
  }
  const getCommunity = (id) => sql.prepare('SELECT * FROM social_feed_communities WHERE id=?').get(id);
  const memberCount = (id) => sql.prepare('SELECT COUNT(*) n FROM social_feed_members WHERE community_id=?').get(id).n;
  const isMember = (id, howlerUserId) => !!sql.prepare('SELECT 1 FROM social_feed_members WHERE community_id=? AND howler_user_id=?').get(id, String(howlerUserId));

  // Cursor pagination: `before` is the previous page's last publishedAt.
  const pageArgs = (q) => ({
    limit: Math.min(Math.max(Number(q.limit) || 20, 1), PAGE_MAX),
    before: typeof q.before === 'string' ? q.before : '',
  });

  // ── validation ──
  function validCommunityInput(b, { forUpdate = false } = {}) {
    const out = {};
    if (!forUpdate || b.name !== undefined) {
      const name = String(b.name || '').trim().slice(0, 120);
      if (!name) throw new HttpError(400, 'Community name required');
      out.name = name;
    }
    if (b.description !== undefined) out.description = String(b.description || '').slice(0, 1000);
    if (b.type !== undefined || !forUpdate) {
      const type = String(b.type || 'organiser');
      if (!COMMUNITY_TYPES.includes(type)) throw new HttpError(400, `type must be one of ${COMMUNITY_TYPES.join(', ')}`);
      out.type = type;
    }
    if (out.type === 'event' && !forUpdate) {
      const eventId = String(b.eventId || '').trim();
      if (!/^\d+$/.test(eventId)) throw new HttpError(400, 'A numeric Howler eventId is required for an event community');
      out.event_id = eventId;
    }
    if (b.visibility !== undefined || !forUpdate) {
      const vis = String(b.visibility || 'public');
      if (!VISIBILITIES.includes(vis)) throw new HttpError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
      out.visibility = vis;
    }
    if (b.suiteId !== undefined) out.suite_id = String(b.suiteId || '');
    if (b.parentId !== undefined) out.parent_id = String(b.parentId || '');
    return out;
  }
  function validMediaItem(m) {
    const kind = MEDIA_KINDS.includes(m.kind) ? m.kind : 'image';
    const url = String(m.url || '').trim();
    if (!/^https?:\/\//.test(url) && !url.startsWith('/api/app/social/media/')) throw new HttpError(400, 'Each media item needs a served url');
    const out = { id: String(m.id || uuid()), kind, url, mime: String(m.mime || '').slice(0, 100) };
    if (Number(m.width) > 0) out.width = Math.round(Number(m.width));
    if (Number(m.height) > 0) out.height = Math.round(Number(m.height));
    return out;
  }
  function validPostInput(b, entityId, { forUpdate = false } = {}) {
    const out = {};
    if (!forUpdate || b.communityId !== undefined) {
      const c = getCommunity(String(b.communityId || ''));
      if (!c || c.entity_id !== entityId) throw new HttpError(400, 'communityId must be one of this client’s communities');
      out.community_id = c.id;
    }
    if (b.body !== undefined || !forUpdate) out.body = String(b.body || '').slice(0, MAX_BODY);
    if (b.media !== undefined) {
      if (!Array.isArray(b.media) || b.media.length > MAX_MEDIA_PER_POST) throw new HttpError(400, `media must be a list of at most ${MAX_MEDIA_PER_POST}`);
      out.media = JSON.stringify(b.media.map(validMediaItem));
    }
    if (b.linkUrl !== undefined) {
      const u = String(b.linkUrl || '').trim();
      if (u && !/^https?:\/\//.test(u)) throw new HttpError(400, 'linkUrl must be http(s)');
      out.link_url = u;
    }
    if (b.global !== undefined) out.global = b.global ? 1 : 0;
    if (b.source !== undefined && ['pulse', 'instagram', 'tiktok'].includes(b.source)) out.source = b.source;
    return out;
  }

  // ── management core (shared by admin + /api/my) ──
  function listCommunities(entityId) {
    return sql.prepare('SELECT * FROM social_feed_communities WHERE entity_id=? ORDER BY created_at').all(entityId)
      .map((r) => communityRow(r, { memberCount: memberCount(r.id) }));
  }
  function createCommunity(entityId, body, user) {
    const v = validCommunityInput(body);
    if (v.parent_id) {
      const p = getCommunity(v.parent_id);
      if (!p || p.entity_id !== entityId) throw new HttpError(400, 'parentId must be one of this client’s communities');
    }
    const id = `com_${uuid().slice(0, 12)}`;
    sql.prepare(`INSERT INTO social_feed_communities (id, entity_id, suite_id, parent_id, type, event_id, name, description, visibility, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entityId, v.suite_id || '', v.parent_id || '', v.type, v.event_id || '', v.name, v.description || '', v.visibility, user?.email || '', now(), now());
    return communityRow(getCommunity(id), { memberCount: 0 });
  }
  function updateCommunity(entityId, id, body) {
    const c = getCommunity(id);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Community not found');
    const v = validCommunityInput(body, { forUpdate: true });
    if (body.status !== undefined && ['active', 'archived'].includes(body.status)) v.status = body.status;
    delete v.type; delete v.event_id; // identity fields are immutable after creation
    const sets = Object.keys(v).map((k) => `${k}=?`).join(', ');
    if (sets) sql.prepare(`UPDATE social_feed_communities SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(v), now(), id);
    return communityRow(getCommunity(id), { memberCount: memberCount(id) });
  }
  function listPosts(entityId, { status } = {}) {
    const rows = status
      ? sql.prepare('SELECT * FROM social_feed_posts WHERE entity_id=? AND status=? ORDER BY COALESCE(NULLIF(published_at, \'\'), created_at) DESC').all(entityId, status)
      : sql.prepare('SELECT * FROM social_feed_posts WHERE entity_id=? ORDER BY COALESCE(NULLIF(published_at, \'\'), created_at) DESC').all(entityId);
    return rows.map((r) => postRow(r, getCommunity(r.community_id)));
  }
  function createPost(entityId, body, user) {
    const v = validPostInput(body, entityId);
    if (!v.community_id) throw new HttpError(400, 'communityId required');
    const id = `post_${uuid().slice(0, 12)}`;
    const publish = !!body.publish; // create-and-publish in one step (composer's "Publish now")
    sql.prepare(`INSERT INTO social_feed_posts (id, entity_id, community_id, body, media, link_url, source, global, status, published_at, author_name, author_email, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entityId, v.community_id, v.body || '', v.media || '[]', v.link_url || '', v.source || 'pulse', v.global || 0,
        publish ? 'published' : 'draft', publish ? now() : '', String(body.authorName || '').slice(0, 120), user?.email || '', now(), now());
    return postRow(sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id), getCommunity(v.community_id));
  }
  function updatePost(entityId, id, body) {
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    const v = validPostInput(body, entityId, { forUpdate: true });
    if (body.status !== undefined) {
      if (!POST_STATUSES.includes(body.status)) throw new HttpError(400, `status must be one of ${POST_STATUSES.join(', ')}`);
      v.status = body.status;
      if (body.status === 'published' && !p.published_at) v.published_at = now();
    }
    if (body.authorName !== undefined) v.author_name = String(body.authorName || '').slice(0, 120);
    const sets = Object.keys(v).map((k) => `${k}=?`).join(', ');
    if (sets) sql.prepare(`UPDATE social_feed_posts SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(v), now(), id);
    const r = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    return postRow(r, getCommunity(r.community_id));
  }
  function deletePost(entityId, id) {
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    sql.prepare('DELETE FROM social_feed_posts WHERE id=?').run(id);
  }
  // Base64 media → persistent disk (dev path). Returns the served URL.
  function saveMedia(entityId, { name, mime, data }) {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'Empty media payload');
    if (buf.length > MAX_MEDIA_BYTES) throw new HttpError(400, `Media over the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB direct-upload cap — use the presigned upload`);
    const m = String(mime || '');
    if (!/^(image|video)\//.test(m)) throw new HttpError(400, 'Only image/* or video/* media is accepted');
    // The Howler app's renderer can't decode HEIC/HEIF; the composer converts
    // photos to JPEG in the browser — a raw HEIC reaching us means that failed.
    if (/^image\/hei[cf]/.test(m)) throw new HttpError(400, 'iPhone HEIC photos must be converted first — refresh Pulse and re-pick the photo (it converts to JPEG automatically)');
    const id = uuid();
    fs.writeFileSync(path.join(MEDIA_DIR, id), buf);
    sql.prepare('INSERT INTO social_feed_media (id, entity_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, entityId, String(name || 'media').slice(0, 200), m.slice(0, 100), buf.length, now());
    return { id, url: `/api/app/social/media/${id}`, mime: m, size: buf.length, kind: m.startsWith('video/') ? 'video' : 'image' };
  }
  function presignMedia(entityId, { name, mime }) {
    if (!s3Configured()) throw new HttpError(400, 'Direct-to-bucket uploads are not configured (SOCIAL_S3_* + SOCIAL_MEDIA_BASE_URL)');
    const m = String(mime || '');
    if (!/^(image|video)\//.test(m)) throw new HttpError(400, 'Only image/* or video/* media is accepted');
    const ext = (String(name || '').match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase();
    const key = `social/${entityId}/${uuid()}${ext}`;
    return {
      uploadUrl: presignPut({ key }), method: 'PUT', headers: { 'Content-Type': m },
      publicUrl: `${S3.publicBase}/${key}`, kind: m.startsWith('video/') ? 'video' : 'image',
    };
  }

  // ── ADMIN surface ──
  const A = '/api/admin/entities/:entityId/social';
  app.get(`${A}/communities`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ communities: listCommunities(req.params.entityId) })));
  app.post(`${A}/communities`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(createCommunity(req.params.entityId, req.body || {}, req.user))));
  app.put(`${A}/communities/:id`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(updateCommunity(req.params.entityId, req.params.id, req.body || {}))));
  app.get(`${A}/posts`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ posts: listPosts(req.params.entityId, { status: req.query.status }) })));
  app.post(`${A}/posts`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(createPost(req.params.entityId, req.body || {}, req.user))));
  app.put(`${A}/posts/:id`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(updatePost(req.params.entityId, req.params.id, req.body || {}))));
  app.delete(`${A}/posts/:id`, auth.requireAdmin, asyncHandler(async (req, res) => { deletePost(req.params.entityId, req.params.id); res.json({ ok: true }); }));
  app.post(`${A}/media`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(saveMedia(req.params.entityId, req.body || {}))));
  app.post(`${A}/media/presign`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(presignMedia(req.params.entityId, req.body || {}))));

  // ── CLIENT self-service surface (flag-gated at /api/my/social via flags GATES) ──
  const eid = (req) => String(req.query.entityId || (req.body || {}).entityId || '');
  const M = '/api/my/social';
  const view = auth.requirePermission('campaigns.view', eid);
  const manage = auth.requirePermission('campaigns.approve', eid);
  app.get(`${M}/communities`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ communities: listCommunities(eid(req)) })));
  app.post(`${M}/communities`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(createCommunity(eid(req), req.body || {}, req.user))));
  app.put(`${M}/communities/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(updateCommunity(eid(req), req.params.id, req.body || {}))));
  app.get(`${M}/posts`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ posts: listPosts(eid(req), { status: req.query.status }) })));
  app.post(`${M}/posts`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(createPost(eid(req), req.body || {}, req.user))));
  app.put(`${M}/posts/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(updatePost(eid(req), req.params.id, req.body || {}))));
  app.delete(`${M}/posts/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => { deletePost(eid(req), req.params.id); res.json({ ok: true }); }));
  app.post(`${M}/media`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(saveMedia(eid(req), req.body || {}))));
  app.post(`${M}/media/presign`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(presignMedia(eid(req), req.body || {}))));

  // ── PUBLIC app-facing surface ──
  const readLimit = rateLimit({ windowMs: 60_000, max: 120, by: 'ip', scope: 'social_read' });
  const joinLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, by: 'ip', scope: 'social_join' });
  const gone = (res) => res.status(404).json({ error: 'Not available' });

  // Resolve the verified Howler user for a request, or throw. 401 = no/bad
  // token (log in again); 503 = the Howler backend couldn't be reached to
  // verify (retryable — never treated as "invalid token").
  async function requireAppUser(req) {
    const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) throw new HttpError(401, 'Log in to the Howler app to do this');
    let user;
    try { user = await verifyAppToken(m[1]); }
    catch { throw new HttpError(503, 'Couldn’t verify your session right now — try again in a moment'); }
    if (!user) throw new HttpError(401, 'Your session has expired — log in to the Howler app again');
    return user;
  }

  // Published feed for one community (visible only when its entity's flag is on).
  function communityFeed(c, { limit, before }) {
    const rows = before
      ? sql.prepare("SELECT * FROM social_feed_posts WHERE community_id=? AND status='published' AND published_at<? ORDER BY published_at DESC LIMIT ?").all(c.id, before, limit)
      : sql.prepare("SELECT * FROM social_feed_posts WHERE community_id=? AND status='published' ORDER BY published_at DESC LIMIT ?").all(c.id, limit);
    return rows.map((r) => postRow(r, c));
  }

  // The Howler-wide feed: every published post marked global, newest first,
  // regardless of home community — but only from flag-on entities.
  app.get('/api/app/social/feed', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { limit, before } = pageArgs(req.query);
    const rows = before
      ? sql.prepare("SELECT * FROM social_feed_posts WHERE global=1 AND status='published' AND published_at<? ORDER BY published_at DESC LIMIT ?").all(before, limit)
      : sql.prepare("SELECT * FROM social_feed_posts WHERE global=1 AND status='published' ORDER BY published_at DESC LIMIT ?").all(limit);
    const posts = rows.filter((r) => flagOn(r.entity_id)).map((r) => postRow(r, getCommunity(r.community_id)));
    res.json({ contractVersion: 1, posts, nextCursor: rows.length === limit ? rows[rows.length - 1].published_at : null });
  }));

  // Community discovery — by Howler eventId, or the active set for an entity.
  app.get('/api/app/social/communities', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const eventId = String(req.query.eventId || '').trim();
    const entityId = String(req.query.entityId || '').trim();
    let rows = [];
    if (eventId) rows = sql.prepare("SELECT * FROM social_feed_communities WHERE event_id=? AND status='active'").all(eventId);
    else if (entityId) rows = sql.prepare("SELECT * FROM social_feed_communities WHERE entity_id=? AND status='active'").all(entityId);
    else throw new HttpError(400, 'eventId or entityId required');
    rows = rows.filter((r) => flagOn(r.entity_id));
    res.json({ contractVersion: 1, communities: rows.map((r) => communityRow(r, { memberCount: memberCount(r.id) })) });
  }));

  // One community's feed. `members` visibility requires a VERIFIED member —
  // the caller's Howler JWT is introspected; a howlerUserId param is ignored.
  app.get('/api/app/social/communities/:id/feed', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const c = getCommunity(req.params.id);
    if (!c || c.status !== 'active' || !flagOn(c.entity_id)) return gone(res);
    if (c.visibility === 'members') {
      const user = await requireAppUser(req);
      if (!isMember(c.id, user.id)) throw new HttpError(403, 'Join this community to see its feed');
    }
    const page = pageArgs(req.query);
    const posts = communityFeed(c, page);
    res.json({ contractVersion: 1, community: communityRow(c, { memberCount: memberCount(c.id) }), posts, nextCursor: posts.length === page.limit ? posts[posts.length - 1].publishedAt : null });
  }));

  // Explicit join / leave from the app — identity comes from the verified JWT.
  app.post('/api/app/social/communities/:id/join', joinLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const c = getCommunity(req.params.id);
    if (!c || c.status !== 'active' || !flagOn(c.entity_id)) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare("INSERT OR IGNORE INTO social_feed_members (community_id, howler_user_id, source, created_at) VALUES (?,?,'join',?)")
      .run(c.id, user.id, now());
    res.json({ ok: true, memberCount: memberCount(c.id) });
  }));
  app.post('/api/app/social/communities/:id/leave', joinLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare('DELETE FROM social_feed_members WHERE community_id=? AND howler_user_id=?').run(req.params.id, user.id);
    res.json({ ok: true });
  }));

  // Serve disk-stored media — public, immutable (ids are unguessable UUIDs).
  app.get('/api/app/social/media/:id', asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const m = sql.prepare('SELECT * FROM social_feed_media WHERE id=?').get(String(req.params.id));
    const file = m && path.join(MEDIA_DIR, m.id);
    if (!m || !fs.existsSync(file)) return gone(res);
    res.set('Content-Type', m.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(fs.readFileSync(file));
  }));

  return { listCommunities, createCommunity, createPost, updatePost, saveMedia };
}

module.exports = { mount, _presignPut: presignPut, _verifyAppToken: defaultVerifyAppToken };
