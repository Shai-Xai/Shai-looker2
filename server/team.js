// ─── Client self-service team management — SELF-CONTAINED, DISPOSABLE MODULE ───
// A client Owner manages their own team's logins + roles, scoped to their entity
// (a mirror of the admin Logins tab). Howler-staff logins are never exposed or
// editable here; a client can only ever touch its own members. Also owns the
// first-time "set your password" invite email, which the admin add-user route
// reuses — so it's returned from mount().
//
// Mount: const team = require('./team').mount(app, { auth, db, roles, mailer });
//   then the admin user-create route uses team.randomTempPassword /
//   team.emailSetPasswordInvite for the same email-invite behaviour.

const crypto = require('crypto');

function mount(app, { auth, db, roles, mailer }) {
  function teamMembers(entityId) {
    return db.listUsers()
      .filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(entityId))
      .map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, firstName: u.firstName, lastName: u.lastName, mobile: u.mobile, role: (u.memberships || []).find((m) => m.entityId === entityId)?.role || 'owner', alsoOtherClients: (u.entityIds || []).length > 1 }));
  }
  const ownerCount = (entityId) => teamMembers(entityId).filter((m) => m.role === 'owner').length;

  // The client's Howler support contacts — the admins assigned to the account,
  // shown to the client as "Your Howler Support" with each one's job title + email.
  function howlerSupportFor(entityId) {
    const ent = db.getEntity(entityId);
    return (ent?.howlerSupportIds || [])
      .map((id) => db.getUser(id))
      .filter((u) => u && u.role === 'admin')
      .map((u) => ({ id: u.id, name: u.fullName || u.email, email: u.email, mobile: u.mobile || '', roleLabel: roles.howlerRoleLabel(u.howlerRole) || 'Account Manager' }));
  }

  // A random, policy-passing password for an email-invited account: the user never
  // sees it — they set their own via the emailed link. base64url of 18 bytes ≫ 8 chars.
  function randomTempPassword() { return crypto.randomBytes(18).toString('base64url'); }
  // Email a newly-created user a one-time link to set their OWN password (7-day,
  // single-use 'reset' token). Best-effort: account creation succeeds even if mail
  // is off/unconfigured — 'auth' kind so it's never gated by marketing suppression.
  function emailSetPasswordInvite(user, { invitedBy = '' } = {}) {
    try {
      if (!user?.email || !mailer?.isConfigured?.()) return;
      const token = db.createAuthToken(user.id, 'reset', 7 * 24 * 3600_000);
      const hi = user.firstName ? `Hi ${user.firstName},` : 'Hi,';
      const { html, text } = mailer.notificationEmail({
        title: 'Welcome to Pulse 👋',
        body: `${hi}\n\nYou've been given access to Howler Pulse${invitedBy ? ` by ${invitedBy}` : ''}. Set your password to sign in.\n\nThis link expires in 7 days and can be used once. If you weren't expecting this, you can ignore this email.`,
        ctaText: 'Set your password', ctaPath: `/reset?token=${encodeURIComponent(token)}`,
      });
      mailer.send({ to: user.email, subject: 'Welcome to Pulse — set your password', html, text, kind: 'auth' }).catch((e) => console.error('[invite-mail]', e.message));
    } catch (e) { console.error('[invite-mail]', e.message); }
  }

  app.get('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
    res.json({ members: teamMembers(req.params.entityId).map((m) => ({ ...m, isYou: m.id === req.user.id })), roles: roles.catalog(), support: howlerSupportFor(req.params.entityId) });
  });
  app.post('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
    const { email, password, role, firstName, lastName, mobile } = req.body || {};
    if (!roles.ROLE_KEYS.includes(String(role || ''))) return res.status(400).json({ error: 'Unknown role' });
    try {
      // No password typed → email-invite: create with a random one, then email a
      // set-password link so the teammate chooses their own on first sign-in.
      const emailInvite = !(password && String(password).trim());
      const u = auth.createUser({ email, password: emailInvite ? randomTempPassword() : password, role: 'client', entityIds: [req.params.entityId], firstName, lastName, mobile });
      db.setMembershipRole(u.id, req.params.entityId, role);
      if (emailInvite) emailSetPasswordInvite(u, { invitedBy: req.user.firstName ? `${req.user.firstName}` : 'your team' });
      res.status(201).json({ ok: true, invited: emailInvite });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/my/team/:entityId/:userId/role', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
    const { entityId, userId } = req.params;
    const role = String((req.body || {}).role || '');
    if (!roles.ROLE_KEYS.includes(role)) return res.status(400).json({ error: 'Unknown role' });
    const target = teamMembers(entityId).find((m) => m.id === userId);
    if (!target) return res.status(404).json({ error: 'Not a member of this client' });
    if (target.role === 'owner' && role !== 'owner' && ownerCount(entityId) <= 1) return res.status(400).json({ error: 'This is the last Owner — promote someone else first.' });
    db.setMembershipRole(userId, entityId, role);
    res.json({ ok: true, role });
  });
  app.delete('/api/my/team/:entityId/:userId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
    const { entityId, userId } = req.params;
    const target = teamMembers(entityId).find((m) => m.id === userId);
    if (!target) return res.status(404).json({ error: 'Not a member of this client' });
    if (target.role === 'owner' && ownerCount(entityId) <= 1) return res.status(400).json({ error: 'This is the last Owner — promote someone else first.' });
    db.removeMembership(userId, entityId);
    res.status(204).end();
  });

  return { randomTempPassword, emailSetPasswordInvite, howlerSupportFor };
}

module.exports = { mount };
