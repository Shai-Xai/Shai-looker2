// ─── Owl embed — the Owl inside the Howler organizer portal (pilot) ────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the /api/admin/owl-embed config routes
// and the /api/embed/owl/session handshake. Remove the mount line in index.js +
// this file (and the /embed/owl client page) to uninstall. Guide: docs/OWL_EMBED.md.
//
// The Inventive pattern, INVERTED — this time Pulse is the guest and the organizer
// portal is the host:
//   1. The portal's BACKEND calls POST /api/embed/owl/session (server-to-server,
//      authenticated by a shared secret) with the logged-in organizer's identity
//      (email + name) and their Howler organization id.
//   2. We map the org → a Pulse entity via the admin-managed link list below,
//      JIT-provision a "shadow" client user for that organizer (random unusable
//      password — the portal is the only door), and return a short-lived embed
//      URL + token.
//   3. The portal iframes the URL. The /embed/owl page (client/src/pages/
//      OwlEmbedPage.jsx) sends the token as an Authorization header on every API
//      call — no cookies, so no third-party-cookie problems — and the Owl runs
//      its normal loop: the shadow user is a plain client principal, so applyScope
//      pins every query to the linked entity, exactly like any Pulse login.
//
// Security posture:
//   - The shared secret only lets the portal mint sessions for orgs an ADMIN has
//     linked here; an unlinked org gets nothing.
//   - Sessions are never minted for admin/staff accounts, or for an email that
//     already belongs to a different client — the portal can't impersonate or
//     widen an existing Pulse account.
//   - The embed token is a 2h JWT for one entity-scoped client user. The hard
//     data boundary remains applyScope, same as every tile.
//
// Pilot note: until the Howler→Pulse data integration lands, only orgs that exist
// as Pulse clients (and are linked here) get a working Owl. When ingestion ships,
// links can be auto-created per Howler org — this handshake stays the same.

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');

const TOKEN_TTL_S = 2 * 60 * 60; // matches auth.issueEmbedToken's default

function mount(app, { db, auth, rateLimit }) {
  const enabled = () => db.getSetting('owl_embed_enabled', '0') === '1';
  // Secret is write-only (set in Admin → AI, or OWL_EMBED_SECRET in .env as a
  // fallback) — responses only ever report set + a mask, never the value.
  const secret = () => db.getSetting('owl_embed_secret', '') || process.env.OWL_EMBED_SECRET || '';
  const links = () => {
    try { const a = JSON.parse(db.getSetting('owl_embed_links', '[]') || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  };
  const secretOk = (given) => {
    const s = secret();
    if (!s || !given) return false;
    const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
    return crypto.timingSafeEqual(h(s), h(given)); // constant-time, length-safe
  };

  // ── Admin config (Admin → AI → Organizer portal Owl) ────────────────────────
  const configView = () => {
    const s = db.getSetting('owl_embed_secret', '');
    return {
      enabled: enabled(),
      secretSet: !!(s || process.env.OWL_EMBED_SECRET),
      secretHint: s ? `••••••${s.slice(-4)}` : (process.env.OWL_EMBED_SECRET ? '(from .env)' : ''),
      sessionPath: '/api/embed/owl/session',
      links: links().map((l) => ({ ...l, entityName: db.getEntity(l.entityId)?.name || '(deleted client)' })),
    };
  };
  app.get('/api/admin/owl-embed', auth.requireAdmin, (_req, res) => res.json(configView()));
  app.put('/api/admin/owl-embed', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) db.setSetting('owl_embed_enabled', b.enabled ? '1' : '0');
    if (b.secret) db.setSetting('owl_embed_secret', String(b.secret).trim());
    if (b.clearSecret) db.setSetting('owl_embed_secret', '');
    if (Array.isArray(b.links)) {
      // One link per Howler org, and only to clients that actually exist.
      const seen = new Set();
      const clean = [];
      for (const l of b.links) {
        const orgId = String(l.orgId || '').trim();
        const entityId = String(l.entityId || '').trim();
        if (!orgId || !entityId || seen.has(orgId) || !db.getEntity(entityId)) continue;
        seen.add(orgId);
        clean.push({ orgId, entityId });
      }
      db.setSetting('owl_embed_links', JSON.stringify(clean));
    }
    res.json(configView());
  });

  // ── The handshake: portal backend → Pulse (server-to-server) ────────────────
  // Auth: `Authorization: Bearer <shared secret>` (or x-embed-secret). Body:
  // { orgId, email, firstName?, lastName? }. Returns a short-lived iframe URL —
  // the token rides in the URL FRAGMENT, which browsers never send to servers,
  // so it stays out of access logs.
  app.post('/api/embed/owl/session',
    rateLimit({ windowMs: 60_000, max: 60, by: 'ip', scope: 'owl-embed' }),
    asyncHandler(async (req, res) => {
      const given = (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1]
        || req.headers['x-embed-secret'];
      if (!secretOk(given)) throw new HttpError(401, 'A valid embed secret is required (Authorization: Bearer …).');
      if (!enabled()) throw new HttpError(403, 'The Owl embed is switched off — enable it in Pulse Admin → AI.');
      const b = req.body || {};
      const orgId = String(b.orgId || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      if (!orgId || !/.+@.+\..+/.test(email)) throw new HttpError(400, 'orgId and a valid email are required.');
      const link = links().find((l) => l.orgId === orgId);
      if (!link) throw new HttpError(404, 'This organization isn’t linked to a Pulse client yet.');
      const entity = db.getEntity(link.entityId);
      if (!entity) throw new HttpError(404, 'The linked Pulse client no longer exists.');

      // JIT shadow user: the organizer's first session creates their Pulse login
      // (they can never password-sign-in — random hash). Never widen an existing
      // account: an admin/staff email, or a client of a DIFFERENT entity, is
      // refused rather than hijacked.
      let user = db.getUserByEmail(email);
      if (user) {
        if (user.role !== 'client' || !(user.entityIds || []).includes(entity.id)) {
          throw new HttpError(409, 'This email already belongs to a different Pulse account — ask Howler to link it manually.');
        }
        if (!(user.roles || []).includes('portal')) {
          auth.updateUser(user.id, { roles: [...(user.roles || []), 'portal'] }); // marks them Owl-enabled (see owlChat.owlAllowed)
          user = db.getUser(user.id);
        }
      } else {
        const pub = auth.createUser({
          email,
          password: crypto.randomBytes(24).toString('base64url'), // unusable — the portal is the only door
          role: 'client',
          entityIds: [entity.id],
          firstName: String(b.firstName || '').trim(),
          lastName: String(b.lastName || '').trim(),
          roles: ['portal'],
        });
        user = db.getUser(pub.id);
      }

      const token = auth.issueEmbedToken(user, TOKEN_TTL_S);
      const base = `${req.protocol}://${req.get('host')}`;
      res.json({
        token,
        url: `${base}/embed/owl#token=${encodeURIComponent(token)}`,
        expiresIn: TOKEN_TTL_S,
        entity: { id: entity.id, name: entity.name },
        user: { id: user.id, email: user.email },
      });
    }));

  console.log('[owlEmbed] organizer-portal Owl embed mounted');
}

module.exports = { mount, TOKEN_TTL_S };
