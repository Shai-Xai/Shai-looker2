// ─── Event Media Assets: per-event media served to the Howler app ───────────────
// SELF-CONTAINED, DISPOSABLE MODULE — the Phase-1 pilot slice of "Pulse as the
// event's presentation layer". Owns the `event_assets` + `event_asset_media`
// tables and all /api/eventassets/* + public /api/app/event-assets/* routes.
// Mounted from index.js with one line. Remove that line + this file (+ the
// EventAssets UI) and drop the tables to uninstall.
//
// What it is: an AM or client uploads an event's media (pilot slots: header
// image / header video / event logo) against the suite, previews it, and
// publishes. The Howler app then asks Pulse "what published assets does Howler
// event N have?" (GET /api/app/event-assets/by-event/:eventId — same pattern as
// Map Studio's by-event resolver) and OVERLAYS them on the event data it already
// fetched from Howler GraphQL. Anything unpublished/missing falls back to
// Howler's own media, so the failure mode is "nothing changes". Changing a
// published asset updates every phone on next event open — no app release.
//
// Storage: media bytes go to DATA_DIR/event_assets/<id> (same disk convention as
// social_media) and are served public + immutable with HTTP Range support. At
// scale the bytes should move to R2 + CDN exactly like social.js's presigned
// path — the slot rows store a URL, so swapping the store later changes nothing
// in the manifest contract.
//
// Kill switch: the `eventassets` feature flag (default OFF, beta). Flag off for
// the owning client → the studio API is gated (flags.js GATES) AND the public
// manifest + media stop serving (checked here), so the app falls back instantly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError, asyncHandler } = require('./http');
const flags = require('./flags');

// Pilot slot registry — the app-facing contract. Keyed to the Howler GraphQL
// fields each slot overlays. Grow this list (per-artist, per-ticket-type…) as
// the requirement-sync phase lands; keep keys snake_case and stable forever.
const SLOTS = [
  { key: 'header_image', label: 'Header image', accept: 'image', overlays: 'event.headerImage' },
  { key: 'header_video', label: 'Header video', accept: 'video', overlays: 'event.headerVideo' },
  { key: 'logo', label: 'Event logo', accept: 'image', overlays: 'event.logo' },
];
const SLOT_KEYS = new Set(SLOTS.map((s) => s.key));
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // header videos are short loops; 25MB is plenty for the pilot

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

  const MEDIA_DIR = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), 'event_assets');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  sql.exec(`
    CREATE TABLE IF NOT EXISTS event_assets (
      suite_id      TEXT NOT NULL,
      slot          TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      draft_url     TEXT NOT NULL DEFAULT '',
      draft_mime    TEXT NOT NULL DEFAULT '',
      published_url  TEXT NOT NULL DEFAULT '',
      published_mime TEXT NOT NULL DEFAULT '',
      updated_by    TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL,
      published_at  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (suite_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_event_assets_entity ON event_assets(entity_id);
    CREATE TABLE IF NOT EXISTS event_asset_media (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      mime       TEXT NOT NULL DEFAULT '',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // ── access guards (mirror mapstudio: view = suite member; manage = map.manage,
  // the shared "event content" permission — a dedicated perm can split later) ──
  const isAdmin = (u) => u && u.role === 'admin';
  const canManage = (user, su) => isAdmin(user) || (auth.canAccessSuite(user, su.id) && auth.hasPermission(user, su.entityId, 'map.manage'));
  const canEntity = (user, entityId) => isAdmin(user) || ((user?.entityIds || []).includes(entityId) && auth.hasPermission(user, entityId, 'map.manage'));
  function gateSuite(req, res, { manage = false } = {}) {
    const su = db.getSuite(req.params.suiteId);
    if (!su) { res.status(404).json({ error: 'Event not found' }); return null; }
    if (manage ? !canManage(req.user, su) : !(isAdmin(req.user) || auth.canAccessSuite(req.user, su.id))) {
      res.status(403).json({ error: 'Not allowed' }); return null;
    }
    return su;
  }

  // ── slot rows ───────────────────────────────────────────────────────────────
  const rowsFor = (suiteId) => sql.prepare('SELECT * FROM event_assets WHERE suite_id=?').all(suiteId);
  const slotView = (r) => r && ({
    draftUrl: r.draft_url, draftMime: r.draft_mime,
    publishedUrl: r.published_url, publishedMime: r.published_mime,
    updatedAt: r.updated_at, publishedAt: r.published_at,
    dirty: !!r.draft_url && r.draft_url !== r.published_url,
  });
  function suiteState(su) {
    const by = Object.fromEntries(rowsFor(su.id).map((r) => [r.slot, r]));
    return {
      suiteId: su.id, suiteName: su.name, howlerEventId: su.howlerEventId || '',
      slots: SLOTS.map((s) => ({ ...s, ...( slotView(by[s.key]) || { draftUrl: '', draftMime: '', publishedUrl: '', publishedMime: '', updatedAt: '', publishedAt: '', dirty: false }) })),
    };
  }

  // ── media store (disk pilot path; move to R2+CDN like social.js at scale) ───
  function saveMedia(entityId, { name, mime, data }) {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'Empty media payload');
    if (buf.length > MAX_MEDIA_BYTES) throw new HttpError(400, `Media over the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB cap`);
    const m = String(mime || '');
    if (!/^(image|video)\//.test(m)) throw new HttpError(400, 'Only image/* or video/* media is accepted');
    if (/^image\/hei[cf]/.test(m)) throw new HttpError(400, 'HEIC photos must be converted to JPEG first — re-pick the photo');
    const id = uuid();
    fs.writeFileSync(path.join(MEDIA_DIR, id), buf);
    sql.prepare('INSERT INTO event_asset_media (id, entity_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, entityId, String(name || 'media').slice(0, 200), m.slice(0, 100), buf.length, now());
    return { id, url: `/api/app/event-assets/media/${id}`, mime: m, size: buf.length };
  }
  // Only URLs we minted (or https) may land in a slot — never javascript:/data:.
  const safeAssetUrl = (v) => {
    const s = String(v || '').slice(0, 600).trim();
    if (!s) return '';
    if (s.startsWith('/api/app/event-assets/media/')) return s;
    if (/^https:\/\//i.test(s)) return s;
    return '';
  };

  // ════════════════════════════ authed studio API ═══════════════════════════════
  // Which of my entities can use Event Media (drives the client nav item).
  app.get('/api/eventassets/enabled', auth.requireAuth, (req, res) => {
    const ids = isAdmin(req.user) ? db.listEntities().map((e) => e.id) : (req.user.entityIds || []);
    res.json({ entities: ids.filter((eid) => canEntity(req.user, eid) && flags.enabled(eid, 'eventassets')) });
  });

  // Event picker for an entity (both surfaces).
  app.get('/api/eventassets/entities/:entityId/suites', auth.requireAuth, (req, res) => {
    if (!canEntity(req.user, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const suites = db.listSuitesForEntity(req.params.entityId).map((s) => {
      const pub = sql.prepare("SELECT COUNT(*) c FROM event_assets WHERE suite_id=? AND published_url!=''").get(s.id).c;
      return { id: s.id, name: s.name, howlerEventId: s.howlerEventId || '', publishedSlots: pub };
    });
    res.json({ suites });
  });

  // Full slot state for one event.
  app.get('/api/eventassets/suites/:suiteId', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    res.json({ ...suiteState(su), canManage: canManage(req.user, su) });
  });

  // Upload media bytes (base64 body, pilot path) → served URL for a slot.
  app.post('/api/eventassets/suites/:suiteId/media', auth.requireAuth, asyncHandler(async (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    res.json(saveMedia(su.entityId, req.body || {}));
  }));

  // Set / clear a slot's draft.
  app.put('/api/eventassets/suites/:suiteId/slots/:slot', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const slot = String(req.params.slot);
    if (!SLOT_KEYS.has(slot)) return res.status(400).json({ error: 'Unknown slot' });
    const url = safeAssetUrl((req.body || {}).url);
    const mime = String((req.body || {}).mime || '').slice(0, 100);
    sql.prepare(`INSERT INTO event_assets (suite_id, slot, entity_id, draft_url, draft_mime, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(suite_id, slot) DO UPDATE SET draft_url=excluded.draft_url, draft_mime=excluded.draft_mime, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(su.id, slot, su.entityId, url, url ? mime : '', req.user.email || '', now());
    res.json(suiteState(su));
  });

  // Publish: drafts become the live manifest (empty draft unpublishes the slot).
  app.post('/api/eventassets/suites/:suiteId/publish', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    sql.prepare('UPDATE event_assets SET published_url=draft_url, published_mime=draft_mime, published_at=? WHERE suite_id=?').run(now(), su.id);
    res.json(suiteState(su));
  });
  app.post('/api/eventassets/suites/:suiteId/unpublish', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    sql.prepare("UPDATE event_assets SET published_url='', published_mime='', published_at='' WHERE suite_id=?").run(su.id);
    res.json(suiteState(su));
  });

  // ════════════════════════════ public routes (app-facing) ══════════════════════
  // The manifest — "what published assets does Howler event N have?". Public and
  // deliberately quiet on misses: the app treats any non-200 (or empty assets)
  // as "use the Howler media as always". Mirrors /api/maps/by-event/:eventId.
  app.get('/api/app/event-assets/by-event/:eventId', (req, res) => {
    const id = String(req.params.eventId || '').replace(/\D/g, '').slice(0, 20);
    if (!id) return res.status(404).json({ error: 'No assets' });
    const su = sql.prepare('SELECT id, entity_id FROM suites WHERE howler_event_id=?').get(id);
    if (!su || !flags.enabled(su.entity_id, 'eventassets')) return res.status(404).json({ error: 'No assets' });
    const base = `${req.protocol}://${req.get('host')}`;
    const assets = {};
    for (const r of rowsFor(su.id)) {
      if (!r.published_url) continue;
      assets[r.slot] = {
        url: r.published_url.startsWith('/') ? base + r.published_url : r.published_url,
        mime: r.published_mime, updatedAt: r.published_at,
      };
    }
    if (!Object.keys(assets).length) return res.status(404).json({ error: 'No assets' });
    res.setHeader('Cache-Control', 'public, max-age=60'); // changes reach phones within a minute
    res.json({ eventId: id, assets });
  });

  // Serve disk-stored media — public, immutable (ids are unguessable UUIDs).
  // HTTP Range support so iOS AVPlayer can stream header videos.
  app.get('/api/app/event-assets/media/:id', asyncHandler(async (req, res) => {
    const m = sql.prepare('SELECT * FROM event_asset_media WHERE id=?').get(String(req.params.id));
    const file = m && path.join(MEDIA_DIR, m.id);
    if (!m || !fs.existsSync(file) || !flags.enabled(m.entity_id, 'eventassets')) return res.status(404).end();
    res.set('Content-Type', m.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');
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

  console.log('[eventassets] event media assets module mounted');
  return {
    // For future modules (requirement sync, Owl tools): a suite's published manifest.
    publishedFor: (suiteId) => Object.fromEntries(rowsFor(suiteId).filter((r) => r.published_url).map((r) => [r.slot, r.published_url])),
    SLOTS,
  };
}

module.exports = { mount, SLOTS };
