// Secrets at rest: round-trip, backward-compat with legacy plaintext, and proof
// that the admin export / DB backup no longer carry plaintext credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const secretbox = require('../server/secretbox');

test('seal/open round-trips and open() is a no-op on plaintext', () => {
  const s = secretbox.seal('sk-live-supersecret');
  assert.ok(s.startsWith('gcm1:'));
  assert.notEqual(s, 'sk-live-supersecret');
  assert.equal(secretbox.open(s), 'sk-live-supersecret');
  assert.equal(secretbox.open('plain-legacy-value'), 'plain-legacy-value'); // backward-compat
  assert.equal(secretbox.seal(''), ''); // never seal blanks
});

test('isSecretName flags credential-ish keys, not branding/ids', () => {
  for (const k of ['resend_api_key', 'looker_client_secret', 'github_token', 'whatsapp_webhook_secret', 'anthropicApiKey', 'metaAccessToken']) {
    assert.equal(secretbox.isSecretName(k), true, `${k} should be a secret`);
  }
  for (const k of ['senderName', 'brandColor', 'slackChannel', 'lookerBaseUrl', 'digest_prefs']) {
    assert.equal(secretbox.isSecretName(k), false, `${k} should NOT be a secret`);
  }
});

test('secret settings are stored sealed but read back plaintext', () => {
  h.db.setSetting('resend_api_key', 're_live_ABC123');
  // Raw column value is sealed…
  const raw = h.db.db.prepare("SELECT value FROM settings WHERE key='resend_api_key'").get().value;
  assert.ok(raw.startsWith('gcm1:'), 'stored value must be sealed');
  assert.ok(!raw.includes('re_live_ABC123'), 'plaintext must not be present on disk');
  // …but getSetting transparently decrypts.
  assert.equal(h.db.getSetting('resend_api_key'), 're_live_ABC123');
  // A non-secret setting stays plaintext (comparisons/other code rely on it).
  h.db.setSetting('mail_enabled', '1');
  assert.equal(h.db.db.prepare("SELECT value FROM settings WHERE key='mail_enabled'").get().value, '1');
});

test('entity integration secrets are sealed at rest, non-secret fields are not', () => {
  const ent = h.makeEntity('Sealed Co', 'sealed-org');
  h.db.setEntityIntegrations(ent.id, { anthropicApiKey: 'sk-ant-XYZ', slackChannel: '#ops', senderName: 'Acme' });
  const rawBlob = h.db.db.prepare('SELECT integrations FROM entities WHERE id=?').get(ent.id).integrations;
  assert.ok(!rawBlob.includes('sk-ant-XYZ'), 'secret must be sealed in the stored blob');
  assert.ok(rawBlob.includes('#ops'), 'non-secret field stays readable');
  const got = h.db.getEntityIntegrations(ent.id);
  assert.equal(got.anthropicApiKey, 'sk-ant-XYZ'); // transparently decrypted
  assert.equal(got.slackChannel, '#ops');
});

test('exportAll carries SEALED secrets, never plaintext', () => {
  h.db.setSetting('looker_client_secret', 'looker-plaintext-secret-999');
  const dump = h.db.exportAll();
  const json = JSON.stringify(dump);
  assert.ok(!json.includes('looker-plaintext-secret-999'), 'export must not contain any plaintext secret');
  const row = dump.settings.find((s) => s.key === 'looker_client_secret');
  assert.ok(row && row.value.startsWith('gcm1:'), 'export carries the sealed form');
});
