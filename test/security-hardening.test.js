// Locks in the security-hardening batch:
//  1. Slack webhook URL is host-pinned to hooks.slack.com (SSRF guard).
//  2. Embed tokens carry the password epoch (tv) and stop authenticating after a reset.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, auth, makeClient, makeEntity } = require('./helpers');
const slack = require('../server/slack');

test('Slack webhook: only https://hooks.slack.com/… is accepted', () => {
  const collect = () => { const out = {}; return [out, (k, v) => { out[k] = v; }]; };

  // Legit Slack incoming webhook — stored.
  let [out, set] = collect();
  slack.applyPatch({ slack: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/xyz' } }, set);
  assert.equal(out.slackWebhookUrl, 'https://hooks.slack.com/services/T000/B000/xyz');

  // SSRF attempts — every one must throw (400) and store nothing.
  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',        // cloud metadata
    'http://localhost:3000/internal',                   // loopback
    'https://hooks.slack.com.evil.com/x',               // look-alike host
    'https://evil.com/hooks.slack.com',                 // path trick
    'http://hooks.slack.com/x',                          // http (not https)
  ]) {
    [out, set] = collect();
    assert.throws(() => slack.applyPatch({ slack: { webhookUrl: bad } }, set), /hooks\.slack\.com/, `must reject ${bad}`);
    assert.equal(out.slackWebhookUrl, undefined, `must not store ${bad}`);
  }
});

test('Embed token stops authenticating after the user password epoch changes', () => {
  const e = makeEntity('Embed Co', 'Embed Co');
  const user = makeClient('embed@test.local', [e.id]);

  // A freshly minted embed token authenticates as a bearer.
  const token = auth.issueEmbedToken(db.getUser(user.id));
  const attach = (headers) => { const req = { cookies: {}, headers }; auth.attachUser(req, {}, () => {}); return req; };

  let req = attach({ authorization: `Bearer ${token}` });
  assert.ok(req.user && req.user.id === user.id, 'valid embed token authenticates');
  assert.equal(req.embedAuth, true, 'marked as embed auth');

  // Bump the password epoch (what a password reset does) → old embed token is dead.
  db.bumpTokenVersion(user.id);
  auth.invalidateUser(user.id);
  req = attach({ authorization: `Bearer ${token}` });
  assert.ok(!req.user, 'embed token minted before the reset no longer authenticates');
  assert.ok(!req.embedAuth, 'and is not marked as embed auth');
});
