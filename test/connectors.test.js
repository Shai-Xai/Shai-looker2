// Audience-sync connectors hash PII before it leaves Pulse. The hashes MUST match
// the platforms' Customer-File normalisation (lowercase/trim email; E.164 digits
// phone, default ZA) or matching silently fails — and Meta and TikTok must agree
// so the same person maps to the same hash on both. This locks that behaviour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const meta = require('../server/meta');
const tiktok = require('../server/tiktok');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('email is lowercased + trimmed before hashing', () => {
  assert.equal(meta.hashEmail('  Foo@Bar.com  '), sha256('foo@bar.com'));
  assert.equal(meta.hashEmail(''), '');
  assert.equal(meta.hashEmail(null), '');
});

test('phone is normalised to E.164 digits (default ZA) before hashing', () => {
  const expected = sha256('27821234567');
  assert.equal(meta.hashPhone('0821234567'), expected);      // local SA
  assert.equal(meta.hashPhone('+27 82 123 4567'), expected); // already international
  assert.equal(meta.hashPhone('0027821234567'), expected);   // 00 prefix
  assert.equal(meta.hashPhone('not a phone'), '');
});

test('Meta and TikTok hash identities identically', () => {
  assert.equal(meta.hashEmail('person@example.com'), tiktok.hashEmail('person@example.com'));
  assert.equal(meta.hashPhone('0821234567'), tiktok.hashPhone('0821234567'));
});

test('connectors no-op cleanly when a client is not connected', () => {
  // No db init → not configured → graceful, never throws.
  assert.equal(meta.isConfigured('nope'), false);
  assert.equal(tiktok.isConfigured('nope'), false);
});
