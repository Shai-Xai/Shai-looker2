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
addColumn('entities', 'ai_context', "TEXT NOT NULL DEFAULT ''"); // client-specific AI background
addColumn('entities', 'integrations', "TEXT NOT NULL DEFAULT '{}'"); // per-client API credentials (Looker / Anthropic)
addColumn('entities', 'mail_branding', "TEXT NOT NULL DEFAULT '{}'"); // per-client email branding (logo/colour/sender/wording)
// Sub-dashboards: within a set, a dashboard may nest one level under a parent
// from the same set — children render as tabs inside the parent, not as
// sidebar rows. The relation lives on the membership so the same dashboard can
// be a tab in one set and standalone in another.
addColumn('set_dashboards', 'parent_dashboard_id', 'TEXT');
// Per-event briefing config: { launchDate, eventStart, eventEnd, manualPhase,
// instructions, phaseOverrides: {phaseKey: text} } — drives the home briefing.
addColumn('suites', 'briefing', "TEXT NOT NULL DEFAULT '{}'");
// settlements.notes/.kind added after the table shipped, so migrate existing DBs.
if (tableExists('settlements')) {
  addColumn('settlements', 'notes', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('settlements', 'kind', "TEXT NOT NULL DEFAULT 'ticketing'"); // ticketing | cashless
}
// event_documents.data (extracted invoice JSON) added after the table shipped.
if (tableExists('event_documents')) addColumn('event_documents', 'data', "TEXT NOT NULL DEFAULT '{}'");

// ─── View tracking (powers the personalised home) ────────────────────────────
// One row per dashboard open. Aggregated into a per-user profile: what they
// check most, when they last visited — feeds shortcut ranking and the Owl's
// home briefing.
db.exec(`
CREATE TABLE IF NOT EXISTS user_views (
  user_id      TEXT NOT NULL,
  suite_id     TEXT NOT NULL DEFAULT '',
  dashboard_id TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_views_user ON user_views(user_id, at);
`);
function recordView(userId, suiteId, dashboardId) {
  if (!userId || !dashboardId) return;
  db.prepare('INSERT INTO user_views (user_id, suite_id, dashboard_id, at) VALUES (?,?,?,?)').run(userId, suiteId || '', dashboardId, now());
}
// Profile: top dashboards over the last 90 days + the user's previous session
// start (most recent view older than 30 minutes — so "since your last visit"
// doesn't mean "since 30 seconds ago").
function viewProfile(userId) {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const top = db.prepare(`
    SELECT dashboard_id AS dashboardId, suite_id AS suiteId, COUNT(*) AS count, MAX(at) AS lastAt
    FROM user_views WHERE user_id=? AND at>=? GROUP BY dashboard_id ORDER BY count DESC, lastAt DESC LIMIT 10
  `).all(userId, since);
  const cutoff = new Date(Date.now() - 30 * 60e3).toISOString();
  const last = db.prepare('SELECT MAX(at) AS at FROM user_views WHERE user_id=? AND at<?').get(userId, cutoff);
  return { top, lastVisit: last?.at || null };
}

// ─── Share links ──────────────────────────────────────────────────────────────
// Short links to a dashboard + filter snapshot. NEVER an auth bypass: the
// recipient still logs in and organiser scoping applies — the link just lands
// them on the right dashboard with the sender's filters pre-applied.
db.exec(`
CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,
  suite_id    TEXT NOT NULL DEFAULT '',
  dashboard_id TEXT NOT NULL,
  filters     TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);
`);
function createShareLink({ suiteId, dashboardId, filters, createdBy }) {
  const token = crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO share_links (token, suite_id, dashboard_id, filters, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(token, suiteId || '', dashboardId, JSON.stringify(filters || {}), createdBy || '', now());
  return token;
}
function getShareLink(token) {
  const r = db.prepare('SELECT * FROM share_links WHERE token=?').get(token);
  if (!r) return null;
  db.prepare('UPDATE share_links SET hits = hits + 1 WHERE token=?').run(token);
  return { token: r.token, suiteId: r.suite_id, dashboardId: r.dashboard_id, filters: J(r.filters, {}), createdBy: r.created_by, createdAt: r.created_at, hits: r.hits + 1 };
}

// ─── Briefing feedback ────────────────────────────────────────────────────────
// Reader reactions to the home briefing: like / dislike (with comment) /
// investigate (asks Howler to look at the data). The briefing text is
// snapshotted so the team sees exactly what was reacted to.
db.exec(`
CREATE TABLE IF NOT EXISTS briefing_feedback (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',
  briefing   TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
`);
function addBriefingFeedback({ userId, userEmail, entityId, kind, comment, briefing }) {
  const id = uuid();
  const k = ['like', 'dislike', 'investigate'].includes(kind) ? kind : 'like';
  db.prepare('INSERT INTO briefing_feedback (id,user_id,user_email,entity_id,kind,comment,briefing,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, userEmail || '', entityId || '', k, (comment || '').slice(0, 2000), JSON.stringify(briefing || {}), 'new', now());
  return id;
}
function listBriefingFeedback() {
  return db.prepare('SELECT * FROM briefing_feedback ORDER BY created_at DESC LIMIT 200').all().map((r) => ({
    id: r.id, userId: r.user_id, userEmail: r.user_email, entityId: r.entity_id,
    kind: r.kind, comment: r.comment, briefing: J(r.briefing, {}), status: r.status, createdAt: r.created_at,
  }));
}
function setBriefingFeedbackStatus(id, status) {
  db.prepare('UPDATE briefing_feedback SET status=? WHERE id=?').run(status === 'resolved' ? 'resolved' : 'new', id);
}

// ─── User preferences (small k/v per user — e.g. briefing tune text) ─────────
db.exec(`
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);
`);
function getUserPref(userId, key, fallback = '') {
  const r = db.prepare('SELECT value FROM user_prefs WHERE user_id=? AND key=?').get(userId, key);
  return r ? r.value : fallback;
}
function setUserPref(userId, key, value) {
  db.prepare('INSERT INTO user_prefs (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(userId, key, value == null ? '' : String(value));
}

// ─── Tile marks: pins (show on home) & follows (briefing steering) ───────────
// kind='pin'   → the tile renders on the user's home page.
// kind='follow'→ the home briefing always reads + addresses the tile.
// scope = 'user' (scope_id=userId) | 'entity' (scope_id=entityId, admin default).
db.exec(`
CREATE TABLE IF NOT EXISTS tile_marks (
  scope        TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  tile_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'pin',
  at           TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, dashboard_id, tile_id, kind)
);
`);
// One-time migration from the short-lived home_pins table (those were created
// by the pin button, so they become 'pin' marks).
if (tableExists('home_pins')) {
  try {
    db.exec(`INSERT OR IGNORE INTO tile_marks (scope, scope_id, dashboard_id, tile_id, kind, at)
             SELECT scope, scope_id, dashboard_id, tile_id, 'pin', at FROM home_pins;
             DROP TABLE home_pins;`);
  } catch (e) { console.error('[db] home_pins migration skipped:', e.message); }
}
function setMark(scope, scopeId, dashboardId, tileId, kind, on) {
  const k = kind === 'follow' ? 'follow' : 'pin';
  if (on) {
    db.prepare('INSERT OR IGNORE INTO tile_marks (scope, scope_id, dashboard_id, tile_id, kind, at) VALUES (?,?,?,?,?,?)').run(scope, scopeId, dashboardId, tileId, k, now());
  } else {
    db.prepare('DELETE FROM tile_marks WHERE scope=? AND scope_id=? AND dashboard_id=? AND tile_id=? AND kind=?').run(scope, scopeId, dashboardId, tileId, k);
  }
}
// Marks a user sees = their own ('user') ∪ their entity's defaults ('entity').
function listMarks({ userId, entityId, kind }) {
  const rows = db.prepare(`
    SELECT dashboard_id AS dashboardId, tile_id AS tileId, scope, kind, at FROM tile_marks
    WHERE ((scope='user' AND scope_id=?) OR (scope='entity' AND scope_id=?)) AND kind=?
    ORDER BY at
  `).all(userId || '', entityId || '', kind === 'follow' ? 'follow' : 'pin');
  const out = new Map();
  for (const r of rows) { const k = `${r.dashboardId}|${r.tileId}`; if (!out.has(k) || r.scope === 'user') out.set(k, r); }
  return [...out.values()];
}

// ─── Settings (simple key/value) ──────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');`);function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? '' : String(value));
  return getSetting(key);
}

// ─── Settlements ──────────────────────────────────────────────────────────────
// Event settlement reports for clients. The original PDF is uploaded by an
// admin, AI-extracted into a structured JSON blob (`data`), and rendered as an
// interactive report. The source file rides along (base64) for download.
db.exec(`
CREATE TABLE IF NOT EXISTS settlements (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT REFERENCES entities(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'final',
  kind            TEXT NOT NULL DEFAULT 'ticketing',
  settlement_date TEXT NOT NULL DEFAULT '',
  data            TEXT NOT NULL DEFAULT '{}',
  notes           TEXT NOT NULL DEFAULT '[]',
  file            TEXT NOT NULL DEFAULT '',
  file_name       TEXT NOT NULL DEFAULT '',
  file_type       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_entity ON settlements(entity_id);

-- Event documents: invoices and other files uploaded per client/event. Plain
-- storage + download, no extraction.
CREATE TABLE IF NOT EXISTS event_documents (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT REFERENCES entities(id) ON DELETE SET NULL,
  event_name  TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'invoice',
  data        TEXT NOT NULL DEFAULT '{}',
  file        TEXT NOT NULL DEFAULT '',
  file_name   TEXT NOT NULL DEFAULT '',
  file_type   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_documents_entity ON event_documents(entity_id);
`);

// Tile library ─────────────────────────────────────────────────────────────────
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
  return r && { id: r.id, name: r.name, logo: r.logo || '', aiContext: r.ai_context || '', lockedFilters: J(r.locked_filters, {}), scopeFields: J(r.scope_fields, {}), createdAt: r.created_at };
}
function listEntities() { return db.prepare('SELECT * FROM entities ORDER BY name').all().map(rowToEntity); }
function getEntity(id) { return rowToEntity(db.prepare('SELECT * FROM entities WHERE id=?').get(id)); }
function createEntity({ name, logo = '', aiContext = '', lockedFilters = {}, scopeFields = {} }) {
  const e = { id: uuid(), name: name || 'Untitled entity', logo: logo || '', aiContext: aiContext || '', lockedFilters, scopeFields, createdAt: now() };
  db.prepare('INSERT INTO entities (id,name,logo,ai_context,locked_filters,scope_fields,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(e.id, e.name, e.logo, e.aiContext, JSON.stringify(lockedFilters), JSON.stringify(scopeFields), e.createdAt);
  return e;
}
function updateEntity(id, patch) {
  const cur = db.prepare('SELECT * FROM entities WHERE id=?').get(id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const logo = patch.logo !== undefined ? (patch.logo || '') : (cur.logo || '');
  const aiContext = patch.aiContext !== undefined ? (patch.aiContext || '') : (cur.ai_context || '');
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const sf = patch.scopeFields !== undefined ? JSON.stringify(patch.scopeFields) : cur.scope_fields;
  db.prepare('UPDATE entities SET name=?, logo=?, ai_context=?, locked_filters=?, scope_fields=? WHERE id=?').run(name, logo, aiContext, lf, sf, id);
  return getEntity(id);
}
function deleteEntity(id) { db.prepare('DELETE FROM entities WHERE id=?').run(id); }

// Per-client integration credentials (Looker / Anthropic). Kept separate from
// the general entity object so secrets never ride along to the browser by
// accident — only the dedicated, masked endpoints expose them.
function getEntityIntegrations(id) {
  const r = db.prepare('SELECT integrations FROM entities WHERE id=?').get(id);
  return r ? J(r.integrations, {}) : {};
}
function setEntityIntegrations(id, patch) {
  const cur = getEntityIntegrations(id);
  const next = { ...cur, ...(patch || {}) }; // patch carries only the keys to change
  db.prepare('UPDATE entities SET integrations=? WHERE id=?').run(JSON.stringify(next), id);
  return getEntityIntegrations(id);
}
// Per-client email branding (logo / brand colour / sender name / wording). A
// plain JSON blob on the entity — safe to send to the browser, unlike creds.
function getEntityMailBranding(id) {
  const r = db.prepare('SELECT mail_branding FROM entities WHERE id=?').get(id);
  return r ? J(r.mail_branding, {}) : {};
}
function setEntityMailBranding(id, patch) {
  const cur = getEntityMailBranding(id);
  const next = { ...cur, ...(patch || {}) };
  db.prepare('UPDATE entities SET mail_branding=? WHERE id=?').run(JSON.stringify(next), id);
  return getEntityMailBranding(id);
}

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
    aiContext: def.aiContext || '', // dashboard-level AI context
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
// Ordered membership entries with the nesting relation: [{ id, parentId }].
function setDashboardEntries(setId) {
  return db.prepare('SELECT dashboard_id, parent_dashboard_id FROM set_dashboards WHERE set_id=? ORDER BY position').all(setId)
    .map((r) => ({ id: r.dashboard_id, parentId: r.parent_dashboard_id || null }));
}
function rowToSet(r) { return r && { id: r.id, name: r.name, icon: r.icon || '', dashboardIds: setDashboardIds(r.id), dashboards: setDashboardEntries(r.id), createdAt: r.created_at }; }
function listSets() { return db.prepare('SELECT * FROM sets ORDER BY name').all().map(rowToSet); }
function getSet(id) { return rowToSet(db.prepare('SELECT * FROM sets WHERE id=?').get(id)); }
// Accepts plain ids (top-level) or { id, parentId } entries. Nesting is one
// level deep and a parent must be in the same set — anything else flattens to
// top-level rather than ever losing a dashboard.
const setSetDashboards = db.transaction((setId, items) => {
  db.prepare('DELETE FROM set_dashboards WHERE set_id=?').run(setId);
  const norm = (items || [])
    .map((x) => (typeof x === 'string' ? { id: x, parentId: null } : { id: x?.id, parentId: x?.parentId || null }))
    .filter((x) => x.id);
  const inSet = new Set(norm.map((x) => x.id));
  const ins = db.prepare('INSERT OR IGNORE INTO set_dashboards (set_id, dashboard_id, position, parent_dashboard_id) VALUES (?,?,?,?)');
  norm.forEach((x, i) => {
    let p = x.parentId && x.parentId !== x.id && inSet.has(x.parentId) ? x.parentId : null;
    if (p && norm.find((n) => n.id === p)?.parentId) p = null; // parent is itself a child → flatten
    ins.run(setId, x.id, i, p);
  });
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
  // `dashboards` ({id,parentId} entries) wins over the legacy flat id list.
  if (patch.dashboards !== undefined) setSetDashboards(id, patch.dashboards);
  else if (patch.dashboardIds !== undefined) setSetDashboards(id, patch.dashboardIds);
  return getSet(id);
}
function deleteSet(id) { db.prepare('DELETE FROM sets WHERE id=?').run(id); }
function dashboardsInSet(setId) { return setDashboardIds(setId); }

// ─── Suites (event context: locks + bundled Sets) ─────────────────────────────
function suiteSetIds(suiteId) {
  return db.prepare('SELECT set_id FROM suite_sets WHERE suite_id=? ORDER BY position').all(suiteId).map((r) => r.set_id);
}
function rowToSuite(r) {
  return r && { id: r.id, entityId: r.entity_id, name: r.name, icon: r.icon || '', lockedFilters: J(r.locked_filters, {}), briefing: J(r.briefing, {}), setIds: suiteSetIds(r.id), position: r.position, createdAt: r.created_at };
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
  const brief = patch.briefing !== undefined ? JSON.stringify(patch.briefing || {}) : (cur.briefing || '{}');
  const pos = patch.position ?? cur.position;
  const ent = patch.entityId ?? cur.entity_id;
  db.prepare('UPDATE suites SET name=?, icon=?, entity_id=?, locked_filters=?, briefing=?, position=? WHERE id=?').run(name, icon, ent, lf, brief, pos, id);
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

// ─── Settlements ──────────────────────────────────────────────────────────────
// Lightweight summary for lists: pull the headline numbers out of the JSON so
// index pages never ship the full row data or the PDF.
function rowToSettlementSummary(r) {
  if (!r) return null;
  const d = J(r.data, {});
  return {
    id: r.id, entityId: r.entity_id, title: r.title, status: r.status,
    kind: r.kind || 'ticketing',
    settlementDate: r.settlement_date,
    eventName: d.meta?.eventName || r.title,
    eventDates: d.meta?.eventDates || '',
    venue: d.meta?.venue || '',
    clientName: d.meta?.clientName || '',
    turnover: d.turnover ?? null,
    valueDue: d.valueDue ?? null,
    advances: (d.advances?.rows || []).map((a) => ({ date: a.date, value: a.value })),
    hasFile: !!r.file, fileName: r.file_name || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToSettlement(r) {
  if (!r) return null;
  return { ...rowToSettlementSummary(r), data: J(r.data, {}), notes: J(r.notes, []) };
}
function listSettlements({ entityIds } = {}) {
  let rows = db.prepare('SELECT id, entity_id, title, status, kind, settlement_date, data, file_name, created_at, updated_at, (file != \'\') AS file FROM settlements ORDER BY settlement_date DESC, created_at DESC').all();
  if (entityIds) rows = rows.filter((r) => r.entity_id && entityIds.includes(r.entity_id));
  return rows.map(rowToSettlementSummary);
}
function getSettlement(id) { return rowToSettlement(db.prepare('SELECT * FROM settlements WHERE id=?').get(id)); }
function getSettlementFile(id) {
  const r = db.prepare('SELECT file, file_name, file_type FROM settlements WHERE id=?').get(id);
  return r && r.file ? { file: r.file, fileName: r.file_name, fileType: r.file_type } : null;
}
// Settlement types: many weeklies during the sales period, then one final
// report (interim kept for ad-hoc statements).
const normSettlementStatus = (s) => (['weekly', 'interim', 'final'].includes(s) ? s : 'final');
const normSettlementKind = (k) => (['ticketing', 'cashless'].includes(k) ? k : 'ticketing');
function createSettlement({ entityId = null, title, status = 'final', kind = 'ticketing', settlementDate = '', data = {}, file = '', fileName = '', fileType = '' }) {
  const ts = now();
  const id = uuid();
  db.prepare('INSERT INTO settlements (id,entity_id,title,status,kind,settlement_date,data,file,file_name,file_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, entityId || null, title || data.meta?.eventName || 'Settlement report', normSettlementStatus(status), normSettlementKind(kind),
      settlementDate || data.meta?.settlementDate || '', JSON.stringify(data), file, fileName, fileType, ts, ts);
  return getSettlement(id);
}
function updateSettlement(id, patch) {
  const cur = db.prepare('SELECT * FROM settlements WHERE id=?').get(id);
  if (!cur) return null;
  const entityId = patch.entityId !== undefined ? (patch.entityId || null) : cur.entity_id;
  const title = patch.title ?? cur.title;
  const status = patch.status !== undefined ? normSettlementStatus(patch.status) : cur.status;
  const kind = patch.kind !== undefined ? normSettlementKind(patch.kind) : (cur.kind || 'ticketing');
  const date = patch.settlementDate ?? cur.settlement_date;
  const data = patch.data !== undefined ? JSON.stringify(patch.data) : cur.data;
  const file = patch.file !== undefined ? patch.file : cur.file;
  const fileName = patch.fileName !== undefined ? patch.fileName : cur.file_name;
  const fileType = patch.fileType !== undefined ? patch.fileType : cur.file_type;
  db.prepare('UPDATE settlements SET entity_id=?, title=?, status=?, kind=?, settlement_date=?, data=?, file=?, file_name=?, file_type=?, updated_at=? WHERE id=?')
    .run(entityId, title, status, kind, date, data, file, fileName, fileType, now(), id);
  return getSettlement(id);
}
function deleteSettlement(id) { return db.prepare('DELETE FROM settlements WHERE id=?').run(id).changes > 0; }
// Notes are user-authored annotations (a JSON array) — replaced wholesale by the
// client, which holds the full list. Kept separate from `data` (the extraction).
function setSettlementNotes(id, notes) {
  if (!db.prepare('SELECT 1 FROM settlements WHERE id=?').get(id)) return null;
  db.prepare('UPDATE settlements SET notes=?, updated_at=? WHERE id=?').run(JSON.stringify(Array.isArray(notes) ? notes : []), now(), id);
  return getSettlement(id);
}

// ─── Event documents (invoices etc.) ──────────────────────────────────────────
// `data` carries the AI-extracted invoice JSON (empty object when the file was
// stored without extraction). List rows surface just the headline numbers.
function rowToDocumentSummary(r) {
  if (!r) return null;
  const d = J(r.data, {});
  return {
    id: r.id, entityId: r.entity_id, eventName: r.event_name, title: r.title,
    category: r.category, fileName: r.file_name, fileType: r.file_type, createdAt: r.created_at,
    invoiceNumber: d.meta?.invoiceNumber || '', invoiceDate: d.meta?.date || '',
    total: d.total ?? null, hasData: !!(d.items?.length || d.total != null),
  };
}
function rowToDocument(r) {
  if (!r) return null;
  return { ...rowToDocumentSummary(r), data: J(r.data, {}) };
}
function listDocuments({ entityIds, entityId } = {}) {
  let rows = db.prepare('SELECT id, entity_id, event_name, title, category, data, file_name, file_type, created_at FROM event_documents ORDER BY created_at DESC').all();
  if (entityId) rows = rows.filter((r) => r.entity_id === entityId);
  else if (entityIds) rows = rows.filter((r) => r.entity_id && entityIds.includes(r.entity_id));
  return rows.map(rowToDocumentSummary);
}
function getDocument(id) { return rowToDocument(db.prepare('SELECT id, entity_id, event_name, title, category, data, file_name, file_type, created_at FROM event_documents WHERE id=?').get(id)); }
function getDocumentFile(id) {
  const r = db.prepare('SELECT file, file_name, file_type FROM event_documents WHERE id=?').get(id);
  return r && r.file ? { file: r.file, fileName: r.file_name, fileType: r.file_type } : null;
}
function createDocument({ entityId = null, eventName = '', title, category = 'invoice', data = {}, file = '', fileName = '', fileType = '' }) {
  const id = uuid();
  db.prepare('INSERT INTO event_documents (id,entity_id,event_name,title,category,data,file,file_name,file_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, entityId || null, eventName || '', title || fileName || 'Document', category || 'invoice', JSON.stringify(data || {}), file, fileName, fileType, now());
  return getDocument(id);
}
function updateDocument(id, patch) {
  const cur = db.prepare('SELECT entity_id, event_name, title, category FROM event_documents WHERE id=?').get(id);
  if (!cur) return null;
  const entityId = patch.entityId !== undefined ? (patch.entityId || null) : cur.entity_id;
  const eventName = patch.eventName !== undefined ? (patch.eventName || '') : cur.event_name;
  const title = patch.title ?? cur.title;
  const category = patch.category ?? cur.category;
  db.prepare('UPDATE event_documents SET entity_id=?, event_name=?, title=?, category=? WHERE id=?').run(entityId, eventName, title, category, id);
  return getDocument(id);
}
function deleteDocument(id) { return db.prepare('DELETE FROM event_documents WHERE id=?').run(id).changes > 0; }

// ─── Full backup / restore (export to JSON, import to replace) ────────────────
const EXPORT_TABLES = ['entities', 'users', 'user_entities', 'sets', 'set_dashboards', 'suites', 'suite_sets', 'dashboards', 'settings', 'tile_library', 'settlements', 'event_documents', 'user_views', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts'];
function exportAll() {
  const out = { _version: 1, exportedAt: now() };
  for (const t of EXPORT_TABLES) out[t] = tableExists(t) ? db.prepare(`SELECT * FROM ${t}`).all() : [];
  return out;
}
function insertRow(name, row) {
  const valid = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  const cols = Object.keys(row).filter((c) => valid.has(c));
  if (!cols.length) return;
  const sql = `INSERT OR REPLACE INTO ${name} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  db.prepare(sql).run(...cols.map((c) => row[c]));
}
// Replace ALL data with the contents of an export. Deletes children first
// (FK-safe), then inserts parents first.
const importAll = db.transaction((data) => {
  const delOrder = ['user_views', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts', 'user_entities', 'suite_sets', 'set_dashboards', 'suites', 'sets', 'dashboards', 'users', 'settlements', 'event_documents', 'entities', 'settings', 'tile_library'];
  const insOrder = ['entities', 'dashboards', 'users', 'sets', 'suites', 'set_dashboards', 'suite_sets', 'user_entities', 'settings', 'tile_library', 'settlements', 'event_documents', 'user_views', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts'];
  for (const t of delOrder) { if (tableExists(t)) db.prepare(`DELETE FROM ${t}`).run(); }
  let counts = {};
  for (const t of insOrder) {
    if (!Array.isArray(data[t])) continue;
    for (const row of data[t]) insertRow(t, row);
    counts[t] = data[t].length;
  }
  return counts;
});

module.exports = {
  db,
  defaultTheme,
  exportAll, importAll,
  listEntities, getEntity, createEntity, updateEntity, deleteEntity, getEntityIntegrations, setEntityIntegrations,
  getEntityMailBranding, setEntityMailBranding,
  listUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser, verifyCredentials, publicUser, setUserEntities,
  listDashboards, getDashboard, createDashboard, updateDashboard, removeDashboard,
  // sets (reusable collections)
  listSets, getSet, createSet, updateSet, deleteSet, setSetDashboards, dashboardsInSet,
  // suites (event context)
  listSuites, listSuitesForEntity, getSuite, createSuite, updateSuite, deleteSuite, setSuiteSets, suiteSetIds, dashboardsInSuite, lockedFiltersForSuite,
  // tile library
  listLibraryTiles, listLibraryCategories, getLibraryTile, harvestTile, harvestDashboardTiles, updateLibraryTile, deleteLibraryTile, bumpLibraryUsage,
  // settings (key/value)
  getSetting, setSetting,
  // settlements
  listSettlements, getSettlement, getSettlementFile, createSettlement, updateSettlement, deleteSettlement, setSettlementNotes,
  // event documents (invoices etc.)
  listDocuments, getDocument, getDocumentFile, createDocument, updateDocument, deleteDocument,
  // view tracking
  recordView, viewProfile,
  // tile marks (pins + follows)
  setMark, listMarks,
  // user prefs
  getUserPref, setUserPref,
  // briefing feedback
  addBriefingFeedback, listBriefingFeedback, setBriefingFeedbackStatus,
  // share links
  createShareLink, getShareLink,
};
