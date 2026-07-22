// ─── 👁 View as user — SELF-CONTAINED, DISPOSABLE MODULE ────────────────────────
// Lets a Howler admin see Pulse EXACTLY as one client user does — their role,
// their content visibility, their flags, their Owl access — by swapping into a
// short-lived real session for that user (auth.issueImpersonationCookie). The
// shell shows a persistent banner (hint cookie) with one-tap Exit, which
// restores the admin's own session only if the stashed return token still
// verifies as a live admin. Admins can never impersonate other admins, and every
// start/stop is audit-logged. Remove this file + the mount line to uninstall.
module.exports.mount = function mount(app, { db, auth }) {
  app.post('/api/admin/impersonate/:userId', auth.requireAdmin, (req, res) => {
    const target = db.getUser(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'You can view as client users only — not other Howler admins.' });
    auth.issueImpersonationCookie(req, res, target, req.user);
    console.log(`[impersonate] ${req.user.email} → viewing as ${target.email} (${target.id})`);
    res.json({ ok: true, viewingAs: { id: target.id, email: target.email, name: target.fullName || '' } });
  });
  app.post('/api/impersonate/exit', (req, res) => {
    const admin = auth.endImpersonation(req, res);
    if (!admin) return res.status(401).json({ error: 'Your admin session expired — log in again.' });
    console.log(`[impersonate] ${admin.email} exited view-as`);
    res.json({ ok: true });
  });
};
