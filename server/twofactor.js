// ─── Two-factor auth (TOTP) — disposable module ───────────────────────────────
// Adds a second factor on top of the existing password/JWT login. TOTP only
// (authenticator app) + one-time backup codes — the best fit for a mobile-first
// PWA: no new infra, works offline, and implemented dependency-free (RFC 6238,
// HMAC-SHA1) in keeping with the codebase's zero-dep discipline.
//
// The TOTP secret is stored ENCRYPTED at rest (server/secretbox.js); backup codes
// are stored only as SHA-256 hashes, single-use — same shape as auth_tokens.
//
// Login step-up: index.js checks isEnabled(user) after the password succeeds; if
// so it withholds the session cookie and hands the client a short-lived pending
// token (auth.issue2faPending) instead. The client posts that token + a code to
// /api/auth/2fa, which calls verifyCode() and only THEN gets a real session. The
// magic-link and password-reset flows gate the same way, so 2FA can't be bypassed.
//
// Dual-surface (CLAUDE.md): clients self-serve under /api/my/2fa/*; admins see and
// (for a locked-out user) reset it under /api/admin/users/:id/2fa. Any enable/
// disable/reset bumps token_version so existing sessions must re-authenticate.
//
// Mount: require('./twofactor').mount(app, { db, auth, rateLimit }).

const crypto = require('crypto');
const secretbox = require('./secretbox');

// ── dependency-free TOTP (RFC 6238 / RFC 4226, SHA-1, 6 digits, 30s) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}
// Verify with a ±1 step window (clock skew). timingSafeEqual on the compare.
function verifyTotp(secretB32, token, now = Date.now()) {
  const t = String(token || '').replace(/\D/g, '');
  if (t.length !== 6) return false;
  const key = base32Decode(secretB32);
  const counter = Math.floor(now / 1000 / 30);
  for (let e = -1; e <= 1; e++) {
    const cand = hotp(key, counter + e);
    if (crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(t))) return true;
  }
  return false;
}

function mount(app, { db, auth, rateLimit, meUser, onLoginFail }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const { asyncHandler } = require('./http');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_2fa (
      user_id    TEXT PRIMARY KEY,
      secret_enc TEXT NOT NULL,
      enabled_at TEXT,                       -- null until first successful verify
      method     TEXT NOT NULL DEFAULT 'totp',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_2fa_backup (
      user_id   TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at   TEXT,
      PRIMARY KEY (user_id, code_hash)
    );
  `);

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const row = (userId) => sql.prepare('SELECT * FROM user_2fa WHERE user_id=?').get(userId);
  const isEnabled = (userId) => { const r = row(userId); return !!(r && r.enabled_at); };
  // Login/reset/magic call this after the first factor succeeds: if 2FA is on it
  // sends the pending-token response and returns true (caller must `return`),
  // withholding the session until /api/auth/2fa verifies the code.
  const stepUp = (res, user) => {
    if (!isEnabled(user.id)) return false;
    res.json({ twofa: true, pendingToken: auth.issue2faPending(user) });
    return true;
  };
  const secretOf = (r) => secretbox.open(r.secret_enc);

  function genBackupCodes(userId) {
    sql.prepare('DELETE FROM user_2fa_backup WHERE user_id=?').run(userId);
    const codes = [];
    const ins = sql.prepare('INSERT INTO user_2fa_backup (user_id, code_hash, used_at) VALUES (?,?,NULL)');
    for (let i = 0; i < 10; i++) {
      const code = base32Encode(crypto.randomBytes(6)).slice(0, 10).toLowerCase(); // e.g. "a3f9k2mq5x"
      codes.push(code);
      ins.run(userId, sha(code));
    }
    return codes;
  }
  // Consume a backup code (single-use). Returns true if one matched an unused code.
  function consumeBackup(userId, code) {
    const h = sha(String(code || '').trim().toLowerCase());
    const r = sql.prepare('SELECT code_hash FROM user_2fa_backup WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(userId, h);
    if (!r) return false;
    sql.prepare('UPDATE user_2fa_backup SET used_at=? WHERE user_id=? AND code_hash=?').run(now(), userId, h);
    return true;
  }

  // The login-time check: a live TOTP code OR an unused backup code.
  function verifyCode(userId, code) {
    const r = row(userId);
    if (!r || !r.enabled_at) return false;
    if (verifyTotp(secretOf(r), code)) return true;
    return consumeBackup(userId, code);
  }

  // Disable/reset: drop rows + bump token_version so live sessions must re-auth.
  function disable(userId) {
    sql.prepare('DELETE FROM user_2fa WHERE user_id=?').run(userId);
    sql.prepare('DELETE FROM user_2fa_backup WHERE user_id=?').run(userId);
    db.bumpTokenVersion(userId);
    if (auth.invalidateUser) auth.invalidateUser(userId); // evict the 2s user cache
  }

  // ── self-service routes ──
  const setupLimit = rateLimit({ windowMs: 60_000, max: 10, by: 'user', scope: '2fa-setup' });
  const verifyLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, by: 'user', scope: '2fa-verify' });

  app.get('/api/my/2fa', auth.requireAuth, (req, res) => res.json({ enabled: isEnabled(req.user.id) }));

  // Begin enrollment: mint a secret (not yet active), return the otpauth URI +
  // base32 secret for the authenticator app. Re-callable until confirmed.
  app.post('/api/my/2fa/setup', auth.requireAuth, setupLimit, (req, res) => {
    if (isEnabled(req.user.id)) return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-enrol.' });
    const secret = base32Encode(crypto.randomBytes(20));
    sql.prepare('INSERT INTO user_2fa (user_id, secret_enc, enabled_at, method, created_at) VALUES (?,?,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, enabled_at=NULL, created_at=excluded.created_at')
      .run(req.user.id, secretbox.seal(secret), 'totp', now());
    const label = encodeURIComponent(`Howler Pulse:${req.user.email}`);
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=Howler%20Pulse&period=30&digits=6`;
    res.json({ secret, otpauthUri });
  });

  // Confirm enrollment: a live code proves the app is set up. Turns 2FA ON and
  // returns the one-time backup codes (shown once).
  app.post('/api/my/2fa/verify', auth.requireAuth, verifyLimit, (req, res) => {
    const r = row(req.user.id);
    if (!r) return res.status(400).json({ error: 'Start setup first.' });
    if (!verifyTotp(secretOf(r), (req.body || {}).code)) return res.status(400).json({ error: 'That code didn’t match — check your authenticator and try again.' });
    sql.prepare('UPDATE user_2fa SET enabled_at=? WHERE user_id=?').run(now(), req.user.id);
    const backupCodes = genBackupCodes(req.user.id);
    db.recordAction({ userId: req.user.id, action: 'auth.2fa_enabled', label: 'Enabled two-factor auth', method: 'POST', path: '/api/my/2fa/verify' });
    res.json({ ok: true, backupCodes });
  });

  // Turn 2FA off — requires a current code (or backup code) to prove possession.
  app.post('/api/my/2fa/disable', auth.requireAuth, verifyLimit, (req, res) => {
    if (!isEnabled(req.user.id)) return res.json({ ok: true });
    if (!verifyCode(req.user.id, (req.body || {}).code)) return res.status(400).json({ error: 'Enter a current 2FA code (or a backup code) to disable it.' });
    disable(req.user.id);
    db.recordAction({ userId: req.user.id, action: 'auth.2fa_disabled', label: 'Disabled two-factor auth', method: 'POST', path: '/api/my/2fa/disable' });
    res.json({ ok: true });
  });

  // Regenerate backup codes (requires a live code).
  app.post('/api/my/2fa/backup-codes', auth.requireAuth, verifyLimit, (req, res) => {
    const r = row(req.user.id);
    if (!r || !r.enabled_at) return res.status(400).json({ error: '2FA isn’t enabled.' });
    if (!verifyTotp(secretOf(r), (req.body || {}).code)) return res.status(400).json({ error: 'Enter a current 2FA code first.' });
    res.json({ backupCodes: genBackupCodes(req.user.id) });
  });

  // ── admin: status + break-glass reset for a locked-out user ──
  app.get('/api/admin/users/:id/2fa', auth.requireAdmin, (req, res) => res.json({ enabled: isEnabled(req.params.id) }));
  app.post('/api/admin/users/:id/2fa/reset', auth.requireAdmin, (req, res) => {
    disable(req.params.id);
    db.recordAction({ userId: req.user.id, action: 'auth.2fa_admin_reset', label: `Reset 2FA for user ${req.params.id}`, method: 'POST', path: req.path, targetType: 'user', targetId: req.params.id });
    res.json({ ok: true });
  });

  // Login step-up completion: exchange the pending token (issued by index.js's
  // login/reset/magic when 2FA is on) + a TOTP/backup code for a real session.
  // Rate-limited per-IP; a bad code feeds the shared brute-force detector.
  // Two limiters: per-IP (blocks a single noisy source) AND per pending-token
  // (bounds a distributed-IP TOTP brute to this one sign-in attempt — a token is
  // minted only after a valid password, so this is effectively per-account).
  const perToken = rateLimit({
    windowMs: 15 * 60_000, max: 12, scope: '2fa-token',
    by: (req) => `tok:${crypto.createHash('sha256').update(String(req.body?.pendingToken || '')).digest('hex')}`,
    message: 'Too many codes tried — start the sign-in again.',
  });
  app.post('/api/auth/2fa', rateLimit({ windowMs: 15 * 60_000, max: 12, by: 'ip', scope: '2fa-login' }), perToken, asyncHandler(async (req, res) => {
    const { pendingToken, code } = req.body || {};
    const user = auth.verify2faPending(pendingToken);
    if (!user) return res.status(401).json({ error: 'Your sign-in timed out — start again.' });
    if (!verifyCode(user.id, code)) { if (onLoginFail) onLoginFail(user.email); return res.status(401).json({ error: 'That code didn’t match. Try again, or use a backup code.' }); }
    auth.issueCookie(res, user);
    db.touchLastLogin(user.id);
    db.recordAction({ userId: user.id, action: 'auth.login', label: 'Logged in (2FA)', method: 'POST', path: '/api/auth/2fa' });
    res.json({ user: meUser ? meUser(user) : auth.publicUser(user) });
  }));

  console.log('[twofactor] TOTP 2FA mounted');
  return { isEnabled, verifyCode, stepUp, _verifyTotp: verifyTotp, _base32Encode: base32Encode };
}

module.exports = { mount, _verifyTotp: verifyTotp, _base32Encode: base32Encode, _base32Decode: base32Decode, _hotp: hotp };
