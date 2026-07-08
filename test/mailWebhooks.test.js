// Resend webhook (server/mailWebhooks.js) + the global suppression tier it
// feeds (server/mailer.js). What this pins:
//   1. Svix signature verification: valid → suppression recorded; bad
//      signature → 401; no secret configured → 503 (fail closed).
//   2. Enforcement in mailer.send: a BOUNCED address is blocked for every
//      kind of mail; a COMPLAINED address is blocked for marketing kinds
//      (campaign) but operational mail still flows.
//   3. Admin endpoints: list + un-suppress.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp } = require('./http');

const mailer = require('../server/mailer');

const SECRET_KEY = crypto.randomBytes(24); // svix secrets are base64 after 'whsec_'
const SECRET = 'whsec_' + SECRET_KEY.toString('base64');

// Sign a payload exactly the way Svix/Resend does.
function svixHeaders(payload, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), key = SECRET_KEY } = {}) {
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

let app;
before(async () => {
  mailer.init({ db: h.db });
  app = await startApp((expressApp) => {
    require('../server/mailWebhooks').mount(expressApp, { db: h.db, auth: h.auth, mailer });
  });
});
after(async () => { if (app) await app.close(); });

// Raw fetch: the handler verifies the signature over the EXACT bytes, and the
// harness's global express.json must not consume the stream first (production
// exempts this path from the JSON parser; text/plain sidesteps it here).
const post = (payload, headers) => fetch(`${app.base}/api/webhooks/resend`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: payload,
});

test('no secret configured → 503 (fail closed)', async () => {
  h.db.setSetting('resend_webhook_secret', '');
  const r = await post('{}', svixHeaders('{}'));
  assert.equal(r.status, 503);
});

test('a signed bounce event suppresses the address; bad signatures are rejected', async () => {
  h.db.setSetting('resend_webhook_secret', SECRET);

  // Wrong key → 401, nothing recorded.
  const bad = await post('{}', svixHeaders('{}', { key: crypto.randomBytes(24) }));
  assert.equal(bad.status, 401);
  // Stale timestamp → 401 (replay guard).
  const stale = await post('{}', svixHeaders('{}', { ts: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 401);

  const payload = JSON.stringify({ type: 'email.bounced', data: { to: ['Dead@Example.com'], bounce: { message: 'mailbox does not exist' } } });
  const ok = await post(payload, svixHeaders(payload));
  assert.equal(ok.status, 200);
  const rows = mailer.listSuppressions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'dead@example.com'); // stored lowercased
  assert.equal(rows[0].reason, 'bounced');
});

test('bounced blocks EVERY kind of send; complained blocks marketing only', async () => {
  h.db.setSetting('resend_webhook_secret', SECRET);
  const c = JSON.stringify({ type: 'email.complained', data: { to: ['angry@example.com'], subject: 'Big sale' } });
  assert.equal((await post(c, svixHeaders(c, { id: 'msg_2' }))).status, 200);

  // Bounced (from the previous test's row): dead for all kinds.
  let r = await mailer.send({ to: 'dead@example.com', subject: 'x', html: 'x', kind: 'campaign' });
  assert.match(r.reason, /suppressed \(bounced\)/);
  r = await mailer.send({ to: 'dead@example.com', subject: 'x', html: 'x', kind: 'other' });
  assert.match(r.reason, /suppressed \(bounced\)/);

  // Complained: no more campaigns…
  r = await mailer.send({ to: 'angry@example.com', subject: 'x', html: 'x', kind: 'campaign' });
  assert.match(r.reason, /suppressed \(complained\)/);
  // …but operational mail passes the suppression gate (it then skips on the
  // unconfigured API key — a DIFFERENT reason, which is the point).
  r = await mailer.send({ to: 'angry@example.com', subject: 'x', html: 'x', kind: 'other' });
  assert.doesNotMatch(String(r.reason), /suppressed/);
});

test('admins can list and un-suppress; clients cannot', async () => {
  const admin = h.makeAdmin('mailhooks-admin@test.local');
  const ent = h.makeEntity('Hook Co', 'hook-org');
  const client = h.makeClient('hook-client@test.local', [ent.id], 'owner');

  const denied = await app.req('GET', '/api/admin/mail-suppressions', { as: client });
  assert.equal(denied.status, 403);

  const list = await app.req('GET', '/api/admin/mail-suppressions', { as: admin });
  assert.equal(list.status, 200);
  assert.ok(list.body.suppressions.some((s) => s.email === 'dead@example.com'));

  const del = await app.req('DELETE', '/api/admin/mail-suppressions/dead@example.com', { as: admin });
  assert.equal(del.body.ok, true);
  const r = await mailer.send({ to: 'dead@example.com', subject: 'x', html: 'x', kind: 'campaign' });
  assert.doesNotMatch(String(r.reason), /suppressed/); // un-suppressed → past the gate
});
