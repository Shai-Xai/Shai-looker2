// ─── Dashboard share links ────────────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE (routes only — the share_links table lives in
// db.js). Mint a short link to a dashboard + the sender's current filters. Never
// an auth bypass: /s/:token just redirects; the dashboard route still requires
// login and applies organiser scoping to the recipient. Lifted VERBATIM out of
// index.js. (Report Studio's public share links are separate — server/reports.js.)

function mount(app, { db, auth, store }) {
  app.post('/api/share', auth.requireAuth, (req, res) => {
    const { suiteId, dashboardId, filters } = req.body || {};
    const def = store.get(dashboardId);
    if (!def) return res.status(404).json({ error: 'Dashboard not found' });
    if (!auth.canAccessDashboard(req.user, def)) return res.status(403).json({ error: 'Not allowed' });
    if (suiteId && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const clean = {};
    for (const [k, v] of Object.entries(filters || {})) {
      if (typeof v === 'string' && v.trim() !== '') clean[String(k).slice(0, 120)] = v.slice(0, 300);
    }
    const token = db.createShareLink({ suiteId: suiteId || '', dashboardId, filters: clean, createdBy: req.user.email });
    res.status(201).json({ token, path: `/s/${token}` });
  });
  // Resolve a share token → redirect to the dashboard with filters in the URL.
  // No auth needed for the translation; if the visitor isn't logged in, the SPA
  // shows login and (URL preserved) lands them on the dashboard afterwards.
  app.get('/s/:token', (req, res) => {
    const link = db.getShareLink(req.params.token);
    if (!link) return res.redirect('/');
    const qs = Object.keys(link.filters || {}).length ? `?f=${encodeURIComponent(JSON.stringify(link.filters))}` : '';
    const target = link.suiteId ? `/suite/${link.suiteId}/d/${link.dashboardId}${qs}` : `/d/${link.dashboardId}${qs}`;
    res.redirect(target);
  });
}

module.exports = { mount };
