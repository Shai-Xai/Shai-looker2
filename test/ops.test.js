// Ops alerts (server/ops.js): throttling, suppression accounting, config fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const ops = require('../server/ops');

ops.init({ db });

test('unconfigured ops.alert never throws and stays console-only', () => {
  assert.equal(ops.isConfigured(), false);
  ops.alert('test-kind', 'something broke'); // must not throw, no webhook set
});

test('webhook config is read from the setting when no env var is set', () => {
  db.setSetting('ops_slack_webhook', 'http://127.0.0.1:1/hook');
  assert.equal(ops.isConfigured(), true);
  db.setSetting('ops_slack_webhook', '');
  assert.equal(ops.isConfigured(), false);
});

test('same-kind alerts inside the window are suppressed and counted', () => {
  db.setSetting('ops_slack_webhook', 'http://127.0.0.1:1/hook');
  try {
    ops._recent.clear();
    ops.alert('storm', 'first');   // sends (records kind)
    ops.alert('storm', 'second');  // suppressed
    ops.alert('storm', 'third');   // suppressed
    assert.equal(ops._recent.get('storm').suppressed, 2);
    ops.alert('other', 'different kind still alerts');
    assert.equal(ops._recent.get('other').suppressed, 0);
  } finally { db.setSetting('ops_slack_webhook', ''); }
});
