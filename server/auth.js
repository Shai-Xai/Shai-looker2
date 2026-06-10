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
  return { id: u.id, email: u.email, role: u.role, tenantId: (u.entityIds || [])[0] || null, entityIds: u.entityIds || [] };
}
function loadUsers() { return db.listUsers(); }
function getUser(id) { return db.getUser(id); }
function verifyCredentials(email, password) { return db.verifyCredentials(email, password); }

function createUser({ email, password, role = 'client', tenantId = null, entityIds }) {
  const ids = entityIds || (tenantId ? [tenantId] : []);
  const u = db.createUser({ email, password, role, entityIds: role === 'admin' ? [] : ids });
  return publicUser(u);
}
function updateUser(id, patch) {
  const p = { ...patch };
  if ('tenantId' in patch && !('entityIds' in patch)) p.entityIds = patch.tenantId ? [patch.tenantId] : [];
  const u = db.updateUser(id, p);
  return u ? publicUser(u) : null;
}
function deleteUser(id) { db.deleteUser(id); }

// Seed an admin on first run so the app is usable out of the box.
function seedAdmin() {
  if (db.listUsers().length > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@howler.local';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
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
  const token = jwt.sign({ sub: user.id }, getSecret(), { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function clearCookie(res) { res.clearCookie(COOKIE, COOKIE_OPTS); }

function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try { const { sub } = jwt.verify(token, getSecret()); req.user = db.getUser(sub) || null; }
    catch { req.user = null; }
  }
  next();
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
    const map = {};
    for (const d of db.listDashboards()) {
      const full = db.getDashboard(d.id);
      for (const f of full?.filters || []) {
        const field = f.field || f.dimension;
        const nm = f.name || f.title;
        if (field && nm && !map[nm]) map[nm] = field;
      }
    }
    _nameMap = map; _nameMapAt = NOW;
  }
  return _nameMap[name] || null;
}

// Mandatory filters for a user with no suite context (admin → null; client →
// their entities' organiser locks; nothing configured → fail closed).
function scopeFiltersForUser(user) {
  if (!user || user.role === 'admin') return null;
  return fieldLocksFromEntities(user.entityIds) || { __block: true };
}

// Can this user open this dashboard? Admin: any. Client: the dashboard must be
// in a set bundled into one of their entities' suites.
function canAccessDashboard(user, dashboard) {
  if (!dashboard) return false;
  if (user.role === 'admin') return true;
  for (const eid of user.entityIds || []) {
    for (const su of db.listSuitesForEntity(eid)) {
      if (db.dashboardsInSuite(su.id).includes(dashboard.id)) return true;
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
// Merged locks for a suite (entity organiser + suite event/cashless) — used for
// the UI pre-fill/lock. Only the entity (organiser) part is force-scoped.
function lockedFiltersForSuite(suiteId) { return db.lockedFiltersForSuite(suiteId); }
// The forced (organiser) scope for the suite's entity.
function forcedScopeForSuite(suiteId) {
  const su = db.getSuite(suiteId);
  return su ? fieldLocksFromEntities([su.entityId]) : null;
}

module.exports = {
  COOKIE,
  seedAdmin,
  // users
  loadUsers, publicUser, createUser, updateUser, deleteUser, getUser, verifyCredentials,
  // session
  issueCookie, clearCookie, attachUser, requireAuth, requireAdmin,
  // scoping
  scopeFiltersForUser, canAccessDashboard,
  // suites / navigation
  suitesForUser, canAccessSuite, lockedFiltersForSuite, forcedScopeForSuite,
  filterNameToField,
};
