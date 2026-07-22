// ─── Map Studio: self-service event maps ─────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `map_places`, `map_configs` and
// `map_events` tables and all /api/mapstudio/* + public /maps/* routes. Mounted
// from index.js with one line + injected deps. Remove that line + this file (+
// mapstudioPage.js) and drop the map_* tables to uninstall. Spec + phases:
// docs/MAP_STUDIO_SPEC.md.
//
// What it is: an AM or client builds the event map themselves (pins, logos,
// descriptions, CTAs, filter categories, camera), then publishes it as a
// standalone page at /maps/:slug served by Pulse. The Howler app's existing
// per-event map WebView URL points at that page — no app release needed.
// Republishing updates the live page instantly (mid-event edits included).
//
// Shared-registry rule (founding decision): map places and Event Ops stations are
// ONE set of physical places. v1 keeps the link on map_places.station_id (+ the
// one-click station import); the live busyness layer reads throughput by that id,
// NEVER by name. Don't add another place-like table — see the spec.
//
// Security notes: everything that reaches the public page is sanitised HERE at
// write time (colors must be hex, icons plain text, logos data:image/* only, CTA
// URLs never javascript:/data:). Drafts are never publicly readable — the public
// routes serve only the immutable published snapshot. Beacons are anonymous
// aggregate counters (kind + placeId), deliberately no identity and no location.

const crypto = require('crypto');
const flags = require('./flags');
const { renderMapPage } = require('./mapstudioPage');

// The festival starter pack — every new map begins with these categories.
const DEFAULT_CATEGORIES = [
  { key: 'stage', label: 'Stages', color: '#ff5c8a', icon: '🎤' },
  { key: 'bar', label: 'Bars', color: '#f2b135', icon: '🍺' },
  { key: 'food', label: 'Food', color: '#fd7c3e', icon: '🌮' },
  { key: 'vendor', label: 'Vendors', color: '#a583ff', icon: '🛍️' },
  { key: 'entrance', label: 'Entrances', color: '#3ecf74', icon: '🚪' },
  { key: 'facility', label: 'Facilities', color: '#4aa3ff', icon: '🚻' },
  { key: 'medical', label: 'Medical', color: '#ff5449', icon: '➕' },
];
// Event Ops station kinds → starter category keys (for the import).
const STATION_KIND_TO_CAT = { bar: 'bar', gate: 'entrance', booth: 'vendor', topup: 'facility', vendor: 'vendor', other: 'facility' };

const STYLE_KEYS = ['dark', 'streets', 'satellite', 'outdoors', 'standard'];
const LOGO_CAP = 300 * 1024; // ~300KB data-URL per place logo (matches entity-logo convention)

// ── sanitisers (write-time; the public page trusts what's in the DB) ─────────────
const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max).trim();
const plain = (v, max = 200) => str(v, max).replace(/[<>"'&]/g, ''); // icons/labels that land in HTML attrs
const hexColor = (v, fb) => (/^#[0-9a-fA-F]{3,8}$/.test(str(v, 12)) ? str(v, 12) : fb);
const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clampLat = (v) => Math.max(-90, Math.min(90, num(v)));
const clampLng = (v) => Math.max(-180, Math.min(180, num(v)));
function safeLogo(v) {
  const s = String(v || '');
  if (!s) return '';
  if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s)) return '';
  return s.length <= LOGO_CAP ? s : '';
}
function safeCtaUrl(v) {
  const s = str(v, 600);
  if (!s) return '';
  if (/^(javascript|data|vbscript|file|blob):/i.test(s)) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // app deep links (howler://…)
  return '';
}

function mount(app, { db, auth, eventops }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

  sql.exec(`
    CREATE TABLE IF NOT EXISTS map_configs (
      suite_id     TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      style        TEXT NOT NULL DEFAULT 'dark',
      camera       TEXT NOT NULL DEFAULT '{}',      -- {lat,lng,zoom,pitch,bearing}
      categories   TEXT NOT NULL DEFAULT '[]',
      slug         TEXT NOT NULL DEFAULT '',        -- public path once published
      published    TEXT NOT NULL DEFAULT '',        -- immutable snapshot JSON ('' = never published)
      published_at TEXT NOT NULL DEFAULT '',
      version      INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_map_configs_slug ON map_configs(slug) WHERE slug != '';
  `);
  // Howler event link: lets the Howler app resolve "published map for event N"
  // straight from Pulse (GET /api/maps/by-event/:id) — no Howler admin field needed.
  try { sql.exec("ALTER TABLE map_configs ADD COLUMN howler_event_id TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  // Outsourced maps live in the same registry: when external_url is set, publish
  // serves/resolves THAT url instead of the studio-built page.
  try { sql.exec("ALTER TABLE map_configs ADD COLUMN external_url TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS map_places (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      suite_id     TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'facility',
      icon         TEXT NOT NULL DEFAULT '',
      logo         TEXT NOT NULL DEFAULT '',        -- data:image/* (write-time validated)
      description  TEXT NOT NULL DEFAULT '',
      cta_label    TEXT NOT NULL DEFAULT '',
      cta_url      TEXT NOT NULL DEFAULT '',
      lat          REAL NOT NULL DEFAULT 0,
      lng          REAL NOT NULL DEFAULT 0,
      show_in_filters INTEGER NOT NULL DEFAULT 1,
      sort         INTEGER NOT NULL DEFAULT 0,
      station_id   TEXT NOT NULL DEFAULT '',        -- Event Ops station link (shared registry)
      size         TEXT NOT NULL DEFAULT 'm',       -- pin size: s | m | l
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_places_suite ON map_places(suite_id);
    CREATE TABLE IF NOT EXISTS map_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      suite_id TEXT NOT NULL,
      kind     TEXT NOT NULL,                       -- open | poi_tap | cta_click | filter
      place_id TEXT NOT NULL DEFAULT '',
      at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_map_events_suite ON map_events(suite_id, at);
  `);
  // Existing deployments created map_places before `size` existed.
  try { sql.exec("ALTER TABLE map_places ADD COLUMN size TEXT NOT NULL DEFAULT 'm'"); } catch { /* already there */ }

  // ── access guards (mirror eventops: view = suite member; manage = map.manage) ──
  const isAdmin = (u) => u && u.role === 'admin';
  const canView = (user, suiteId) => isAdmin(user) || auth.canAccessSuite(user, suiteId);
  const canManage = (user, su) => isAdmin(user) || (auth.canAccessSuite(user, su.id) && auth.hasPermission(user, su.entityId, 'map.manage'));
  function gateSuite(req, res, { manage = false } = {}) {
    const su = db.getSuite(req.params.suiteId);
    if (!su) { res.status(404).json({ error: 'Event not found' }); return null; }
    if (manage ? !canManage(req.user, su) : !canView(req.user, su.id)) {
      res.status(403).json({ error: 'Not allowed' }); return null;
    }
    return su;
  }
  const canEntity = (user, entityId) => isAdmin(user) || ((user?.entityIds || []).includes(entityId) && auth.hasPermission(user, entityId, 'map.manage'));

  // ── config + place shapers ──────────────────────────────────────────────────
  function getConfig(su) {
    let r = sql.prepare('SELECT * FROM map_configs WHERE suite_id=?').get(su.id);
    if (!r) {
      sql.prepare('INSERT INTO map_configs (suite_id, entity_id, name, categories, updated_at) VALUES (?,?,?,?,?)')
        .run(su.id, su.entityId, su.name || 'Event map', JSON.stringify(DEFAULT_CATEGORIES), now());
      r = sql.prepare('SELECT * FROM map_configs WHERE suite_id=?').get(su.id);
    }
    return r;
  }
  const configView = (r) => ({
    suiteId: r.suite_id, name: r.name, style: r.style, camera: J(r.camera, {}),
    categories: J(r.categories, DEFAULT_CATEGORIES), slug: r.slug,
    published: !!r.published, publishedAt: r.published_at, version: r.version,
    publicPath: r.slug ? `/maps/${r.slug}` : '', howlerEventId: r.howler_event_id || '',
    externalUrl: r.external_url || '', updatedAt: r.updated_at,
  });
  const placeView = (p) => ({
    id: p.id, name: p.name, kind: p.kind, icon: p.icon, logo: p.logo, description: p.description,
    ctaLabel: p.cta_label, ctaUrl: p.cta_url, lat: p.lat, lng: p.lng, size: p.size || 'm',
    showInFilters: !!p.show_in_filters, sort: p.sort, stationId: p.station_id || null,
    createdAt: p.created_at, updatedAt: p.updated_at,
  });
  const listPlaces = (suiteId) => sql.prepare('SELECT * FROM map_places WHERE suite_id=? ORDER BY sort, created_at').all(suiteId).map(placeView);

  function cleanCategories(cats) {
    if (!Array.isArray(cats)) return DEFAULT_CATEGORIES;
    const out = cats.slice(0, 24).map((c, i) => ({
      key: plain(c.key, 24).toLowerCase().replace(/[^a-z0-9_-]/g, '') || `cat${i}`,
      label: plain(c.label, 40) || `Category ${i + 1}`,
      color: hexColor(c.color, '#8899aa'),
      icon: plain(c.icon, 8) || '📍',
    }));
    const seen = new Set();
    return out.filter((c) => !seen.has(c.key) && seen.add(c.key));
  }
  function cleanPlaceBody(b, cats) {
    const kinds = new Set((cats || DEFAULT_CATEGORIES).map((c) => c.key));
    return {
      name: plain(b.name, 80),
      kind: kinds.has(String(b.kind)) ? String(b.kind) : (cats[0]?.key || 'facility'),
      icon: plain(b.icon, 8),
      logo: safeLogo(b.logo),
      description: str(b.description, 600),
      cta_label: plain(b.ctaLabel, 40),
      cta_url: safeCtaUrl(b.ctaUrl),
      lat: clampLat(b.lat), lng: clampLng(b.lng),
      show_in_filters: b.showInFilters === false ? 0 : 1,
      sort: Math.max(0, Math.min(9999, num(b.sort, 0))),
      size: ['s', 'm', 'l'].includes(b.size) ? b.size : 'm',
    };
  }

  const mapboxToken = () => db.getSetting('mapbox_public_token', '') || process.env.MAPBOX_TOKEN || '';

  // The app-wide CSP (server/http.js) pins script-src to 'self' — correct for the
  // SPA, but it kills the map pages: they carry their own inline <script> and load
  // Mapbox GL from api.mapbox.com (script/styles/tiles/glyphs + blob: workers).
  // These are static server-rendered pages with no session-scoped actions, so they
  // relax the policy for themselves only (same pattern as surveyWeb/fanOwl).
  const MAP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://api.mapbox.com; style-src 'self' 'unsafe-inline' https://api.mapbox.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.mapbox.com https://events.mapbox.com; worker-src blob:; child-src blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'";
  // Public map: embeddable anywhere (event websites); preview: same-origin iframe only.
  const mapPageHeaders = (res, { embeddable }) => {
    res.set('Content-Security-Policy', MAP_CSP + (embeddable ? '; frame-ancestors *' : "; frame-ancestors 'self'"));
    if (embeddable) res.removeHeader('X-Frame-Options');
  };

  // ════════════════════════════ authed studio API ═══════════════════════════════
  // Which of my entities can use Map Studio (drives the client nav item).
  app.get('/api/mapstudio/enabled', auth.requireAuth, (req, res) => {
    const ids = isAdmin(req.user) ? db.listEntities().map((e) => e.id) : (req.user.entityIds || []);
    res.json({ entities: ids.filter((eid) => canEntity(req.user, eid)) });
  });

  // Event picker for an entity (both surfaces).
  app.get('/api/mapstudio/entities/:entityId/suites', auth.requireAuth, (req, res) => {
    if (!canEntity(req.user, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const suites = db.listSuitesForEntity(req.params.entityId).map((s) => {
      const c = sql.prepare('SELECT slug, published, version FROM map_configs WHERE suite_id=?').get(s.id);
      return { id: s.id, name: s.name, published: !!(c && c.published), publicPath: c && c.slug ? `/maps/${c.slug}` : '' };
    });
    res.json({ suites });
  });

  // Full editor state for one event.
  app.get('/api/mapstudio/suites/:suiteId', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const cfg = getConfig(su);
    // token rides along for the editor's venue-search geocoding (pk. tokens are public by design)
    res.json({ config: configView(cfg), places: listPlaces(su.id), tokenSet: !!mapboxToken(), token: mapboxToken(), canManage: canManage(req.user, su) });
  });

  // Update config (name / style / camera / categories).
  app.put('/api/mapstudio/suites/:suiteId/config', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const cfg = getConfig(su);
    const b = req.body || {};
    const cats = b.categories !== undefined ? cleanCategories(b.categories) : J(cfg.categories, DEFAULT_CATEGORIES);
    const cam = b.camera !== undefined ? {
      lat: clampLat(b.camera?.lat), lng: clampLng(b.camera?.lng),
      zoom: Math.max(1, Math.min(22, num(b.camera?.zoom, 15))),
      pitch: Math.max(0, Math.min(85, num(b.camera?.pitch, 0))),
      bearing: Math.max(-180, Math.min(180, num(b.camera?.bearing, 0))),
    } : J(cfg.camera, {});
    sql.prepare('UPDATE map_configs SET name=?, style=?, camera=?, categories=?, howler_event_id=?, external_url=?, updated_at=? WHERE suite_id=?').run(
      b.name !== undefined ? (plain(b.name, 80) || su.name || 'Event map') : cfg.name,
      STYLE_KEYS.includes(b.style) ? b.style : cfg.style,
      JSON.stringify(cam), JSON.stringify(cats),
      b.howlerEventId !== undefined ? String(b.howlerEventId).replace(/\D/g, '').slice(0, 20) : (cfg.howler_event_id || ''),
      b.externalUrl !== undefined ? (/^https:\/\//i.test(str(b.externalUrl, 600)) ? str(b.externalUrl, 600) : '') : (cfg.external_url || ''),
      now(), su.id,
    );
    res.json({ config: configView(sql.prepare('SELECT * FROM map_configs WHERE suite_id=?').get(su.id)) });
  });

  // Places CRUD.
  app.post('/api/mapstudio/suites/:suiteId/places', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    if (sql.prepare('SELECT COUNT(*) c FROM map_places WHERE suite_id=?').get(su.id).c >= 300) {
      return res.status(400).json({ error: 'Place limit reached (300).' });
    }
    const cfg = getConfig(su);
    const c = cleanPlaceBody(req.body || {}, J(cfg.categories, DEFAULT_CATEGORIES));
    if (!c.name) return res.status(400).json({ error: 'Give the place a name.' });
    const id = uuid(); const ts = now();
    sql.prepare(`INSERT INTO map_places (id, entity_id, suite_id, name, kind, icon, logo, description, cta_label, cta_url, lat, lng, show_in_filters, sort, station_id, size, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, su.entityId, su.id, c.name, c.kind, c.icon, c.logo, c.description, c.cta_label, c.cta_url, c.lat, c.lng, c.show_in_filters, c.sort, str(req.body?.stationId, 64), c.size, ts, ts);
    res.json({ place: placeView(sql.prepare('SELECT * FROM map_places WHERE id=?').get(id)) });
  });
  app.put('/api/mapstudio/suites/:suiteId/places/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const p = sql.prepare('SELECT * FROM map_places WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!p) return res.status(404).json({ error: 'Place not found' });
    const cfg = getConfig(su);
    const merged = { ...placeView(p), ...(req.body || {}) };
    const c = cleanPlaceBody(merged, J(cfg.categories, DEFAULT_CATEGORIES));
    if (!c.name) return res.status(400).json({ error: 'Give the place a name.' });
    sql.prepare(`UPDATE map_places SET name=?, kind=?, icon=?, logo=?, description=?, cta_label=?, cta_url=?, lat=?, lng=?, show_in_filters=?, sort=?, station_id=?, size=?, updated_at=? WHERE id=?`)
      .run(c.name, c.kind, c.icon, c.logo, c.description, c.cta_label, c.cta_url, c.lat, c.lng, c.show_in_filters, c.sort, str(merged.stationId, 64), c.size, now(), p.id);
    res.json({ place: placeView(sql.prepare('SELECT * FROM map_places WHERE id=?').get(p.id)) });
  });
  app.delete('/api/mapstudio/suites/:suiteId/places/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    sql.prepare('DELETE FROM map_places WHERE id=? AND suite_id=?').run(req.params.id, su.id);
    res.json({ ok: true });
  });

  // One-click import of Event Ops stations as places (shared registry, linked by id).
  app.post('/api/mapstudio/suites/:suiteId/import-stations', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    if (!eventops || !eventops.listStations) return res.json({ imported: 0, stations: 0 });
    let stations = [];
    try { stations = eventops.listStations(su.id) || []; } catch { stations = []; }
    const cfg = getConfig(su);
    const cats = J(cfg.categories, DEFAULT_CATEGORIES);
    const cam = J(cfg.camera, {});
    const existing = new Set(sql.prepare('SELECT station_id FROM map_places WHERE suite_id=? AND station_id!=?').all(su.id, '').map((r) => r.station_id));
    let imported = 0;
    for (const st of stations) {
      if (st.name === 'Hive' || existing.has(st.id)) continue; // warehouse never shows to attendees
      const kind = STATION_KIND_TO_CAT[st.kind] || 'facility';
      const c = cleanPlaceBody({ name: st.name, kind, lat: cam.lat || 0, lng: cam.lng || 0 }, cats);
      const id = uuid(); const ts = now();
      sql.prepare(`INSERT INTO map_places (id, entity_id, suite_id, name, kind, icon, logo, description, cta_label, cta_url, lat, lng, show_in_filters, sort, station_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, su.entityId, su.id, c.name, c.kind, '', '', '', '', '', c.lat, c.lng, 1, 0, st.id, ts, ts);
      imported++;
    }
    res.json({ imported, stations: stations.length, places: listPlaces(su.id) });
  });

  // Publish: snapshot draft → immutable published JSON + slug.
  app.post('/api/mapstudio/suites/:suiteId/publish', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const cfg = getConfig(su);
    let slug = cfg.slug;
    if (!slug) {
      const base = (su.name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'event';
      do { slug = `${base}-${crypto.randomBytes(3).toString('hex')}`; }
      while (sql.prepare('SELECT 1 FROM map_configs WHERE slug=?').get(slug));
    }
    const snapshot = {
      name: cfg.name || su.name || 'Event map',
      style: cfg.style, camera: J(cfg.camera, {}), categories: J(cfg.categories, DEFAULT_CATEGORIES),
      places: listPlaces(su.id),
    };
    sql.prepare('UPDATE map_configs SET slug=?, published=?, published_at=?, version=version+1, updated_at=? WHERE suite_id=?')
      .run(slug, JSON.stringify(snapshot), now(), now(), su.id);
    res.json({ config: configView(sql.prepare('SELECT * FROM map_configs WHERE suite_id=?').get(su.id)) });
  });
  app.post('/api/mapstudio/suites/:suiteId/unpublish', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    sql.prepare("UPDATE map_configs SET published='', published_at='', updated_at=? WHERE suite_id=?").run(now(), su.id);
    res.json({ ok: true });
  });

  // Editor preview page (authed, DRAFT data, edit mode — iframed by MapStudio.jsx).
  app.get('/api/mapstudio/suites/:suiteId/preview', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const cfg = getConfig(su);
    const config = { name: cfg.name, style: cfg.style, camera: J(cfg.camera, {}), categories: J(cfg.categories, DEFAULT_CATEGORIES), places: listPlaces(su.id) };
    res.setHeader('Cache-Control', 'no-store');
    mapPageHeaders(res, { embeddable: false });
    res.type('html').send(renderMapPage({ mode: 'edit', title: `${config.name} — preview`, token: mapboxToken(), config }));
  });

  // Tap analytics for the editor's engagement panel.
  app.get('/api/mapstudio/suites/:suiteId/analytics', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const count = (kind) => sql.prepare('SELECT COUNT(*) c FROM map_events WHERE suite_id=? AND kind=? AND at>=?').get(su.id, kind, since).c;
    const top = sql.prepare(`SELECT place_id, COUNT(*) c FROM map_events WHERE suite_id=? AND kind='poi_tap' AND at>=? AND place_id!='' GROUP BY place_id ORDER BY c DESC LIMIT 8`).all(su.id, since);
    const names = new Map(sql.prepare('SELECT id, name FROM map_places WHERE suite_id=?').all(su.id).map((r) => [r.id, r.name]));
    res.json({
      sinceDays: 7, opens: count('open'), poiTaps: count('poi_tap'), ctaClicks: count('cta_click'),
      topPlaces: top.map((t) => ({ placeId: t.place_id, name: names.get(t.place_id) || '(removed)', taps: t.c })),
    });
  });

  // Mapbox public token (admin-set; pk. tokens ship to every browser by design).
  app.get('/api/mapstudio/token', auth.requireAuth, (req, res) => {
    const t = mapboxToken();
    res.json({ set: !!t, mask: t ? `${t.slice(0, 8)}…${t.slice(-4)}` : '', fromEnv: !db.getSetting('mapbox_public_token', '') && !!process.env.MAPBOX_TOKEN });
  });
  app.put('/api/mapstudio/token', auth.requireAdmin, (req, res) => {
    const t = str(req.body?.token, 200);
    if (t && !/^pk\./.test(t)) return res.status(400).json({ error: 'Use a Mapbox PUBLIC token (starts with pk.) — never a secret sk. token.' });
    db.setSetting('mapbox_public_token', t);
    res.json({ set: !!mapboxToken() });
  });

  // ════════════════════════════ public routes (published snapshot ONLY) ══════════
  // The mapstudio feature flag is the kill switch: flag off for the owning client
  // → the studio API is gated (flags.js GATES) AND the public map stops serving.
  const bySlug = (slug) => {
    const r = sql.prepare('SELECT * FROM map_configs WHERE slug=?').get(String(slug || '').slice(0, 80));
    return r && flags.enabled(r.entity_id, 'mapstudio') ? r : null;
  };

  app.get('/maps/:slug', (req, res) => {
    mapPageHeaders(res, { embeddable: true });
    const r = bySlug(req.params.slug);
    if (!r || !r.published) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Map not found</title><body style="font-family:sans-serif;background:#101418;color:#eef1f5;display:grid;place-items:center;height:100vh;margin:0"><p>This event map isn’t published.</p>');
    if (r.external_url) return res.redirect(302, r.external_url); // outsourced map: one link, wherever it lives
    const config = J(r.published, null);
    if (!config) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=60'); // fresh-ish, but survives festival re-opens
    res.type('html').send(renderMapPage({ mode: 'live', title: config.name || 'Event map', token: mapboxToken(), config, beaconPath: `/maps/${r.slug}/e` }));
  });

  // Howler-app resolver: "does event N have a published map?" — public, tiny, and
  // deliberately quiet on misses (the app treats any non-200 as "use the old path").
  app.get('/api/maps/by-event/:eventId', (req, res) => {
    const id = String(req.params.eventId || '').replace(/\D/g, '').slice(0, 20);
    if (!id) return res.status(404).json({ error: 'No map' });
    const r = sql.prepare("SELECT * FROM map_configs WHERE howler_event_id=? AND published!='' AND slug!=''").get(id);
    if (!r || !flags.enabled(r.entity_id, 'mapstudio')) return res.status(404).json({ error: 'No map' });
    // Outsourced/professional map: the registry hands the app that URL instead.
    // Studio maps get ?app=1 so the page insets its header around the app's own
    // back/refresh overlay buttons (external pro maps are passed through untouched).
    const url = r.external_url || `${req.protocol}://${req.get('host')}/maps/${r.slug}?app=1`;
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (req.query.redirect) return res.redirect(302, url);
    res.json({ url, slug: r.slug, version: r.version, name: r.name });
  });

  app.get('/maps/:slug/config.json', (req, res) => {
    const r = bySlug(req.params.slug);
    if (!r || !r.published) return res.status(404).json({ error: 'Not published' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ version: r.version, publishedAt: r.published_at, ...J(r.published, {}) });
  });

  // Anonymous beacon. Body may arrive as a Blob-typed sendBeacon (json parsed upstream).
  app.post('/maps/:slug/e', (req, res) => {
    const r = bySlug(req.params.slug);
    if (!r || !r.published) return res.status(204).end();
    const kind = String(req.body?.kind || '').slice(0, 20);
    if (!['open', 'poi_tap', 'cta_click', 'filter'].includes(kind)) return res.status(204).end();
    // soft cap: keep the table from growing unbounded under abuse
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const recent = sql.prepare('SELECT COUNT(*) c FROM map_events WHERE suite_id=? AND at >= ?').get(r.suite_id, cutoff).c;
    if (recent < 2000) sql.prepare('INSERT INTO map_events (suite_id, kind, place_id, at) VALUES (?,?,?,?)').run(r.suite_id, kind, str(req.body?.placeId, 80), now());
    res.status(204).end();
  });

  console.log('[mapstudio] self-service event maps module mounted');
  return {
    // for future modules (live layer, Owl tools): resolve a suite's published map
    publishedFor: (suiteId) => { const r = sql.prepare('SELECT * FROM map_configs WHERE suite_id=?').get(suiteId); return r && r.published ? { slug: r.slug, version: r.version, ...J(r.published, {}) } : null; },
    listPlaces,
  };
}

module.exports = { mount, DEFAULT_CATEGORIES };
