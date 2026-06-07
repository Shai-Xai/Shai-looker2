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
const lines = (csv) => String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);

// Present an Entity (+ its first set's event lock) as the legacy tenant shape.
function entityToTenant(e) {
  if (!e) return null;
  const sf = { organiser: e.scopeFields?.organiser || ORG_FIELD, event: e.scopeFields?.event || EV_FIELD };
  const sets = db.listSetsForEntity(e.id);
  const eventNames = sets.length ? lines(sets[0].lockedFilters[sf.event]) : [];
  return { id: e.id, name: e.name, organiserNames: lines(e.lockedFilters[sf.organiser]), eventNames, scopeFields: sf };
}
function listTenants() { return db.listEntities().map(entityToTenant); }
function getTenant(id) { return entityToTenant(db.getEntity(id)); }

// Dashboards a freshly-created client should see by default = the migration's
// "Shared dashboards" template, if present.
function sharedDashboardIds() {
  const t = db.listTemplates().find((x) => x.name === 'Shared dashboards');
  return t ? t.dashboardIds : [];
}

function createTenant({ name, organiserNames = [], eventNames = [] }) {
  const sf = { organiser: ORG_FIELD, event: EV_FIELD };
  const locks = {};
  if (organiserNames.filter(Boolean).length) locks[sf.organiser] = organiserNames.filter(Boolean).join(',');
  const entity = db.createEntity({ name: name || 'Untitled client', lockedFilters: locks, scopeFields: sf });
  const template = db.createTemplate({ name: `${entity.name} dashboards`, dashboardIds: sharedDashboardIds() });
  const setLocks = {};
  if (eventNames.filter(Boolean).length) setLocks[sf.event] = eventNames.filter(Boolean).join(',');
  db.createSet({ entityId: entity.id, templateId: template.id, name: entity.name, lockedFilters: setLocks });
  return entityToTenant(db.getEntity(entity.id));
}

function updateTenant(id, patch) {
  const e = db.getEntity(id);
  if (!e) return null;
  const sf = { organiser: e.scopeFields?.organiser || ORG_FIELD, event: e.scopeFields?.event || EV_FIELD };
  if (patch.name !== undefined || patch.organiserNames !== undefined) {
    const locks = { ...e.lockedFilters };
    if (patch.organiserNames !== undefined) {
      const orgs = patch.organiserNames.filter(Boolean);
      if (orgs.length) locks[sf.organiser] = orgs.join(','); else delete locks[sf.organiser];
    }
    db.updateEntity(id, { name: patch.name ?? e.name, lockedFilters: locks });
  }
  if (patch.eventNames !== undefined) {
    const evs = patch.eventNames.filter(Boolean);
    let set = db.listSetsForEntity(id)[0];
    if (!set) {
      const tmpl = db.createTemplate({ name: `${e.name} dashboards`, dashboardIds: sharedDashboardIds() });
      set = db.createSet({ entityId: id, templateId: tmpl.id, name: e.name, lockedFilters: {} });
    }
    const setLocks = { ...set.lockedFilters };
    if (evs.length) setLocks[sf.event] = evs.join(','); else delete setLocks[sf.event];
    db.updateSet(set.id, { lockedFilters: setLocks });
  }
  return entityToTenant(db.getEntity(id));
}
function deleteTenant(id) { db.deleteEntity(id); }

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
function issueCookie(res, user) {
  const token = jwt.sign({ sub: user.id }, getSecret(), { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function clearCookie(res) { res.clearCookie(COOKIE); }

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
// The mandatory filters forced onto every query for this user:
//   - admin → null (sees everything)
//   - client → merged locked filters across all their entities + sets
//              (organiser from the entity, event/other from the sets)
//   - client with nothing configured → { __block: true } (fail closed)
function scopeFiltersForUser(user) {
  if (!user || user.role === 'admin') return null;
  const acc = {}; // field -> Set(values)
  let any = false;
  const add = (map) => {
    for (const [f, v] of Object.entries(map || {})) {
      if (v == null || v === '') continue;
      acc[f] = acc[f] || new Set();
      for (const part of String(v).split(',')) { const t = part.trim(); if (t) { acc[f].add(t); any = true; } }
    }
  };
  for (const eid of user.entityIds || []) {
    const sets = db.listSetsForEntity(eid);
    if (sets.length) for (const s of sets) add(db.lockedFiltersForSet(s.id));
    else add(db.getEntity(eid)?.lockedFilters);
  }
  if (!any) return { __block: true };
  const out = {};
  for (const [f, set] of Object.entries(acc)) out[f] = [...set].join(',');
  return out;
}

// Can this user open this dashboard? Admin: any. Client: the dashboard must be
// in a template attached (via a set) to one of their entities.
function canAccessDashboard(user, dashboard) {
  if (!dashboard) return false;
  if (user.role === 'admin') return true;
  for (const eid of user.entityIds || []) {
    for (const s of db.listSetsForEntity(eid)) {
      if (db.dashboardsInSet(s.id).includes(dashboard.id)) return true;
    }
  }
  return false;
}

// ─── Dashboard sets (navigation context) ──────────────────────────────────────
// Sets this user can open (admin → all; client → their entities' sets).
function setsForUser(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.listSets();
  const out = [];
  for (const eid of user.entityIds || []) out.push(...db.listSetsForEntity(eid));
  return out;
}
function canAccessSet(user, setId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const s = db.getSet(setId);
  return !!s && (user.entityIds || []).includes(s.entityId);
}
// Merged locked-filters map for a specific set (entity locks + set locks).
function lockedFiltersForSet(setId) { return db.lockedFiltersForSet(setId); }

module.exports = {
  COOKIE,
  seedAdmin,
  // tenants (compat over entities)
  listTenants, getTenant, createTenant, updateTenant, deleteTenant,
  // users
  loadUsers, publicUser, createUser, updateUser, deleteUser, getUser, verifyCredentials,
  // session
  issueCookie, clearCookie, attachUser, requireAuth, requireAdmin,
  // scoping
  scopeFiltersForUser, canAccessDashboard,
  // sets / navigation
  setsForUser, canAccessSet, lockedFiltersForSet,
};
