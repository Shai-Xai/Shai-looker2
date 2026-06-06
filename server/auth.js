// ─── Authentication, tenants & data scoping ──────────────────────────────────
// File-backed users + tenants, bcrypt password hashing, JWT session cookies,
// Express middleware, and the row-level scoping that forces every client's
// Looker query down to their organiser/events.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const COOKIE = 'howler_session';
const TOKEN_TTL = '7d';

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) { ensureDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ─── Session secret (env, or a persisted random one) ──────────────────────────
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDir();
  let s = readJson(SECRET_FILE, null);
  if (!s) { s = crypto.randomBytes(32).toString('hex'); writeJson(SECRET_FILE, s); }
  return s;
}

// ─── Tenants ──────────────────────────────────────────────────────────────────
function listTenants() { return readJson(TENANTS_FILE, []); }
function getTenant(id) { return listTenants().find((t) => t.id === id) || null; }
function saveTenants(list) { writeJson(TENANTS_FILE, list); }

function createTenant({ name, organiserNames = [], eventNames = [] }) {
  const list = listTenants();
  const tenant = {
    id: crypto.randomUUID(),
    name: name || 'Untitled client',
    organiserNames: organiserNames.filter(Boolean),
    eventNames: eventNames.filter(Boolean),
    scopeFields: { organiser: 'core_organisers.name', event: 'core_events.name' },
    createdAt: new Date().toISOString(),
  };
  list.push(tenant);
  saveTenants(list);
  return tenant;
}
function updateTenant(id, patch) {
  const list = listTenants();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id, scopeFields: list[i].scopeFields };
  saveTenants(list);
  return list[i];
}
function deleteTenant(id) { saveTenants(listTenants().filter((t) => t.id !== id)); }

// ─── Users ──────────────────────────────────────────────────────────────────
function loadUsers() { return readJson(USERS_FILE, []); }
function saveUsers(list) { writeJson(USERS_FILE, list); }

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, tenantId: u.tenantId || null };
}

function findUserByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return loadUsers().find((u) => u.email === e) || null;
}
function getUser(id) { return loadUsers().find((u) => u.id === id) || null; }

function createUser({ email, password, role = 'client', tenantId = null }) {
  const list = loadUsers();
  const e = (email || '').trim().toLowerCase();
  if (!e || !password) throw new Error('email and password are required');
  if (list.some((u) => u.email === e)) throw new Error('A user with that email already exists');
  const user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'client',
    tenantId: role === 'admin' ? null : tenantId,
    createdAt: new Date().toISOString(),
  };
  list.push(user);
  saveUsers(list);
  return publicUser(user);
}
function updateUser(id, patch) {
  const list = loadUsers();
  const i = list.findIndex((u) => u.id === id);
  if (i < 0) return null;
  const next = { ...list[i] };
  if (patch.email) next.email = patch.email.trim().toLowerCase();
  if (patch.password) next.passwordHash = bcrypt.hashSync(patch.password, 10);
  if (patch.role) next.role = patch.role === 'admin' ? 'admin' : 'client';
  if ('tenantId' in patch) next.tenantId = next.role === 'admin' ? null : patch.tenantId;
  list[i] = next;
  saveUsers(list);
  return publicUser(next);
}
function deleteUser(id) { saveUsers(loadUsers().filter((u) => u.id !== id)); }

function verifyCredentials(email, password) {
  const u = findUserByEmail(email);
  if (!u) return null;
  return bcrypt.compareSync(password || '', u.passwordHash) ? u : null;
}

// Seed an admin on first run so the app is usable out of the box.
function seedAdmin() {
  if (loadUsers().length > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@howler.local';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  createUser({ email, password, role: 'admin' });
  console.log('\n  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  Seeded admin account (change the password after login):  │');
  console.log(`  │   email:    ${email.padEnd(44)}│`);
  console.log(`  │   password: ${password.padEnd(44)}│`);
  console.log('  └─────────────────────────────────────────────────────────┘\n');
}

// ─── JWT cookie helpers ───────────────────────────────────────────────────────
function issueCookie(res, user) {
  const token = jwt.sign({ sub: user.id }, getSecret(), { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // set true behind HTTPS in production
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
function clearCookie(res) { res.clearCookie(COOKIE); }

// Middleware: attach req.user from the session cookie (no-op if absent/invalid).
function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const { sub } = jwt.verify(token, getSecret());
      req.user = getUser(sub) || null;
    } catch { req.user = null; }
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
// Returns the filters to force onto a query for this user:
//   - admin → null (no scoping; sees everything)
//   - client with a tenant + organiserNames → { orgField: "A,B", [eventField]: "X,Y"] }
//   - client with no tenant / no organiser configured → { __block: true } (fail closed)
function scopeFiltersForUser(user) {
  if (!user || user.role === 'admin') return null;
  const t = getTenant(user.tenantId);
  if (!t || !(t.organiserNames || []).length) return { __block: true };
  const orgField = t.scopeFields?.organiser || 'core_organisers.name';
  const evField = t.scopeFields?.event || 'core_events.name';
  const f = { [orgField]: t.organiserNames.join(',') };
  if ((t.eventNames || []).length) f[evField] = t.eventNames.join(',');
  return f;
}

// Can this user see / open this dashboard? Admin: yes. Client: shared (no
// tenantId) or assigned to their tenant.
function canAccessDashboard(user, dashboard) {
  if (!dashboard) return false;
  if (user.role === 'admin') return true;
  return !dashboard.tenantId || dashboard.tenantId === user.tenantId;
}

module.exports = {
  COOKIE,
  seedAdmin,
  // tenants
  listTenants, getTenant, createTenant, updateTenant, deleteTenant,
  // users
  loadUsers, publicUser, createUser, updateUser, deleteUser, getUser, verifyCredentials,
  // session
  issueCookie, clearCookie, attachUser, requireAuth, requireAdmin,
  // scoping
  scopeFiltersForUser, canAccessDashboard,
};
