// ─── Social metrics INBOUND connector — disposable module ─────────────────────
// Pulls ORGANIC social stats INTO Pulse (the read direction), as opposed to the
// audience-sync connectors (server/meta.js, server/tiktok.js) which push segments
// OUT to ad platforms. Two grains are ingested per connected account:
//   • account-level, one row per day  → followers, reach, impressions, …
//   • post-level, one row per post    → reach, likes, comments, shares, …
// stored in social_account_metrics / social_post_metrics, upserted so repeat
// pulls (and platforms restating the last few days) never duplicate.
//
// Mirrors the house conventions of mailer.js / meta.js:
//   • per-client connection read from entity integrations (write-only secrets)
//   • graceful no-op when a client isn't connected
//   • one sync chokepoint per platform that NEVER throws — a broken token records
//     an error on the account row and the rest of the system carries on.
//
// Per-client connection (Admin → client → Integrations, or client self-service).
// The audience-sync token (metaAccessToken / tiktokAccessToken) is REUSED, but
// organic insights need extra asset ids that ad-account sync doesn't:
//   Meta:   metaAccessToken  + metaPageId (Facebook Page) and/or
//                              metaIgUserId (Instagram Business/Creator user id)
//   TikTok: tiktokAccessToken + (open id is derived from the token)
//
// NOTE: there are no Meta/TikTok credentials in this environment, so the network
// calls are UNTESTED against the live APIs — endpoint paths and metric names move
// between Graph / Display API versions and MUST be verified against current docs
// before going live. The reusable scaffolding (schema, connection, normalise +
// upsert, sync chokepoint, query helpers, history) is the deliverable and is
// covered by tests.
const fetch = require('node-fetch');

const GRAPH = 'https://graph.facebook.com/v19.0';
const TIKTOK = 'https://open.tiktokapis.com/v2';

let db = null;
function init(deps) {
  db = deps.db;
  db.db.exec(`
    -- One row per connected account (entity × platform × account). Holds the
    -- latest snapshot + last-sync health, so the UI can list accounts without
    -- replaying the metric tables.
    CREATE TABLE IF NOT EXISTS social_accounts (
      entity_id    TEXT NOT NULL,
      platform     TEXT NOT NULL,           -- 'facebook' | 'instagram' | 'tiktok'
      account_ref  TEXT NOT NULL,           -- page id / ig user id / tiktok open id
      username     TEXT NOT NULL DEFAULT '',
      name         TEXT NOT NULL DEFAULT '',
      profile_url  TEXT NOT NULL DEFAULT '',
      followers    INTEGER,
      posts_count  INTEGER,
      last_status  TEXT NOT NULL DEFAULT '',  -- 'ok' | 'error'
      last_error   TEXT NOT NULL DEFAULT '',
      last_synced  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, platform, account_ref)
    );
    -- Account-level daily series. Upsert on the day so re-pulls restate, not dup.
    CREATE TABLE IF NOT EXISTS social_account_metrics (
      entity_id     TEXT NOT NULL,
      platform      TEXT NOT NULL,
      account_ref   TEXT NOT NULL,
      date          TEXT NOT NULL,          -- YYYY-MM-DD
      followers     INTEGER,
      reach         INTEGER,
      impressions   INTEGER,
      profile_views INTEGER,
      engagement    INTEGER,
      PRIMARY KEY (entity_id, platform, account_ref, date)
    );
    -- Post-level metrics. Upsert on post id; counts are restated on each pull.
    CREATE TABLE IF NOT EXISTS social_post_metrics (
      entity_id    TEXT NOT NULL,
      platform     TEXT NOT NULL,
      account_ref  TEXT NOT NULL,
      post_id      TEXT NOT NULL,
      posted_at    TEXT NOT NULL DEFAULT '',
      permalink    TEXT NOT NULL DEFAULT '',
      caption      TEXT NOT NULL DEFAULT '',
      media_type   TEXT NOT NULL DEFAULT '',
      reach        INTEGER,
      impressions  INTEGER,
      likes        INTEGER,
      comments     INTEGER,
      shares       INTEGER,
      saves        INTEGER,
      video_views  INTEGER,
      engagement   INTEGER,
      updated_at   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, platform, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_acct_metrics ON social_account_metrics(entity_id, platform, date);
    CREATE INDEX IF NOT EXISTS idx_social_posts ON social_post_metrics(entity_id, platform, posted_at);
  `);
}

// ── connection (per client, from entity integrations) ──
function connection(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  return {
    metaToken: (i.metaAccessToken || '').trim(),
    pageId: (i.metaPageId || '').trim(),
    igUserId: (i.metaIgUserId || '').trim(),
    tiktokToken: (i.tiktokAccessToken || '').trim(),
  };
}
// Which platforms are connected for this client. A platform needs its token AND
// at least one asset id (TikTok derives the account from the token itself).
function configuredPlatforms(entityId) {
  const c = connection(entityId);
  const out = [];
  if (c.metaToken && c.pageId) out.push('facebook');
  if (c.metaToken && c.igUserId) out.push('instagram');
  if (c.tiktokToken) out.push('tiktok');
  return out;
}
function isConfigured(entityId) { return configuredPlatforms(entityId).length > 0; }
function status(entityId) {
  const c = connection(entityId);
  return {
    configured: isConfigured(entityId),
    platforms: configuredPlatforms(entityId),
    facebook: { tokenSet: !!c.metaToken, pageId: c.pageId },
    instagram: { tokenSet: !!c.metaToken, igUserId: c.igUserId },
    tiktok: { tokenSet: !!c.tiktokToken },
  };
}

// ── small fetch helpers ──
async function graph(path, { token } = {}) {
  const url = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { timeout: 20000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(e.message || `Meta HTTP ${res.status}`);
    err.metaCode = e.code; err.httpStatus = res.status;
    throw err;
  }
  return data;
}
async function ttGet(path, token) {
  const res = await fetch(`${TIKTOK}/${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code && data.error.code !== 'ok') {
    const err = new Error(data.error?.message || `TikTok HTTP ${res.status}`);
    err.httpStatus = res.status; throw err;
  }
  return data;
}
async function ttPost(path, token, body) {
  const res = await fetch(`${TIKTOK}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), timeout: 20000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.error?.code && data.error.code !== 'ok')) {
    const err = new Error(data.error?.message || `TikTok HTTP ${res.status}`);
    err.httpStatus = res.status; throw err;
  }
  return data;
}

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (ts) => (ts ? String(ts).slice(0, 10) : today());
const num = (v) => (v == null || v === '' ? null : Number(v));

// ── upserts ──
function upsertAccount(row) {
  db.db.prepare(`INSERT INTO social_accounts (entity_id, platform, account_ref, username, name, profile_url, followers, posts_count, last_status, last_error, last_synced)
    VALUES (@entity_id,@platform,@account_ref,@username,@name,@profile_url,@followers,@posts_count,@last_status,@last_error,@last_synced)
    ON CONFLICT(entity_id, platform, account_ref) DO UPDATE SET
      username=excluded.username, name=excluded.name, profile_url=excluded.profile_url,
      followers=COALESCE(excluded.followers, social_accounts.followers),
      posts_count=COALESCE(excluded.posts_count, social_accounts.posts_count),
      last_status=excluded.last_status, last_error=excluded.last_error, last_synced=excluded.last_synced`)
    .run({ username: '', name: '', profile_url: '', followers: null, posts_count: null, last_status: 'ok', last_error: '', last_synced: new Date().toISOString(), ...row });
}
// Record a connection/sync error against the account row (so the UI can show it)
// without losing the last good snapshot. Best-effort.
function markAccountError(entityId, platform, accountRef, error) {
  try {
    upsertAccount({ entity_id: entityId, platform, account_ref: accountRef || '(unknown)', last_status: 'error', last_error: String(error).slice(0, 300) });
  } catch { /* never break a sync over bookkeeping */ }
}
function upsertAccountMetric(row) {
  db.db.prepare(`INSERT INTO social_account_metrics (entity_id, platform, account_ref, date, followers, reach, impressions, profile_views, engagement)
    VALUES (@entity_id,@platform,@account_ref,@date,@followers,@reach,@impressions,@profile_views,@engagement)
    ON CONFLICT(entity_id, platform, account_ref, date) DO UPDATE SET
      followers=COALESCE(excluded.followers, social_account_metrics.followers),
      reach=COALESCE(excluded.reach, social_account_metrics.reach),
      impressions=COALESCE(excluded.impressions, social_account_metrics.impressions),
      profile_views=COALESCE(excluded.profile_views, social_account_metrics.profile_views),
      engagement=COALESCE(excluded.engagement, social_account_metrics.engagement)`)
    .run({ followers: null, reach: null, impressions: null, profile_views: null, engagement: null, ...row });
}
function upsertPost(row) {
  db.db.prepare(`INSERT INTO social_post_metrics (entity_id, platform, account_ref, post_id, posted_at, permalink, caption, media_type, reach, impressions, likes, comments, shares, saves, video_views, engagement, updated_at)
    VALUES (@entity_id,@platform,@account_ref,@post_id,@posted_at,@permalink,@caption,@media_type,@reach,@impressions,@likes,@comments,@shares,@saves,@video_views,@engagement,@updated_at)
    ON CONFLICT(entity_id, platform, post_id) DO UPDATE SET
      posted_at=excluded.posted_at, permalink=excluded.permalink, caption=excluded.caption, media_type=excluded.media_type,
      reach=COALESCE(excluded.reach, social_post_metrics.reach),
      impressions=COALESCE(excluded.impressions, social_post_metrics.impressions),
      likes=COALESCE(excluded.likes, social_post_metrics.likes),
      comments=COALESCE(excluded.comments, social_post_metrics.comments),
      shares=COALESCE(excluded.shares, social_post_metrics.shares),
      saves=COALESCE(excluded.saves, social_post_metrics.saves),
      video_views=COALESCE(excluded.video_views, social_post_metrics.video_views),
      engagement=COALESCE(excluded.engagement, social_post_metrics.engagement),
      updated_at=excluded.updated_at`)
    .run({ posted_at: '', permalink: '', caption: '', media_type: '', reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, video_views: null, engagement: null, updated_at: new Date().toISOString(), ...row });
}

// Pull the last `metric` value out of a Graph insights response by metric name.
function insightLatest(data, metric) {
  const m = (data.data || []).find((x) => x.name === metric);
  const vals = m?.values || [];
  const last = vals[vals.length - 1];
  return last ? num(last.value) : null;
}
// Map a Graph insights response into per-day rows keyed by date → {metric: value}.
function insightSeries(data, mapping) {
  const byDate = {};
  for (const m of (data.data || [])) {
    const key = mapping[m.name];
    if (!key) continue;
    for (const v of (m.values || [])) {
      const d = dayOf(v.end_time);
      (byDate[d] = byDate[d] || {})[key] = num(v.value);
    }
  }
  return byDate;
}

// ── Meta: Facebook Page ──
async function syncFacebook(entityId, token, pageId) {
  const prof = await graph(`${pageId}?fields=name,username,fan_count,link`, { token });
  upsertAccount({ entity_id: entityId, platform: 'facebook', account_ref: pageId, username: prof.username || '', name: prof.name || '', profile_url: prof.link || '', followers: num(prof.fan_count) });
  // Daily account insights → series.
  const ins = await graph(`${pageId}/insights?metric=page_impressions,page_post_engagements,page_fans&period=day`, { token });
  const series = insightSeries(ins, { page_impressions: 'impressions', page_post_engagements: 'engagement', page_fans: 'followers' });
  for (const [date, vals] of Object.entries(series)) upsertAccountMetric({ entity_id: entityId, platform: 'facebook', account_ref: pageId, date, ...vals });
  // Recent posts + their reach/engagement.
  const posts = await graph(`${pageId}/posts?fields=id,message,created_time,permalink_url,insights.metric(post_impressions,post_engaged_users)&limit=25`, { token });
  for (const p of (posts.data || [])) {
    upsertPost({
      entity_id: entityId, platform: 'facebook', account_ref: pageId, post_id: p.id,
      posted_at: p.created_time || '', permalink: p.permalink_url || '', caption: p.message || '', media_type: 'post',
      impressions: insightLatest(p.insights || {}, 'post_impressions'),
      engagement: insightLatest(p.insights || {}, 'post_engaged_users'),
    });
  }
}

// ── Meta: Instagram Business/Creator ──
async function syncInstagram(entityId, token, igUserId) {
  const prof = await graph(`${igUserId}?fields=username,name,followers_count,media_count`, { token });
  upsertAccount({ entity_id: entityId, platform: 'instagram', account_ref: igUserId, username: prof.username || '', name: prof.name || '', profile_url: prof.username ? `https://instagram.com/${prof.username}` : '', followers: num(prof.followers_count), posts_count: num(prof.media_count) });
  const ins = await graph(`${igUserId}/insights?metric=reach,impressions,profile_views&period=day`, { token });
  const series = insightSeries(ins, { reach: 'reach', impressions: 'impressions', profile_views: 'profile_views' });
  for (const [date, vals] of Object.entries(series)) upsertAccountMetric({ entity_id: entityId, platform: 'instagram', account_ref: igUserId, date, followers: num(prof.followers_count), ...vals });
  const media = await graph(`${igUserId}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count,insights.metric(reach,impressions,saved)&limit=25`, { token });
  for (const m of (media.data || [])) {
    const likes = num(m.like_count); const comments = num(m.comments_count);
    upsertPost({
      entity_id: entityId, platform: 'instagram', account_ref: igUserId, post_id: m.id,
      posted_at: m.timestamp || '', permalink: m.permalink || '', caption: m.caption || '', media_type: m.media_type || '',
      reach: insightLatest(m.insights || {}, 'reach'), impressions: insightLatest(m.insights || {}, 'impressions'),
      saves: insightLatest(m.insights || {}, 'saved'), likes, comments,
      engagement: (likes || 0) + (comments || 0),
    });
  }
}

// ── TikTok (Display API): current snapshot only — no historical day series. ──
async function syncTiktok(entityId, token) {
  const info = await ttGet('user/info/?fields=open_id,display_name,follower_count,following_count,likes_count,video_count', token);
  const u = info.data?.user || {};
  const ref = u.open_id || '(me)';
  upsertAccount({ entity_id: entityId, platform: 'tiktok', account_ref: ref, username: u.display_name || '', name: u.display_name || '', followers: num(u.follower_count), posts_count: num(u.video_count) });
  // Snapshot today's account totals (TikTok gives no per-day backfill here).
  upsertAccountMetric({ entity_id: entityId, platform: 'tiktok', account_ref: ref, date: today(), followers: num(u.follower_count), engagement: num(u.likes_count) });
  const vids = await ttPost('video/list/?fields=id,title,create_time,view_count,like_count,comment_count,share_count', token, { max_count: 20 });
  for (const v of (vids.data?.videos || [])) {
    const likes = num(v.like_count); const comments = num(v.comment_count); const shares = num(v.share_count);
    upsertPost({
      entity_id: entityId, platform: 'tiktok', account_ref: ref, post_id: String(v.id),
      posted_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : '', caption: v.title || '', media_type: 'video',
      video_views: num(v.view_count), likes, comments, shares,
      engagement: (likes || 0) + (comments || 0) + (shares || 0),
    });
  }
}

// Sync ONE client across every platform it has connected. Best-effort: a failure
// on one platform is recorded against that account and the others still run.
// Never throws. Returns a per-platform result for the manual-refresh UI.
async function syncEntity(entityId) {
  const c = connection(entityId);
  const platforms = configuredPlatforms(entityId);
  const results = {};
  for (const platform of platforms) {
    try {
      if (platform === 'facebook') await syncFacebook(entityId, c.metaToken, c.pageId);
      else if (platform === 'instagram') await syncInstagram(entityId, c.metaToken, c.igUserId);
      else if (platform === 'tiktok') await syncTiktok(entityId, c.tiktokToken);
      results[platform] = { ok: true };
    } catch (e) {
      const ref = platform === 'facebook' ? c.pageId : platform === 'instagram' ? c.igUserId : '(me)';
      markAccountError(entityId, platform, ref, e.message);
      results[platform] = { ok: false, error: e.message };
    }
  }
  return { ok: true, platforms, results };
}

// ── query helpers (feed the Social page AND the dashboard data source) ──
function accounts(entityId) {
  if (!db) return [];
  return db.db.prepare('SELECT platform, account_ref AS accountRef, username, name, profile_url AS profileUrl, followers, posts_count AS postsCount, last_status AS lastStatus, last_error AS lastError, last_synced AS lastSynced FROM social_accounts WHERE entity_id=? ORDER BY platform').all(entityId);
}
// Daily account series for one metric, oldest→newest, last `days`.
function accountSeries(entityId, { platform, accountRef, metric = 'reach', days = 30 } = {}) {
  if (!db) return [];
  const col = ['followers', 'reach', 'impressions', 'profile_views', 'engagement'].includes(metric) ? metric : 'reach';
  const where = ['entity_id=?']; const args = [entityId];
  if (platform) { where.push('platform=?'); args.push(platform); }
  if (accountRef) { where.push('account_ref=?'); args.push(accountRef); }
  const rows = db.db.prepare(`SELECT date, ${col} AS value FROM social_account_metrics WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ?`).all(...args, days);
  return rows.reverse();
}
// Top posts by a chosen metric (engagement by default), newest sync data.
function topPosts(entityId, { platform, sort = 'engagement', limit = 10 } = {}) {
  if (!db) return [];
  const col = ['engagement', 'reach', 'impressions', 'likes', 'comments', 'shares', 'video_views'].includes(sort) ? sort : 'engagement';
  const where = ['entity_id=?']; const args = [entityId];
  if (platform) { where.push('platform=?'); args.push(platform); }
  return db.db.prepare(`SELECT platform, post_id AS postId, posted_at AS postedAt, permalink, caption, media_type AS mediaType, reach, impressions, likes, comments, shares, saves, video_views AS videoViews, engagement FROM social_post_metrics WHERE ${where.join(' AND ')} ORDER BY ${col} DESC NULLS LAST LIMIT ?`).all(...args, limit);
}

// Per-client health summary for the admin monitoring view (mirrors meta.summary).
function summary(entityId) {
  const accts = accounts(entityId);
  const errors = accts.filter((a) => a.lastStatus === 'error').length;
  const lastAt = accts.reduce((m, a) => (a.lastSynced > m ? a.lastSynced : m), '');
  const lastError = accts.filter((a) => a.lastStatus === 'error').sort((a, b) => String(b.lastSynced).localeCompare(String(a.lastSynced)))[0] || null;
  return {
    channel: 'social', configured: isConfigured(entityId), platforms: configuredPlatforms(entityId),
    accountCount: accts.length, ok: accts.length - errors, errors, lastAt,
    lastError: lastError ? { at: lastError.lastSynced, error: lastError.lastError, platform: lastError.platform } : null,
    accounts: accts,
  };
}

// Live token check — does each connected platform answer right now? Never throws.
async function verify(entityId) {
  const c = connection(entityId);
  const checkedAt = new Date().toISOString();
  const out = { checkedAt, platforms: {} };
  if (!isConfigured(entityId)) return { ...out, ok: false, status: 'not_configured' };
  for (const platform of configuredPlatforms(entityId)) {
    try {
      if (platform === 'facebook') await graph(`${c.pageId}?fields=name`, { token: c.metaToken });
      else if (platform === 'instagram') await graph(`${c.igUserId}?fields=username`, { token: c.metaToken });
      else if (platform === 'tiktok') await ttGet('user/info/?fields=open_id', c.tiktokToken);
      out.platforms[platform] = { ok: true };
    } catch (e) {
      out.platforms[platform] = { ok: false, status: (e.metaCode === 190 || e.httpStatus === 401) ? 'token_invalid' : 'error', detail: e.message };
    }
  }
  out.ok = Object.values(out.platforms).every((p) => p.ok);
  return out;
}

// ── daily scheduler (started from index.js, NOT from init, so tests stay timer-free) ──
let timer = null;
let lastRunDay = '';
function startDailySync({ listEntities, hourUtc = 4 } = {}) {
  if (timer) return;
  async function tick() {
    const now = new Date();
    if (now.getUTCHours() !== hourUtc) return;        // run in a 1-hour window once/day
    const day = today();
    if (day === lastRunDay) return;                    // already ran today
    lastRunDay = day;
    for (const e of (listEntities ? listEntities() : [])) {
      if (isConfigured(e.id)) { try { await syncEntity(e.id); } catch { /* never throw */ } }
    }
  }
  timer = setInterval(() => { tick().catch(() => {}); }, 15 * 60 * 1000); // check every 15m
  if (timer.unref) timer.unref();
}
function stopDailySync() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  init, connection, isConfigured, configuredPlatforms, status,
  syncEntity, accounts, accountSeries, topPosts, summary, verify,
  startDailySync, stopDailySync,
};
