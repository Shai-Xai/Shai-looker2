// ─── Authentication, entities & data scoping ─────────────────────────────────
// Session cookies + middleware live here; persistent data (users, entities,
// templates, sets) lives in db.js (SQLite). This module also exposes a thin
// "tenant" compatibility layer so the existing admin/client UI keeps working:
// an Entity is presented as the old { name, organiserNames, eventNames } shape,
// with organiser locked at the entity and event locked on its first set.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const roles = require('./roles');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const COOKIE = 'howler_session';
const TOKEN_TTL = '7d';

const ORG_FIELD = 'core_organisers.name';
const EV_FIELD = 'core_events.name';

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { ensureDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ─── Session secret (env, or a persisted random one) ──────────────────────────
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDir();
  let s = readJson(SECRET_FILE, null);
  if (!s) { s = crypto.randomBytes(32).toString('hex'); writeJson(SECRET_FILE, s); }
  return s;
}

// ─── Tenant ⇄ Entity compatibility ────────────────────────────────────────────
// ─── Users ────────────────────────────────────────────────────────────────────
// Public shape keeps a compat `tenantId` (the user's first entity) for the
// current admin UI, alongside the real `entityIds`.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, roles: u.roles || [], firstName: u.firstName || '', lastName: u.lastName || '', fullName: u.fullName || '', mobile: u.mobile || '', tenantId: (u.entityIds || [])[0] || null, entityIds: u.entityIds || [], notifyEmail: u.notifyEmail !== false, notifyPush: u.notifyPush !== false };
}
function loadUsers() { return db.listUsers(); }
function getUser(id) { return db.getUser(id); }
function verifyCredentials(email, password) { return db.verifyCredentials(email, password); }

function createUser({ email, password, role = 'client', tenantId = null, entityIds, firstName = '', lastName = '', mobile = '', howlerRole = '', roles = [] }) {
  const ids = entityIds || (tenantId ? [tenantId] : []);
  // Admins keep entity links too: full access regardless, but a link makes them
  // part of that client's team surface (logins list, digests, notifications).
  const u = db.createUser({ email, password, role, entityIds: ids, firstName, lastName, mobile, howlerRole, roles });
  return publicUser(u);
}
function updateUser(id, patch) {
  const p = { ...patch };
  if ('tenantId' in patch && !('entityIds' in patch)) p.entityIds = patch.tenantId ? [patch.tenantId] : [];
  const u = db.updateUser(id, p);
  invalidateUser(id); // reflect role/entity/pref changes immediately, not after the TTL
  return u ? publicUser(u) : null;
}
function deleteUser(id) { db.deleteUser(id); invalidateUser(id); }

// Seed an admin on first run so the app is usable out of the box.
function seedAdmin() {
  if (db.listUsers().length > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@howler.local';
  // Never seed a KNOWN password in production: if ADMIN_PASSWORD is unset there,
  // mint a strong random one-time password (printed once below) so a fresh deploy
  // can't boot with publicly-known credentials. The convenient default is dev-only.
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = process.env.NODE_ENV === 'production'
      ? crypto.randomBytes(12).toString('base64url')
      : 'changeme123';
  }
  db.createUser({ email, password, role: 'admin' });
  console.log('\n  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  Seeded admin account (change the password after login):  │');
  console.log(`  │   email:    ${email.padEnd(44)}│`);
  console.log(`  │   password: ${password.padEnd(44)}│`);
  console.log('  └─────────────────────────────────────────────────────────┘\n');
}

// ─── JWT cookie helpers ───────────────────────────────────────────────────────
// In production (behind HTTPS) the session cookie must be Secure so it's only
// sent over TLS. Driven by NODE_ENV; override with COOKIE_SECURE=1/0 if needed.
const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE };
function issueCookie(res, user) {
  // `tv` (token version) pins the session to the user's current password epoch —
  // attachUser rejects a token whose tv is behind, so a password reset evicts
  // every previously-issued session. HS256 pinned (see attachUser) as defence-
  // in-depth against algorithm-confusion.
  const token = jwt.sign({ sub: user.id, tv: user.tokenVersion || 0 }, getSecret(), { algorithm: 'HS256', expiresIn: TOKEN_TTL });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function clearCookie(res) { res.clearCookie(COOKIE, COOKIE_OPTS); }

// ─── Embed session tokens (organizer-portal Owl — server/owlEmbed.js) ─────────
// A short-lived bearer JWT (marked with an `emb` claim) that authenticates the
// chromeless /embed/owl page WITHOUT a cookie: inside a cross-site iframe the
// sameSite session cookie is never sent, so the embed page attaches this token
// as an Authorization header on every API call instead. Minted only after the
// portal's server-to-server handshake, for entity-scoped shadow client users —
// attachUser accepts it below and marks the request `req.embedAuth`.
const EMBED_TOKEN_TTL_S = 2 * 60 * 60; // one working session; the portal mints a fresh one per open
function issueEmbedToken(user, ttlSeconds = EMBED_TOKEN_TTL_S) {
  return jwt.sign({ sub: user.id, emb: 1 }, getSecret(), { expiresIn: ttlSeconds });
}

// Short-TTL cache of the authenticated user. A single screen fires 10-20 parallel
// tile/data requests, and attachUser runs on each — without this, that's 10-20 ×
// getUser() (2 SQLite queries each) for the SAME user per navigation. 2s collapses
// the burst while keeping any mid-session permission change near-immediate; user
// mutations also invalidate explicitly (see updateUser/deleteUser).
const USER_CACHE_TTL = 2000;
const userCache = new Map(); // id -> { at, user }
function cachedUser(id) {
  const e = userCache.get(id);
  if (e && Date.now() - e.at < USER_CACHE_TTL) return e.user;
  const user = db.getUser(id);
  userCache.set(id, { at: Date.now(), user });
  if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
  return user;
}
function invalidateUser(id) { userCache.delete(id); }

function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const { sub, tv, stage } = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
      // A 2FA step-up (pending) token is NOT a session — never let it authenticate.
      if (stage) { req.user = null; return next(); }
      const user = cachedUser(sub) || null;
      // Reject a token minted before the user's current password epoch. Legacy
      // tokens (pre-tv, undefined) are accepted only against tokenVersion 0, so
      // the first reset after this ships still evicts them.
      req.user = (user && (tv || 0) === (user.tokenVersion || 0)) ? user : null;
    } catch { req.user = null; }
  }
  // No cookie? Accept an embed session token (issueEmbedToken) as a bearer. Only
  // JWTs WE signed with the `emb` claim verify; anything else (a pulse_sk_ API
  // key, a foreign token) falls through untouched — apiKeys.bearerAuth still owns
  // its own routes.
  if (!req.user) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers?.authorization || '');
    if (m && m[1].split('.').length === 3) {
      try {
        const p = jwt.verify(m[1], getSecret());
        if (p.emb) { req.user = cachedUser(p.sub) || null; req.embedAuth = !!req.user; }
      } catch { /* not an embed token — ignore */ }
    }
  }
  next();
}

// Short-lived token issued after password/link succeeds but BEFORE the second
// factor — the client sends it back to /api/auth/2fa with the code. Carries
// stage:'2fa' so attachUser refuses it as a session, and tv so a password
// change / 2FA reset invalidates it.
function issue2faPending(user) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion || 0, stage: '2fa' }, getSecret(), { algorithm: 'HS256', expiresIn: '10m' });
}
function verify2faPending(token) {
  try {
    const { sub, tv, stage } = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (stage !== '2fa') return null;
    const user = db.getUser(sub);
    return (user && (tv || 0) === (user.tokenVersion || 0)) ? user : null;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}
// ─── Super Admin gate ─────────────────────────────────────────────────────────
// The 403 boundary for the highest-risk global controls (billing master rates,
// integrations, status notices, backup/restore). UI hiding is cosmetic; this is
// the real check. A generic Howler admin who is NOT a super admin is refused.
function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!roles.isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super Admins only' });
  next();
}
// Does this Howler admin administer this specific client? (Account managers are
// the client's Howler support contacts — howlerSupportIds, which falls back to
// the creating admin.) Used to delegate CLIENT-LEVEL fee edits without exposing
// global controls. Super admins administer every client.
function administersEntity(user, entityId) {
  if (!user || user.role !== 'admin' || !entityId) return false;
  if (roles.isSuperAdmin(user)) return true;
  const e = db.getEntity(entityId);
  return !!e && (e.howlerSupportIds || []).includes(user.id);
}
// Middleware for a client-scoped admin control (e.g. per-client fees): a super
// admin, or the admin who administers the entity named on the request, passes.
function requireEntityAdmin(entityFrom) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const entityId = entityFrom ? entityFrom(req) : (req.params.id || req.params.entityId);
    if (administersEntity(req.user, entityId)) return next();
    return res.status(403).json({ error: 'You don’t administer this client.' });
  };
}
// Guard against privilege escalation via the user editor: only a super admin may
// grant or revoke the super_admin tag. For everyone else we pin the tag on the
// incoming `roles` array to whatever the target currently has (create → stripped),
// so a generic admin editing a user can't self-elevate or promote a peer.
function guardSuperAdminTag(req, res, next) {
  const body = req.body || {};
  if (!('roles' in body) || roles.isSuperAdmin(req.user)) return next();
  const incoming = Array.isArray(body.roles) ? body.roles : [];
  const target = req.params.id ? db.getUser(req.params.id) : null;
  const had = !!(target && (target.roles || []).includes(roles.SUPER_ADMIN));
  const without = incoming.filter((r) => r !== roles.SUPER_ADMIN);
  body.roles = had ? [...without, roles.SUPER_ADMIN] : without;
  next();
}
// Boot-time bootstrap of the initial super admins. Idempotent. Grants the tag to
// any admin whose email is listed in SUPER_ADMIN_EMAILS (comma-separated). If the
// system still has NO super admin afterwards (fresh deploy, env unset), it
// promotes the oldest admin so the platform's global controls are never locked
// out — logged loudly. Existing admins otherwise keep exactly what they had.
function ensureSuperAdmins() {
  const grant = (u) => {
    if (!u || u.role !== 'admin' || (u.roles || []).includes(roles.SUPER_ADMIN)) return;
    updateUser(u.id, { roles: [...(u.roles || []), roles.SUPER_ADMIN] });
    console.log(`[roles] granted Super Admin to ${u.email}`);
  };
  const emails = String(process.env.SUPER_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const all = db.listUsers();
  for (const email of emails) grant(all.find((u) => u.email === email));
  if (db.listUsers().some((u) => roles.isSuperAdmin(u))) return;
  const admins = db.listUsers().filter((u) => u.role === 'admin').sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (admins[0]) { grant(admins[0]); console.warn(`[roles] no Super Admin configured — bootstrapped ${admins[0].email}. Set SUPER_ADMIN_EMAILS and assign the real ones.`); }
}

// ─── Data scoping ─────────────────────────────────────────────────────────────
// Only ENTITY-level field locks (organiser) are *forced* onto every query —
// that's the hard security boundary. Suite locks (event/cashless) are per-tile
// presets applied in the UI + via listenTo, so they never clobber each other
// (e.g. current vs past vs comparison on the same field).
const fieldLocksFromEntities = (entityIds) => {
  const acc = {};
  let any = false;
  for (const eid of entityIds || []) {
    const e = db.getEntity(eid);
    for (const [key, v] of Object.entries(e?.lockedFilters || {})) {
      if (v == null || v === '') continue;
      // The lock key is usually already a real dotted field. But the admin UI
      // hides raw fields used by several named filters (organiser, event…) and
      // offers name-based options instead — so a lock may be keyed by a filter
      // NAME (e.g. "Organiser Name"). Resolve that back to its underlying field
      // so the organiser security lock actually applies.
      const field = key.includes('.') ? key : filterNameToField(key);
      if (!field || !field.includes('.')) continue;
      acc[field] = acc[field] || new Set();
      for (const part of String(v).split(',')) { const t = part.trim(); if (t) { acc[field].add(t); any = true; } }
    }
  }
  if (!any) return null;
  const out = {};
  for (const [f, set] of Object.entries(acc)) out[f] = [...set].join(',');
  return out;
};

// Map a filter NAME (as shown in the locked-filter picker) to its real Looker
// field by scanning the saved dashboards' filters. Cached briefly since
// dashboards change rarely and this runs on every scoped query.
let _nameMap = null, _nameMapAt = 0;
function filterNameToField(name) {
  const NOW = Date.now();
  if (!_nameMap || NOW - _nameMapAt > 60000) {
    // One rogue dashboard (e.g. a bespoke client import reusing the name
    // "Organiser" for a different field) must not redefine what a filter name
    // means platform-wide. Majority vote across all dashboards decides; the
    // canonical organiser field always wins outright; ties break shared-first.
    const votes = {}; // name -> field -> count
    const all = db.listDashboards();
    const ordered = [...all.filter((d) => !d.ownerEntityId), ...all.filter((d) => d.ownerEntityId)];
    for (const d of ordered) {
      const full = db.getDashboard(d.id);
      for (const f of full?.filters || []) {
        const field = f.field || f.dimension;
        const nm = f.name || f.title;
        if (!field || !nm) continue;
        votes[nm] = votes[nm] || new Map();
        votes[nm].set(field, (votes[nm].get(field) || 0) + 1);
      }
    }
    const map = {};
    for (const [nm, fieldVotes] of Object.entries(votes)) {
      if (fieldVotes.has(ORG_FIELD)) { map[nm] = ORG_FIELD; continue; }
      let best = null, bestN = 0;
      for (const [field, n] of fieldVotes) if (n > bestN) { best = field; bestN = n; } // ties: first seen (shared-first order)
      if (best) map[nm] = best;
    }
    _nameMap = map; _nameMapAt = NOW;
  }
  return _nameMap[name] || null;
}

// Mandatory filters for a user with no suite context (admin → null; client →
// their entities' organiser locks; nothing configured → fail closed).
function scopeFiltersForUser(user) {
  if (!user || user.role === 'admin') return null;
  // Internal/management clients are intentionally unscoped (see resolveScope).
  if ((user.entityIds || []).length && user.entityIds.every((eid) => db.getEntity(eid)?.allOrganisers)) return null;
  return fieldLocksFromEntities(user.entityIds) || { __block: true };
}

// The organiser field-lock for the organisers a user can ACCESS — used to bind the
// agentic Owl so it never runs platform-wide. Unlike scopeFiltersForUser (admins →
// null = unscoped), this restricts EVERY user, including admins, to the organisers
// of the entities they belong to. `preferEntityId` (e.g. the previewed client) wins
// when the user can access it, so an admin's Owl scopes to the client they're in.
// Returns { 'core_organisers.name': 'a,b' } or null when no bounded scope exists
// (a global admin with no memberships / an "all organisers" internal entity) — the
// caller then refuses rather than leaking across clients.
function accessibleOrgFilters(user, preferEntityId) {
  if (!user) return null;
  if (preferEntityId) {
    const e = db.getEntity(preferEntityId);
    const canAccess = user.role === 'admin' || (user.entityIds || []).includes(preferEntityId);
    if (e && canAccess && !e.allOrganisers) {
      const locks = fieldLocksFromEntities([preferEntityId]);
      if (locks) return locks;
    }
  }
  const ids = user.entityIds || [];
  if (ids.length && ids.every((eid) => db.getEntity(eid)?.allOrganisers)) return null; // intentionally unscoped
  return fieldLocksFromEntities(ids);
}

// Can this user open this dashboard? Admin: any. Client: the dashboard must be
// in a set bundled into one of their entities' suites.
function canAccessDashboard(user, dashboard) {
  if (!dashboard) return false;
  if (user.role === 'admin') return true;
  // Reachable via one of the user's memberships AND visible to their role there.
  for (const m of user.memberships || []) {
    const role = m.role || roles.DEFAULT_ROLE;
    for (const su of db.listSuitesForEntity(m.entityId)) {
      for (const sid of db.suiteSetIds(su.id)) {
        if (db.dashboardsInSet(sid).includes(dashboard.id) && db.dashboardVisibleToRole(m.entityId, sid, dashboard.id, role)) return true;
      }
    }
  }
  return false;
}

// ─── Suites (navigation context) ──────────────────────────────────────────────
function suitesForUser(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.listSuites();
  const out = [];
  for (const eid of user.entityIds || []) out.push(...db.listSuitesForEntity(eid));
  return out;
}
function canAccessSuite(user, suiteId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const su = db.getSuite(suiteId);
  return !!su && (user.entityIds || []).includes(su.entityId);
}
// ─── Roles & permissions ──────────────────────────────────────────────────────
// The user's role WITHIN a given client (its membership). Howler admins are
// treated as 'owner' everywhere (full access). Returns null if not a member.
function roleForEntity(user, entityId) {
  if (!user || !entityId) return null;
  if (user.role === 'admin') return roles.DEFAULT_ROLE; // owner-equivalent everywhere
  const m = (user.memberships || []).find((x) => x.entityId === entityId);
  return m ? (m.role || roles.DEFAULT_ROLE) : null;
}
// Resolved access for a user in one client: { role, permissions:[], lens } —
// admins get every permission; non-members get none.
function permissionsFor(user, entityId) {
  if (user && user.role === 'admin') {
    return { role: 'admin', permissions: Object.values(roles.PERMISSIONS), lens: 'exec' };
  }
  const role = roleForEntity(user, entityId);
  if (!role) return { role: null, permissions: [], lens: 'exec' };
  return { role, permissions: [...roles.permissionsForRole(role)], lens: roles.lensForRole(role) };
}
function hasPermission(user, entityId, perm) {
  if (user && user.role === 'admin') return true;
  return roleForEntity(user, entityId) ? roles.permissionsForRole(roleForEntity(user, entityId)).has(perm) : false;
}
// Express middleware: require `perm` on the entity named in the request. The
// entity is read from the route param / query / body (`entityFrom` lets a route
// override how to find it). Admins always pass. The 403 is the real boundary —
// UI hiding is cosmetic.
function requirePermission(perm, entityFrom) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    const entityId = entityFrom ? entityFrom(req) : (req.params.entityId || req.query.entityId || (req.body || {}).entityId);
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    if (!hasPermission(req.user, entityId, perm)) return res.status(403).json({ error: 'You don’t have access to this.' });
    next();
  };
}

// Merged locks for a suite (entity organiser + suite event/cashless) — used for
// the UI pre-fill/lock. Only the entity (organiser) part is force-scoped.
function lockedFiltersForSuite(suiteId) { return db.lockedFiltersForSuite(suiteId); }
// The forced (organiser) scope for the suite's entity.
function forcedScopeForSuite(suiteId) {
  const su = db.getSuite(suiteId);
  return su ? fieldLocksFromEntities([su.entityId]) : null;
}

// ─── Explore-aware organiser scope ─────────────────────────────────────────────
// The forced organiser lock is keyed to ONE explore's field (core_organisers.name
// on the ticketing model). Other explores (e.g. GA4) have their own organiser
// dimension, so injecting core_organisers.name there is an "Invalid filter".
// We resolve the organiser field that belongs to the QUERY's explore — using the
// organiser filter the dashboards already define on that explore (Looker has
// validated it) — and apply the entity's organiser VALUE to it.
const ORG_RE = /organi[sz]er/i;
const isOrgField = (field, name) => field === ORG_FIELD || ORG_RE.test(field || '') || ORG_RE.test(name || '');

let _exIdx = null, _exIdxAt = 0;
function exploreScopeIndex() {
  const NOW = Date.now();
  if (_exIdx && NOW - _exIdxAt < 60000) return _exIdx;
  const orgField = new Map(); // `${model}::${explore}` -> organiser field valid there
  const views = new Map();    // `${model}::${explore}` -> Set(view prefixes seen in tile fields)
  const addView = (key, v) => { if (!v) return; let s = views.get(key); if (!s) { s = new Set(); views.set(key, s); } s.add(v); };
  const setOrg = (k, field) => { if (k && field && (!orgField.has(k) || field === ORG_FIELD)) orgField.set(k, field); };
  // Shared dashboards first so they own each explore's organiser field; a
  // client's bespoke import can only resolve explores no shared dashboard covers.
  const all = db.listDashboards();
  const ordered = [...all.filter((d) => !d.ownerEntityId), ...all.filter((d) => d.ownerEntityId)];
  for (const d of ordered) {
    const full = db.getDashboard(d.id);
    // Names of this dashboard's organiser-style filters (e.g. "Organiser").
    const orgFilterNames = new Set();
    for (const f of full?.filters || []) {
      const field = f.field || f.dimension;
      if (isOrgField(field, f.name || f.title)) { if (f.name) orgFilterNames.add(f.name); if (f.title) orgFilterNames.add(f.title); }
    }
    for (const t of full?.tiles || []) {
      const q = t.query; if (!q?.model || !q?.view) continue;
      const key = `${q.model}::${q.view}`;
      for (const f of q.fields || []) addView(key, String(f).split('.')[0]);
      // Authoritative: how Looker wires the organiser dashboard-filter onto THIS
      // tile's query field — works even when the filter's own model/explore are
      // null on a bespoke import. listenTo: { dashboardFilterName -> queryField }.
      for (const [fname, qfield] of Object.entries(t.listenTo || {})) {
        if (orgFilterNames.has(fname) && qfield && String(qfield).includes('.')) setOrg(key, qfield);
      }
    }
    for (const f of full?.filters || []) {
      const field = f.field || f.dimension;
      if (!field || !field.includes('.') || !isOrgField(field, f.name || f.title)) continue;
      if (f.model && f.explore) setOrg(`${f.model}::${f.explore}`, field);
    }
  }
  _exIdx = { orgField, views }; _exIdxAt = NOW; return _exIdx;
}

// The entity's organiser VALUE + the field it's stored under.
function entityOrganiser(entityIds) {
  const locks = fieldLocksFromEntities(entityIds);
  if (!locks) return null;
  let value = null, directField = null;
  for (const [field, val] of Object.entries(locks)) {
    if (isOrgField(field)) { value = value ? `${value},${val}` : val; directField = directField || field; }
  }
  return value ? { value, directField } : null;
}

// Authoritative last resort: ask Looker whether the query's explore exposes an
// organiser dimension (the canonical field first, else any organiser-named
// dimension, preferring a `.name`). Includes hidden dimensions — they are
// still filterable. Cached per explore for the process lifetime; lookup
// failures are NOT cached so a Looker blip doesn't permanently block an
// explore. Resolves the cashless-style explores whose dashboards never declare
// an organiser filter but whose model does join core_organisers.
const _lkOrg = new Map(); // `${model}::${view}` -> field | null (resolved)
const _lkOrgPending = new Map();
function lookerOrganiserField(model, view) {
  if (!model || !view) return Promise.resolve(null);
  const key = `${model}::${view}`;
  if (_lkOrg.has(key)) return Promise.resolve(_lkOrg.get(key));
  if (_lkOrgPending.has(key)) return _lkOrgPending.get(key);
  const looker = require('./looker'); // lazy: avoids any startup-order surprises
  const p = looker.lookerRequest('GET',
    `/lookml_models/${encodeURIComponent(model)}/explores/${encodeURIComponent(view)}?fields=fields(dimensions(name,label,hidden))`)
    .then((data) => {
      const dims = data?.fields?.dimensions || [];
      let field = dims.some((d) => d.name === ORG_FIELD) ? ORG_FIELD : null;
      if (!field) {
        const cands = dims.filter((d) => ORG_RE.test(d.name || '') || ORG_RE.test(d.label || ''));
        field = (cands.find((d) => /\.name$/.test(d.name)) || cands[0])?.name || null;
      }
      _lkOrg.set(key, field);
      return field;
    })
    .catch((e) => { console.error('[scope] explore organiser lookup failed', key, e.message); return null; })
    .finally(() => { _lkOrgPending.delete(key); });
  _lkOrgPending.set(key, p);
  return p;
}

// Resolve the forced organiser scope for ONE query. Returns either
// `{ filters }` (the org filter to inject; `{}` = admin, unscoped) or
// `{ block, reason }` to deny (fail closed). The `reason` is for admin
// diagnostics/logging — never shown to clients.
async function resolveScope(query, user, suiteId) {
  let entityIds;
  if (suiteId) {
    if (!canAccessSuite(user, suiteId)) return { block: true, reason: 'no access to this suite' };
    const su = db.getSuite(suiteId); entityIds = su ? [su.entityId] : [];
  } else {
    if (user.role === 'admin') return { filters: {} };
    entityIds = user.entityIds || [];
  }
  // Internal/management clients are deliberately UNSCOPED — they see every
  // organiser's data. Only an admin can set this flag on an entity, so a client
  // can't self-elevate. Requires EVERY resolved entity to be flagged (mixed →
  // fall through to normal scoping, never silently widen).
  if (entityIds.length && entityIds.every((eid) => db.getEntity(eid)?.allOrganisers)) return { filters: {} };

  const org = entityOrganiser(entityIds);
  if (!org) return { block: true, reason: 'no organiser is configured for this client (set the organiser locked filter on the entity, or mark it "all organisers" if it is an internal/management client)' };

  const idx = exploreScopeIndex();
  const key = `${query?.model}::${query?.view}`;
  let field = idx.orgField.get(key) || null; // the explore's own (Looker-validated) organiser field
  if (!field) {
    // Fallback to the entity's direct organiser field, but only if this query's
    // explore actually exposes that field's view (otherwise it's an invalid filter).
    const qViews = new Set([
      ...((query?.fields) || []).map((f) => String(f).split('.')[0]),
      ...Object.keys(query?.filters || {}).map((f) => f.split('.')[0]),
      ...(idx.views.get(key) ? [...idx.views.get(key)] : []),
    ]);
    if (org.directField && qViews.has(org.directField.split('.')[0])) field = org.directField;
  }
  // Last resort: Looker's own explore metadata (e.g. cashless explores join
  // core_organisers but no dashboard ever declares an organiser filter there).
  if (!field) field = await lookerOrganiserField(query?.model, query?.view);
  if (!field) return { block: true, reason: `couldn't resolve an organiser field for explore ${key} — no dashboard declares an organiser filter there and Looker exposes none (${ORG_FIELD} or an organiser-named dimension)` };
  return { filters: { [field]: org.value } };
}

// Forced organiser scope for ONE query. Returns a filters object, {} (admin, no
// suite), or false to block (fail closed). Logs the reason when blocking so
// "No data access" failures are traceable in the server logs.
async function scopeForQuery(query, user, suiteId) {
  const r = await resolveScope(query, user, suiteId);
  if (r.block) { console.warn(`[scope] blocked ${query?.model}::${query?.view} for ${user?.email || user?.id} — ${r.reason}`); return false; }
  return r.filters;
}

module.exports = {
  COOKIE,
  seedAdmin,
  // users
  loadUsers, publicUser, createUser, updateUser, deleteUser, getUser, verifyCredentials,
  // session
  issueCookie, clearCookie, issueEmbedToken, attachUser, requireAuth, requireAdmin, invalidateUser,
  requireSuperAdmin, administersEntity, requireEntityAdmin, guardSuperAdminTag, ensureSuperAdmins,
  issue2faPending, verify2faPending,
  // scoping
  scopeFiltersForUser, accessibleOrgFilters, canAccessDashboard,
  // suites / navigation
  suitesForUser, canAccessSuite, lockedFiltersForSuite, forcedScopeForSuite, scopeForQuery, resolveScope,
  filterNameToField,
  // roles & permissions
  roleForEntity, permissionsFor, hasPermission, requirePermission,
};
