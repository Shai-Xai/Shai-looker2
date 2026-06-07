// ─── SQLite data layer ───────────────────────────────────────────────────────
// Durable, relational storage for the multi-tenant model:
//
//   Entity ──< user_entities >── User        (a user belongs to many entities)
//   Entity ──< DashboardSet >── Template      (a set applies a template to an
//                                              entity, with locked filters)
//   Template ──< template_dashboards >── Dashboard  (dashboards reused across
//                                                    many templates)
//
// Scoping = Entity.lockedFilters merged with DashboardSet.lockedFilters, forced
// onto every Looker query the client runs.
//
// Dashboard *content* (tiles, filters, theme…) stays a JSON blob — only the org
// structure is relational. The exported API is intentionally small so callers
// (auth/index/store) don't touch SQL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'howler.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  locked_filters TEXT NOT NULL DEFAULT '{}',   -- JSON { "field": "v1,v2" }
  scope_fields  TEXT NOT NULL DEFAULT '{}',     -- JSON, optional legacy hints
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'client', -- 'admin' | 'client'
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_entities (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, entity_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  def        TEXT NOT NULL,                      -- JSON: full dashboard definition
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_dashboards (
  template_id  TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, dashboard_id)
);

CREATE TABLE IF NOT EXISTS dashboard_sets (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  locked_filters TEXT NOT NULL DEFAULT '{}',     -- JSON { "field": "v1,v2" }
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_entities_user   ON user_entities(user_id);
CREATE INDEX IF NOT EXISTS idx_template_dash_tmpl   ON template_dashboards(template_id);
CREATE INDEX IF NOT EXISTS idx_sets_entity          ON dashboard_sets(entity_id);
CREATE INDEX IF NOT EXISTS idx_sets_template        ON dashboard_sets(template_id);
`);

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const J = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ─── Entities ─────────────────────────────────────────────────────────────────
function rowToEntity(r) {
  return r && { id: r.id, name: r.name, lockedFilters: J(r.locked_filters, {}), scopeFields: J(r.scope_fields, {}), createdAt: r.created_at };
}
function listEntities() {
  return db.prepare('SELECT * FROM entities ORDER BY name').all().map(rowToEntity);
}
function getEntity(id) {
  return rowToEntity(db.prepare('SELECT * FROM entities WHERE id=?').get(id));
}
function createEntity({ name, lockedFilters = {}, scopeFields = {} }) {
  const e = { id: uuid(), name: name || 'Untitled entity', lockedFilters, scopeFields, createdAt: now() };
  db.prepare('INSERT INTO entities (id,name,locked_filters,scope_fields,created_at) VALUES (?,?,?,?,?)')
    .run(e.id, e.name, JSON.stringify(lockedFilters), JSON.stringify(scopeFields), e.createdAt);
  return e;
}
function updateEntity(id, patch) {
  const cur = db.prepare('SELECT * FROM entities WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const sf = patch.scopeFields !== undefined ? JSON.stringify(patch.scopeFields) : cur.scope_fields;
  db.prepare('UPDATE entities SET name=?, locked_filters=?, scope_fields=? WHERE id=?').run(name, lf, sf, id);
  return getEntity(id);
}
function deleteEntity(id) { db.prepare('DELETE FROM entities WHERE id=?').run(id); }

// ─── Users ────────────────────────────────────────────────────────────────────
function entityIdsForUser(userId) {
  return db.prepare('SELECT entity_id FROM user_entities WHERE user_id=?').all(userId).map((r) => r.entity_id);
}
function rowToUser(r) {
  return r && { id: r.id, email: r.email, role: r.role, passwordHash: r.password_hash, entityIds: entityIdsForUser(r.id), createdAt: r.created_at };
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, entityIds: u.entityIds || [] };
}
function listUsers() { return db.prepare('SELECT * FROM users ORDER BY email').all().map(rowToUser); }
function getUser(id) { return rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
function getUserByEmail(email) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE email=?').get((email || '').trim().toLowerCase()));
}
const setUserEntities = db.transaction((userId, entityIds) => {
  db.prepare('DELETE FROM user_entities WHERE user_id=?').run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO user_entities (user_id, entity_id) VALUES (?,?)');
  for (const eid of entityIds || []) if (eid) ins.run(userId, eid);
});
function createUser({ email, password, role = 'client', entityIds = [] }) {
  const e = (email || '').trim().toLowerCase();
  if (!e || !password) throw new Error('email and password are required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(e)) throw new Error('A user with that email already exists');
  const id = uuid();
  const r = role === 'admin' ? 'admin' : 'client';
  db.prepare('INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run(id, e, bcrypt.hashSync(password, 10), r, now());
  setUserEntities(id, r === 'admin' ? [] : entityIds);
  return publicUser(getUser(id));
}
function updateUser(id, patch) {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!cur) return null;
  const email = patch.email ? patch.email.trim().toLowerCase() : cur.email;
  const hash = patch.password ? bcrypt.hashSync(patch.password, 10) : cur.password_hash;
  const role = patch.role ? (patch.role === 'admin' ? 'admin' : 'client') : cur.role;
  db.prepare('UPDATE users SET email=?, password_hash=?, role=? WHERE id=?').run(email, hash, role, id);
  if ('entityIds' in patch) setUserEntities(id, role === 'admin' ? [] : patch.entityIds);
  return publicUser(getUser(id));
}
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id=?').run(id); }
function verifyCredentials(email, password) {
  const u = getUserByEmail(email);
  if (!u) return null;
  return bcrypt.compareSync(password || '', u.passwordHash) ? u : null;
}

// ─── Dashboards (content kept as JSON blob) ───────────────────────────────────
function defaultTheme() {
  return { brand: '#ff385c', background: '#f5f6f8', tileBackground: '#ffffff', text: '#222222' };
}
function rowToDashboard(r) {
  if (!r) return null;
  const def = J(r.def, {});
  return { ...def, id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}
function listDashboards() {
  return db.prepare('SELECT * FROM dashboards ORDER BY updated_at DESC').all().map((r) => {
    const def = J(r.def, {});
    return {
      id: r.id, title: r.title, description: def.description || '',
      tileCount: (def.tiles || []).length, source: def.source || null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  });
}
function getDashboard(id) { return rowToDashboard(db.prepare('SELECT * FROM dashboards WHERE id=?').get(id)); }
function createDashboard(def = {}) {
  const ts = now();
  const dash = {
    id: uuid(),
    title: def.title || 'Untitled dashboard',
    description: def.description || '',
    theme: def.theme || defaultTheme(),
    filters: def.filters || [],
    tiles: def.tiles || [],
    carousels: def.carousels || [],
    gridAfter: def.gridAfter || 0,
    source: def.source || null,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare('INSERT INTO dashboards (id,title,def,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(dash.id, dash.title, JSON.stringify(stripMeta(dash)), ts, ts);
  return dash;
}
function updateDashboard(id, patch) {
  const cur = getDashboard(id);
  if (!cur) return null;
  const merged = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: now() };
  db.prepare('UPDATE dashboards SET title=?, def=?, updated_at=? WHERE id=?')
    .run(merged.title, JSON.stringify(stripMeta(merged)), merged.updatedAt, id);
  return merged;
}
function removeDashboard(id) { return db.prepare('DELETE FROM dashboards WHERE id=?').run(id).changes > 0; }
// Keep id/title/timestamps out of the JSON blob (they live in columns).
function stripMeta(d) {
  const { id, title, createdAt, updatedAt, ...rest } = d;
  return rest;
}

// ─── Templates ────────────────────────────────────────────────────────────────
function templateDashboardIds(templateId) {
  return db.prepare('SELECT dashboard_id FROM template_dashboards WHERE template_id=? ORDER BY position')
    .all(templateId).map((r) => r.dashboard_id);
}
function rowToTemplate(r) {
  return r && { id: r.id, name: r.name, dashboardIds: templateDashboardIds(r.id), createdAt: r.created_at };
}
function listTemplates() { return db.prepare('SELECT * FROM templates ORDER BY name').all().map(rowToTemplate); }
function getTemplate(id) { return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id=?').get(id)); }
const setTemplateDashboards = db.transaction((templateId, dashboardIds) => {
  db.prepare('DELETE FROM template_dashboards WHERE template_id=?').run(templateId);
  const ins = db.prepare('INSERT OR IGNORE INTO template_dashboards (template_id, dashboard_id, position) VALUES (?,?,?)');
  (dashboardIds || []).forEach((did, i) => { if (did) ins.run(templateId, did, i); });
});
function createTemplate({ name, dashboardIds = [] }) {
  const id = uuid();
  db.prepare('INSERT INTO templates (id,name,created_at) VALUES (?,?,?)').run(id, name || 'Untitled template', now());
  setTemplateDashboards(id, dashboardIds);
  return getTemplate(id);
}
function updateTemplate(id, patch) {
  const cur = db.prepare('SELECT * FROM templates WHERE id=?').get(id);
  if (!cur) return null;
  if (patch.name !== undefined) db.prepare('UPDATE templates SET name=? WHERE id=?').run(patch.name, id);
  if (patch.dashboardIds !== undefined) setTemplateDashboards(id, patch.dashboardIds);
  return getTemplate(id);
}
function deleteTemplate(id) { db.prepare('DELETE FROM templates WHERE id=?').run(id); }

// ─── Dashboard sets (template applied to an entity, with locked filters) ───────
function rowToSet(r) {
  return r && {
    id: r.id, entityId: r.entity_id, templateId: r.template_id, name: r.name,
    lockedFilters: J(r.locked_filters, {}), position: r.position, createdAt: r.created_at,
  };
}
function listSets() { return db.prepare('SELECT * FROM dashboard_sets ORDER BY position, name').all().map(rowToSet); }
function listSetsForEntity(entityId) {
  return db.prepare('SELECT * FROM dashboard_sets WHERE entity_id=? ORDER BY position, name').all(entityId).map(rowToSet);
}
function getSet(id) { return rowToSet(db.prepare('SELECT * FROM dashboard_sets WHERE id=?').get(id)); }
function createSet({ entityId, templateId, name, lockedFilters = {}, position = 0 }) {
  const id = uuid();
  db.prepare('INSERT INTO dashboard_sets (id,entity_id,template_id,name,locked_filters,position,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, entityId, templateId, name || 'Untitled set', JSON.stringify(lockedFilters), position, now());
  return getSet(id);
}
function updateSet(id, patch) {
  const cur = db.prepare('SELECT * FROM dashboard_sets WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const tmpl = patch.templateId ?? cur.template_id;
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const pos = patch.position ?? cur.position;
  db.prepare('UPDATE dashboard_sets SET name=?, template_id=?, locked_filters=?, position=? WHERE id=?').run(name, tmpl, lf, pos, id);
  return getSet(id);
}
function deleteSet(id) { db.prepare('DELETE FROM dashboard_sets WHERE id=?').run(id); }

// Dashboards a user can reach through a given set (template membership).
function dashboardsInSet(setId) {
  const s = getSet(setId);
  if (!s) return [];
  return templateDashboardIds(s.templateId);
}

// Merged locked filters for a set = entity locks + set locks (set wins on
// conflict). This is the map forced onto the user's Looker queries.
function lockedFiltersForSet(setId) {
  const s = getSet(setId);
  if (!s) return {};
  const e = getEntity(s.entityId);
  return { ...(e?.lockedFilters || {}), ...(s.lockedFilters || {}) };
}

module.exports = {
  db,
  defaultTheme,
  // entities
  listEntities, getEntity, createEntity, updateEntity, deleteEntity,
  // users
  listUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser, verifyCredentials, publicUser, setUserEntities,
  // dashboards
  listDashboards, getDashboard, createDashboard, updateDashboard, removeDashboard,
  // templates
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, setTemplateDashboards,
  // sets
  listSets, listSetsForEntity, getSet, createSet, updateSet, deleteSet, dashboardsInSet, lockedFiltersForSet,
};
