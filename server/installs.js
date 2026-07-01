// ─── PWA install tracking — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────
// Knowing whether a user actually put Pulse on their phone is otherwise invisible
// server-side. The client pings POST /api/my/installed every time it loads while
// running as an installed/standalone app (home-screen on iOS, standalone display
// mode on Android/desktop). We stamp first-seen + last-seen + device per user, so
// admin can show an "📱 installed · last opened …" marker on the user views.
//
//   • first_at — when we first saw them open the installed app.
//   • last_at  — the most recent in-app open (a live "still using the app" signal).
//   • ua       — the device/browser, for context.
//
// Mount: require('./installs').mount(app, { db, auth });

function mount(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS app_installs (
    user_id  TEXT PRIMARY KEY,
    first_at TEXT NOT NULL DEFAULT '',
    last_at  TEXT NOT NULL DEFAULT '',
    ua       TEXT NOT NULL DEFAULT ''
  );`);

  // Client self-report: fired on load when running as the installed app.
  app.post('/api/my/installed', auth.requireAuth, (req, res) => {
    const now = new Date().toISOString();
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    sql.prepare(`INSERT INTO app_installs (user_id, first_at, last_at, ua) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at, ua = excluded.ua`).run(req.user.id, now, now, ua);
    res.json({ ok: true });
  });

  // Admin: install state for every user, keyed by id — merged into the user views.
  app.get('/api/admin/installs', auth.requireAdmin, (req, res) => {
    const out = {};
    try { for (const r of sql.prepare('SELECT user_id, first_at, last_at, ua FROM app_installs').all()) out[r.user_id] = { firstAt: r.first_at, lastAt: r.last_at, ua: r.ua }; } catch { /* table new */ }
    res.json({ installs: out });
  });

  console.log('[installs] PWA install tracking mounted');
}

module.exports = { mount };
