// ─── Login brute-force guard — small shared library ───────────────────────────
// Two rate limiters + a failed-attempt recorder for the login route, kept out of
// the composition root. Per-IP alone misses a distributed/rotating-IP attack on
// one account; the per-ACCOUNT limiter (keyed on the submitted email) closes that.
// Both fail open (never lock out legitimate traffic). onFailure records the
// attempt for Admin → Users (against the real user id when the email exists, so
// it adds NO enumeration signal to the generic 401) and fires an ops alert when
// one account crosses a burst threshold — detection, not just prevention.
//
// Factory: require('./loginGuard')({ rateLimit, ops, db }) → { perIp, perAccount, onFailure }.

module.exports = function createLoginGuard({ rateLimit, ops, db }) {
  const perIp = rateLimit({ windowMs: 15 * 60_000, max: 10, by: 'ip', scope: 'login' });
  const perAccount = rateLimit({
    windowMs: 15 * 60_000, max: 6,
    by: (req) => `acct:${String(req.body?.email || '').trim().toLowerCase()}`,
    scope: 'login-acct',
    message: 'Too many attempts for this account — wait a few minutes and try again.',
  });

  const fails = new Map(); // email -> { n, at }
  function onFailure(email) {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return;
    try { const u = db.getUserByEmail(key); if (u) db.recordAction({ userId: u.id, action: 'auth.login_failed', label: 'Failed login attempt', method: 'POST', path: '/api/auth/login' }); } catch { /* never break login */ }
    const now = Date.now();
    const rec = fails.get(key);
    if (!rec || now - rec.at > 15 * 60_000) fails.set(key, { n: 1, at: now });
    else { rec.n += 1; rec.at = now; if (rec.n === 5) ops.alert('auth', `Repeated failed logins for ${key} (5+ in 15 min) — possible brute force`); }
    if (fails.size > 5000) fails.clear();
  }

  return { perIp, perAccount, onFailure, _fails: fails };
};
