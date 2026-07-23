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
const { HttpError, asyncHandler, jsonWithEtag } = require('./http');
const flags = require('./flags'); // per-client gate: `community` (default OFF, beta)
const appAuth = require('./appAuth'); // shared Howler-JWT introspection (see server/appAuth.js)
const moderation = require('./moderation'); // phase-1 rule engine on every fan write (docs/specs/MODERATION_CONTRACT.md)

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

function mount(app, { db, auth, rateLimit, verifyAppToken = appAuth.defaultVerifyAppToken, fetchAppTickets = appAuth.defaultFetchAppTickets }) {
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

    -- Likes: one row per (post, verified Howler user). Counts ride every post
    -- shape; per-user state (hasReacted) only when a verified JWT is presented.
    CREATE TABLE IF NOT EXISTS social_feed_reactions (
      post_id        TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (post_id, howler_user_id)
    );

    -- Comments: the first UGC. Author identity is the VERIFIED Howler user;
    -- author_name is captured at write time (verified name, else app-supplied,
    -- else "Howler fan"). Moderation: author can delete own; organiser/admin
    -- delete any from the composer; any verified user can report.
    CREATE TABLE IF NOT EXISTS social_feed_comments (
      id             TEXT PRIMARY KEY,
      post_id        TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      author_name    TEXT NOT NULL DEFAULT '',
      body           TEXT NOT NULL,
      reported       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sfcm_post ON social_feed_comments(post_id, created_at);

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

  // Columns added after first deploy — ALTER for existing DBs.
  try {
    const cols = sql.prepare('PRAGMA table_info(social_feed_posts)').all().map((c) => c.name);
    if (!cols.includes('cta_label')) sql.exec("ALTER TABLE social_feed_posts ADD COLUMN cta_label TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('cta_style')) sql.exec("ALTER TABLE social_feed_posts ADD COLUMN cta_style TEXT NOT NULL DEFAULT 'primary'"); // primary banner | secondary floating pill
    if (!cols.includes('cta_destination')) sql.exec("ALTER TABLE social_feed_posts ADD COLUMN cta_destination TEXT NOT NULL DEFAULT ''");
    // Per-community comment settings: images + links in fan comments (both
    // default OFF — the organiser opts in per community).
    const ccols = sql.prepare('PRAGMA table_info(social_feed_communities)').all().map((c) => c.name);
    if (!ccols.includes('allow_comment_images')) sql.exec('ALTER TABLE social_feed_communities ADD COLUMN allow_comment_images INTEGER NOT NULL DEFAULT 0');
    if (!ccols.includes('allow_comment_links')) sql.exec('ALTER TABLE social_feed_communities ADD COLUMN allow_comment_links INTEGER NOT NULL DEFAULT 0');
    if (!ccols.includes('avatar_url')) sql.exec("ALTER TABLE social_feed_communities ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
    // Comment threading (organiser replies) + media + author kind.
    const mcols = sql.prepare('PRAGMA table_info(social_feed_comments)').all().map((c) => c.name);
    if (!mcols.includes('parent_id')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''");
    if (!mcols.includes('author_type')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'fan'");
    if (!mcols.includes('media')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN media TEXT NOT NULL DEFAULT '[]'");
    // Organiser replies can carry a CTA button (same vocabulary as post CTAs:
    // native screen keyword or open_url:https://…).
    if (!mcols.includes('cta_label')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN cta_label TEXT NOT NULL DEFAULT ''");
    if (!mcols.includes('cta_destination')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN cta_destination TEXT NOT NULL DEFAULT ''");
    // Organiser pin: pinned posts surface at the top of the feed for everyone.
    if (!cols.includes('pinned')) sql.exec('ALTER TABLE social_feed_posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    // Targeting: '' = everyone; else JSON {type:'holders'} (any ticket for the
    // community's event) or {type:'ticketTypes', ticketTypes:[names]}.
    if (!cols.includes('audience')) sql.exec("ALTER TABLE social_feed_posts ADD COLUMN audience TEXT NOT NULL DEFAULT ''");
    // Event → organiser roll-up: per-post opt-in, same mechanic as `global`.
    if (!cols.includes('to_parent')) sql.exec('ALTER TABLE social_feed_posts ADD COLUMN to_parent INTEGER NOT NULL DEFAULT 0');
    // Moderation content states (MODERATION_CONTRACT.md §5): visible | held
    // (author-only until reviewed) | removed (moderator-declined stub).
    if (!cols.includes('moderation_status')) sql.exec("ALTER TABLE social_feed_posts ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'visible'");
    if (!mcols.includes('moderation_status')) sql.exec("ALTER TABLE social_feed_comments ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'visible'");
  } catch (e) { console.error('[social] column migrations skipped:', e.message); }

  // Personal pins: a fan bookmarks a post for THEMSELVES (visible only to them,
  // returned as pinnedByMe + in the feed's myPins strip). Distinct from the
  // organiser's global `pinned` flag on the post row.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS social_feed_user_pins (
      post_id        TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (post_id, howler_user_id)
    );

    -- Story-rail "seen" marks: when a viewer last opened a community's feed.
    -- Drives the unseen ring on the rail (lastPostAt > last_seen_at).
    CREATE TABLE IF NOT EXISTS social_feed_seen (
      community_id   TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      PRIMARY KEY (community_id, howler_user_id)
    );

    -- App posters: Howler app accounts authorised to publish posts for this
    -- client STRAIGHT FROM THE APP (no Pulse login). Managed from both Pulse
    -- surfaces; the app endpoint checks the verified JWT identity against
    -- this list. name '' = post in the brand's voice (community name shows).
    CREATE TABLE IF NOT EXISTS social_feed_posters (
      entity_id      TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      name           TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      PRIMARY KEY (entity_id, howler_user_id)
    );

    -- Share-link attribution: every /p/:id hit, tagged with WHO shared it
    -- (?s=<howlerUserId> appended by the app). Surfaces the organic promoters
    -- driving virality. device 'preview-bot' = link-unfurl crawlers
    -- (WhatsApp/Slack/…) fetching the OG preview, excluded from click counts.
    CREATE TABLE IF NOT EXISTS social_feed_share_clicks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      sharer_howler_user_id TEXT NOT NULL DEFAULT '',
      device     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sfsc_entity ON social_feed_share_clicks(entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sfsc_post ON social_feed_share_clicks(post_id);

  `);

  const enabled = () => db.getSetting('social_feed_enabled', '1') !== '0'; // global kill switch
  const flagOn = (entityId) => { try { return !!flags.enabled(entityId, 'community'); } catch { return false; } };

  // ── shapers (public wire shapes — SOCIAL_CONTRACT.md) ──
  const mediaList = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } };
  // Default community image = the organiser's (entity's) logo when the
  // community has no image of its own. Only URL logos are used (a data-URI
  // logo would bloat feeds + can't be an OG preview image).
  const entityLogo = (entityId) => {
    try {
      const l = (db.getEntity && db.getEntity(entityId)?.logo) || '';
      return /^(https?:\/\/|\/)/.test(l) ? l : '';
    } catch { return ''; }
  };
  const communityAvatar = (r) => (r && (r.avatar_url || entityLogo(r.entity_id))) || '';
  // The client's (and event's) Pulse branding colours, layered platform ←
  // client ← event(suite) via the mailer resolver. Feeds/chat/share links tint
  // their accents with these so a post looks like the organiser's own brand.
  const communityBrand = (r) => {
    try {
      const b = require('./mailer').resolveBranding(r.entity_id, r.suite_id || undefined);
      return { brandColor: b.brandColor || '', secondaryColor: b.secondaryColor || '' };
    } catch { return { brandColor: '', secondaryColor: '' }; }
  };

  function communityRow(r, { memberCount = null, canPost = null } = {}) {
    const brand = communityBrand(r);
    const out = {
      id: r.id, entityId: r.entity_id, type: r.type, name: r.name, description: r.description,
      visibility: r.visibility, status: r.status, parentId: r.parent_id || null,
      eventId: r.event_id || null, suiteId: r.suite_id || null,
      allowCommentImages: !!r.allow_comment_images, allowCommentLinks: !!r.allow_comment_links,
      avatarUrl: communityAvatar(r) || null,
      brandColor: brand.brandColor || null, secondaryColor: brand.secondaryColor || null,
      createdAt: r.created_at,
    };
    if (memberCount != null) out.memberCount = memberCount;
    if (canPost != null) out.canPost = canPost; // viewer is an authorised app poster
    return out;
  }
  const reactionCount = (postId) => sql.prepare('SELECT COUNT(*) n FROM social_feed_reactions WHERE post_id=?').get(postId).n;
  const commentCount = (postId) => sql.prepare("SELECT COUNT(*) n FROM social_feed_comments WHERE post_id=? AND moderation_status='visible'").get(postId).n;
  // Feed hot path: ONE query per page per signal instead of four per POST.
  // postRow uses this when passed as `state`; management paths keep the
  // simple per-row helpers above (a handful of rows, not a request storm).
  function batchPostState(rows, viewerId) {
    const state = { reactions: {}, comments: {}, mine: new Set(), pins: new Set() };
    const ids = [...new Set(rows.map((r) => r.id))];
    if (!ids.length) return state;
    const ph = ids.map(() => '?').join(',');
    for (const r of sql.prepare(`SELECT post_id, COUNT(*) n FROM social_feed_reactions WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids)) state.reactions[r.post_id] = r.n;
    for (const r of sql.prepare(`SELECT post_id, COUNT(*) n FROM social_feed_comments WHERE moderation_status='visible' AND post_id IN (${ph}) GROUP BY post_id`).all(...ids)) state.comments[r.post_id] = r.n;
    if (viewerId) {
      for (const r of sql.prepare(`SELECT post_id FROM social_feed_reactions WHERE howler_user_id=? AND post_id IN (${ph})`).all(String(viewerId), ...ids)) state.mine.add(r.post_id);
      for (const r of sql.prepare(`SELECT post_id FROM social_feed_user_pins WHERE howler_user_id=? AND post_id IN (${ph})`).all(String(viewerId), ...ids)) state.pins.add(r.post_id);
    }
    return state;
  }
  function commentRow(r, { viewerId = null } = {}) {
    // Moderation states ride the shape when set; a removed comment collapses
    // to a stub ("Removed by moderators" in the app) — the author-only read
    // filtering happened in the query, so any removed row here is the author's.
    const mod = r.moderation_status && r.moderation_status !== 'visible' ? { moderation: { status: r.moderation_status } } : {};
    if (r.moderation_status === 'removed') {
      return { id: r.id, postId: r.post_id, parentCommentId: r.parent_id || null, authorType: r.author_type || 'fan', ...mod, createdAt: r.created_at };
    }
    return {
      id: r.id, postId: r.post_id, parentCommentId: r.parent_id || null,
      authorType: r.author_type || 'fan',
      author: { id: r.howler_user_id, name: r.author_name || 'Howler fan' },
      text: r.body, media: mediaList(r.media), reported: !!r.reported,
      ctaLabel: r.cta_label || null, ctaDestination: r.cta_destination || null,
      ...(viewerId ? { isOwner: r.author_type !== 'organiser' && r.howler_user_id === String(viewerId) } : {}),
      ...mod,
      createdAt: r.created_at,
    };
  }
  // Top-level comments with organiser/fan replies nested one level deep.
  function nestComments(rows, { viewerId = null } = {}) {
    const byParent = {};
    for (const r of rows.filter((r) => r.parent_id)) (byParent[r.parent_id] = byParent[r.parent_id] || []).push(r);
    return rows.filter((r) => !r.parent_id).map((r) => ({
      ...commentRow(r, { viewerId }),
      replies: (byParent[r.id] || []).map((x) => commentRow(x, { viewerId })),
    }));
  }
  const URL_RE = /(https?:\/\/|www\.)\S+/i;
  // ── targeting (ticket types) ──
  const audienceOf = (r) => { try { return r.audience ? JSON.parse(r.audience) : null; } catch { return null; } };
  const tokenOf = (req) => (String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  // Is this post visible to a viewer holding `tickets`? Untargeted → always.
  // Targeted → needs the community's event + a matching (non-expired) ticket;
  // tickets===null (anonymous, or holdings unknown) fails CLOSED.
  function postVisible(r, community, tickets) {
    const a = audienceOf(r);
    if (!a) return true;
    if (!community?.event_id || !Array.isArray(tickets)) return false;
    const mine = tickets.filter((t) => t.eventId === String(community.event_id));
    if (a.type === 'holders') return mine.length > 0;
    if (a.type === 'ticketTypes') {
      const wanted = new Set((a.ticketTypes || []).map((s) => String(s).trim().toLowerCase()));
      return mine.some((t) => wanted.has(String(t.name || '').trim().toLowerCase()));
    }
    return false;
  }
  // Fetch the viewer's tickets only when the row set actually needs them.
  async function ticketsIfNeeded(rows, req, viewer) {
    if (!viewer || !rows.some((r) => r.audience)) return null;
    try { return await fetchAppTickets(tokenOf(req)); } catch { return null; }
  }

  // ── the Howler house + follow/ticket gating on the global feed ──
  // The GLOBAL feed is personalised: posts from the designated HOUSE entity
  // (Howler's own voice) reach EVERYONE; any other organiser's global post
  // only reaches viewers CONNECTED to that organiser — they joined any of its
  // communities ("follow") or hold a ticket to any of its events. Anonymous
  // readers see house posts only.
  const houseEntity = () => String(db.getSetting ? db.getSetting('social_house_entity', '') : '').trim();
  function entityConnected(entityId, viewerId, tickets) {
    if (sql.prepare('SELECT 1 FROM social_feed_members m JOIN social_feed_communities c ON c.id=m.community_id WHERE c.entity_id=? AND m.howler_user_id=? LIMIT 1').get(entityId, String(viewerId))) return true;
    const held = new Set((tickets || []).map((t) => String(t.eventId)));
    if (!held.size) return false;
    return sql.prepare("SELECT DISTINCT event_id FROM social_feed_communities WHERE entity_id=? AND event_id!=''").all(entityId)
      .some((r) => held.has(String(r.event_id)));
  }
  // entity ids from `rows` the viewer may see on the GLOBAL feed.
  async function allowedGlobalEntities(rows, req, viewer) {
    const house = houseEntity();
    const allowed = new Set(house ? [house] : []);
    if (!house) return null; // no house configured → legacy behaviour (everyone sees all)
    if (!viewer) return allowed;
    const others = [...new Set(rows.map((r) => r.entity_id))].filter((id) => id !== house);
    if (!others.length) return allowed;
    let tickets = null;
    try { tickets = await fetchAppTickets(tokenOf(req)); } catch { /* membership can still connect */ }
    for (const id of others) if (entityConnected(id, viewer.id, tickets)) allowed.add(id);
    return allowed;
  }
  const hasReacted = (postId, howlerUserId) => !!sql.prepare('SELECT 1 FROM social_feed_reactions WHERE post_id=? AND howler_user_id=?').get(postId, String(howlerUserId));
  const hasPinned = (postId, howlerUserId) => !!sql.prepare('SELECT 1 FROM social_feed_user_pins WHERE post_id=? AND howler_user_id=?').get(postId, String(howlerUserId));
  // viewerId: the VERIFIED app user (or null) — adds per-user hasReacted state.
  function postRow(r, community, { viewerId = null, state = null } = {}) {
    return {
      id: r.id, communityId: r.community_id,
      community: community ? { id: community.id, name: community.name, type: community.type, avatarUrl: communityAvatar(community) || null, ...(() => { const br = communityBrand(community); return { brandColor: br.brandColor || null, secondaryColor: br.secondaryColor || null }; })() } : undefined,
      body: r.body, media: mediaList(r.media), linkUrl: r.link_url || null, source: r.source,
      status: r.status, global: !!r.global, pinned: !!r.pinned,
      toParent: !!r.to_parent,
      audience: audienceOf(r),
      author: { name: r.author_name || community?.name || '' },
      reactionCount: state ? (state.reactions[r.id] || 0) : reactionCount(r.id),
      commentCount: state ? (state.comments[r.id] || 0) : commentCount(r.id),
      // canEdit: the viewer authored this post from the app — unlocks the
      // app's own edit/delete affordance (server-enforced on the endpoints).
      ...(viewerId ? {
        hasReacted: state ? state.mine.has(r.id) : hasReacted(r.id, viewerId),
        pinnedByMe: state ? state.pins.has(r.id) : hasPinned(r.id, viewerId),
        canEdit: r.author_email === `app:${viewerId}`,
      } : {}),
      // Held/removed states (author-only rows — the read filters did the gating).
      ...(r.moderation_status && r.moderation_status !== 'visible' ? { moderation: { status: r.moderation_status } } : {}),
      // CTA button (app renders it via its existing PostCtaResolver vocabulary,
      // e.g. "explore_tickets:19203" or "open_url:https://…"). Style:
      // primary = full-width banner under the media; secondary = a compact
      // glowing icon pill floating on the image (busy feeds stay calm).
      ctaLabel: r.cta_label || null, ctaDestination: r.cta_destination || null,
      ctaStyle: r.cta_label ? (r.cta_style === 'secondary' ? 'secondary' : 'primary') : null,
      eventId: community?.event_id || null,
      createdAt: r.created_at, publishedAt: r.published_at || null,
    };
  }
  const posterRow = (entityId, howlerUserId) => sql.prepare('SELECT * FROM social_feed_posters WHERE entity_id=? AND howler_user_id=?').get(entityId, String(howlerUserId));
  const getCommunity = (id) => sql.prepare('SELECT * FROM social_feed_communities WHERE id=?').get(id);
  const memberCount = (id) => sql.prepare('SELECT COUNT(*) n FROM social_feed_members WHERE community_id=?').get(id).n;
  const isMember = (id, howlerUserId) => !!sql.prepare('SELECT 1 FROM social_feed_members WHERE community_id=? AND howler_user_id=?').get(id, String(howlerUserId));

  // ── moderation read filters (MODERATION_CONTRACT.md §5) ──
  // Everyone sees 'visible'; held/removed rows return ONLY to their author
  // (with a moderation:{status} object on the shape). App-authored posts carry
  // their author as author_email 'app:<howlerUserId>'; comments carry
  // howler_user_id directly. `a` prefixes an alias for joined queries.
  const postMod = (a = '') => `(${a}moderation_status='visible' OR (${a}moderation_status IN ('held','removed') AND ${a}author_email=?))`;
  const asPostAuthor = (viewerId) => `app:${viewerId || '-'}`;
  const cmtMod = "(moderation_status='visible' OR (moderation_status IN ('held','removed') AND howler_user_id=?))";

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
    if (b.allowCommentImages !== undefined) out.allow_comment_images = b.allowCommentImages ? 1 : 0;
    if (b.allowCommentLinks !== undefined) out.allow_comment_links = b.allowCommentLinks ? 1 : 0;
    if (b.avatarUrl !== undefined) out.avatar_url = String(b.avatarUrl || '').slice(0, 500);
    return out;
  }
  function validMediaItem(m) {
    const kind = MEDIA_KINDS.includes(m.kind) ? m.kind : 'image';
    const url = String(m.url || '').trim();
    if (!/^https?:\/\//.test(url) && !url.startsWith('/api/app/social/media/')) throw new HttpError(400, 'Each media item needs a served url');
    const out = { id: String(m.id || uuid()), kind, url, mime: String(m.mime || '').slice(0, 100) };
    if (Number(m.width) > 0) out.width = Math.round(Number(m.width));
    if (Number(m.height) > 0) out.height = Math.round(Number(m.height));
    // Poster/thumbnail image for a VIDEO (captured client-side at upload) —
    // feed cards show it instantly instead of a black box while (or if ever)
    // the video loads.
    const poster = String(m.posterUrl || '').trim();
    if (poster && (/^https?:\/\//.test(poster) || poster.startsWith('/api/app/social/media/'))) out.posterUrl = poster;
    // Reframe focus (composer drag, IG-style): which part of the image
    // survives when a feed card must crop. -1..1 per axis, 0 = centre.
    const fx = Number(m.focusX), fy = Number(m.focusY);
    if (Number.isFinite(fx) && fx !== 0) out.focusX = Math.max(-1, Math.min(1, fx));
    if (Number.isFinite(fy) && fy !== 0) out.focusY = Math.max(-1, Math.min(1, fy));
    return out;
  }
  function validPostInput(b, entityId, { forUpdate = false } = {}) {
    const out = {};
    let community = null;
    if (!forUpdate || b.communityId !== undefined) {
      const c = getCommunity(String(b.communityId || ''));
      if (!c || c.entity_id !== entityId) throw new HttpError(400, 'communityId must be one of this client’s communities');
      out.community_id = c.id;
      community = c;
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
    // Event → organiser roll-up: only meaningful for a nested event community.
    if (b.toParent !== undefined) out.to_parent = (b.toParent && community?.parent_id) ? 1 : 0;
    // Targeting: holders / specific ticket types (event communities only).
    // A targeted post can never ride the Howler-wide feed.
    if (b.audience !== undefined) {
      const a = b.audience || {};
      const type = String(a.type || 'everyone');
      if (type === 'everyone' || !type) out.audience = '';
      else if (type === 'holders') out.audience = JSON.stringify({ type: 'holders' });
      else if (type === 'ticketTypes') {
        const names = (Array.isArray(a.ticketTypes) ? a.ticketTypes : [])
          .map((s) => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 30);
        if (!names.length) throw new HttpError(400, 'Pick at least one ticket type to target');
        out.audience = JSON.stringify({ type: 'ticketTypes', ticketTypes: names });
      } else throw new HttpError(400, 'audience.type must be everyone, holders or ticketTypes');
      if (out.audience) {
        if (community && !community.event_id) throw new HttpError(400, 'Ticket targeting only works on an event community');
        out.global = 0;
      }
    }
    if (b.source !== undefined && ['pulse', 'instagram', 'tiktok', 'app'].includes(b.source)) out.source = b.source;
    if (b.ctaLabel !== undefined || b.ctaDestination !== undefined) {
      const ctaLabel = String(b.ctaLabel || '').trim().slice(0, 40);
      const dest = String(b.ctaDestination || '').trim().slice(0, 500);
      if (ctaLabel && !dest) throw new HttpError(400, 'A button needs a destination');
      if (dest && !/^(open_url:https?:\/\/.+|[a-z][a-z0-9_]*(:\d+)?)$/.test(dest)) {
        throw new HttpError(400, 'Button destination must be a known screen keyword (e.g. explore_tickets:19203) or open_url:https://…');
      }
      out.cta_label = ctaLabel;
      out.cta_destination = ctaLabel ? dest : '';
      out.cta_style = b.ctaStyle === 'secondary' ? 'secondary' : 'primary';
    }
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
    const stats = postStats(entityId);
    return rows.map((r) => ({
      ...postRow(r, getCommunity(r.community_id)),
      stats: stats[r.id] || { delivered: 0, reach: 0, seen: 0, views: 0 },
    }));
  }
  function createPost(entityId, body, user) {
    const v = validPostInput(body, entityId);
    if (!v.community_id) throw new HttpError(400, 'communityId required');
    const id = `post_${uuid().slice(0, 12)}`;
    const publish = !!body.publish; // create-and-publish in one step (composer's "Publish now")
    // Only the app write path ever passes 'held' (rule-engine hold) — anything
    // else collapses to 'visible', so organiser callers are untouched.
    const modStatus = body.moderationStatus === 'held' ? 'held' : 'visible';
    sql.prepare(`INSERT INTO social_feed_posts (id, entity_id, community_id, body, media, link_url, source, global, to_parent, status, published_at, cta_label, cta_destination, cta_style, audience, author_name, author_email, moderation_status, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entityId, v.community_id, v.body || '', v.media || '[]', v.link_url || '', v.source || 'pulse', v.global || 0, v.to_parent || 0,
        publish ? 'published' : 'draft', publish ? now() : '', v.cta_label || '', v.cta_destination || '', v.cta_style || 'primary', v.audience || '',
        String(body.authorName || '').slice(0, 120), user?.email || '', modStatus, now(), now());
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
  // App posters — who may publish for this client straight from the app.
  function listPosters(entityId) {
    return sql.prepare('SELECT * FROM social_feed_posters WHERE entity_id=? ORDER BY created_at').all(entityId)
      .map((r) => ({ howlerUserId: r.howler_user_id, name: r.name, createdAt: r.created_at }));
  }
  function addPoster(entityId, body) {
    const uid = String((body || {}).howlerUserId || '').trim();
    if (!/^\d+$/.test(uid)) throw new HttpError(400, 'A numeric Howler user id is required');
    sql.prepare('INSERT OR REPLACE INTO social_feed_posters (entity_id, howler_user_id, name, created_at) VALUES (?,?,?,?)')
      .run(entityId, uid, String((body || {}).name || '').trim().slice(0, 80), now());
    return { posters: listPosters(entityId) };
  }
  function removePoster(entityId, howlerUserId) {
    sql.prepare('DELETE FROM social_feed_posters WHERE entity_id=? AND howler_user_id=?').run(entityId, String(howlerUserId));
    return { posters: listPosters(entityId) };
  }
  // Best-known display name for an app user id (posters registry, then chat,
  // then comments). '' when the id has never carried a name.
  function appUserName(id) {
    const q = (t, col) => { try { const r = sql.prepare(`SELECT ${col} n FROM ${t} WHERE howler_user_id=? AND ${col}!='' ORDER BY created_at DESC LIMIT 1`).get(String(id)); return (r && r.n) || null; } catch { return null; } };
    return q('social_feed_posters', 'name') || q('social_chat_messages', 'author_name') || q('social_feed_comments', 'author_name') || '';
  }

  // Share-link attribution rollup: who's driving clicks (organic promoters)
  // and which posts travel. Human clicks only; unfurl-bot fetches reported
  // separately (they indicate REACH — every WhatsApp recipient's preview).
  function shareStats(entityId) {
    const rows = sql.prepare('SELECT sharer_howler_user_id sharer, device, post_id, COUNT(*) n, MAX(created_at) last FROM social_feed_share_clicks WHERE entity_id=? GROUP BY sharer, device, post_id').all(entityId);
    const sharers = new Map(); const posts = new Map();
    let clicks = 0; let previews = 0;
    for (const r of rows) {
      if (r.device === 'preview-bot') { previews += r.n; continue; }
      clicks += r.n;
      posts.set(r.post_id, (posts.get(r.post_id) || 0) + r.n);
      if (r.sharer) {
        const s = sharers.get(r.sharer) || { howlerUserId: r.sharer, clicks: 0, lastAt: '' };
        s.clicks += r.n;
        if (r.last > s.lastAt) s.lastAt = r.last;
        sharers.set(r.sharer, s);
      }
    }
    return {
      totalClicks: clicks,
      previewFetches: previews,
      sharers: [...sharers.values()].sort((a, b) => b.clicks - a.clicks).slice(0, 20)
        .map((s) => ({ ...s, name: appUserName(s.howlerUserId) })),
      posts: [...posts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([id, n]) => ({ postId: id, clicks: n, body: String(sql.prepare('SELECT body FROM social_feed_posts WHERE id=?').get(id)?.body || '').slice(0, 80) })),
    };
  }

  // Recently ACTIVE app users (id + best-known name) so an admin can pick a
  // poster without hunting user ids in Active Admin. Sources: chat messages &
  // members, feed comments and community joins already store howler_user_id.
  // scopeEntityId limits to one client's activity (the /my self-service
  // surface must not see other clients' users); admins see platform-wide.
  function posterSuggestions(scopeEntityId = null) {
    const hasTable = (t) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const a = scopeEntityId ? [scopeEntityId] : [];
    const parts = [];
    // Feed sources always exist (owned by this module).
    parts.push(`SELECT howler_user_id, author_name name, created_at at FROM social_feed_comments ${scopeEntityId ? 'WHERE entity_id=?' : ''}`);
    parts.push(`SELECT m.howler_user_id, '' name, m.created_at at FROM social_feed_members m
      JOIN social_feed_communities c ON c.id=m.community_id ${scopeEntityId ? 'WHERE c.entity_id=?' : ''}`);
    // Chat sources exist only once server/chat.js has mounted.
    if (hasTable('social_chat_messages')) parts.push(`SELECT howler_user_id, author_name name, created_at at FROM social_chat_messages ${scopeEntityId ? 'WHERE entity_id=?' : ''}`);
    if (hasTable('social_chat_members') && hasTable('social_chat_channels')) parts.push(`SELECT m.howler_user_id, m.member_name name, m.created_at at FROM social_chat_members m
      JOIN social_chat_channels c ON c.id=m.channel_id ${scopeEntityId ? 'WHERE c.entity_id=?' : ''}`);
    const rows = sql.prepare(`
      SELECT howler_user_id id, MAX(name) name, MAX(at) lastSeenAt FROM (${parts.join(' UNION ALL ')})
      GROUP BY howler_user_id ORDER BY lastSeenAt DESC LIMIT 25`)
      .all(...Array(parts.length).fill(a).flat());
    return rows.map((r) => ({ howlerUserId: String(r.id), name: r.name || '', lastSeenAt: r.lastSeenAt }));
  }

  // Organiser pin/unpin: floats the post to the top of its feeds for everyone.
  function pinPost(entityId, id, pinned) {
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    sql.prepare('UPDATE social_feed_posts SET pinned=?, updated_at=? WHERE id=?').run(pinned ? 1 : 0, now(), id);
    const r = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    return postRow(r, getCommunity(r.community_id));
  }
  function deletePost(entityId, id) {
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(id);
    if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    sql.prepare('DELETE FROM social_feed_posts WHERE id=?').run(id);
    sql.prepare('DELETE FROM social_feed_reactions WHERE post_id=?').run(id);
    sql.prepare('DELETE FROM social_feed_comments WHERE post_id=?').run(id);
    sql.prepare('DELETE FROM social_feed_user_pins WHERE post_id=?').run(id);
  }
  // Hard delete: the community, its posts (with their comments/likes/pins),
  // memberships and seen marks. Organiser communities must shed their event
  // children first — a guard against wiping a whole brand tree in one tap.
  function deleteCommunity(entityId, id) {
    const c = getCommunity(id);
    if (!c || c.entity_id !== entityId) throw new HttpError(404, 'Community not found');
    const kids = sql.prepare('SELECT COUNT(*) n FROM social_feed_communities WHERE parent_id=?').get(id).n;
    if (kids) throw new HttpError(400, 'This community still has event communities nested under it — delete those first');
    for (const p of sql.prepare('SELECT id FROM social_feed_posts WHERE community_id=?').all(id)) deletePost(entityId, p.id);
    sql.prepare('DELETE FROM social_feed_members WHERE community_id=?').run(id);
    sql.prepare('DELETE FROM social_feed_seen WHERE community_id=?').run(id);
    sql.prepare('DELETE FROM social_feed_communities WHERE id=?').run(id);
  }
  // Moderation (organiser/admin): list a post's comments incl. reported flags;
  // delete any comment. Exposed on both management surfaces.
  function listComments(entityId, postId) {
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(postId);
    if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    return sql.prepare('SELECT * FROM social_feed_comments WHERE post_id=? ORDER BY created_at DESC').all(postId).map((r) => commentRow(r));
  }
  function moderateDeleteComment(entityId, commentId) {
    const r = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(commentId);
    if (!r || r.entity_id !== entityId) throw new HttpError(404, 'Comment not found');
    sql.prepare('DELETE FROM social_feed_comments WHERE id=? OR parent_id=?').run(commentId, commentId);
  }
  // The organiser's moderation inbox: EVERY comment across their posts,
  // reported first, with post context for each.
  function listAllComments(entityId) {
    const rows = sql.prepare('SELECT * FROM social_feed_comments WHERE entity_id=? ORDER BY reported DESC, created_at DESC LIMIT 500').all(entityId);
    const postCache = {};
    return rows.map((r) => {
      const p = postCache[r.post_id] ||= sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(r.post_id) || {};
      return { ...commentRow(r), post: { id: p.id || r.post_id, body: String(p.body || '').slice(0, 80), communityName: getCommunity(p.community_id || '')?.name || '' } };
    });
  }
  // Organiser reply — threads under the fan's comment, authored as the brand.
  // Optionally carries a CTA button (same vocabulary + validation as post CTAs).
  function organiserReply(entityId, commentId, body, authorName) {
    const parent = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(commentId);
    if (!parent || parent.entity_id !== entityId) throw new HttpError(404, 'Comment not found');
    const b = body && typeof body === 'object' ? body : { text: body };
    const clean = String(b.text || '').trim().slice(0, 1000);
    if (!clean) throw new HttpError(400, 'Write a reply first');
    const ctaLabel = String(b.ctaLabel || '').trim().slice(0, 40);
    const dest = String(b.ctaDestination || '').trim().slice(0, 500);
    if (ctaLabel && !/^(open_url:https?:\/\/.+|[a-z][a-z0-9_]*(:\d+)?)$/.test(dest)) {
      throw new HttpError(400, 'Button destination must be a known screen keyword (e.g. explore_tickets:19203) or open_url:https://…');
    }
    const id = `cmt_${uuid().slice(0, 12)}`;
    sql.prepare("INSERT INTO social_feed_comments (id, post_id, entity_id, howler_user_id, author_name, author_type, body, parent_id, cta_label, cta_destination, created_at) VALUES (?,?,?,?,?,'organiser',?,?,?,?,?)")
      .run(id, parent.post_id, entityId, '', authorName, clean, parent.parent_id || parent.id, ctaLabel, ctaLabel ? dest : '', now());
    return commentRow(sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(id));
  }
  // Base64 media → persistent disk (dev path). Returns the served URL.
  // Server-side PUT for INLINE uploads (base64 through Pulse) — same signer
  // the browser's direct path uses, driven from Node. At scale image bytes
  // must not live on (or be served from) the app disk; R2+CDN carries them.
  async function uploadToBucket(entityId, name, mime, buf) {
    const ext = (String(name || '').match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase();
    const key = `social/${entityId}/${uuid()}${ext}`;
    const put = await fetch(presignPut({ key }), { method: 'PUT', headers: { 'Content-Type': mime }, body: buf });
    if (!put.ok) throw new Error(`bucket PUT ${put.status}`);
    return `${S3.publicBase}/${key}`;
  }
  async function saveMedia(entityId, { name, mime, data }) {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'Empty media payload');
    if (buf.length > MAX_MEDIA_BYTES) throw new HttpError(400, `Media over the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB direct-upload cap — use the presigned upload`);
    const m = String(mime || '');
    if (!/^(image|video)\//.test(m)) throw new HttpError(400, 'Only image/* or video/* media is accepted');
    // The Howler app's renderer can't decode HEIC/HEIF; the composer converts
    // photos to JPEG in the browser — a raw HEIC reaching us means that failed.
    if (/^image\/hei[cf]/.test(m)) throw new HttpError(400, 'iPhone HEIC photos must be converted first — refresh Pulse and re-pick the photo (it converts to JPEG automatically)');
    const kind = m.startsWith('video/') ? 'video' : 'image';
    // Bucket first when configured; the disk stays as the fallback so a
    // bucket outage degrades to today's behaviour instead of failed posts.
    if (s3Configured()) {
      try {
        const url = await uploadToBucket(entityId, name, m, buf);
        return { id: uuid(), url, mime: m, size: buf.length, kind };
      } catch (e) {
        console.error('[social] bucket upload failed — falling back to disk:', e.message);
      }
    }
    const id = uuid();
    fs.writeFileSync(path.join(MEDIA_DIR, id), buf);
    sql.prepare('INSERT INTO social_feed_media (id, entity_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, entityId, String(name || 'media').slice(0, 200), m.slice(0, 100), buf.length, now());
    return { id, url: `/api/app/social/media/${id}`, mime: m, size: buf.length, kind };
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
  app.delete(`${A}/communities/:id`, auth.requireAdmin, asyncHandler(async (req, res) => { deleteCommunity(req.params.entityId, req.params.id); res.json({ ok: true }); }));
  app.get(`${A}/posts`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ posts: listPosts(req.params.entityId, { status: req.query.status }) })));
  app.post(`${A}/posts`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(createPost(req.params.entityId, req.body || {}, req.user))));
  app.put(`${A}/posts/:id`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(updatePost(req.params.entityId, req.params.id, req.body || {}))));
  app.delete(`${A}/posts/:id`, auth.requireAdmin, asyncHandler(async (req, res) => { deletePost(req.params.entityId, req.params.id); res.json({ ok: true }); }));
  app.post(`${A}/posts/:id/pin`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(pinPost(req.params.entityId, req.params.id, !!(req.body || {}).pinned))));
  app.get(`${A}/posters`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ posters: listPosters(req.params.entityId) })));
  app.post(`${A}/posters`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(addPoster(req.params.entityId, req.body))));
  app.delete(`${A}/posters/:userId`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(removePoster(req.params.entityId, req.params.userId))));
  // Admins see platform-wide activity (the house entity has no fans of its own yet).
  app.get(`${A}/posters-suggestions`, auth.requireAdmin, asyncHandler(async (_req, res) => res.json({ suggestions: posterSuggestions() })));
  app.get(`${A}/share-stats`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(shareStats(req.params.entityId))));
  app.get(`${A}/cta-clicks`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(engagement.clickers(req.params.entityId, req.query.kind, req.query.refId))));
  app.post(`${A}/media`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await saveMedia(req.params.entityId, req.body || {}))));
  app.post(`${A}/media/presign`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(presignMedia(req.params.entityId, req.body || {}))));
  app.get(`${A}/media/config`, auth.requireAdmin, asyncHandler(async (_req, res) => res.json({ direct: s3Configured() })));
  app.get(`${A}/posts/:id/comments`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ comments: listComments(req.params.entityId, req.params.id) })));
  app.get(`${A}/comments`, auth.requireAdmin, asyncHandler(async (req, res) => res.json({ comments: listAllComments(req.params.entityId) })));
  app.post(`${A}/comments/:id/reply`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(organiserReply(req.params.entityId, req.params.id, req.body || {}, db.getEntity(req.params.entityId)?.name || 'Organiser'))));
  app.delete(`${A}/comments/:id`, auth.requireAdmin, asyncHandler(async (req, res) => { moderateDeleteComment(req.params.entityId, req.params.id); res.json({ ok: true }); }));

  // ── CLIENT self-service surface (flag-gated at /api/my/social via flags GATES) ──
  const eid = (req) => String(req.query.entityId || (req.body || {}).entityId || '');
  const M = '/api/my/social';
  const view = auth.requirePermission('campaigns.view', eid);
  const manage = auth.requirePermission('campaigns.approve', eid);
  app.get(`${M}/communities`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ communities: listCommunities(eid(req)) })));
  app.post(`${M}/communities`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(createCommunity(eid(req), req.body || {}, req.user))));
  app.put(`${M}/communities/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(updateCommunity(eid(req), req.params.id, req.body || {}))));
  app.delete(`${M}/communities/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => { deleteCommunity(eid(req), req.params.id); res.json({ ok: true }); }));
  app.get(`${M}/posts`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ posts: listPosts(eid(req), { status: req.query.status }) })));
  app.post(`${M}/posts`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(createPost(eid(req), req.body || {}, req.user))));
  app.put(`${M}/posts/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(updatePost(eid(req), req.params.id, req.body || {}))));
  app.delete(`${M}/posts/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => { deletePost(eid(req), req.params.id); res.json({ ok: true }); }));
  app.post(`${M}/posts/:id/pin`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(pinPost(eid(req), req.params.id, !!(req.body || {}).pinned))));
  app.get(`${M}/posters`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ posters: listPosters(eid(req)) })));
  app.post(`${M}/posters`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(addPoster(eid(req), req.body))));
  app.delete(`${M}/posters/:userId`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(removePoster(eid(req), req.params.userId))));
  // Clients only see users active on THEIR OWN communities/chats (no cross-client leak).
  app.get(`${M}/posters-suggestions`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ suggestions: posterSuggestions(eid(req)) })));
  app.get(`${M}/share-stats`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json(shareStats(eid(req)))));
  app.get(`${M}/cta-clicks`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json(engagement.clickers(eid(req), req.query.kind, req.query.refId))));
  app.post(`${M}/media`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(await saveMedia(eid(req), req.body || {}))));
  app.post(`${M}/media/presign`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(presignMedia(eid(req), req.body || {}))));
  app.get(`${M}/media/config`, auth.requireAuth, view, asyncHandler(async (_req, res) => res.json({ direct: s3Configured() })));
  app.get(`${M}/posts/:id/comments`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ comments: listComments(eid(req), req.params.id) })));
  app.get(`${M}/comments`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json({ comments: listAllComments(eid(req)) })));
  app.post(`${M}/comments/:id/reply`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(organiserReply(eid(req), req.params.id, req.body || {}, db.getEntity(eid(req))?.name || 'Organiser'))));
  app.delete(`${M}/comments/:id`, auth.requireAuth, manage, asyncHandler(async (req, res) => { moderateDeleteComment(eid(req), req.params.id); res.json({ ok: true }); }));

  // ── PUBLIC app-facing surface ──
  const readLimit = rateLimit({ windowMs: 60_000, max: 120, by: 'ip', scope: 'social_read' });
  const joinLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, by: 'ip', scope: 'social_join' });
  const gone = (res) => res.status(404).json({ error: 'Not available' });

  const { requireAppUser, optionalAppUser } = appAuth.helpers(verifyAppToken);

  // Published feed rows for one community (visible only when its entity's
  // flag is on). An ORGANISER community's feed also carries child event
  // posts that opted in (to_parent=1 — the event→organiser roll-up, same
  // mechanic as global). Raw rows out — the endpoint filters targeted posts
  // against the viewer's tickets and keeps the cursor exact (from RAW rows,
  // so a filtered-out post never breaks paging).
  function communityFeedRows(c, { limit, before }, viewerId) {
    const scope = "(community_id=? OR (to_parent=1 AND community_id IN (SELECT id FROM social_feed_communities WHERE parent_id=? AND status='active')))";
    const base = [c.id, c.id, asPostAuthor(viewerId)];
    return before
      ? sql.prepare(`SELECT * FROM social_feed_posts WHERE ${scope} AND status='published' AND ${postMod()} AND published_at<? ORDER BY published_at DESC LIMIT ?`).all(...base, before, limit)
      : sql.prepare(`SELECT * FROM social_feed_posts WHERE ${scope} AND status='published' AND ${postMod()} ORDER BY published_at DESC LIMIT ?`).all(...base, limit);
  }

  // Pinned strips for a feed's FIRST page (pages stay purely chronological so
  // the before-cursor never skips or repeats): the organiser's globally pinned
  // posts, plus the viewer's own personal pins, each capped at 10. Raw rows —
  // callers apply ticket-targeting filters where relevant.
  function pinnedStripRows(where, args, viewerId) {
    const pinned = sql.prepare(`SELECT * FROM social_feed_posts WHERE ${where} AND status='published' AND ${postMod()} AND pinned=1 ORDER BY published_at DESC LIMIT 10`).all(...args, asPostAuthor(viewerId))
      .filter((r) => flagOn(r.entity_id));
    const myPins = viewerId
      ? sql.prepare(`SELECT p.* FROM social_feed_posts p JOIN social_feed_user_pins u ON u.post_id=p.id AND u.howler_user_id=? WHERE ${where} AND p.status='published' AND ${postMod('p.')} ORDER BY u.created_at DESC LIMIT 10`).all(String(viewerId), ...args, asPostAuthor(viewerId))
        .filter((r) => flagOn(r.entity_id))
      : [];
    return { pinned, myPins };
  }

  // Who am I — echoes the VERIFIED identity behind the presented Howler JWT
  // (the exact id the posters/membership checks use). Lets a tester read their
  // own user id in-app instead of hunting it in Active Admin.
  app.get('/api/app/social/whoami', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    res.json({ contractVersion: 1, id: String(user.id), name: user.name || '' });
  }));

  // Communities the signed-in user may POST to (they're an app poster for the
  // owning entity, entity flag on). Powers the production feed's compose
  // button: shown only to authorised posters, with a target picker if several.
  app.get('/api/app/social/postable', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const entityIds = sql.prepare('SELECT DISTINCT entity_id FROM social_feed_posters WHERE howler_user_id=?')
      .all(String(user.id)).map((r) => r.entity_id).filter((id) => flagOn(id));
    const rows = entityIds.flatMap((id) =>
      sql.prepare("SELECT * FROM social_feed_communities WHERE entity_id=? AND status='active' ORDER BY type='event', created_at").all(id));
    res.json({ contractVersion: 1, communities: rows.map((r) => communityRow(r, { canPost: true })) });
  }));

  // The Howler-wide feed: every published post marked global, newest first,
  // regardless of home community — but only from flag-on entities.
  // ── views & impressions + CTA click ledger (engine: server/socialStats.js) ──
  const engagement = require('./socialStats').create({ sql, now, appUserName });
  const { logImpressions, postStats } = engagement;

  app.get('/api/app/social/feed', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const viewer = await optionalAppUser(req);
    const { limit, before } = pageArgs(req.query);
    const rows = before
      ? sql.prepare(`SELECT * FROM social_feed_posts WHERE global=1 AND status='published' AND ${postMod()} AND published_at<? ORDER BY published_at DESC LIMIT ?`).all(asPostAuthor(viewer?.id), before, limit)
      : sql.prepare(`SELECT * FROM social_feed_posts WHERE global=1 AND status='published' AND ${postMod()} ORDER BY published_at DESC LIMIT ?`).all(asPostAuthor(viewer?.id), limit);
    const stripRows = before ? { pinned: [], myPins: [] } : pinnedStripRows('global=1', [], viewer?.id);
    const allowed = await allowedGlobalEntities([...rows, ...stripRows.pinned, ...stripRows.myPins], req, viewer);
    const visible = (r) => flagOn(r.entity_id) && (allowed === null || allowed.has(r.entity_id));
    const state = batchPostState([...rows, ...stripRows.pinned, ...stripRows.myPins], viewer?.id);
    // Community lookups repeat per page — memoise for the request.
    const comms = new Map();
    const comm = (id) => { if (!comms.has(id)) comms.set(id, getCommunity(id)); return comms.get(id); };
    const shape = (r) => postRow(r, comm(r.community_id), { viewerId: viewer?.id, state });
    const posts = rows.filter(visible).map(shape);
    const strips = before ? {} : {
      pinned: stripRows.pinned.filter(visible).map(shape),
      myPins: stripRows.myPins.filter(visible).map(shape),
    };
    logImpressions(posts.map((p) => p.id), viewer?.id, 'delivered');
    // ETag/304: the app polls this — unchanged feeds cost headers only.
    jsonWithEtag(req, res, { contractVersion: 1, posts, ...strips, nextCursor: rows.length === limit ? rows[rows.length - 1].published_at : null });
  }));

  // Which entity is "Howler's own voice" on the global feed (platform admin).
  app.get('/api/admin/social/house', auth.requireAdmin, asyncHandler(async (_req, res) => res.json({ entityId: houseEntity() })));
  app.put('/api/admin/social/house', auth.requireAdmin, asyncHandler(async (req, res) => {
    db.setSetting('social_house_entity', String((req.body || {}).entityId || '').trim());
    res.json({ entityId: houseEntity() });
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
    const viewer = await optionalAppUser(req);
    res.json({
      contractVersion: 1,
      communities: rows.map((r) => communityRow(r, {
        memberCount: memberCount(r.id),
        canPost: viewer ? !!posterRow(r.entity_id, viewer.id) : null,
      })),
    });
  }));

  // One community's feed. `members` visibility requires a VERIFIED member —
  // the caller's Howler JWT is introspected; a howlerUserId param is ignored.
  app.get('/api/app/social/communities/:id/feed', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const c = getCommunity(req.params.id);
    if (!c || c.status !== 'active' || !flagOn(c.entity_id)) return gone(res);
    let viewer = null;
    if (c.visibility === 'members') {
      viewer = await requireAppUser(req);
      if (!isMember(c.id, viewer.id)) throw new HttpError(403, 'Join this community to see its feed');
    } else {
      viewer = await optionalAppUser(req);
    }
    const page = pageArgs(req.query);
    const rows = communityFeedRows(c, page, viewer?.id);
    const stripRows = page.before ? { pinned: [], myPins: [] } : pinnedStripRows('community_id=?', [c.id], viewer?.id);
    const tickets = await ticketsIfNeeded([...rows, ...stripRows.pinned, ...stripRows.myPins], req, viewer);
    // Rolled-up child posts keep their HOME community for labels + ticket
    // targeting (the audience matches against the EVENT's tickets).
    const home = (r) => (r.community_id === c.id ? c : getCommunity(r.community_id));
    const state = batchPostState([...rows, ...stripRows.pinned, ...stripRows.myPins], viewer?.id);
    const shape = (r) => postRow(r, home(r), { viewerId: viewer?.id, state });
    const seen = (r) => postVisible(r, home(r), tickets);
    const posts = rows.filter(seen).map(shape);
    const strips = page.before ? {} : {
      pinned: stripRows.pinned.filter(seen).map(shape),
      myPins: stripRows.myPins.filter(seen).map(shape),
    };
    const community = communityRow(c, {
      memberCount: memberCount(c.id),
      canPost: viewer ? !!posterRow(c.entity_id, viewer.id) : null,
    });
    logImpressions(posts.map((p) => p.id), viewer?.id, 'delivered');
    jsonWithEtag(req, res, { contractVersion: 1, community, posts, ...strips, nextCursor: rows.length === page.limit ? rows[rows.length - 1].published_at : null });
  }));

  // Tier-2 impressions from the app, batched + best-effort: which cards were
  // actually SEEN on screen and which videos were watched. Anonymous ok —
  // anonymous counts add to totals but not unique reach.
  app.post('/api/app/social/impressions', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const viewer = await optionalAppUser(req);
    const b = req.body || {};
    const ids = (v) => (Array.isArray(v) ? v.slice(0, 100).map((x) => String(x)) : []);
    logImpressions(ids(b.seen), viewer?.id, 'seen');
    logImpressions(ids(b.views), viewer?.id, 'view');
    res.json({ ok: true });
  }));

  // A CTA button was TAPPED — feed post (ref=post id), chat broadcast
  // (ref=message id) or organiser comment reply (ref=comment id). Anonymous ok
  // (total only); signed-in taps carry the verified name/email for segments.
  app.post('/api/app/social/cta-click', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const viewer = await optionalAppUser(req);
    engagement.logClick((req.body || {}).kind, (req.body || {}).refId, viewer);
    res.json({ ok: true });
  }));

  // ── Story rail — the quick-door row of community circles (mockup frame 7).
  // Active, flag-on communities that have posted, with per-viewer state:
  // joined (they follow it), hasTicket (verified holdings), unseen (posts
  // since they last opened the feed). Sorted: joined → ticket-held → most
  // recently active. ?parentId= scopes to one organiser's events (the rail
  // ON an organiser feed); omit for the global rail (all levels).
  app.get('/api/app/social/rail', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const viewer = await optionalAppUser(req);
    const parentId = String(req.query.parentId || '').trim();
    let rows = parentId
      ? sql.prepare("SELECT * FROM social_feed_communities WHERE parent_id=? AND status='active'").all(parentId)
      : sql.prepare("SELECT * FROM social_feed_communities WHERE status='active'").all();
    rows = rows.filter((r) => flagOn(r.entity_id));
    const kids = (id) => sql.prepare('SELECT id FROM social_feed_communities WHERE parent_id=?').all(id).map((k) => k.id);
    // Last activity: own posts, plus child-event posts for organiser circles
    // (the brand circle glows when any of its events posts).
    const lastPostAt = (r) => {
      const ids = [r.id, ...(r.type === 'organiser' ? kids(r.id) : [])];
      const ph = ids.map(() => '?').join(',');
      return sql.prepare(`SELECT MAX(published_at) t FROM social_feed_posts WHERE community_id IN (${ph}) AND status='published' AND moderation_status='visible'`).get(...ids)?.t || null;
    };
    let tickets = null;
    if (viewer) { try { tickets = await fetchAppTickets(tokenOf(req)); } catch { /* rail still renders */ } }
    const held = new Set((tickets || []).map((t) => String(t.eventId)));
    const items = rows.map((r) => {
      const last = lastPostAt(r);
      if (!last) return null; // quiet communities stay off the rail
      const childEventIds = r.type === 'organiser' ? sql.prepare("SELECT event_id FROM social_feed_communities WHERE parent_id=? AND event_id!=''").all(r.id).map((k) => String(k.event_id)) : [];
      const joined = viewer
        ? !!(isMember(r.id, viewer.id) || (r.type === 'organiser' && kids(r.id).some((k) => isMember(k, viewer.id))))
        : false;
      const hasTicket = r.event_id ? held.has(String(r.event_id)) : childEventIds.some((e) => held.has(e));
      const seen = viewer ? sql.prepare('SELECT last_seen_at FROM social_feed_seen WHERE community_id=? AND howler_user_id=?').get(r.id, String(viewer.id))?.last_seen_at || '' : '';
      const brand = communityBrand(r);
      return {
        communityId: r.id, name: r.name, type: r.type,
        entityId: r.entity_id, eventId: r.event_id || null, parentId: r.parent_id || null,
        avatarUrl: communityAvatar(r) || null,
        brandColor: brand.brandColor || null, secondaryColor: brand.secondaryColor || null,
        lastPostAt: last, joined, hasTicket,
        unseen: !!viewer && last > seen,
      };
    }).filter(Boolean);
    // Howler's house circles anchor the rail for everyone (right after the
    // viewer's own joined circles) — the platform voice is always in reach.
    const house = houseEntity();
    items.sort((a, b) => (b.joined - a.joined)
      || ((b.entityId === house) - (a.entityId === house))
      || (b.hasTicket - a.hasTicket)
      || (a.lastPostAt < b.lastPostAt ? 1 : -1));
    jsonWithEtag(req, res, { contractVersion: 1, rail: items.slice(0, 20) });
  }));

  // Mark a community's feed seen (clears its unseen ring on the rail).
  app.post('/api/app/social/communities/:id/seen', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare('INSERT OR REPLACE INTO social_feed_seen (community_id, howler_user_id, last_seen_at) VALUES (?,?,?)')
      .run(String(req.params.id), user.id, now());
    res.json({ ok: true });
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

  // Like / unlike a post — verified identity only; idempotent both ways.
  // Members-only ring-fencing applies: you can only like what you can see.
  async function reactablePost(req) {
    const user = await requireAppUser(req);
    // Held/removed posts are not interactable — not even by their author.
    const p = sql.prepare("SELECT * FROM social_feed_posts WHERE id=? AND status='published' AND moderation_status='visible'").get(String(req.params.id));
    const c = p && getCommunity(p.community_id);
    if (!p || !c || c.status !== 'active' || !flagOn(p.entity_id)) throw new HttpError(404, 'Not available');
    // Posts syndicated out of their home community (global or rolled up to
    // the organiser feed) are interactable by whoever can see them there.
    if (c.visibility === 'members' && !p.global && !p.to_parent && !isMember(c.id, user.id)) throw new HttpError(403, 'Join this community first');
    if (p.audience) {
      let tickets = null;
      try { tickets = await fetchAppTickets(tokenOf(req)); } catch { /* fail closed below */ }
      if (!postVisible(p, c, tickets)) throw new HttpError(403, 'This post is for specific ticket holders');
    }
    return { user, post: p };
  }

  // ── Comments (the first UGC) ──
  const commentLimit = rateLimit({ windowMs: 10 * 60_000, max: 60, by: 'ip', scope: 'social_comment' });

  // Comments are readable by whoever can see the post: public/global posts
  // anonymously; members-only posts by verified members.
  app.get('/api/app/social/posts/:id/comments', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const p = sql.prepare("SELECT * FROM social_feed_posts WHERE id=? AND status='published' AND moderation_status='visible'").get(String(req.params.id));
    const c = p && getCommunity(p.community_id);
    if (!p || !c || c.status !== 'active' || !flagOn(p.entity_id)) return gone(res);
    let viewer = null;
    if (c.visibility === 'members' && !p.global && !p.to_parent) {
      viewer = await requireAppUser(req);
      if (!isMember(c.id, viewer.id)) throw new HttpError(403, 'Join this community first');
    } else {
      viewer = await optionalAppUser(req);
    }
    if (p.audience) {
      if (!viewer) throw new HttpError(403, 'This post is for specific ticket holders');
      let tickets = null;
      try { tickets = await fetchAppTickets(tokenOf(req)); } catch { /* fail closed below */ }
      if (!postVisible(p, c, tickets)) throw new HttpError(403, 'This post is for specific ticket holders');
    }
    const { limit, before } = pageArgs(req.query);
    // Page over TOP-LEVEL comments; replies ride nested under their parent.
    const cmtViewer = String(viewer?.id || '-');
    const top = before
      ? sql.prepare(`SELECT * FROM social_feed_comments WHERE post_id=? AND parent_id='' AND ${cmtMod} AND created_at<? ORDER BY created_at DESC LIMIT ?`).all(p.id, cmtViewer, before, limit)
      : sql.prepare(`SELECT * FROM social_feed_comments WHERE post_id=? AND parent_id='' AND ${cmtMod} ORDER BY created_at DESC LIMIT ?`).all(p.id, cmtViewer, limit);
    const replies = top.length
      ? sql.prepare(`SELECT * FROM social_feed_comments WHERE parent_id IN (${top.map(() => '?').join(',')}) AND ${cmtMod}`).all(...top.map((r) => r.id), cmtViewer)
      : [];
    res.json({
      contractVersion: 1, commentCount: commentCount(p.id),
      allowImages: !!c.allow_comment_images, allowLinks: !!c.allow_comment_links,
      comments: nestComments([...top, ...replies], { viewerId: viewer?.id }),
      nextCursor: top.length === limit ? top[top.length - 1].created_at : null,
    });
  }));

  app.post('/api/app/social/posts/:id/comments', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { user, post } = await reactablePost(req); // same visibility rules as liking
    const community = getCommunity(post.community_id);
    const body = req.body || {};
    const text = String(body.text || '').trim().slice(0, 1000);
    // Fan replies thread one level deep under a top-level comment on the same post.
    let parentId = '';
    if (body.parentCommentId) {
      const parent = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(String(body.parentCommentId));
      if (!parent || parent.post_id !== post.id) throw new HttpError(400, 'That comment isn’t on this post');
      parentId = parent.parent_id || parent.id; // replying to a reply attaches to its top-level parent
    }
    // Links in comments are organiser-opt-in per community (anti-spam default).
    if (text && URL_RE.test(text) && !community.allow_comment_links) {
      throw new HttpError(400, 'Links aren’t allowed in comments here');
    }
    // Optional image — organiser-opt-in per community; stored via the normal
    // media path (entity-scoped) and served like any other media.
    let media = '[]';
    if (body.imageData) {
      if (!community.allow_comment_images) throw new HttpError(400, 'Photos aren’t allowed in comments here');
      const saved = await saveMedia(post.entity_id, { name: 'comment.jpg', mime: String(body.imageMime || 'image/jpeg'), data: body.imageData });
      media = JSON.stringify([{ id: saved.id, kind: 'image', url: saved.url, mime: saved.mime }]);
    }
    if (!text && media === '[]') throw new HttpError(400, 'Write something first');
    const id = `cmt_${uuid().slice(0, 12)}`;
    const name = (user.name || String(body.displayName || '')).trim().slice(0, 80);
    // Moderation (MODERATION_CONTRACT.md §2 #2): the text + the fan-supplied
    // fallback display name (the verified Howler name is trusted). Exact hit →
    // 422, nothing persisted; fuzzy hit → persisted 'held', author-only, 202.
    const fallbackName = user.name ? '' : name;
    const verdict = moderation.screenText(post.entity_id, fallbackName ? `${text}\n${fallbackName}` : text);
    if (verdict.outcome === 'block') {
      moderation.recordBlockedAttempt({ contentType: 'comment', snapshot: { text, displayName: fallbackName }, authorUserId: user.id, communityId: community.id, entityId: post.entity_id, evidence: { ruleIds: verdict.matches.map((m) => m.id) } });
      return res.status(422).json(moderation.blockedBody(verdict.reason));
    }
    sql.prepare('INSERT INTO social_feed_comments (id, post_id, entity_id, howler_user_id, author_name, body, parent_id, media, moderation_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, post.id, post.entity_id, user.id, name, text, parentId, media, verdict.outcome === 'hold' ? 'held' : 'visible', now());
    const row = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(id);
    if (verdict.outcome === 'hold') {
      moderation.recordHold({ contentType: 'comment', contentId: id, snapshot: { text, displayName: fallbackName }, authorUserId: user.id, communityId: community.id, entityId: post.entity_id, evidence: { ruleIds: verdict.matches.map((m) => m.id) } });
      return res.status(202).json({ ...commentRow(row, { viewerId: user.id }), moderation: moderation.heldMeta(verdict.reason) });
    }
    res.json(commentRow(row, { viewerId: user.id }));
  }));

  // Author deletes their own comment; anyone verified can report one.
  app.delete('/api/app/social/comments/:id', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const r = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(String(req.params.id));
    if (!r) return gone(res);
    if (r.author_type === 'organiser' || r.howler_user_id !== String(user.id)) throw new HttpError(403, 'You can only delete your own comments');
    sql.prepare('DELETE FROM social_feed_comments WHERE id=? OR parent_id=?').run(r.id, r.id);
    res.json({ ok: true });
  }));
  app.post('/api/app/social/comments/:id/report', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    sql.prepare('UPDATE social_feed_comments SET reported=1 WHERE id=?').run(String(req.params.id));
    // Reports also land in the moderation review queue (content stays visible
    // until a moderator declines); the reported flag stays for the old inbox.
    const r = sql.prepare('SELECT * FROM social_feed_comments WHERE id=?').get(String(req.params.id));
    if (r) {
      moderation.recordReport({
        contentType: 'comment', contentId: r.id, reporterId: user.id, reason: (req.body || {}).reason,
        snapshot: { text: r.body }, authorUserId: r.howler_user_id, entityId: r.entity_id,
      });
    }
    res.json({ ok: true });
  }));
  // Post-level report — parity with comments/messages (MODERATION_CONTRACT.md
  // §8.1). Files a queue item; the post stays visible until declined.
  app.post('/api/app/social/posts/:id/report', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const p = sql.prepare("SELECT * FROM social_feed_posts WHERE id=? AND status='published' AND moderation_status='visible'").get(String(req.params.id));
    if (!p || !flagOn(p.entity_id)) return gone(res);
    moderation.recordReport({
      contentType: 'post', contentId: p.id, reporterId: user.id, reason: (req.body || {}).reason,
      snapshot: { text: p.body },
      authorUserId: String(p.author_email || '').startsWith('app:') ? p.author_email.slice(4) : '',
      communityId: p.community_id, entityId: p.entity_id,
    });
    res.json({ ok: true });
  }));
  app.post('/api/app/social/posts/:id/react', joinLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { user, post } = await reactablePost(req);
    sql.prepare('INSERT OR IGNORE INTO social_feed_reactions (post_id, howler_user_id, created_at) VALUES (?,?,?)').run(post.id, user.id, now());
    res.json({ ok: true, reactionCount: reactionCount(post.id), hasReacted: true });
  }));
  app.delete('/api/app/social/posts/:id/react', joinLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { user, post } = await reactablePost(req);
    sql.prepare('DELETE FROM social_feed_reactions WHERE post_id=? AND howler_user_id=?').run(post.id, user.id);
    res.json({ ok: true, reactionCount: reactionCount(post.id), hasReacted: false });
  }));

  // Post AS THE BRAND straight from the app — authorised app posters only
  // (managed in Pulse → Community → App posters; checked against the VERIFIED
  // JWT identity). Publishes immediately; images ride inline as base64 (the
  // app converts to JPEG first, same as comment photos).
  app.post('/api/app/social/posts', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const body = req.body || {};
    const c = getCommunity(String(body.communityId || ''));
    if (!c || c.status !== 'active' || !flagOn(c.entity_id)) return gone(res);
    const poster = posterRow(c.entity_id, user.id);
    if (!poster) throw new HttpError(403, 'You aren’t set up to post here — ask the organiser to add you as an app poster in Pulse');
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_MEDIA_PER_POST) : [];
    const media = [];
    for (let i = 0; i < images.length; i++) {
      const it = images[i] || {};
      // Direct-uploaded item (via /presign): already sitting in the bucket —
      // reference it by url instead of re-uploading through Pulse.
      if (it.url && !it.data) { media.push(validMediaItem(it)); continue; }
      const saved = await saveMedia(c.entity_id, { name: `app-post-${i}.jpg`, mime: String(it.mime || 'image/jpeg'), data: it.data });
      // validMediaItem re-validates the saved url and carries the reframe
      // focus / poster metadata the composer attached to the inline item.
      media.push(validMediaItem({ ...it, id: saved.id, kind: saved.kind, url: saved.url, mime: saved.mime, data: undefined }));
    }
    const text = String(body.text || '').trim().slice(0, MAX_BODY);
    if (!text && media.length === 0) throw new HttpError(400, 'Write something or add a photo first');
    // Moderation (MODERATION_CONTRACT.md §2 #1): screen the text before
    // anything publishes. Media checks (pHash) are phase 2.
    const verdict = moderation.screenText(c.entity_id, text);
    if (verdict.outcome === 'block') {
      moderation.recordBlockedAttempt({ contentType: 'post', snapshot: { text }, authorUserId: user.id, communityId: c.id, entityId: c.entity_id, evidence: { ruleIds: verdict.matches.map((m) => m.id) } });
      return res.status(422).json(moderation.blockedBody(verdict.reason));
    }
    // authorName '' → the post renders in the brand's voice (community name).
    // CTA fields ride through validPostInput — same validation as the Pulse
    // composer (label needs a destination, destination must be a screen
    // keyword or open_url:https://…), so app posters get real 400s not junk.
    const post = createPost(c.entity_id, {
      communityId: c.id, body: text, media, global: !!body.global, publish: true,
      source: 'app', authorName: poster.name || '',
      ctaLabel: body.ctaLabel, ctaDestination: body.ctaDestination, ctaStyle: body.ctaStyle,
      moderationStatus: verdict.outcome === 'hold' ? 'held' : undefined,
    }, { email: `app:${user.id}` });
    if (verdict.outcome === 'hold') {
      moderation.recordHold({ contentType: 'post', contentId: post.id, snapshot: { text }, authorUserId: user.id, communityId: c.id, entityId: c.entity_id, evidence: { ruleIds: verdict.matches.map((m) => m.id) } });
      return res.status(202).json({ ...post, moderation: moderation.heldMeta(verdict.reason) });
    }
    res.json(post);
  }));

  // Edit / delete an OWN app post (canEdit on feed shapes flags these to the
  // app). Ownership = the post was authored from the app by THIS verified user
  // (author_email 'app:<id>') AND they're still a registered poster. Edits
  // cover the caption + CTA (media stays — delete and repost to change it);
  // delete archives (stats and the click ledger survive for Pulse reporting).
  const requireOwnAppPost = async (req) => {
    const user = await requireAppUser(req);
    const p = sql.prepare('SELECT * FROM social_feed_posts WHERE id=?').get(req.params.id);
    if (!p || p.author_email !== `app:${user.id}` || !posterRow(p.entity_id, user.id)) {
      throw new HttpError(404, 'Post not found');
    }
    return { user, p };
  };
  app.patch('/api/app/social/posts/:id', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { p } = await requireOwnAppPost(req);
    const b = req.body || {};
    const text = String(b.text ?? p.body).trim().slice(0, MAX_BODY);
    if (!text && !mediaList(p.media).length) throw new HttpError(400, 'Write something first');
    const verdict = moderation.screenText(p.entity_id, text);
    if (verdict.outcome === 'block') return res.status(422).json(moderation.blockedBody(verdict.reason));
    res.json(updatePost(p.entity_id, p.id, {
      body: text,
      ...(b.ctaLabel !== undefined || b.ctaDestination !== undefined
        ? { ctaLabel: b.ctaLabel, ctaDestination: b.ctaDestination, ctaStyle: b.ctaStyle } : {}),
    }));
  }));
  app.delete('/api/app/social/posts/:id', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { p } = await requireOwnAppPost(req);
    updatePost(p.entity_id, p.id, { status: 'archived' });
    res.json({ ok: true });
  }));

  // Direct-to-bucket upload for APP posters — the same presigned-PUT path the
  // Pulse composer uses, so big videos from the phone go straight to R2 and
  // never hit Pulse's inline body cap. Registered posters only.
  app.post('/api/app/social/presign', commentLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const user = await requireAppUser(req);
    const body = req.body || {};
    // Scope the bucket key to the community's entity when given; otherwise any
    // entity the caller is registered as a poster for.
    const c = body.communityId ? getCommunity(String(body.communityId)) : null;
    const posterOf = c ? (posterRow(c.entity_id, user.id) && { entity_id: c.entity_id })
      : sql.prepare('SELECT entity_id FROM social_feed_posters WHERE howler_user_id=? LIMIT 1').get(String(user.id));
    if (!posterOf) throw new HttpError(403, 'You aren’t set up to post here — ask the organiser to add you as an app poster in Pulse');
    res.json({ contractVersion: 1, ...presignMedia(posterOf.entity_id, body) });
  }));

  // Personal pin / unpin — a private bookmark, only ever visible to the pinner
  // (pinnedByMe on posts + the feed's myPins strip). Same ring-fencing as likes.
  app.post('/api/app/social/posts/:id/pin', joinLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const { user, post } = await reactablePost(req);
    if ((req.body || {}).pinned === false) {
      sql.prepare('DELETE FROM social_feed_user_pins WHERE post_id=? AND howler_user_id=?').run(post.id, user.id);
      return res.json({ ok: true, pinnedByMe: false });
    }
    sql.prepare('INSERT OR IGNORE INTO social_feed_user_pins (post_id, howler_user_id, created_at) VALUES (?,?,?)').run(post.id, user.id, now());
    res.json({ ok: true, pinnedByMe: true });
  }));

  // Serve disk-stored media — public, immutable (ids are unguessable UUIDs).
  app.get('/api/app/social/media/:id', asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const m = sql.prepare('SELECT * FROM social_feed_media WHERE id=?').get(String(req.params.id));
    const file = m && path.join(MEDIA_DIR, m.id);
    if (!m || !fs.existsSync(file)) return gone(res);
    res.set('Content-Type', m.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');
    // HTTP Range support — iOS AVPlayer refuses to stream video from servers
    // that can't serve partial content, so Pulse-hosted (fallback-uploaded)
    // videos would show as a black box without this.
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Math.min(Number(range[1]), size - 1) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`).set('Content-Length', String(end - start + 1));
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.send(fs.readFileSync(file));
  }));

  // Single post (deep-link target / single-post screen). Same visibility as
  // the feed: flag-on, published; members-only needs membership; targeted
  // posts need the matching ticket.
  app.get('/api/app/social/posts/:id', readLimit, asyncHandler(async (req, res) => {
    if (!enabled()) return gone(res);
    const p = sql.prepare("SELECT * FROM social_feed_posts WHERE id=? AND status='published'").get(String(req.params.id));
    const c = p && getCommunity(p.community_id);
    if (!p || !c || c.status !== 'active' || !flagOn(p.entity_id)) return gone(res);
    let viewer = null;
    if (c.visibility === 'members' && !p.global && !p.to_parent) {
      viewer = await requireAppUser(req);
      if (!isMember(c.id, viewer.id)) throw new HttpError(403, 'Join this community to see this post');
    } else {
      viewer = await optionalAppUser(req);
    }
    if (p.audience) {
      if (!viewer) throw new HttpError(403, 'This post is for specific ticket holders');
      let tickets = null;
      try { tickets = await fetchAppTickets(tokenOf(req)); } catch { /* fail closed */ }
      if (!postVisible(p, c, tickets)) throw new HttpError(403, 'This post is for specific ticket holders');
    }
    // Held/removed posts exist only for their author (pending/removed states).
    if (p.moderation_status !== 'visible' && asPostAuthor(viewer?.id) !== p.author_email) return gone(res);
    res.json({ contractVersion: 1, post: postRow(p, c, { viewerId: viewer?.id }) });
  }));

  // Shareable web page for a post (GET /p/:id) — extracted to its own module
  // (line-budget split); mounted here with the closures the page needs.
  require('./socialShare').mount(app, { sql, now, enabled, flagOn, getCommunity, mediaList, communityAvatar, communityBrand });

  return { listCommunities, createCommunity, createPost, updatePost, saveMedia };
}

module.exports = { mount, _presignPut: presignPut, _verifyAppToken: appAuth.defaultVerifyAppToken };
