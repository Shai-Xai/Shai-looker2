// ─── Dashboard store ─────────────────────────────────────────────────────────
// Thin facade over the SQLite data layer (db.js). Kept as its own module so the
// many callers in index.js don't change. Dashboard *content* lives as a JSON
// blob; who-can-see-what is now decided by template/set membership (see db.js),
// not a tenantId on the dashboard.

const db = require('./db');

module.exports = {
  list: db.listDashboards,
  get: db.getDashboard,
  create: db.createDashboard,
  update: db.updateDashboard,
  remove: db.removeDashboard,
  defaultTheme: db.defaultTheme,
};
