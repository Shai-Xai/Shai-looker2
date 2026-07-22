// ─── Instagram → Community feed import — disposable module ────────────────────
// "Post what's already on your Instagram, in one click." Lists the client's
// recent IG media (Graph API) and imports a chosen item into the community
// feed: media bytes are downloaded SERVER-SIDE and re-hosted through the
// normal social media store (IG CDN urls expire — never hotlink), caption
// prefilled, source 'instagram'.
//
// Connection: REUSES the socialMetrics fields — entity integrations
// metaAccessToken + metaIgUserId (Instagram Business/Creator account id).
// The ads house token carries no IG permissions, so this is per-client only.
// Not connected → { connected:false } (a hint, not an error).
//
// Surfaces: management only for now (admin + /api/my — the /api/my prefix is
// already gated by the `community` flag via GATES). The app's one-click
// surface rides the same helpers next (poster-gated, contract §8).
//
// Remove: this file + the mount call in index.js.

const { HttpError, asyncHandler } = require('./http');

const GRAPH = 'https://graph.facebook.com/v19.0';
const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type,thumbnail_url}';
const MAX_ITEMS_PER_IMPORT = 10; // matches social.js MAX_MEDIA_PER_POST

function mount(app, { db, auth, social, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  const connection = (entityId) => {
    const i = db.getEntityIntegrations ? (db.getEntityIntegrations(entityId) || {}) : {};
    return { token: (i.metaAccessToken || '').trim(), igUserId: (i.metaIgUserId || '').trim() };
  };

  async function graph(path, token) {
    const res = await doFetch(`${GRAPH}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `Instagram API error (${res.status})`;
      throw new HttpError(502, `Instagram said: ${String(msg).slice(0, 200)}`);
    }
    return body;
  }

  // Recent media, shaped for a picker grid.
  async function listMedia(entityId) {
    const c = connection(entityId);
    if (!c.token || !c.igUserId) return { connected: false, media: [] };
    const out = await graph(`${c.igUserId}/media?fields=${MEDIA_FIELDS}&limit=30`, c.token);
    const media = (out.data || []).map((m) => ({
      id: m.id,
      type: m.media_type, // IMAGE | VIDEO | CAROUSEL_ALBUM
      caption: m.caption || '',
      thumbnailUrl: m.thumbnail_url || m.media_url || '',
      permalink: m.permalink || '',
      timestamp: m.timestamp || '',
      childCount: m.children?.data?.length || 0,
    }));
    return { connected: true, media };
  }

  // Download one IG CDN url and re-host it via the social media store.
  async function fetchAndStore(entityId, url, index) {
    const res = await doFetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new HttpError(502, 'Could not download that media from Instagram');
    const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    // social.saveMedia enforces the size cap + mime rules and returns the
    // served item shape ({ id, kind, url, mime }).
    return social.saveMedia(entityId, { name: `instagram-${index}`, mime, data: buf.toString('base64') });
  }

  // One click: pull the IG item, re-host its media, publish as a post.
  async function importMedia(entityId, body) {
    const c = connection(entityId);
    if (!c.token || !c.igUserId) throw new HttpError(400, 'Connect Instagram first (Integrations → Meta, with an Instagram account id)');
    const mediaId = String((body || {}).mediaId || '').trim();
    if (!mediaId) throw new HttpError(400, 'mediaId required');
    const m = await graph(`${mediaId}?fields=${MEDIA_FIELDS}`, c.token);
    const sources = m.media_type === 'CAROUSEL_ALBUM'
      ? (m.children?.data || []).map((ch) => ({ url: ch.media_url, video: ch.media_type === 'VIDEO' }))
      : [{ url: m.media_url, video: m.media_type === 'VIDEO' }];
    const usable = sources.filter((s) => s.url).slice(0, MAX_ITEMS_PER_IMPORT);
    if (!usable.length) throw new HttpError(400, 'That Instagram post has no importable media');
    const media = [];
    for (let i = 0; i < usable.length; i++) media.push(await fetchAndStore(entityId, usable[i].url, i));
    return social.createPost(entityId, {
      communityId: String((body || {}).communityId || ''),
      body: typeof body.caption === 'string' ? body.caption : (m.caption || ''),
      media,
      global: !!(body || {}).global,
      publish: (body || {}).publish !== false,
      source: 'instagram',
    }, { email: 'instagram-import' });
  }

  // ── routes (dual surface; /api/my is community-flag-gated via GATES) ──
  const A = '/api/admin/entities/:entityId/social/instagram';
  const M = '/api/my/social/instagram';
  const eid = (req) => String(req.query.entityId || (req.body || {}).entityId || '');
  const view = auth.requirePermission('campaigns.view', eid);
  const manage = auth.requirePermission('campaigns.approve', eid);

  app.get(`${A}/media`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await listMedia(req.params.entityId))));
  app.post(`${A}/import`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await importMedia(req.params.entityId, req.body || {}))));
  app.get(`${M}/media`, auth.requireAuth, view, asyncHandler(async (req, res) => res.json(await listMedia(eid(req)))));
  app.post(`${M}/import`, auth.requireAuth, manage, asyncHandler(async (req, res) => res.json(await importMedia(eid(req), req.body || {}))));

  return { listMedia, importMedia };
}

module.exports = { mount };
