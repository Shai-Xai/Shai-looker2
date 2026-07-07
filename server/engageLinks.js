// ─── Engage Links — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────────────
// A per-client set of useful links (to apps, dashboards, docs…) grouped into
// typed CATEGORIES so a growing list stays easy to navigate. The client-facing
// Engage → Links tab shows category tiles; tapping one drills into just that
// category's links. First category is "App" (seeded with Chotulink).
//
// Per-client + dual-surface (admins manage a client's links via preview; a
// client manages their own), scoped server-side exactly like campaignTemplates:
// one entity-scoped route set, the ownership guard lets an admin act for any
// client. Mount: require('./engageLinks').mount(app, { db, auth });
//
// To remove the whole feature: delete this file + its one mount line in
// index.js (the engage_links rows + seed-flag settings are harmless leftovers).

const crypto = require('crypto');

// Known categories drive the picker + tile icons. `key` is the stored slug; any
// other slug is still accepted (custom categories) and rendered with a default
// icon + a title-cased label client-side. "App" is always first.
const CATALOG = [
  { key: 'app', label: 'App', icon: '📱' },
  { key: 'dashboards', label: 'Dashboards', icon: '📊' },
  { key: 'docs', label: 'Docs & guides', icon: '📄' },
  { key: 'social', label: 'Social', icon: '💬' },
  { key: 'other', label: 'Other', icon: '🔗' },
];

// URL-safe category slug: lowercase, alphanumeric + single hyphens. Falls back to
// 'app' so a link always lands in a real category (never orphaned/uncategorised).
function normalizeCategory(s) {
  const slug = String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'app';
}

// Only accept http(s) URLs (or a root-relative in-app path) — never javascript:
// or other schemes that would be unsafe when opened from a tile.
function cleanUrl(s) {
  const raw = String(s || '').trim().slice(0, 2000);
  if (!raw) return '';
  if (raw.startsWith('/')) return raw; // in-app path
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return ''; // reject other schemes
  return 'https://' + raw; // bare domain → assume https
}

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  sql.exec(`CREATE TABLE IF NOT EXISTS engage_links (
    id         TEXT PRIMARY KEY,
    entity_id  TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'app',
    label      TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engage_links_entity ON engage_links(entity_id);`);

  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => { if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; } return true; };
  const row = (r) => ({ id: r.id, entityId: r.entity_id, category: r.category, label: r.label, url: r.url, sort: r.sort });
  const get = (id) => sql.prepare('SELECT * FROM engage_links WHERE id=?').get(id);
  const listFor = (entityId) => sql.prepare('SELECT * FROM engage_links WHERE entity_id=? ORDER BY category, sort, created_at').all(entityId).map(row);

  const clean = (b = {}) => ({
    label: String(b.label || '').trim().slice(0, 120),
    url: cleanUrl(b.url),
    category: normalizeCategory(b.category),
    sort: Number.isFinite(+b.sort) ? Math.trunc(+b.sort) : 0,
  });

  // Seed the "App → Chotulink" default ONCE per entity (guarded by a flag so a
  // deleted seed link stays deleted). Runs lazily on first read.
  const SEED_KEY = (entityId) => `engage_links_seeded:${entityId}`;
  const ensureSeeded = (entityId) => {
    if (db.getSetting(SEED_KEY(entityId), '') === '1') return;
    db.setSetting(SEED_KEY(entityId), '1');
    const ts = now();
    sql.prepare('INSERT INTO engage_links (id,entity_id,category,label,url,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), entityId, 'app', 'Chotulink', 'https://chotulink.com', 0, ts, ts);
  };

  // Read: links (grouped-friendly, category-ordered) + the category catalog so
  // the client can render tiles/icons/labels from one source of truth.
  app.get('/api/engage-links/:entityId', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    ensureSeeded(req.params.entityId);
    res.json({ links: listFor(req.params.entityId), catalog: CATALOG });
  });

  app.post('/api/engage-links/:entityId', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const c = clean(req.body || {});
    if (!c.label) return res.status(400).json({ error: 'A link name is required' });
    if (!c.url) return res.status(400).json({ error: 'A valid http(s) link is required' });
    const id = crypto.randomUUID(); const ts = now();
    sql.prepare('INSERT INTO engage_links (id,entity_id,category,label,url,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, c.category, c.label, c.url, c.sort, ts, ts);
    res.status(201).json({ link: row(get(id)) });
  });

  app.put('/api/engage-links/:entityId/:id', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cur = get(req.params.id);
    if (!cur || cur.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const c = clean(req.body || {});
    if (!c.label) return res.status(400).json({ error: 'A link name is required' });
    if (!c.url) return res.status(400).json({ error: 'A valid http(s) link is required' });
    sql.prepare('UPDATE engage_links SET category=?,label=?,url=?,sort=?,updated_at=? WHERE id=?')
      .run(c.category, c.label, c.url, c.sort, now(), req.params.id);
    res.json({ link: row(get(req.params.id)) });
  });

  app.delete('/api/engage-links/:entityId/:id', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cur = get(req.params.id);
    if (!cur || cur.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    sql.prepare('DELETE FROM engage_links WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  console.log('[engageLinks] module mounted');
  return { CATALOG, normalizeCategory, cleanUrl, listFor };
}

module.exports = { mount, CATALOG, normalizeCategory, cleanUrl };
