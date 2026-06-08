// ─── SQLite data layer ───────────────────────────────────────────────────────
// Durable, relational storage for the multi-tenant model:
//
//   Entity ──< user_entities >── User      (a user belongs to many entities)
//   Entity ──< Suite                       (a suite = an event context, holds
//                                            the event/cashless locked filters)
//   Suite  ──< suite_sets >── Set          (a suite bundles many reusable Sets:
//                                            Ticketing, Cashless, Access, …)
//   Set    ──< set_dashboards >── Dashboard (dashboards reused across many Sets)
//
// Scoping = Entity.lockedFilters (organiser) merged with Suite.lockedFilters
// (event/cashless), forced onto every Looker query the client runs.
//
// Dashboard *content* (tiles, filters, theme…) stays a JSON blob — only the org
// structure is relational.

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
  locked_filters TEXT NOT NULL DEFAULT '{}',
  scope_fields  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'client',
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
  def        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A Set is a reusable collection of dashboards (Ticketing, Cashless, …).
CREATE TABLE IF NOT EXISTS sets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS set_dashboards (
  set_id       TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, dashboard_id)
);

-- A Suite is an event context for a client: it holds the event/cashless locks
-- and bundles several Sets.
CREATE TABLE IF NOT EXISTS suites (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  locked_filters TEXT NOT NULL DEFAULT '{}',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suite_sets (
  suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  set_id   TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (suite_id, set_id)
);

CREATE INDEX IF NOT EXISTS idx_user_entities_user ON user_entities(user_id);
CREATE INDEX IF NOT EXISTS idx_set_dashboards_set ON set_dashboards(set_id);
CREATE INDEX IF NOT EXISTS idx_suites_entity      ON suites(entity_id);
CREATE INDEX IF NOT EXISTS idx_suite_sets_suite   ON suite_sets(suite_id);
`);

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const J = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const tableExists = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);

// ─── Legacy migration: templates → sets, dashboard_sets → suites(+ one set) ───
const migrateLegacy = db.transaction(() => {
  if (tableExists('templates') && db.prepare('SELECT COUNT(*) c FROM sets').get().c === 0) {
    for (const t of db.prepare('SELECT * FROM templates').all()) {
      db.prepare('INSERT OR IGNORE INTO sets (id,name,created_at) VALUES (?,?,?)').run(t.id, t.name, t.created_at);
    }
    if (tableExists('template_dashboards')) {
      for (const r of db.prepare('SELECT * FROM template_dashboards').all()) {
        db.prepare('INSERT OR IGNORE INTO set_dashboards (set_id,dashboard_id,position) VALUES (?,?,?)').run(r.template_id, r.dashboard_id, r.position);
      }
    }
  }
  if (tableExists('dashboard_sets') && db.prepare('SELECT COUNT(*) c FROM suites').get().c === 0) {
    for (const s of db.prepare('SELECT * FROM dashboard_sets').all()) {
      db.prepare('INSERT OR IGNORE INTO suites (id,entity_id,name,locked_filters,position,created_at) VALUES (?,?,?,?,?,?)')
        .run(s.id, s.entity_id, s.name, s.locked_filters, s.position, s.created_at);
      db.prepare('INSERT OR IGNORE INTO suite_sets (suite_id,set_id,position) VALUES (?,?,0)').run(s.id, s.template_id);
    }
  }
});
try { migrateLegacy(); } catch (e) { console.error('[db] legacy migration skipped:', e.message); }

// Add columns to existing DBs as the schema grows.
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumn('sets', 'icon', "TEXT NOT NULL DEFAULT ''");   // emoji or image data-URL
addColumn('suites', 'icon', "TEXT NOT NULL DEFAULT ''");
addColumn('entities', 'logo', "TEXT NOT NULL DEFAULT ''"); // client brand image data-URL / emoji

// ─── Tile library ─────────────────────────────────────────────────────────────
// Every visualization tile imported from Looker is harvested here so it can be
// labelled (what it is / what it's used for) and reused when building new
// dashboards. Deduplicated by a signature of its underlying query + vis type.
db.exec(`
CREATE TABLE IF NOT EXISTS tile_library (
  id            TEXT PRIMARY KEY,
  signature     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  vis_type      TEXT NOT NULL DEFAULT '',
  fields_summary TEXT NOT NULL DEFAULT '',
  model         TEXT,
  explore       TEXT,
  def           TEXT NOT NULL,
  source_dashboard_id TEXT,
  source_title  TEXT,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tile_library_category ON tile_library(category);
`);

// ─── Entities ─────────────────────────────────────────────────────────────────
function rowToEntity(r) {
  return r && { id: r.id, name: r.name, logo: r.logo || '', lockedFilters: J(r.locked_filters, {}), scopeFields: J(r.scope_fields, {}), createdAt: r.created_at };
}
function listEntities() { return db.prepare('SELECT * FROM entities ORDER BY name').all().map(rowToEntity); }
function getEntity(id) { return rowToEntity(db.prepare('SELECT * FROM entities WHERE id=?').get(id)); }
function createEntity({ name, logo = '', lockedFilters = {}, scopeFields = {} }) {
  const e = { id: uuid(), name: name || 'Untitled entity', logo: logo || '', lockedFilters, scopeFields, createdAt: now() };
  db.prepare('INSERT INTO entities (id,name,logo,locked_filters,scope_fields,created_at) VALUES (?,?,?,?,?,?)')
    .run(e.id, e.name, e.logo, JSON.stringify(lockedFilters), JSON.stringify(scopeFields), e.createdAt);
  return e;
}
function updateEntity(id, patch) {
  const cur = db.prepare('SELECT * FROM entities WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const logo = patch.logo !== undefined ? (patch.logo || '') : (cur.logo || '');
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const sf = patch.scopeFields !== undefined ? JSON.stringify(patch.scopeFields) : cur.scope_fields;
  db.prepare('UPDATE entities SET name=?, logo=?, locked_filters=?, scope_fields=? WHERE id=?').run(name, logo, lf, sf, id);
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
  return { ...J(r.def, {}), id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}
function listDashboards() {
  return db.prepare('SELECT * FROM dashboards ORDER BY updated_at DESC').all().map((r) => {
    const def = J(r.def, {});
    return { id: r.id, title: r.title, description: def.description || '', folder: def.folder || '', tileCount: (def.tiles || []).length, source: def.source || null, createdAt: r.created_at, updatedAt: r.updated_at };
  });
}
function getDashboard(id) { return rowToDashboard(db.prepare('SELECT * FROM dashboards WHERE id=?').get(id)); }
function stripMeta(d) { const { id, title, createdAt, updatedAt, ...rest } = d; return rest; }
function createDashboard(def = {}) {
  const ts = now();
  const dash = {
    id: uuid(), title: def.title || 'Untitled dashboard', description: def.description || '',
    folder: def.folder || '', // organisational folder (e.g. the Looker folder it came from)
    theme: def.theme || defaultTheme(), filters: def.filters || [], tiles: def.tiles || [],
    carousels: def.carousels || [], gridAfter: def.gridAfter || 0, source: def.source || null,
    createdAt: ts, updatedAt: ts,
  };
  db.prepare('INSERT INTO dashboards (id,title,def,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(dash.id, dash.title, JSON.stringify(stripMeta(dash)), ts, ts);
  return dash;
}
function updateDashboard(id, patch) {
  const cur = getDashboard(id);
  if (!cur) return null;
  const merged = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: now() };
  db.prepare('UPDATE dashboards SET title=?, def=?, updated_at=? WHERE id=?').run(merged.title, JSON.stringify(stripMeta(merged)), merged.updatedAt, id);
  return merged;
}
function removeDashboard(id) { return db.prepare('DELETE FROM dashboards WHERE id=?').run(id).changes > 0; }

// ─── Sets (reusable dashboard collections) ────────────────────────────────────
function setDashboardIds(setId) {
  return db.prepare('SELECT dashboard_id FROM set_dashboards WHERE set_id=? ORDER BY position').all(setId).map((r) => r.dashboard_id);
}
function rowToSet(r) { return r && { id: r.id, name: r.name, icon: r.icon || '', dashboardIds: setDashboardIds(r.id), createdAt: r.created_at }; }
function listSets() { return db.prepare('SELECT * FROM sets ORDER BY name').all().map(rowToSet); }
function getSet(id) { return rowToSet(db.prepare('SELECT * FROM sets WHERE id=?').get(id)); }
const setSetDashboards = db.transaction((setId, dashboardIds) => {
  db.prepare('DELETE FROM set_dashboards WHERE set_id=?').run(setId);
  const ins = db.prepare('INSERT OR IGNORE INTO set_dashboards (set_id, dashboard_id, position) VALUES (?,?,?)');
  (dashboardIds || []).forEach((did, i) => { if (did) ins.run(setId, did, i); });
});
function createSet({ name, icon = '', dashboardIds = [] }) {
  const id = uuid();
  db.prepare('INSERT INTO sets (id,name,icon,created_at) VALUES (?,?,?,?)').run(id, name || 'Untitled set', icon || '', now());
  setSetDashboards(id, dashboardIds);
  return getSet(id);
}
function updateSet(id, patch) {
  const cur = db.prepare('SELECT * FROM sets WHERE id=?').get(id);
  if (!cur) return null;
  if (patch.name !== undefined) db.prepare('UPDATE sets SET name=? WHERE id=?').run(patch.name, id);
  if (patch.icon !== undefined) db.prepare('UPDATE sets SET icon=? WHERE id=?').run(patch.icon || '', id);
  if (patch.dashboardIds !== undefined) setSetDashboards(id, patch.dashboardIds);
  return getSet(id);
}
function deleteSet(id) { db.prepare('DELETE FROM sets WHERE id=?').run(id); }
function dashboardsInSet(setId) { return setDashboardIds(setId); }

// ─── Suites (event context: locks + bundled Sets) ─────────────────────────────
function suiteSetIds(suiteId) {
  return db.prepare('SELECT set_id FROM suite_sets WHERE suite_id=? ORDER BY position').all(suiteId).map((r) => r.set_id);
}
function rowToSuite(r) {
  return r && { id: r.id, entityId: r.entity_id, name: r.name, icon: r.icon || '', lockedFilters: J(r.locked_filters, {}), setIds: suiteSetIds(r.id), position: r.position, createdAt: r.created_at };
}
function listSuites() { return db.prepare('SELECT * FROM suites ORDER BY position, name').all().map(rowToSuite); }
function listSuitesForEntity(entityId) {
  return db.prepare('SELECT * FROM suites WHERE entity_id=? ORDER BY position, name').all(entityId).map(rowToSuite);
}
function getSuite(id) { return rowToSuite(db.prepare('SELECT * FROM suites WHERE id=?').get(id)); }
const setSuiteSets = db.transaction((suiteId, setIds) => {
  db.prepare('DELETE FROM suite_sets WHERE suite_id=?').run(suiteId);
  const ins = db.prepare('INSERT OR IGNORE INTO suite_sets (suite_id, set_id, position) VALUES (?,?,?)');
  (setIds || []).forEach((sid, i) => { if (sid) ins.run(suiteId, sid, i); });
});
function createSuite({ entityId, name, icon = '', lockedFilters = {}, setIds = [], position = 0 }) {
  const id = uuid();
  db.prepare('INSERT INTO suites (id,entity_id,name,icon,locked_filters,position,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, entityId, name || 'Untitled suite', icon || '', JSON.stringify(lockedFilters), position, now());
  setSuiteSets(id, setIds);
  return getSuite(id);
}
function updateSuite(id, patch) {
  const cur = db.prepare('SELECT * FROM suites WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const icon = patch.icon !== undefined ? (patch.icon || '') : cur.icon;
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const pos = patch.position ?? cur.position;
  const ent = patch.entityId ?? cur.entity_id;
  db.prepare('UPDATE suites SET name=?, icon=?, entity_id=?, locked_filters=?, position=? WHERE id=?').run(name, icon, ent, lf, pos, id);
  if (patch.setIds !== undefined) setSuiteSets(id, patch.setIds);
  return getSuite(id);
}
function deleteSuite(id) { db.prepare('DELETE FROM suites WHERE id=?').run(id); }

// All dashboards reachable through a suite (union across its sets).
function dashboardsInSuite(suiteId) {
  const out = new Set();
  for (const sid of suiteSetIds(suiteId)) for (const did of setDashboardIds(sid)) out.add(did);
  return [...out];
}
// Merged locked filters for a suite = entity locks (organiser) + suite locks
// (event/cashless). The map forced onto the user's Looker queries.
function lockedFiltersForSuite(suiteId) {
  const s = getSuite(suiteId);
  if (!s) return {};
  const e = getEntity(s.entityId);
  return { ...(e?.lockedFilters || {}), ...(s.lockedFilters || {}) };
}

// ─── Tile library ─────────────────────────────────────────────────────────────
// A stable signature for a tile's underlying query + visualization, used to
// dedupe the same tile imported from many dashboards.
function tileSignature(tile) {
  const q = tile.query || {};
  const parts = [
    q.model || '', q.view || '',
    (q.fields || []).slice().sort().join(','),
    (q.pivots || []).join(','),
    tile.vis?.type || '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// Friendly defaults derived from the query, used until a human/AI improves them.
const VIS_LABELS = {
  looker_column: 'Column chart', looker_bar: 'Bar chart', looker_line: 'Line chart',
  looker_area: 'Area chart', looker_scatter: 'Scatter chart', looker_pie: 'Pie chart',
  looker_donut_multiples: 'Donut chart', looker_grid: 'Table', table: 'Table',
  looker_single_record: 'Record', single_value: 'Single value', looker_funnel: 'Funnel',
  looker_map: 'Map', looker_geo_choropleth: 'Map', looker_timeline: 'Timeline', text: 'Text',
};
function shortField(f) { const i = f.indexOf('.'); return i >= 0 ? f.slice(i + 1).replace(/_/g, ' ') : f; }
function deriveFieldsSummary(tile) {
  const fields = (tile.query?.fields || []).map(shortField);
  return fields.join(', ');
}
function deriveName(tile) {
  if (tile.title && tile.title.trim()) return tile.title.trim();
  const vis = VIS_LABELS[tile.vis?.type] || 'Visualization';
  const fs = deriveFieldsSummary(tile);
  return fs ? `${vis}: ${fs}` : vis;
}
function deriveDescription(tile) {
  const vis = VIS_LABELS[tile.vis?.type] || 'Visualization';
  const fs = deriveFieldsSummary(tile);
  return fs ? `${vis} showing ${fs}.` : `${vis}.`;
}

function rowToLibraryTile(r) {
  if (!r) return null;
  return {
    id: r.id, signature: r.signature, name: r.name, description: r.description,
    category: r.category, visType: r.vis_type, fieldsSummary: r.fields_summary,
    model: r.model, explore: r.explore, def: J(r.def, {}),
    sourceDashboardId: r.source_dashboard_id, sourceTitle: r.source_title,
    usageCount: r.usage_count, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function listLibraryTiles({ search, category } = {}) {
  let rows = db.prepare('SELECT * FROM tile_library ORDER BY usage_count DESC, name').all();
  if (category) rows = rows.filter((r) => r.category === category);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.description} ${r.fields_summary} ${r.category}`.toLowerCase().includes(q));
  }
  return rows.map(rowToLibraryTile);
}
function listLibraryCategories() {
  return db.prepare("SELECT DISTINCT category FROM tile_library WHERE category != '' ORDER BY category").all().map((r) => r.category);
}
function getLibraryTile(id) { return rowToLibraryTile(db.prepare('SELECT * FROM tile_library WHERE id=?').get(id)); }

// Harvest a single tile into the library. Skips non-query tiles. Returns the
// library row (existing or newly created); never overwrites a curated label.
function harvestTile(tile, { sourceDashboardId, sourceTitle } = {}) {
  if (!tile || tile.type === 'text' || !tile.query?.model) return null;
  const signature = tileSignature(tile);
  const existing = db.prepare('SELECT * FROM tile_library WHERE signature=?').get(signature);
  if (existing) return rowToLibraryTile(existing);
  const ts = now();
  const id = uuid();
  // Store a clean, position-free copy of the tile to stamp into new dashboards.
  const { id: _i, layout: _l, ...tileDef } = tile;
  db.prepare(`INSERT INTO tile_library
    (id,signature,name,description,category,vis_type,fields_summary,model,explore,def,source_dashboard_id,source_title,usage_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
    id, signature, deriveName(tile), deriveDescription(tile), '', tile.vis?.type || '',
    deriveFieldsSummary(tile), tile.query?.model || null, tile.query?.view || null,
    JSON.stringify(tileDef), sourceDashboardId || null, sourceTitle || null, ts, ts,
  );
  return getLibraryTile(id);
}
// Harvest all tiles of a dashboard definition. Returns how many were newly added.
function harvestDashboardTiles(def, { sourceDashboardId } = {}) {
  let added = 0;
  const all = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const before = db.prepare('SELECT COUNT(*) c FROM tile_library').get().c;
  for (const t of all) harvestTile(t, { sourceDashboardId, sourceTitle: def.title });
  added = db.prepare('SELECT COUNT(*) c FROM tile_library').get().c - before;
  return added;
}
function updateLibraryTile(id, patch) {
  const cur = db.prepare('SELECT * FROM tile_library WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const description = patch.description ?? cur.description;
  const category = patch.category ?? cur.category;
  db.prepare('UPDATE tile_library SET name=?, description=?, category=?, updated_at=? WHERE id=?')
    .run(name, description, category, now(), id);
  return getLibraryTile(id);
}
function deleteLibraryTile(id) { return db.prepare('DELETE FROM tile_library WHERE id=?').run(id).changes > 0; }
function bumpLibraryUsage(id) { db.prepare('UPDATE tile_library SET usage_count = usage_count + 1 WHERE id=?').run(id); }

module.exports = {
  db,
  defaultTheme,
  listEntities, getEntity, createEntity, updateEntity, deleteEntity,
  listUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser, verifyCredentials, publicUser, setUserEntities,
  listDashboards, getDashboard, createDashboard, updateDashboard, removeDashboard,
  // sets (reusable collections)
  listSets, getSet, createSet, updateSet, deleteSet, setSetDashboards, dashboardsInSet,
  // suites (event context)
  listSuites, listSuitesForEntity, getSuite, createSuite, updateSuite, deleteSuite, setSuiteSets, suiteSetIds, dashboardsInSuite, lockedFiltersForSuite,
  // tile library
  listLibraryTiles, listLibraryCategories, getLibraryTile, harvestTile, harvestDashboardTiles, updateLibraryTile, deleteLibraryTile, bumpLibraryUsage,
};
