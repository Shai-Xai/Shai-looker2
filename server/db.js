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
addColumn('sets', 'owner_entity_id', "TEXT NOT NULL DEFAULT ''"); // '' = shared template; else a client's CUSTOM set
addColumn('sets', 'folder', "TEXT NOT NULL DEFAULT ''"); // optional grouping label in the Sets library ('' = ungrouped)
addColumn('suites', 'icon', "TEXT NOT NULL DEFAULT ''");
addColumn('entities', 'logo', "TEXT NOT NULL DEFAULT ''"); // client brand image data-URL / emoji
addColumn('entities', 'ai_context', "TEXT NOT NULL DEFAULT ''"); // client-specific AI background
addColumn('entities', 'integrations', "TEXT NOT NULL DEFAULT '{}'"); // per-client API credentials (Looker / Anthropic)
addColumn('entities', 'inventive_name', "TEXT NOT NULL DEFAULT ''"); // optional Inventive workspace name override ('' = use the client name)
addColumn('entities', 'inventive_ref_id', "TEXT NOT NULL DEFAULT ''"); // optional Inventive externalRefId override ('' = use the client's own UUID)
addColumn('entities', 'mail_branding', "TEXT NOT NULL DEFAULT '{}'"); // per-client email branding (logo/colour/sender/wording)
addColumn('entities', 'inbox_token', "TEXT NOT NULL DEFAULT ''"); // unique token for the client's CC-the-Owl inbound address
addColumn('entities', 'all_organisers', "INTEGER NOT NULL DEFAULT 0"); // internal/management client: sees ALL organisers' data (deliberately unscoped)
// Per-user notification channel preferences (1 = receive on that channel).
addColumn('users', 'notify_email', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'notify_push', 'INTEGER NOT NULL DEFAULT 1');
// Most recent successful login (ISO; null = never logged in). Powers Admin → Users.
addColumn('users', 'last_login', 'TEXT');
// Identity captured at creation (optional; blank for legacy users). Names give the
// admin directory a human label beyond email; mobile is a contact / SMS handle.
addColumn('users', 'first_name', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'last_name', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'mobile', "TEXT NOT NULL DEFAULT ''");
// Persistent per-folder settings for the dashboard library. Folders are "/"-path
// strings on each dashboard (not records), so a setting keyed by path cascades to
// every dashboard in that folder + subfolders — and to ones added later.
db.exec("CREATE TABLE IF NOT EXISTS folder_settings (folder TEXT PRIMARY KEY, keep_imported INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '')");
// Per-(user, client) role — the client-side role lives on the MEMBERSHIP, so the
// same person can hold different roles at different clients. Existing rows
// become 'owner' (full client access) so nothing loses access on upgrade.
addColumn('user_entities', 'role', "TEXT NOT NULL DEFAULT 'owner'");

// Content visibility by role, scoped PER CLIENT. A row allowlists a role for a
// set or a dashboard within an entity. NO rows for a scope = visible to everyone
// (open by default, non-breaking). Resolution: dashboard rows win, else the
// set's rows, else open. So the same dashboard can be marketing-only at one
// client and finance-only at another.
db.exec(`CREATE TABLE IF NOT EXISTS content_roles (
  entity_id  TEXT NOT NULL,
  scope_type TEXT NOT NULL,   -- 'set' | 'dashboard'
  scope_id   TEXT NOT NULL,
  role       TEXT NOT NULL,
  PRIMARY KEY (entity_id, scope_type, scope_id, role)
);`);
// Sub-dashboards: within a set, a dashboard may nest one level under a parent
// from the same set — children render as tabs inside the parent, not as
// sidebar rows. The relation lives on the membership so the same dashboard can
// be a tab in one set and standalone in another.
addColumn('set_dashboards', 'parent_dashboard_id', 'TEXT');
// Per-event briefing config: { launchDate, eventStart, eventEnd, manualPhase,
// instructions, phaseOverrides: {phaseKey: text} } — drives the home briefing.
addColumn('suites', 'briefing', "TEXT NOT NULL DEFAULT '{}'");
addColumn('suites', 'mail_branding', "TEXT NOT NULL DEFAULT '{}'"); // per-event branding override (logo/colour/sender/wording); blank inherits the client
addColumn('suites', 'event_url', "TEXT NOT NULL DEFAULT ''"); // the event's ticket/checkout link — default CTA for campaigns
// Per-suite dashboard tweaks layered over the bundled sets:
//   excluded_dashboards — dashboard ids hidden from THIS suite even though their
//     set includes them (so an admin can pick a subset of a set per client).
//   dashboard_locks — { dashboardId: { field: "v1,v2" } } locked-filter overrides
//     applied to one dashboard within this suite, on top of the suite-wide locks.
addColumn('suites', 'excluded_dashboards', "TEXT NOT NULL DEFAULT '[]'");
addColumn('suites', 'dashboard_locks', "TEXT NOT NULL DEFAULT '{}'");
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
// The user's most recent dashboard opens, with titles (for the activity feed).
function recentViewsForUser(userId, limit = 60) {
  return db.prepare(`
    SELECT uv.dashboard_id AS dashboardId, uv.suite_id AS suiteId, uv.at AS at, d.title AS title
    FROM user_views uv LEFT JOIN dashboards d ON d.id = uv.dashboard_id
    WHERE uv.user_id=? ORDER BY uv.at DESC LIMIT ?
  `).all(userId, Math.min(200, limit));
}
// Per-client usage breakdown for one user: group their dashboard opens (last
// `days`) by the client whose suite they were opened under. A dashboard open
// carries the suite it happened in, and a suite belongs to a client — so the
// same shared dashboard counts toward whichever client's context it was used in.
// Views with no suite context can't be attributed to a client and are skipped.
function usageByClientForUser(userId, days = 90) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = db.prepare(`
    SELECT suite_id AS suiteId, dashboard_id AS dashboardId, COUNT(*) AS count, MAX(at) AS lastAt
    FROM user_views WHERE user_id=? AND at>=? GROUP BY suite_id, dashboard_id
  `).all(userId, since);
  const byEntity = new Map();
  for (const r of rows) {
    const suite = r.suiteId ? getSuite(r.suiteId) : null;
    const eid = suite ? suite.entityId : '';
    if (!eid) continue; // unattributable without a client context
    let b = byEntity.get(eid);
    if (!b) { b = { entityId: eid, entityName: getEntity(eid)?.name || eid, views: 0, lastAt: '', dashboards: new Map() }; byEntity.set(eid, b); }
    b.views += r.count;
    if (r.lastAt > b.lastAt) b.lastAt = r.lastAt;
    const d = b.dashboards.get(r.dashboardId) || { dashboardId: r.dashboardId, count: 0, lastAt: '' };
    d.count += r.count; if (r.lastAt > d.lastAt) d.lastAt = r.lastAt;
    b.dashboards.set(r.dashboardId, d);
  }
  return [...byEntity.values()]
    .sort((a, c) => c.views - a.views)
    .map((b) => ({
      entityId: b.entityId, entityName: b.entityName, views: b.views, lastAt: b.lastAt,
      topDashboards: [...b.dashboards.values()]
        .sort((a, c) => c.count - a.count || (a.lastAt < c.lastAt ? 1 : -1)).slice(0, 5)
        .map((d) => ({ dashboardId: d.dashboardId, title: getDashboard(d.dashboardId)?.title || d.dashboardId, count: d.count, lastAt: d.lastAt })),
    }));
}
// Batch: each user's latest dashboard view (for the "last active" column).
function lastViewForUsers() {
  const out = {};
  for (const r of db.prepare('SELECT user_id, MAX(at) AS at FROM user_views GROUP BY user_id').all()) out[r.user_id] = r.at;
  return out;
}
// The user's recent onboarding/feature telemetry (guide + feature engagement),
// folded into the activity feed. The table is owned by telemetry.js; tolerate
// its absence (module not mounted) without throwing.
function recentUsageForUser(userId, limit = 60) {
  try {
    return db.prepare('SELECT entity_id AS entityId, kind, name, event, ts AS at FROM usage_events WHERE user_id=? ORDER BY ts DESC LIMIT ?')
      .all(userId, Math.min(200, limit));
  } catch { return []; }
}

// ─── User action audit log (every meaningful action) ─────────────────────────
// One row per state-changing request (and a few deliberate "views"), recorded by
// the audit middleware (server/audit.js) and a couple of explicit call sites
// (login/logout). Powers the Admin → Users activity timeline. Bounded per user.
db.exec(`
CREATE TABLE IF NOT EXISTS user_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  entity_id   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,            -- machine key, e.g. 'campaign.send'
  label       TEXT NOT NULL DEFAULT '', -- human summary, e.g. 'Sent a campaign'
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '{}',
  method      TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_actions_user ON user_actions(user_id, at);
`);
function recordAction({ userId, entityId = '', action, label = '', targetType = '', targetId = '', detail = {}, method = '', path = '' } = {}) {
  if (!userId || !action) return;
  try {
    db.prepare('INSERT INTO user_actions (user_id,entity_id,action,label,target_type,target_id,detail,method,path,at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(userId, entityId || '', String(action).slice(0, 64), String(label || '').slice(0, 160),
           String(targetType || '').slice(0, 32), String(targetId || '').slice(0, 80),
           JSON.stringify(detail || {}).slice(0, 1000), String(method || '').slice(0, 8), String(path || '').slice(0, 200), now());
    // Keep the per-user log bounded (latest 500) so it never grows unbounded.
    db.prepare('DELETE FROM user_actions WHERE user_id=? AND id NOT IN (SELECT id FROM user_actions WHERE user_id=? ORDER BY id DESC LIMIT 500)').run(userId, userId);
  } catch { /* audit must never break a request */ }
}
const rowToAction = (r) => ({ id: r.id, userId: r.user_id, entityId: r.entity_id, action: r.action, label: r.label, targetType: r.target_type, targetId: r.target_id, detail: J(r.detail, {}), method: r.method, path: r.path, at: r.at });
function listActionsForUser(userId, limit = 100) {
  return db.prepare('SELECT * FROM user_actions WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, Math.min(500, limit)).map(rowToAction);
}
// Batch: each user's most recent action (for the users list). One grouped query.
function lastActionsForUsers() {
  const out = {};
  const rows = db.prepare('SELECT user_id, action, label, entity_id, at FROM user_actions WHERE id IN (SELECT MAX(id) FROM user_actions GROUP BY user_id)').all();
  for (const r of rows) out[r.user_id] = { action: r.action, label: r.label, entityId: r.entity_id, at: r.at };
  return out;
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

// ─── Digest history + feedback (the knowledge-base loop) ──────────────────────
// Every digest we send is archived (so it's browsable in-app), and feedback on it
// — from in-email buttons, an email reply, or in-app — is collected and periodically
// DISTILLED into a per-client "digest preferences" note that future digests honour.
db.exec(`
CREATE TABLE IF NOT EXISTS digest_history (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  job_id      TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  role_label  TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  headline    TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '{}',
  recipients  TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_history_entity ON digest_history(entity_id, created_at);
CREATE TABLE IF NOT EXISTS digest_feedback (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  digest_id   TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',   -- email | inapp | reply | briefing
  email       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',   -- up | down | comment
  comment     TEXT NOT NULL DEFAULT '',
  distilled   INTEGER NOT NULL DEFAULT 0, -- 0 = not yet folded into the prefs note
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_feedback_entity ON digest_feedback(entity_id, created_at);
`);
function addDigestHistory({ entityId, jobId, role, roleLabel, subject, headline, content, recipients }) {
  const id = uuid();
  db.prepare('INSERT INTO digest_history (id,entity_id,job_id,role,role_label,subject,headline,content,recipients,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, entityId, jobId || '', role || '', roleLabel || '', (subject || '').slice(0, 200), (headline || '').slice(0, 600), JSON.stringify(content || {}), JSON.stringify(recipients || []), now());
  // Keep the archive bounded per client (latest 200).
  db.prepare('DELETE FROM digest_history WHERE entity_id=? AND id NOT IN (SELECT id FROM digest_history WHERE entity_id=? ORDER BY created_at DESC LIMIT 200)').run(entityId, entityId);
  return id;
}
const rowToDigest = (r) => r && ({ id: r.id, entityId: r.entity_id, jobId: r.job_id, role: r.role, roleLabel: r.role_label, subject: r.subject, headline: r.headline, content: J(r.content, {}), recipients: J(r.recipients, []), createdAt: r.created_at });
function getDigestHistory(id) { return rowToDigest(db.prepare('SELECT * FROM digest_history WHERE id=?').get(id)); }
function listDigestHistory(entityId, limit = 60) {
  return db.prepare('SELECT * FROM digest_history WHERE entity_id=? ORDER BY created_at DESC LIMIT ?').all(entityId, Math.min(200, limit)).map(rowToDigest);
}
function addDigestFeedback({ entityId, digestId, source, email, kind, comment }) {
  const id = uuid();
  const k = ['up', 'down', 'comment'].includes(kind) ? kind : 'comment';
  db.prepare('INSERT INTO digest_feedback (id,entity_id,digest_id,source,email,kind,comment,distilled,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(id, entityId || '', digestId || '', source || 'inapp', (email || '').toLowerCase(), k, (comment || '').slice(0, 2000), now());
  return id;
}
function listDigestFeedback(entityId, { limit = 200, onlyUndistilled = false } = {}) {
  const where = onlyUndistilled ? 'entity_id=? AND distilled=0' : 'entity_id=?';
  return db.prepare(`SELECT * FROM digest_feedback WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(entityId, Math.min(500, limit))
    .map((r) => ({ id: r.id, entityId: r.entity_id, digestId: r.digest_id, source: r.source, email: r.email, kind: r.kind, comment: r.comment, distilled: !!r.distilled, createdAt: r.created_at }));
}
function feedbackForDigest(digestId) {
  return db.prepare('SELECT id, kind, comment, source, email, created_at FROM digest_feedback WHERE digest_id=? ORDER BY created_at').all(digestId)
    .map((r) => ({ id: r.id, kind: r.kind, comment: r.comment, source: r.source, email: r.email, createdAt: r.created_at }));
}
function getDigestFeedbackRow(id) { const r = db.prepare('SELECT * FROM digest_feedback WHERE id=?').get(id); return r && { id: r.id, entityId: r.entity_id, digestId: r.digest_id, email: r.email, kind: r.kind, comment: r.comment }; }
// Edit a feedback comment — reset distilled so the change is reconsidered next pass.
function updateDigestFeedback(id, comment) {
  db.prepare('UPDATE digest_feedback SET comment=?, kind=?, distilled=0 WHERE id=?').run(String(comment || '').slice(0, 2000), 'comment', id);
}
function markDigestFeedbackDistilled(entityId) { db.prepare('UPDATE digest_feedback SET distilled=1 WHERE entity_id=? AND distilled=0').run(entityId); }
// Per-client distilled "digest preferences" note (the knowledge base), in settings.
function getDigestPrefs(entityId) { try { return JSON.parse(getSetting(`digest_prefs:${entityId}`, '') || '{}'); } catch { return {}; } }
function setDigestPrefs(entityId, prefs) { setSetting(`digest_prefs:${entityId}`, JSON.stringify({ note: String(prefs.note || '').slice(0, 4000), updatedAt: now(), fromCount: prefs.fromCount || 0 })); }


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
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');`);

// ─── Mail assets: rendered images embedded in emails (e.g. digest tile charts) ─
// Stored as bytes + served by an unguessable token, so a digest's chart <img>
// keeps resolving long after it was sent. Pruned by age on write.
db.exec(`CREATE TABLE IF NOT EXISTS mail_assets (
  token      TEXT PRIMARY KEY,
  mime       TEXT NOT NULL DEFAULT 'image/png',
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);`);
function putMailAsset(token, mime, bytes) {
  db.prepare('INSERT OR REPLACE INTO mail_assets (token, mime, bytes, created_at) VALUES (?,?,?,?)').run(token, mime || 'image/png', bytes, now());
  // Best-effort prune of assets older than 60 days.
  try { db.prepare("DELETE FROM mail_assets WHERE created_at < ?").run(new Date(Date.now() - 60 * 864e5).toISOString()); } catch { /* ignore */ }
}
function getMailAsset(token) {
  return db.prepare('SELECT token, mime, bytes FROM mail_assets WHERE token=?').get(token) || null;
}


// Saved dashboard filter views. scope='user' (owner=userId, personal) or
// 'entity' (owner=entityId, the client default an admin sets). Resolution on
// load: user view > entity default > the dashboard's own default_value.
db.exec(`CREATE TABLE IF NOT EXISTS dashboard_filter_views (
  scope        TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  filters      TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (scope, owner_id, dashboard_id)
);`);
function getFilterView(scope, ownerId, dashboardId) {
  if (!ownerId || !dashboardId) return null;
  const r = db.prepare('SELECT filters FROM dashboard_filter_views WHERE scope=? AND owner_id=? AND dashboard_id=?').get(scope, ownerId, dashboardId);
  return r ? J(r.filters, {}) : null;
}
function setFilterView(scope, ownerId, dashboardId, filters) {
  db.prepare(`INSERT INTO dashboard_filter_views (scope, owner_id, dashboard_id, filters, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(scope, owner_id, dashboard_id) DO UPDATE SET filters=excluded.filters, updated_at=excluded.updated_at`)
    .run(scope, ownerId, dashboardId, JSON.stringify(filters || {}), now());
}
function deleteFilterView(scope, ownerId, dashboardId) {
  db.prepare('DELETE FROM dashboard_filter_views WHERE scope=? AND owner_id=? AND dashboard_id=?').run(scope, ownerId, dashboardId);
}

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? '' : String(value));
  return getSetting(key);
}

// ─── Release notes (daily product changelog, authored in Admin → Product) ─────
// Each row is one dated entry (title + markdown body). Drafts (`published`=0) are
// hidden from any client-facing surface but kept for the team to finish later.
db.exec(`CREATE TABLE IF NOT EXISTS release_notes (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
addColumn('release_notes', 'source', "TEXT NOT NULL DEFAULT 'manual'"); // 'manual' | 'auto' (AI-summarised from commits)
addColumn('release_notes', 'last_sha', "TEXT NOT NULL DEFAULT ''");     // newest commit sha summarised for that day
// Release Notes 2.0 lenses: `body` is the end-user summary; how_to + deep_link ride to clients
// (What's New + weekly email); body_dev is internal-only and never sent to a client surface.
addColumn('release_notes', 'how_to', "TEXT NOT NULL DEFAULT ''");    // end-user steps — serves clients AND the team
addColumn('release_notes', 'body_dev', "TEXT NOT NULL DEFAULT ''");  // technical lens — internal only
addColumn('release_notes', 'deep_link', "TEXT NOT NULL DEFAULT ''"); // in-app path to the headline feature
addColumn('release_notes', 'modules', "TEXT NOT NULL DEFAULT ''");   // future per-client relevance tags (unused in v1)
function rowToReleaseNote(r) {
  return r && { id: r.id, date: r.date, title: r.title, body: r.body, howTo: r.how_to || '', bodyDev: r.body_dev || '', deepLink: r.deep_link || '', modules: r.modules || '', published: !!r.published, source: r.source || 'manual', lastSha: r.last_sha || '', createdAt: r.created_at, updatedAt: r.updated_at };
}
// Newest day first; ties broken by most-recently created.
function listReleaseNotes() {
  return db.prepare('SELECT * FROM release_notes ORDER BY date DESC, created_at DESC').all().map(rowToReleaseNote);
}
function getReleaseNote(id) { return rowToReleaseNote(db.prepare('SELECT * FROM release_notes WHERE id=?').get(id)); }
function createReleaseNote({ date = '', title = '', body = '', howTo = '', bodyDev = '', deepLink = '', modules = '', published = true, source = 'manual', lastSha = '' } = {}) {
  const id = uuid(); const ts = now();
  db.prepare('INSERT INTO release_notes (id,date,title,body,how_to,body_dev,deep_link,modules,published,source,last_sha,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, date || ts.slice(0, 10), title || '', body || '', howTo || '', bodyDev || '', deepLink || '', modules || '', published ? 1 : 0, (['auto', 'seed'].includes(source) ? source : 'manual'), lastSha || '', ts, ts);
  return getReleaseNote(id);
}
function updateReleaseNote(id, patch = {}) {
  const cur = db.prepare('SELECT * FROM release_notes WHERE id=?').get(id);
  if (!cur) return null;
  const date = patch.date !== undefined ? (patch.date || '') : cur.date;
  const title = patch.title !== undefined ? (patch.title || '') : cur.title;
  const body = patch.body !== undefined ? (patch.body || '') : cur.body;
  const howTo = patch.howTo !== undefined ? (patch.howTo || '') : cur.how_to;
  const bodyDev = patch.bodyDev !== undefined ? (patch.bodyDev || '') : cur.body_dev;
  const deepLink = patch.deepLink !== undefined ? (patch.deepLink || '') : cur.deep_link;
  const modules = patch.modules !== undefined ? (patch.modules || '') : cur.modules;
  const published = patch.published !== undefined ? (patch.published ? 1 : 0) : cur.published;
  db.prepare('UPDATE release_notes SET date=?, title=?, body=?, how_to=?, body_dev=?, deep_link=?, modules=?, published=?, updated_at=? WHERE id=?').run(date, title, body, howTo, bodyDev, deepLink, modules, published, now(), id);
  return getReleaseNote(id);
}
function deleteReleaseNote(id) { return db.prepare('DELETE FROM release_notes WHERE id=?').run(id).changes > 0; }

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

// Owl auto-ingest provenance + review gate (settlements/invoices that arrive by
// CC-the-Owl email). `source`='email' marks Owl-ingested; `needs_review`=1 hides
// it from the client until a human publishes (set when the totals cross-check
// failed); `source_ref` is the os_attachment id it came from (dedup vs re-delivery).
addColumn('settlements', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('settlements', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
addColumn('settlements', 'source_ref', "TEXT NOT NULL DEFAULT ''");
addColumn('event_documents', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('event_documents', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
addColumn('event_documents', 'source_ref', "TEXT NOT NULL DEFAULT ''");

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
  return r && { id: r.id, name: r.name, logo: r.logo || '', aiContext: r.ai_context || '', inventiveName: r.inventive_name || '', inventiveRefId: r.inventive_ref_id || '', lockedFilters: J(r.locked_filters, {}), scopeFields: J(r.scope_fields, {}), allOrganisers: !!r.all_organisers, createdAt: r.created_at };
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
  const invName = patch.inventiveName !== undefined ? (patch.inventiveName || '') : (cur.inventive_name || '');
  const invRef = patch.inventiveRefId !== undefined ? (patch.inventiveRefId || '') : (cur.inventive_ref_id || '');
  const lf = patch.lockedFilters !== undefined ? JSON.stringify(patch.lockedFilters) : cur.locked_filters;
  const sf = patch.scopeFields !== undefined ? JSON.stringify(patch.scopeFields) : cur.scope_fields;
  const allOrg = patch.allOrganisers !== undefined ? (patch.allOrganisers ? 1 : 0) : cur.all_organisers;
  db.prepare('UPDATE entities SET name=?, logo=?, ai_context=?, inventive_name=?, inventive_ref_id=?, locked_filters=?, scope_fields=?, all_organisers=? WHERE id=?').run(name, logo, aiContext, invName, invRef, lf, sf, allOrg, id);
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
// Per-EVENT (suite) branding override — same shape as the client branding, but
// one tier higher: blank fields inherit the client. Lets one client run several
// events each with their own logo/colours/sender in mailers + the in-app theme.
function getSuiteMailBranding(id) {
  const r = db.prepare('SELECT mail_branding FROM suites WHERE id=?').get(id);
  return r ? J(r.mail_branding, {}) : {};
}
function setSuiteMailBranding(id, patch) {
  const cur = getSuiteMailBranding(id);
  const next = { ...cur, ...(patch || {}) };
  db.prepare('UPDATE suites SET mail_branding=? WHERE id=?').run(JSON.stringify(next), id);
  return getSuiteMailBranding(id);
}

// ── CC-the-Owl inbound address tokens ──
// Each entity owns a short, URL/email-safe token used as the local part of its
// inbound address (e.g. <name>-<token>@in.<domain>). Generated lazily and
// rotatable; lookups route an arriving email to the right client.
function makeInboxToken(name) {
  const slug = String(name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'client';
  return `${slug}-${uuid().slice(0, 6)}`;
}
function ensureInboxToken(id) {
  const r = db.prepare('SELECT name, inbox_token FROM entities WHERE id=?').get(id);
  if (!r) return '';
  if (r.inbox_token) return r.inbox_token;
  const tok = makeInboxToken(r.name);
  db.prepare('UPDATE entities SET inbox_token=? WHERE id=?').run(tok, id);
  return tok;
}
function regenerateInboxToken(id) {
  const r = db.prepare('SELECT name FROM entities WHERE id=?').get(id);
  if (!r) return '';
  const tok = makeInboxToken(r.name);
  db.prepare('UPDATE entities SET inbox_token=? WHERE id=?').run(tok, id);
  return tok;
}
function findEntityByInboxToken(token) {
  if (!token) return null;
  return rowToEntity(db.prepare('SELECT * FROM entities WHERE inbox_token=? COLLATE NOCASE').get(String(token)));
}

// ─── Users ────────────────────────────────────────────────────────────────────
function entityIdsForUser(userId) {
  return db.prepare('SELECT entity_id FROM user_entities WHERE user_id=?').all(userId).map((r) => r.entity_id);
}
// Membership rows with their per-client role.
function membershipsForUser(userId) {
  return db.prepare('SELECT entity_id, role FROM user_entities WHERE user_id=?').all(userId).map((r) => ({ entityId: r.entity_id, role: r.role || 'owner' }));
}
function roleForMembership(userId, entityId) {
  return db.prepare('SELECT role FROM user_entities WHERE user_id=? AND entity_id=?').get(userId, entityId)?.role || null;
}
function rowToUser(r) {
  if (!r) return null;
  const memberships = membershipsForUser(r.id);
  const firstName = r.first_name || '', lastName = r.last_name || '';
  return { id: r.id, email: r.email, role: r.role, passwordHash: r.password_hash, firstName, lastName, fullName: [firstName, lastName].filter(Boolean).join(' '), mobile: r.mobile || '', entityIds: memberships.map((m) => m.entityId), memberships, notifyEmail: r.notify_email !== 0, notifyPush: r.notify_push !== 0, lastLogin: r.last_login || null, createdAt: r.created_at };
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, firstName: u.firstName || '', lastName: u.lastName || '', fullName: u.fullName || '', mobile: u.mobile || '', entityIds: u.entityIds || [], memberships: u.memberships || [], notifyEmail: u.notifyEmail !== false, notifyPush: u.notifyPush !== false };
}
// Update a user's notification channel preferences (partial).
function setNotificationPrefs(userId, prefs = {}) {
  const cur = db.prepare('SELECT notify_email, notify_push FROM users WHERE id=?').get(userId);
  if (!cur) return null;
  const email = 'email' in prefs ? (prefs.email ? 1 : 0) : cur.notify_email;
  const push = 'push' in prefs ? (prefs.push ? 1 : 0) : cur.notify_push;
  db.prepare('UPDATE users SET notify_email=?, notify_push=? WHERE id=?').run(email, push, userId);
  return { email: email !== 0, push: push !== 0 };
}
function listUsers() { return db.prepare('SELECT * FROM users ORDER BY email').all().map(rowToUser); }
function getUser(id) { return rowToUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
function getUserByEmail(email) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE email=?').get((email || '').trim().toLowerCase()));
}
// Set a user's memberships. Accepts plain entity ids (strings) or {entityId,role}
// objects. ROLE-PRESERVING: existing memberships keep their role unless a new one
// is supplied; removed entities are dropped; brand-new ones default to
// `defaultRole`. (The old wipe-and-reinsert dropped roles on every edit.)
const setUserEntities = db.transaction((userId, list, defaultRole = 'owner') => {
  const items = (list || []).map((x) => (typeof x === 'string' ? { entityId: x } : x)).filter((x) => x && x.entityId);
  const wanted = new Set(items.map((x) => x.entityId));
  const existing = new Map(db.prepare('SELECT entity_id, role FROM user_entities WHERE user_id=?').all(userId).map((r) => [r.entity_id, r.role]));
  for (const eid of existing.keys()) if (!wanted.has(eid)) db.prepare('DELETE FROM user_entities WHERE user_id=? AND entity_id=?').run(userId, eid);
  const ins = db.prepare('INSERT INTO user_entities (user_id, entity_id, role) VALUES (?,?,?) ON CONFLICT(user_id, entity_id) DO UPDATE SET role=excluded.role');
  for (const it of items) ins.run(userId, it.entityId, it.role || existing.get(it.entityId) || defaultRole);
});
// Update just one membership's role.
function setMembershipRole(userId, entityId, role) {
  return db.prepare('UPDATE user_entities SET role=? WHERE user_id=? AND entity_id=?').run(role, userId, entityId).changes > 0;
}
// Remove a single membership (unlink a user from one client).
function removeMembership(userId, entityId) {
  return db.prepare('DELETE FROM user_entities WHERE user_id=? AND entity_id=?').run(userId, entityId).changes > 0;
}
function createUser({ email, password, role = 'client', entityIds = [], firstName = '', lastName = '', mobile = '' }) {
  const e = (email || '').trim().toLowerCase();
  if (!e || !password) throw new Error('email and password are required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(e)) throw new Error('A user with that email already exists');
  const id = uuid();
  const r = role === 'admin' ? 'admin' : 'client';
  db.prepare('INSERT INTO users (id,email,password_hash,role,first_name,last_name,mobile,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, e, bcrypt.hashSync(password, 10), r, String(firstName || '').trim(), String(lastName || '').trim(), String(mobile || '').trim(), now());
  setUserEntities(id, entityIds); // admins may carry entity links too (team surface)
  return publicUser(getUser(id));
}
function updateUser(id, patch) {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!cur) return null;
  const email = patch.email ? patch.email.trim().toLowerCase() : cur.email;
  // Email is unique — surface a clear message instead of a raw constraint 500
  // when the target email already belongs to another login.
  if (email !== cur.email) {
    const clash = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, id);
    if (clash) throw new Error('That email is already used by another login.');
  }
  const hash = patch.password ? bcrypt.hashSync(patch.password, 10) : cur.password_hash;
  const role = patch.role ? (patch.role === 'admin' ? 'admin' : 'client') : cur.role;
  const firstName = patch.firstName !== undefined ? String(patch.firstName || '').trim() : cur.first_name;
  const lastName = patch.lastName !== undefined ? String(patch.lastName || '').trim() : cur.last_name;
  const mobile = patch.mobile !== undefined ? String(patch.mobile || '').trim() : cur.mobile;
  db.prepare('UPDATE users SET email=?, password_hash=?, role=?, first_name=?, last_name=?, mobile=? WHERE id=?').run(email, hash, role, firstName, lastName, mobile, id);
  if ('entityIds' in patch) setUserEntities(id, patch.entityIds);
  return publicUser(getUser(id));
}
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id=?').run(id); }
// Stamp the most recent successful login. Best-effort — never block auth on it.
function touchLastLogin(userId) {
  if (!userId) return;
  try { db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), userId); } catch { /* ignore */ }
}
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
    return { id: r.id, title: r.title, description: def.description || '', folder: def.folder || '', tileCount: (def.tiles || []).length, source: def.source || null, ownerEntityId: def.ownerEntityId || '', createdAt: r.created_at, updatedAt: r.updated_at };
  });
}
// Dashboards available to put in a context: shared (no owner) + those owned by
// the given entity. Client-owned dashboards never leak into another client's
// picker or the shared library.
function dashboardPoolFor(entityId) {
  return listDashboards().filter((d) => !d.ownerEntityId || d.ownerEntityId === entityId);
}
function sharedDashboards() { return listDashboards().filter((d) => !d.ownerEntityId); }
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
    ownerEntityId: def.ownerEntityId || '', // '' = shared; else a client's bespoke dashboard
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
  delete merged.folderKeepImported; // transient view-time hint — never persist it onto the dashboard
  db.prepare('UPDATE dashboards SET title=?, def=?, updated_at=? WHERE id=?').run(merged.title, JSON.stringify(stripMeta(merged)), merged.updatedAt, id);
  return merged;
}

// ─── Folder settings (persistent, cascade to all dashboards in the folder) ──────
function setFolderKeepImported(folder, on) {
  db.prepare("INSERT INTO folder_settings (folder, keep_imported, updated_at) VALUES (?,?,?) ON CONFLICT(folder) DO UPDATE SET keep_imported=excluded.keep_imported, updated_at=excluded.updated_at")
    .run(String(folder || ''), on ? 1 : 0, now());
}
function folderSettingsMap() {
  const m = {};
  for (const r of db.prepare('SELECT folder, keep_imported FROM folder_settings').all()) m[r.folder] = { keepImported: !!r.keep_imported };
  return m;
}
// Does this dashboard's folder path (or any ancestor folder) pin imported filters?
function folderKeepImportedFor(path) {
  const p = String(path || '');
  const rows = db.prepare('SELECT folder FROM folder_settings WHERE keep_imported=1').all();
  return rows.some((r) => { const f = r.folder; return f === '' ? p === '' : (p === f || p.startsWith(`${f}/`)); });
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
function rowToSet(r) { return r && { id: r.id, name: r.name, icon: r.icon || '', folder: r.folder || '', ownerEntityId: r.owner_entity_id || '', dashboardIds: setDashboardIds(r.id), dashboards: setDashboardEntries(r.id), createdAt: r.created_at }; }
// Shared library only (custom client sets are hidden here).
function listSets() { return db.prepare("SELECT * FROM sets WHERE owner_entity_id='' ORDER BY folder, name").all().map(rowToSet); }
// A client's CUSTOM sets.
function listSetsForEntity(entityId) { return db.prepare('SELECT * FROM sets WHERE owner_entity_id=? ORDER BY name').all(entityId).map(rowToSet); }
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
function createSet({ name, icon = '', folder = '', dashboardIds = [], ownerEntityId = '' }) {
  const id = uuid();
  db.prepare('INSERT INTO sets (id,name,icon,folder,owner_entity_id,created_at) VALUES (?,?,?,?,?,?)').run(id, name || 'Untitled set', icon || '', folder || '', ownerEntityId || '', now());
  setSetDashboards(id, dashboardIds);
  return getSet(id);
}
// Duplicate a set (and its dashboard membership/nesting) into a CLIENT-OWNED
// copy. References the same dashboards — a custom bundle the client can tweak.
function cloneSetForEntity(setId, ownerEntityId, name) {
  const src = getSet(setId);
  if (!src) return null;
  const copy = createSet({ name: name || `${src.name} (custom)`, icon: src.icon, ownerEntityId });
  setSetDashboards(copy.id, src.dashboards); // preserves {id,parentId} nesting
  return getSet(copy.id);
}
function updateSet(id, patch) {
  const cur = db.prepare('SELECT * FROM sets WHERE id=?').get(id);
  if (!cur) return null;
  if (patch.name !== undefined) db.prepare('UPDATE sets SET name=? WHERE id=?').run(patch.name, id);
  if (patch.icon !== undefined) db.prepare('UPDATE sets SET icon=? WHERE id=?').run(patch.icon || '', id);
  if (patch.folder !== undefined) db.prepare('UPDATE sets SET folder=? WHERE id=?').run(patch.folder || '', id);
  // `dashboards` ({id,parentId} entries) wins over the legacy flat id list.
  if (patch.dashboards !== undefined) setSetDashboards(id, patch.dashboards);
  else if (patch.dashboardIds !== undefined) setSetDashboards(id, patch.dashboardIds);
  return getSet(id);
}
function deleteSet(id) { db.prepare('DELETE FROM sets WHERE id=?').run(id); }
function dashboardsInSet(setId) { return setDashboardIds(setId); }

// ─── Content visibility by role (per client) ──────────────────────────────────
function rolesForScope(entityId, scopeType, scopeId) {
  return db.prepare('SELECT role FROM content_roles WHERE entity_id=? AND scope_type=? AND scope_id=?').all(entityId, scopeType, scopeId).map((r) => r.role);
}
// Replace the allowlist for one scope ([] = open to everyone).
const setContentRoles = db.transaction((entityId, scopeType, scopeId, rolesList) => {
  db.prepare('DELETE FROM content_roles WHERE entity_id=? AND scope_type=? AND scope_id=?').run(entityId, scopeType, scopeId);
  const ins = db.prepare('INSERT OR IGNORE INTO content_roles (entity_id, scope_type, scope_id, role) VALUES (?,?,?,?)');
  for (const r of rolesList || []) if (r) ins.run(entityId, scopeType, scopeId, r);
});
// All allowlists for a client, for the admin editor: { sets:{id:[roles]}, dashboards:{id:[roles]} }.
function contentRolesForEntity(entityId) {
  const out = { sets: {}, dashboards: {} };
  for (const r of db.prepare('SELECT scope_type, scope_id, role FROM content_roles WHERE entity_id=?').all(entityId)) {
    const bucket = r.scope_type === 'set' ? out.sets : out.dashboards;
    (bucket[r.scope_id] = bucket[r.scope_id] || []).push(r.role);
  }
  return out;
}
// Visibility decision for a dashboard in a client, given the viewer's role:
// dashboard rows win, else the set's rows, else open.
function dashboardVisibleToRole(entityId, setId, dashboardId, role) {
  const d = rolesForScope(entityId, 'dashboard', dashboardId);
  if (d.length) return d.includes(role);
  if (setId) { const s = rolesForScope(entityId, 'set', setId); if (s.length) return s.includes(role); }
  return true;
}

// ─── Suites (event context: locks + bundled Sets) ─────────────────────────────
function suiteSetIds(suiteId) {
  return db.prepare('SELECT set_id FROM suite_sets WHERE suite_id=? ORDER BY position').all(suiteId).map((r) => r.set_id);
}
function rowToSuite(r) {
  return r && { id: r.id, entityId: r.entity_id, name: r.name, icon: r.icon || '', eventUrl: r.event_url || '', lockedFilters: J(r.locked_filters, {}), dashboardLocks: J(r.dashboard_locks, {}), excludedDashboards: J(r.excluded_dashboards, []), briefing: J(r.briefing, {}), setIds: suiteSetIds(r.id), position: r.position, createdAt: r.created_at };
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
  const eventUrl = patch.eventUrl !== undefined ? String(patch.eventUrl || '') : (cur.event_url || '');
  const excluded = patch.excludedDashboards !== undefined ? JSON.stringify(patch.excludedDashboards || []) : (cur.excluded_dashboards || '[]');
  const dashLocks = patch.dashboardLocks !== undefined ? JSON.stringify(patch.dashboardLocks || {}) : (cur.dashboard_locks || '{}');
  db.prepare('UPDATE suites SET name=?, icon=?, entity_id=?, locked_filters=?, briefing=?, position=?, event_url=?, excluded_dashboards=?, dashboard_locks=? WHERE id=?').run(name, icon, ent, lf, brief, pos, eventUrl, excluded, dashLocks, id);
  if (patch.setIds !== undefined) setSuiteSets(id, patch.setIds);
  return getSuite(id);
}
function deleteSuite(id) { db.prepare('DELETE FROM suites WHERE id=?').run(id); }
// Set (or clear) the per-dashboard lock overrides for ONE dashboard within a
// suite, without disturbing the others. Empty map removes the dashboard's entry.
function setSuiteDashboardLocks(suiteId, dashboardId, locks) {
  const row = db.prepare('SELECT dashboard_locks FROM suites WHERE id=?').get(suiteId);
  if (!row) return null;
  const map = J(row.dashboard_locks, {});
  if (locks && Object.keys(locks).length) map[dashboardId] = locks; else delete map[dashboardId];
  db.prepare('UPDATE suites SET dashboard_locks=? WHERE id=?').run(JSON.stringify(map), suiteId);
  return map;
}

// All dashboards reachable through a suite (union across its sets).
function dashboardsInSuite(suiteId) {
  const out = new Set();
  for (const sid of suiteSetIds(suiteId)) for (const did of setDashboardIds(sid)) out.add(did);
  return [...out];
}
// Merged locked filters for a suite = entity locks (organiser) + suite locks
// (event/cashless) + (when a dashboardId is given) that dashboard's per-suite
// lock overrides. The map forced onto the user's Looker queries — most specific
// wins, so a per-dashboard lock beats the suite-wide one.
function lockedFiltersForSuite(suiteId, dashboardId) {
  const s = getSuite(suiteId);
  if (!s) return {};
  const e = getEntity(s.entityId);
  const perDash = (dashboardId && s.dashboardLocks && s.dashboardLocks[dashboardId]) || {};
  return { ...(e?.lockedFilters || {}), ...(s.lockedFilters || {}), ...perDash };
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
    source: r.source || 'manual', needsReview: !!r.needs_review,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToSettlement(r) {
  if (!r) return null;
  return { ...rowToSettlementSummary(r), data: J(r.data, {}), notes: J(r.notes, []) };
}
function listSettlements({ entityIds, includeDrafts = false } = {}) {
  let rows = db.prepare('SELECT id, entity_id, title, status, kind, settlement_date, data, file_name, source, needs_review, created_at, updated_at, (file != \'\') AS file FROM settlements ORDER BY settlement_date DESC, created_at DESC').all();
  if (!includeDrafts) rows = rows.filter((r) => !r.needs_review); // drafts (failed cross-check) stay hidden until a human publishes
  if (entityIds) rows = rows.filter((r) => r.entity_id && entityIds.includes(r.entity_id));
  return rows.map(rowToSettlementSummary);
}
// Has a settlement/document already been created from this inbound attachment?
// Used by the Owl auto-ingest to stay idempotent across webhook re-delivery.
function settlementExistsForSource(ref) { return !!ref && !!db.prepare('SELECT 1 FROM settlements WHERE source_ref=? LIMIT 1').get(String(ref)); }
function getSettlement(id) { return rowToSettlement(db.prepare('SELECT * FROM settlements WHERE id=?').get(id)); }
function getSettlementFile(id) {
  const r = db.prepare('SELECT file, file_name, file_type FROM settlements WHERE id=?').get(id);
  return r && r.file ? { file: r.file, fileName: r.file_name, fileType: r.file_type } : null;
}
// Settlement types: many weeklies during the sales period, then one final
// report (interim kept for ad-hoc statements).
const normSettlementStatus = (s) => (['weekly', 'interim', 'final'].includes(s) ? s : 'final');
const normSettlementKind = (k) => (['ticketing', 'cashless'].includes(k) ? k : 'ticketing');
function createSettlement({ entityId = null, title, status = 'final', kind = 'ticketing', settlementDate = '', data = {}, file = '', fileName = '', fileType = '', source = 'manual', needsReview = 0, sourceRef = '' }) {
  const ts = now();
  const id = uuid();
  db.prepare('INSERT INTO settlements (id,entity_id,title,status,kind,settlement_date,data,file,file_name,file_type,source,needs_review,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, entityId || null, title || data.meta?.eventName || 'Settlement report', normSettlementStatus(status), normSettlementKind(kind),
      settlementDate || data.meta?.settlementDate || '', JSON.stringify(data), file, fileName, fileType, source === 'email' ? 'email' : 'manual', needsReview ? 1 : 0, String(sourceRef || ''), ts, ts);
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
  // `eventName` edits the extracted meta so the name is consistent everywhere —
  // the admin card, the client-side event grouping, and the report header all
  // read meta.eventName.
  let data = patch.data !== undefined ? JSON.stringify(patch.data) : cur.data;
  if (patch.eventName !== undefined) {
    const d = J(data, {});
    d.meta = { ...(d.meta || {}), eventName: String(patch.eventName || '') };
    data = JSON.stringify(d);
  }
  const file = patch.file !== undefined ? patch.file : cur.file;
  const fileName = patch.fileName !== undefined ? patch.fileName : cur.file_name;
  const fileType = patch.fileType !== undefined ? patch.fileType : cur.file_type;
  // Publishing an Owl-drafted settlement = clearing needs_review (provenance
  // `source`/`source_ref` stay put).
  const needsReview = patch.needsReview !== undefined ? (patch.needsReview ? 1 : 0) : cur.needs_review;
  db.prepare('UPDATE settlements SET entity_id=?, title=?, status=?, kind=?, settlement_date=?, data=?, file=?, file_name=?, file_type=?, needs_review=?, updated_at=? WHERE id=?')
    .run(entityId, title, status, kind, date, data, file, fileName, fileType, needsReview, now(), id);
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
    source: r.source || 'manual', needsReview: !!r.needs_review,
  };
}
function rowToDocument(r) {
  if (!r) return null;
  return { ...rowToDocumentSummary(r), data: J(r.data, {}) };
}
function listDocuments({ entityIds, entityId, includeDrafts = false } = {}) {
  let rows = db.prepare('SELECT id, entity_id, event_name, title, category, data, file_name, file_type, source, needs_review, created_at FROM event_documents ORDER BY created_at DESC').all();
  if (!includeDrafts) rows = rows.filter((r) => !r.needs_review); // Owl-drafted docs stay hidden until a human publishes
  if (entityId) rows = rows.filter((r) => r.entity_id === entityId);
  else if (entityIds) rows = rows.filter((r) => r.entity_id && entityIds.includes(r.entity_id));
  return rows.map(rowToDocumentSummary);
}
function documentExistsForSource(ref) { return !!ref && !!db.prepare('SELECT 1 FROM event_documents WHERE source_ref=? LIMIT 1').get(String(ref)); }
function getDocument(id) { return rowToDocument(db.prepare('SELECT id, entity_id, event_name, title, category, data, file_name, file_type, source, needs_review, created_at FROM event_documents WHERE id=?').get(id)); }
function getDocumentFile(id) {
  const r = db.prepare('SELECT file, file_name, file_type FROM event_documents WHERE id=?').get(id);
  return r && r.file ? { file: r.file, fileName: r.file_name, fileType: r.file_type } : null;
}
function createDocument({ entityId = null, eventName = '', title, category = 'invoice', data = {}, file = '', fileName = '', fileType = '', source = 'manual', needsReview = 0, sourceRef = '' }) {
  const id = uuid();
  db.prepare('INSERT INTO event_documents (id,entity_id,event_name,title,category,data,file,file_name,file_type,source,needs_review,source_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, entityId || null, eventName || '', title || fileName || 'Document', category || 'invoice', JSON.stringify(data || {}), file, fileName, fileType, source === 'email' ? 'email' : 'manual', needsReview ? 1 : 0, String(sourceRef || ''), now());
  return getDocument(id);
}
function updateDocument(id, patch) {
  const cur = db.prepare('SELECT entity_id, event_name, title, category FROM event_documents WHERE id=?').get(id);
  if (!cur) return null;
  const entityId = patch.entityId !== undefined ? (patch.entityId || null) : cur.entity_id;
  const eventName = patch.eventName !== undefined ? (patch.eventName || '') : cur.event_name;
  const title = patch.title ?? cur.title;
  const category = patch.category ?? cur.category;
  const needsReview = patch.needsReview !== undefined ? (patch.needsReview ? 1 : 0) : (db.prepare('SELECT needs_review FROM event_documents WHERE id=?').get(id)?.needs_review || 0);
  db.prepare('UPDATE event_documents SET entity_id=?, event_name=?, title=?, category=?, needs_review=? WHERE id=?').run(entityId, eventName, title, category, needsReview, id);
  return getDocument(id);
}
function deleteDocument(id) { return db.prepare('DELETE FROM event_documents WHERE id=?').run(id).changes > 0; }

// ─── Full backup / restore (export to JSON, import to replace) ────────────────
const EXPORT_TABLES = ['entities', 'users', 'user_entities', 'sets', 'set_dashboards', 'suites', 'suite_sets', 'dashboards', 'settings', 'tile_library', 'settlements', 'event_documents', 'user_views', 'user_actions', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts', 'scheduled_jobs', 'actions', 'action_suppressions', 'action_clicks'];
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
  const delOrder = ['user_views', 'user_actions', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts', 'scheduled_jobs', 'actions', 'action_suppressions', 'action_clicks', 'user_entities', 'suite_sets', 'set_dashboards', 'suites', 'sets', 'dashboards', 'users', 'settlements', 'event_documents', 'entities', 'settings', 'tile_library'];
  const insOrder = ['entities', 'dashboards', 'users', 'sets', 'suites', 'set_dashboards', 'suite_sets', 'user_entities', 'settings', 'tile_library', 'settlements', 'event_documents', 'user_views', 'user_actions', 'user_prefs', 'tile_marks', 'briefing_feedback', 'share_links', 'os_threads', 'os_messages', 'os_receipts', 'scheduled_jobs', 'actions', 'action_suppressions', 'action_clicks'];
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
  getFilterView, setFilterView, deleteFilterView,
  listEntities, getEntity, createEntity, updateEntity, deleteEntity, getEntityIntegrations, setEntityIntegrations,
  getEntityMailBranding, setEntityMailBranding,
  getSuiteMailBranding, setSuiteMailBranding,
  ensureInboxToken, regenerateInboxToken, findEntityByInboxToken,
  listUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser, verifyCredentials, publicUser, setUserEntities, setNotificationPrefs, touchLastLogin,
  membershipsForUser, roleForMembership, setMembershipRole, removeMembership,
  listDashboards, getDashboard, createDashboard, updateDashboard, removeDashboard, dashboardPoolFor, sharedDashboards,
  setFolderKeepImported, folderSettingsMap, folderKeepImportedFor,
  // sets (reusable collections)
  listSets, listSetsForEntity, getSet, createSet, cloneSetForEntity, updateSet, deleteSet, setSetDashboards, dashboardsInSet,
  rolesForScope, setContentRoles, contentRolesForEntity, dashboardVisibleToRole,
  // suites (event context)
  listSuites, listSuitesForEntity, getSuite, createSuite, updateSuite, deleteSuite, setSuiteSets, setSuiteDashboardLocks, suiteSetIds, dashboardsInSuite, lockedFiltersForSuite,
  // tile library
  listLibraryTiles, listLibraryCategories, getLibraryTile, harvestTile, harvestDashboardTiles, updateLibraryTile, deleteLibraryTile, bumpLibraryUsage,
  // settings (key/value)
  getSetting, setSetting,
  // release notes (daily product changelog)
  listReleaseNotes, getReleaseNote, createReleaseNote, updateReleaseNote, deleteReleaseNote,
  // settlements
  listSettlements, getSettlement, getSettlementFile, createSettlement, updateSettlement, deleteSettlement, setSettlementNotes, settlementExistsForSource,
  // event documents (invoices etc.)
  listDocuments, getDocument, getDocumentFile, createDocument, updateDocument, deleteDocument, documentExistsForSource,
  // view tracking
  recordView, viewProfile, recentViewsForUser, lastViewForUsers, recentUsageForUser, usageByClientForUser,
  // user action audit log
  recordAction, listActionsForUser, lastActionsForUsers,
  // tile marks (pins + follows)
  setMark, listMarks,
  // mail assets (email-embedded images)
  putMailAsset, getMailAsset,
  // user prefs
  getUserPref, setUserPref,
  // briefing feedback
  addBriefingFeedback, listBriefingFeedback, setBriefingFeedbackStatus,
  // digest history + feedback (knowledge-base loop)
  addDigestHistory, getDigestHistory, listDigestHistory,
  addDigestFeedback, listDigestFeedback, feedbackForDigest, markDigestFeedbackDistilled,
  getDigestFeedbackRow, updateDigestFeedback,
  getDigestPrefs, setDigestPrefs,
  // share links
  createShareLink, getShareLink,
};
