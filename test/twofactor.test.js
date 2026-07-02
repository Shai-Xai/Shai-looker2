// 2FA: TOTP correctness + the enrollment / step-up / backup-code flows and the
// session-invalidation on disable. Driven over real HTTP via the test harness.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp, cookieFor } = require('./http');
const tf = require('../server/twofactor');

// Compute a valid TOTP for a base32 secret at "now" (mirrors an authenticator app).
function codeFor(secret, when = Date.now()) {
  const key = tf._base32Decode(secret);
  return tf._hotp(key, Math.floor(when / 1000 / 30));
}

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  // RFC 6238 seed "12345678901234567890" (ASCII); at T=59s (counter 1) the 8-digit
  // value is 94287082 → last 6 digits "287082".
  const secretB32 = tf._base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(tf._hotp(tf._base32Decode(secretB32), 1), '287082');
  // And verifyTotp accepts the code computed for the current window.
  assert.equal(tf._verifyTotp(secretB32, tf._hotp(tf._base32Decode(secretB32), Math.floor(Date.now() / 1000 / 30))), true);
});

test('verifyTotp accepts the current code and rejects a wrong one', () => {
  const secret = tf._base32Encode(crypto.randomBytes(20));
  assert.equal(tf._verifyTotp(secret, codeFor(secret)), true);
  assert.equal(tf._verifyTotp(secret, '000000'), false);
  assert.equal(tf._verifyTotp(secret, 'abc'), false);
});

let app, mod;
before(async () => {
  app = await startApp((expressApp) => {
    // A permissive rate-limit stub isn't needed — the real one allows these counts.
    mod = require('../server/twofactor').mount(expressApp, { db: h.db, auth: h.auth, rateLimit: require('../server/ratelimit') });
  });
});
after(async () => { if (app) await app.close(); });

test('enrollment: setup → verify turns 2FA on and returns backup codes', async () => {
  const u = h.makeClient('tfa-enroll@test.local', [h.makeEntity('T1', 't1-org').id], 'owner');
  const jar = cookieFor(u);
  const setup = await app.req('POST', '/api/my/2fa/setup', { headers: { Cookie: jar } });
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.ok(setup.body.secret);
  assert.equal(mod.isEnabled(u.id), false, 'not enabled until confirmed');

  const bad = await app.req('POST', '/api/my/2fa/verify', { headers: { Cookie: jar }, body: { code: '000000' } });
  assert.equal(bad.status, 400);

  const ok = await app.req('POST', '/api/my/2fa/verify', { headers: { Cookie: jar }, body: { code: codeFor(setup.body.secret) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.backupCodes.length, 10);
  assert.equal(mod.isEnabled(u.id), true);

  // verifyCode accepts a live TOTP and a one-time backup code (single-use).
  assert.equal(mod.verifyCode(u.id, codeFor(setup.body.secret)), true);
  const backup = ok.body.backupCodes[0];
  assert.equal(mod.verifyCode(u.id, backup), true);
  assert.equal(mod.verifyCode(u.id, backup), false, 'backup code is single-use');
});

test('disable requires a valid code and bumps token_version (invalidates sessions)', async () => {
  const u = h.makeClient('tfa-disable@test.local', [h.makeEntity('T2', 't2-org').id], 'owner');
  const jar = cookieFor(u);
  const setup = await app.req('POST', '/api/my/2fa/setup', { headers: { Cookie: jar } });
  await app.req('POST', '/api/my/2fa/verify', { headers: { Cookie: jar }, body: { code: codeFor(setup.body.secret) } });
  const tvBefore = h.db.getUser(u.id).tokenVersion;

  const bad = await app.req('POST', '/api/my/2fa/disable', { headers: { Cookie: jar }, body: { code: '000000' } });
  assert.equal(bad.status, 400);
  assert.equal(mod.isEnabled(u.id), true, 'still on after a bad code');

  const ok = await app.req('POST', '/api/my/2fa/disable', { headers: { Cookie: jar }, body: { code: codeFor(setup.body.secret) } });
  assert.equal(ok.status, 200);
  assert.equal(mod.isEnabled(u.id), false);
  assert.ok(h.db.getUser(u.id).tokenVersion > tvBefore, 'token_version bumped on disable');
});

test('admin can reset (break-glass) a locked-out user’s 2FA', async () => {
  const u = h.makeClient('tfa-locked@test.local', [h.makeEntity('T3', 't3-org').id], 'owner');
  const jar = cookieFor(u);
  const setup = await app.req('POST', '/api/my/2fa/setup', { headers: { Cookie: jar } });
  await app.req('POST', '/api/my/2fa/verify', { headers: { Cookie: jar }, body: { code: codeFor(setup.body.secret) } });
  assert.equal(mod.isEnabled(u.id), true);

  const admin = h.makeAdmin('tfa-admin@test.local');
  const res = await app.req('POST', `/api/admin/users/${u.id}/2fa/reset`, { headers: { Cookie: cookieFor(admin) } });
  assert.equal(res.status, 200);
  assert.equal(mod.isEnabled(u.id), false, 'admin reset cleared 2FA');

  // A non-admin cannot reset someone else's 2FA.
  const other = h.makeClient('tfa-other@test.local', [h.makeEntity('T4', 't4-org').id], 'owner');
  const denied = await app.req('POST', `/api/admin/users/${u.id}/2fa/reset`, { headers: { Cookie: cookieFor(other) } });
  assert.equal(denied.status, 403);
});
