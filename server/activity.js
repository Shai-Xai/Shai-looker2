// ─── User activity + audit log — extracted from db.js ─────────────────────────
// Owns the two activity tables and every read/report over them:
//   • user_views   — one row per dashboard open (recordView), pruned to a
//     rolling window; powers the profile feed, per-client usage, and the admin
//     activity report.
//   • user_actions — one row per meaningful state-changing request (recordAction,
//     written by the audit middleware), bounded per user; powers the timeline.
//
// Lifted VERBATIM out of db.js (behaviour-preserving) to keep db.js under its
// line budget and give this cohesive concern its own home. Collaborators from
// db.js (getSuite/getEntity/getDashboard/getUser/listUsers/listEntities + now/J)
// arrive as injected deps, so there's no circular require.
//
// Factory: require('./activity')({ sql, now, J, ... }) → the function set, which
// db.js re-exports under the same names it always had.

module.exports = function createActivity({ sql, now, J, getSuite, getEntity, getDashboard, getUser, listUsers, listEntities }) {
  sql.exec(`
  CREATE TABLE IF NOT EXISTS user_views (
    user_id      TEXT NOT NULL,
    suite_id     TEXT NOT NULL DEFAULT '',
    dashboard_id TEXT NOT NULL,
    at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_views_user ON user_views(user_id, at);
  CREATE INDEX IF NOT EXISTS idx_user_views_at ON user_views(at);
  `);

  // user_views grows one row per dashboard open forever. The admin reports scan it
  // by time-range (idx_user_views_at serves those), and we keep the table itself
  // bounded by pruning past the retention window — cheaply, every Nth insert
  // rather than on every open (this is a hot path).
  const VIEW_RETAIN_DAYS = Number(process.env.USER_VIEWS_RETAIN_DAYS) || 400; // ~13 months (reports cap at 365d)
  let _viewInserts = 0;
  function recordView(userId, suiteId, dashboardId) {
    if (!userId || !dashboardId) return;
    sql.prepare('INSERT INTO user_views (user_id, suite_id, dashboard_id, at) VALUES (?,?,?,?)').run(userId, suiteId || '', dashboardId, now());
    if ((++_viewInserts % 500) === 0) {
      try { sql.prepare('DELETE FROM user_views WHERE at < ?').run(new Date(Date.now() - VIEW_RETAIN_DAYS * 86400000).toISOString()); } catch { /* prune is best-effort */ }
    }
  }
  // Profile: top dashboards over the last 90 days + the user's previous session
  // start (most recent view older than 30 minutes — so "since your last visit"
  // doesn't mean "since 30 seconds ago").
  function viewProfile(userId) {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const top = sql.prepare(`
      SELECT dashboard_id AS dashboardId, suite_id AS suiteId, COUNT(*) AS count, MAX(at) AS lastAt
      FROM user_views WHERE user_id=? AND at>=? GROUP BY dashboard_id ORDER BY count DESC, lastAt DESC LIMIT 10
    `).all(userId, since);
    const cutoff = new Date(Date.now() - 30 * 60e3).toISOString();
    const last = sql.prepare('SELECT MAX(at) AS at FROM user_views WHERE user_id=? AND at<?').get(userId, cutoff);
    return { top, lastVisit: last?.at || null };
  }
  // The user's most recent dashboard opens, with titles (for the activity feed).
  function recentViewsForUser(userId, limit = 60) {
    return sql.prepare(`
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
    const rows = sql.prepare(`
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
    for (const r of sql.prepare('SELECT user_id, MAX(at) AS at FROM user_views GROUP BY user_id').all()) out[r.user_id] = r.at;
    return out;
  }
  // The user's recent onboarding/feature telemetry (guide + feature engagement),
  // folded into the activity feed. The table is owned by telemetry.js; tolerate
  // its absence (module not mounted) without throwing.
  function recentUsageForUser(userId, limit = 60) {
    try {
      return sql.prepare('SELECT entity_id AS entityId, kind, name, event, ts AS at FROM usage_events WHERE user_id=? ORDER BY ts DESC LIMIT ?')
        .all(userId, Math.min(200, limit));
    } catch { return []; }
  }

  // Platform-wide activity summary for the admin Users console: how many people are
  // active, who's most active, which dashboards get opened most and which features
  // get used most — aggregated across every user from the view + audit logs.
  function adminActivityReport({ days = 30, limit = 8 } = {}) {
    const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const win = ago(days);                          // selected window → breakdowns
    const f1 = ago(1), f7 = ago(7), f30 = ago(30);  // FIXED windows for the snapshot card
    // Active = a user in the view log OR action log in the window (deduped).
    const activeIds = (s) => sql.prepare('SELECT user_id FROM (SELECT user_id FROM user_views WHERE at>=? UNION SELECT user_id FROM user_actions WHERE at>=?)').all(s, s).map((r) => r.user_id);
    const winIds = activeIds(win);
    // Surface split: window's active users who opened the INSTALLED app vs only a browser.
    const appUsers = new Set();
    try { for (const r of sql.prepare('SELECT user_id FROM app_installs WHERE last_at>=?').all(win)) appUsers.add(r.user_id); } catch { /* table new */ }
    const app = winIds.filter((id) => appUsers.has(id)).length;
    const topUsers = sql.prepare(
      `SELECT user_id AS userId, SUM(c) AS total, MAX(lastAt) AS lastAt FROM (
         SELECT user_id, COUNT(*) c, MAX(at) lastAt FROM user_views   WHERE at>=? GROUP BY user_id
         UNION ALL
         SELECT user_id, COUNT(*) c, MAX(at) lastAt FROM user_actions WHERE at>=? GROUP BY user_id
       ) GROUP BY user_id ORDER BY total DESC LIMIT ?`,
    ).all(win, win, limit).map((r) => { const u = getUser(r.userId); return { userId: r.userId, name: u ? (u.fullName || u.email) : r.userId, role: u?.role || '', total: r.total, lastAt: r.lastAt }; });
    const topDashboards = sql.prepare('SELECT dashboard_id AS dashboardId, COUNT(*) AS opens, COUNT(DISTINCT user_id) AS users, MAX(at) AS lastAt FROM user_views WHERE at>=? GROUP BY dashboard_id ORDER BY opens DESC LIMIT ?')
      .all(win, limit).map((r) => ({ ...r, title: getDashboard(r.dashboardId)?.title || r.dashboardId }));
    const topFeatures = sql.prepare('SELECT action, COUNT(*) AS uses, COUNT(DISTINCT user_id) AS users, MAX(label) AS label FROM user_actions WHERE at>=? GROUP BY action ORDER BY uses DESC LIMIT ?')
      .all(win, limit).map((r) => ({ action: r.action, label: r.label || r.action, uses: r.uses, users: r.users }));
    const totalViews = sql.prepare('SELECT COUNT(*) c FROM user_views WHERE at>=?').get(win).c;
    const totalActions = sql.prepare('SELECT COUNT(*) c FROM user_actions WHERE at>=?').get(win).c;
    return {
      days, active: { d1: activeIds(f1).length, d7: activeIds(f7).length, d30: activeIds(f30).length },
      surfaces: { total: winIds.length, app, web: winIds.length - app },
      totals: { views: totalViews, actions: totalActions }, topUsers, topDashboards, topFeatures,
    };
  }
  // Clients (entities) with no client-side engagement in `days` — last login /
  // dashboard open / audited action across their non-admin logins. `never` = none ever.
  function inactivity(days = 30, limit = 60) {
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    const lv = lastViewForUsers(), la = lastActionsForUsers();
    const lastOf = (u) => [u.lastLogin, lv[u.id], la[u.id]?.at].filter(Boolean).sort().pop() || null;
    const byE = new Map(); const users = [];
    for (const u of listUsers().filter((x) => x.role !== 'admin')) { const t = lastOf(u);
      if (!t || t < cutoff) users.push({ id: u.id, name: u.fullName || u.email, email: u.email, lastActiveAt: t, never: !t, client: (u.entityIds || []).map((eid) => getEntity(eid)?.name || '').filter(Boolean).join(', ') });
      for (const eid of u.entityIds || []) { const b = byE.get(eid) || { lastActiveAt: null, userCount: 0 }; b.userCount += 1; if (t && (!b.lastActiveAt || t > b.lastActiveAt)) b.lastActiveAt = t; byE.set(eid, b); }
    }
    const bySort = (a, c) => (!!a.never === !!c.never ? String(a.lastActiveAt || '').localeCompare(String(c.lastActiveAt || '')) : (a.never ? -1 : 1));
    const clients = listEntities().map((e) => { const b = byE.get(e.id) || { lastActiveAt: null, userCount: 0 }; return { entityId: e.id, entityName: e.name, lastActiveAt: b.lastActiveAt, userCount: b.userCount, never: !b.lastActiveAt }; }).filter((c) => c.never || c.lastActiveAt < cutoff).sort(bySort).slice(0, limit);
    return { clients, users: users.sort(bySort).slice(0, limit) };
  }

  // ─── User action audit log (every meaningful action) ─────────────────────────
  // One row per state-changing request (and a few deliberate "views"), recorded by
  // the audit middleware (server/audit.js) and a couple of explicit call sites
  // (login/logout). Powers the Admin → Users activity timeline. Bounded per user.
  sql.exec(`
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
      sql.prepare('INSERT INTO user_actions (user_id,entity_id,action,label,target_type,target_id,detail,method,path,at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(userId, entityId || '', String(action).slice(0, 64), String(label || '').slice(0, 160),
             String(targetType || '').slice(0, 32), String(targetId || '').slice(0, 80),
             JSON.stringify(detail || {}).slice(0, 1000), String(method || '').slice(0, 8), String(path || '').slice(0, 200), now());
      // Keep the per-user log bounded (latest 500) so it never grows unbounded.
      sql.prepare('DELETE FROM user_actions WHERE user_id=? AND id NOT IN (SELECT id FROM user_actions WHERE user_id=? ORDER BY id DESC LIMIT 500)').run(userId, userId);
    } catch { /* audit must never break a request */ }
  }
  const rowToAction = (r) => ({ id: r.id, userId: r.user_id, entityId: r.entity_id, action: r.action, label: r.label, targetType: r.target_type, targetId: r.target_id, detail: J(r.detail, {}), method: r.method, path: r.path, at: r.at });
  function listActionsForUser(userId, limit = 100) {
    return sql.prepare('SELECT * FROM user_actions WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, Math.min(500, limit)).map(rowToAction);
  }
  // Batch: each user's most recent action (for the users list). One grouped query.
  function lastActionsForUsers() {
    const out = {};
    const rows = sql.prepare('SELECT user_id, action, label, entity_id, at FROM user_actions WHERE id IN (SELECT MAX(id) FROM user_actions GROUP BY user_id)').all();
    for (const r of rows) out[r.user_id] = { action: r.action, label: r.label, entityId: r.entity_id, at: r.at };
    return out;
  }

  return {
    recordView, viewProfile, recentViewsForUser, usageByClientForUser, lastViewForUsers,
    recentUsageForUser, adminActivityReport, inactivity,
    recordAction, listActionsForUser, lastActionsForUsers,
  };
};
