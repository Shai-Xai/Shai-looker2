// ─── Vanity login URLs (white-label) ─────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Gives a client an optional white-labelled
// login at /<slug> (e.g. /kunye) — their logo, colours and a background image, so
// signing in feels like their own product. Owns the `client_slugs` table
// (slug ↔ entity) and these routes:
//   GET  /api/branding/:slug           (PUBLIC)  → non-secret brand for the login
//   GET  /api/admin/entities/:id/slug  (admin)   → the client's current slug
//   PUT  /api/admin/entities/:id/slug  (admin)   → set/clear it (validated)
// Slugs are ADMIN-ONLY (a shared URL namespace — collision/abuse sensitive). The
// login background image rides the normal branding blob (mailer DEFAULTS →
// loginBackground), edited admin-side. To remove the whole feature: delete this
// file + its one mount line in index.js, then drop the client_slugs table.

// Real top-level app paths a slug must never shadow (so /<slug> can't be confused
// with a built-in route once the visitor is signed in).
const RESERVED = new Set([
  'reset', 'magic', 'login', 'logout', 'admin', 'dashboards', 'settings', 'goals', 'alerts',
  'social', 'settlements', 'documents', 'inbox', 'digests', 'engage', 'ask', 'actions', 'segments',
  'suite', 'd', 'clone', 'preview', 'api', 'assets', 'mail-assets', 'sw.js', 'manifest.webmanifest',
  'index.html', 'robots.txt', 'favicon.ico',
]);

// URL-safe handle: lowercase, alphanumeric + single hyphens, trimmed, capped.
function normalizeSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function mount(app, { db, auth, mailer }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS client_slugs (
      slug       TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_slugs_entity ON client_slugs(entity_id);
  `);

  const slugForEntity = (id) => { const r = sql.prepare('SELECT slug FROM client_slugs WHERE entity_id=?').get(id); return r ? r.slug : ''; };
  const entityForSlug = (slug) => { const r = sql.prepare('SELECT entity_id FROM client_slugs WHERE slug=?').get(normalizeSlug(slug)); return r ? r.entity_id : ''; };

  // PUBLIC (no auth): just enough NON-SECRET branding to paint the white-labelled
  // login before anyone signs in. Never integrations/secrets/sender details.
  app.get('/api/branding/:slug', (req, res) => {
    const eid = entityForSlug(req.params.slug);
    const ent = eid && db.getEntity(eid);
    if (!ent) return res.status(404).json({ error: 'Not found' });
    const b = mailer.resolveBranding(eid);
    res.json({
      name: b.wordmark || ent.name,
      logo: b.logo || '', logoDark: b.logoDark || '',
      primary: b.brandColor, secondary: b.secondaryColor,
      loginBackground: b.loginBackground || '',
    });
  });

  // Admin: read the client's slug.
  app.get('/api/admin/entities/:id/slug', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ slug: slugForEntity(req.params.id) });
  });

  // Admin: set or clear it. Validates format, reserved words and uniqueness.
  app.put('/api/admin/entities/:id/slug', auth.requireAdmin, (req, res) => {
    const id = req.params.id;
    if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
    const slug = normalizeSlug((req.body || {}).slug);
    if (!slug) { sql.prepare('DELETE FROM client_slugs WHERE entity_id=?').run(id); return res.json({ slug: '' }); }
    if (slug.length < 2) return res.status(400).json({ error: 'Too short — use at least 2 characters.' });
    if (RESERVED.has(slug)) return res.status(400).json({ error: `"${slug}" is reserved — pick another.` });
    const taken = sql.prepare('SELECT entity_id FROM client_slugs WHERE slug=?').get(slug);
    if (taken && taken.entity_id !== id) return res.status(409).json({ error: `"${slug}" is already taken by another client.` });
    sql.prepare('DELETE FROM client_slugs WHERE entity_id=?').run(id);
    sql.prepare('INSERT INTO client_slugs (slug, entity_id, created_at) VALUES (?,?,?)').run(slug, id, new Date().toISOString());
    res.json({ slug });
  });
}

module.exports = { mount, normalizeSlug };
