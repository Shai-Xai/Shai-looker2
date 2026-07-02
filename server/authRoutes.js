// ─── Auth routes — extracted from index.js ────────────────────────────────────
// The session-lifecycle HTTP surface: login (+ brute-force guard + 2FA step-up),
// logout, the current-user probe, and the passwordless/recovery flows (forgot,
// reset, magic link). Lifted VERBATIM out of the composition root to keep it
// under its line budget and give this security-critical cluster its own home.
//
// It owns the loginGuard (per-IP + per-account throttle + failed-login detector)
// and mounts twofactor here, since both are used only by these routes. Everything
// else — auth, db, mailer, rateLimit, ops, and meUser (shared with the rest of
// index.js) — arrives as injected deps.
//
// Mount: require('./authRoutes').mount(app, { auth, db, mailer, rateLimit, ops, meUser }).

const { asyncHandler } = require('./http');

function mount(app, { auth, db, mailer, rateLimit, ops, meUser }) {
  // Brute-force guard (per-IP + per-account limiters + failed-attempt detector) → server/loginGuard.js.
  const loginGuard = require('./loginGuard')({ rateLimit, ops, db });
  // Two-factor auth (TOTP) → server/twofactor.js (login/reset/magic gate via stepUp()).
  const twofactor = require('./twofactor').mount(app, { db, auth, rateLimit, meUser, onLoginFail: (email) => loginGuard.onFailure(email) });

  app.post('/api/auth/login', loginGuard.perIp, loginGuard.perAccount, asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const user = await auth.verifyCredentials(email, password);
    if (!user) { loginGuard.onFailure(email); return res.status(401).json({ error: 'Invalid email or password' }); } // record+burst-detect; response stays generic (no enumeration)
    if (twofactor.stepUp(res, user)) return; // 2FA on → withhold session until /api/auth/2fa
    auth.issueCookie(res, user);
    db.touchLastLogin(user.id); // most recent login → Admin → Users
    db.recordAction({ userId: user.id, action: 'auth.login', label: 'Logged in', method: 'POST', path: '/api/auth/login' });
    res.json({ user: meUser(user) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    if (req.user) db.recordAction({ userId: req.user.id, action: 'auth.logout', label: 'Logged out', method: 'POST', path: '/api/auth/logout' });
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // Current user (200 with null when not logged in, so the client can decide).
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: meUser(req.user) });
  });

  // ─── Passwordless / recovery sign-in (reset link + magic link) ─────────────────
  // Both flows email a one-time link, and always answer 200 {ok:true} so an attacker
  // can't probe which emails have logins. Tokens are single-use, time-boxed, hashed.
  function sendAuthLink(user, kind, ttlMs, { subject, title, body, ctaText, path }) {
    const token = db.createAuthToken(user.id, kind, ttlMs);
    const url = `${mailer.baseUrl()}${path}?token=${encodeURIComponent(token)}`;
    const { html, text } = mailer.notificationEmail({
      title, body: `${body}\n\nThis link expires in ${Math.round(ttlMs / 60000)} minutes and can be used once. If you didn't request it, you can ignore this email.`,
      ctaText, ctaPath: `${path}?token=${encodeURIComponent(token)}`,
    });
    // notificationEmail builds the CTA from baseUrl()+ctaPath. Best-effort send.
    mailer.send({ to: user.email, subject, html, text, kind: 'auth' }).catch((e) => console.error('[auth-link]', e.message));
    return url;
  }

  // Request a password-reset email.
  app.post('/api/auth/forgot', rateLimit({ windowMs: 15 * 60_000, max: 5, by: 'ip', scope: 'forgot' }), (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const user = email ? db.getUserByEmail(email) : null;
    if (user && mailer.isConfigured()) {
      sendAuthLink(user, 'reset', 60 * 60_000, {
        subject: 'Reset your Howler : Pulse password',
        title: 'Reset your password',
        body: 'Tap the button below to set a new password for your Howler : Pulse login.',
        ctaText: 'Set a new password', path: '/reset',
      });
    }
    res.json({ ok: true });
  });

  // Complete a password reset: consume the token, set the new password, sign in.
  app.post('/api/auth/reset', rateLimit({ windowMs: 15 * 60_000, max: 10, by: 'ip', scope: 'reset' }), (req, res) => {
    const { token, password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'Choose a password of at least 8 characters.' });
    const userId = db.consumeAuthToken(token, 'reset');
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    db.updateUser(userId, { password }); // bumps token_version → old sessions die
    db.clearAuthTokens(userId, 'reset'); // any other outstanding reset links are now dead
    auth.invalidateUser(userId);         // evict the 2s user cache so old cookies are rejected at once
    const user = db.getUser(userId);
    db.recordAction({ userId, action: 'auth.reset', label: 'Reset password', method: 'POST', path: '/api/auth/reset' });
    if (twofactor.stepUp(res, user)) return; // a reset must not bypass 2FA
    auth.issueCookie(res, user);         // this browser gets a fresh cookie at the new epoch
    res.json({ user: meUser(user) });
  });

  // Request a magic sign-in link.
  app.post('/api/auth/magic', rateLimit({ windowMs: 15 * 60_000, max: 5, by: 'ip', scope: 'magic' }), (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const user = email ? db.getUserByEmail(email) : null;
    if (user && mailer.isConfigured()) {
      sendAuthLink(user, 'magic', 15 * 60_000, {
        subject: 'Your Howler : Pulse sign-in link',
        title: 'Sign in to Pulse',
        body: 'Tap the button below to sign in — no password needed.',
        ctaText: 'Sign in to Pulse', path: '/magic',
      });
    }
    res.json({ ok: true });
  });

  // Consume a magic link: issue the session cookie.
  app.post('/api/auth/magic/consume', rateLimit({ windowMs: 15 * 60_000, max: 10, by: 'ip', scope: 'magic-consume' }), (req, res) => {
    const userId = db.consumeAuthToken((req.body || {}).token, 'magic');
    if (!userId) return res.status(400).json({ error: 'This sign-in link is invalid or has expired. Request a new one.' });
    const user = db.getUser(userId);
    if (twofactor.stepUp(res, user)) return; // a magic link must not bypass 2FA
    auth.issueCookie(res, user);
    db.touchLastLogin(user.id);
    db.recordAction({ userId, action: 'auth.magic', label: 'Signed in via magic link', method: 'POST', path: '/api/auth/magic/consume' });
    res.json({ user: meUser(user) });
  });

  return { twofactor, loginGuard };
}

module.exports = { mount };
