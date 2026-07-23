// Product board → reporter notifications. Focus: the branded EMAIL the reporter
// gets at EVERY stage their report moves through (triaged → accepted → building →
// review → live, or declined), not just at resolution. Asserts each stage is a
// single, tenant-branded, opt-out-aware send to the original reporter, works for
// staff reporters with no entity, and never double-emails via the inbox fan-out.

const test = require('node:test');
const assert = require('node:assert');
const { db, makeEntity, makeClient, makeAdmin } = require('./helpers');

// Records route handlers by "METHOD /path" so tests can invoke one directly,
// skipping the auth/kill-switch middleware (we drive the engine, not HTTP).
function fakeApp() {
  const routes = {};
  const reg = (m) => (path, ...fns) => { routes[`${m} ${path}`] = fns[fns.length - 1]; };
  return { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), _routes: routes };
}
function invoke(app, method, path, { user, params, body, query } = {}) {
  const h = app._routes[`${method} ${path}`];
  assert.ok(h, `route ${method} ${path} not registered`);
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  h({ user, params: params || {}, body: body || {}, query: query || {} }, res);
  return out;
}

// Mount tickets with real db + capturing stubs for every outbound channel.
function mountTickets({ mailerOn = true } = {}) {
  const app = fakeApp();
  const sent = [];        // mailer.send() payloads
  const announced = [];   // os.announce() payloads
  const pushes = [];      // push.sendToUser() (userId, payload, type)
  const stubAuth = { requireAuth: (q, s, n) => n && n(), requireAdmin: (q, s, n) => n && n() };
  const mod = require('../server/tickets').mount(app, {
    db,
    auth: stubAuth,
    insights: { isConfigured: () => false }, // no AI draft → no network
    adminAnthropicKey: () => '',
    os: { announce: (a) => { announced.push(a); return { id: 'thread' }; } },
    github: {},
    push: { sendToUser: (uid, payload, type) => { pushes.push({ uid, payload, type }); } },
    mailer: {
      isConfigured: () => mailerOn,
      resolveBranding: (eid) => ({ senderName: eid ? `Brand-${eid}` : 'Howler : Pulse' }),
      notificationEmail: ({ title, body, ctaText, ctaPath }) => ({
        html: `<h1>${title}</h1><p>${body}</p>`,
        text: `${title}\n\n${body}\n\n${ctaText}: https://pulse.test${ctaPath}`,
      }),
      send: (m) => { sent.push(m); return { ok: true }; },
      baseUrl: () => 'https://pulse.test',
    },
  });
  return { app, mod, sent, announced, pushes };
}

const setStatus = (app, admin, id, body) =>
  invoke(app, 'PATCH', '/api/admin/tickets/:id', { user: admin, params: { id }, body });
const ship = (app, admin, id, over = {}) =>
  setStatus(app, admin, id, { status: 'shipped', shipNote: 'We fixed the crash on the sales page.', ...over });

test('every stage a report moves through emails the reporter once, tenant-branded', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am1@test.local');
  const ent = makeEntity('Acme Events', 'acme');
  const reporter = makeClient('reporter1@acme.test', [ent.id]);
  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Checkout is broken', body: 'It crashes', entityId: ent.id });

  const stages = [
    { status: 'triaged', subject: /reviewing/ },
    { status: 'accepted', subject: /Accepted/ },
    { status: 'in_progress', subject: /In progress/ },
    { status: 'shipped', subject: /Resolved/ },
  ];
  for (const [i, s] of stages.entries()) {
    setStatus(app, admin, t.id, s.status === 'shipped' ? { status: s.status, shipNote: 'We fixed the crash on the sales page.' } : { status: s.status });
    assert.equal(sent.length, i + 1, `one email per stage (after ${s.status})`);
    const e = sent[i];
    assert.equal(e.to, 'reporter1@acme.test');
    assert.match(e.subject, s.subject);
    assert.match(e.subject, /Checkout is broken/, 'report title in the subject');
    assert.match(e.text, /https:\/\/pulse\.test\/product/, 'link to view details');
    assert.equal(e.fromName, `Brand-${ent.id}`, 'tenant sender/branding');
    assert.equal(e.entity, ent.id, 'scoped to the tenant for custom domain + logging');
    assert.equal(e.kind, 'ticket');
  }
  assert.match(sent[3].text, /We fixed the crash on the sales page\./, 'resolution note = shipped email body');

  // The inbox thread still lands per stage, but with email dropped from its
  // fan-out so each stage emails exactly once (via the dedicated email above).
  assert.equal(announced.length, stages.length);
  for (const a of announced) assert.deepEqual(a.channels, ['push', 'slack']);
});

test('a report to a staff reporter (no entity) still emails per stage, with platform branding', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am2@test.local');
  const staff = makeAdmin('devreporter@test.local');
  const t = mod.createTicket({ user: staff, type: 'improvement', title: 'Tidy the nav', body: 'cramped' });

  setStatus(app, admin, t.id, { status: 'in_progress' });
  ship(app, admin, t.id);

  assert.equal(sent.length, 2, 'in_progress + shipped each emailed');
  for (const e of sent) {
    assert.equal(e.to, 'devreporter@test.local');
    assert.equal(e.fromName, 'Howler : Pulse', 'platform brand when there is no tenant');
    assert.equal(e.entity, '');
  }
  assert.equal(announced.length, 0, 'no entity → no inbox thread');
});

test('no emails when the reporter opted out of report updates', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am3@test.local');
  const ent = makeEntity('Beta Co', 'beta');
  const reporter = makeClient('optout@beta.test', [ent.id]);
  db.setNotifyMatrix(reporter.id, { email: { reports: false } }); // client self-service opt-out

  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Typo on page', body: 'x', entityId: ent.id });
  setStatus(app, admin, t.id, { status: 'accepted' });
  ship(app, admin, t.id);

  assert.equal(sent.length, 0, 'opt-out suppresses every stage email');
  // The in-app inbox thread still lands (opt-out is email-only), still without an
  // email fan-out so nothing sneaks an email through the messages channel.
  for (const a of announced) assert.deepEqual(a.channels, ['push', 'slack']);
});

test('no email when the reporter has no valid address', () => {
  const { app, mod, sent } = mountTickets();
  const admin = makeAdmin('am4@test.local');
  const staff = makeAdmin('hasmail@test.local');
  const t = mod.createTicket({ user: staff, type: 'idea', title: 'Dark mode', body: 'please' });
  db.db.prepare('UPDATE tickets SET reporter_email=? WHERE id=?').run('', t.id); // strip the address

  ship(app, admin, t.id);
  assert.equal(sent.length, 0);
});

test('no email when the mailer is not configured', () => {
  const { app, mod, sent } = mountTickets({ mailerOn: false });
  const admin = makeAdmin('am5@test.local');
  const staff = makeAdmin('nomailer@test.local');
  const t = mod.createTicket({ user: staff, type: 'bug', title: 'Broken', body: 'x' });
  ship(app, admin, t.id);
  assert.equal(sent.length, 0);
});

test('declining a report emails the reporter with the decline reason', () => {
  const { app, mod, sent } = mountTickets();
  const admin = makeAdmin('am6@test.local');
  const staff = makeAdmin('declined@test.local');
  const t = mod.createTicket({ user: staff, type: 'idea', title: 'Neon theme', body: 'x' });

  setStatus(app, admin, t.id, { status: 'declined', declineReason: 'Out of scope for now.' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Update on your report/);
  assert.match(sent[0].text, /Out of scope for now\./);
});

test('a same-status update does not re-email', () => {
  const { app, mod, sent } = mountTickets();
  const admin = makeAdmin('am7@test.local');
  const staff = makeAdmin('same@test.local');
  const t = mod.createTicket({ user: staff, type: 'bug', title: 'Slow page', body: 'x' });

  setStatus(app, admin, t.id, { status: 'accepted' });
  setStatus(app, admin, t.id, { status: 'accepted' }); // no transition
  assert.equal(sent.length, 1, 'only the real transition emails');
});

// ── Daily review reminders ──────────────────────────────────────────────────────
// A ticket sitting in shipped/staging with no verdict re-nudges the reporter on
// every channel each 24h until they approve or send it back.

const backdate = (id, col, hoursAgo) => db.db.prepare(`UPDATE tickets SET ${col}=? WHERE id=?`)
  .run(new Date(Date.now() - hoursAgo * 3600_000).toISOString(), id);

test('a shipped ticket awaiting review re-nudges the reporter daily on all channels', () => {
  const { app, mod, sent, announced, pushes } = mountTickets();
  const admin = makeAdmin('rem1@test.local');
  const ent = makeEntity('Delta Live', 'delta');
  const reporter = makeClient('await@delta.test', [ent.id]);
  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Broken totals', body: 'x', entityId: ent.id });
  ship(app, admin, t.id);
  const base = { sent: sent.length, announced: announced.length, pushes: pushes.length };

  // Fresh ask (review_asked_at just stamped) → no reminder yet.
  mod.sweepReviewReminders();
  assert.equal(sent.length, base.sent, 'no reminder within 24h of the ask');

  // 25h after the ask → one reminder on every channel.
  backdate(t.id, 'review_asked_at', 25);
  mod.sweepReviewReminders();
  assert.equal(sent.length, base.sent + 1, 'reminder email sent');
  assert.match(sent[sent.length - 1].subject, /Reminder: .*waiting for your review/);
  assert.equal(pushes.length, base.pushes + 1, 'reminder push sent');
  assert.equal(pushes[pushes.length - 1].type, 'reports');
  assert.equal(announced.length, base.announced + 1, 'reminder inbox thread sent');
  assert.deepEqual(announced[announced.length - 1].channels, ['push', 'slack']);

  // Sweeping again straight away → nothing (next nudge is 24h out).
  mod.sweepReviewReminders();
  assert.equal(sent.length, base.sent + 1, 'no double reminder');

  // Another 24h with no verdict → nudges again.
  backdate(t.id, 'review_reminder_at', 25);
  mod.sweepReviewReminders();
  assert.equal(sent.length, base.sent + 2, 'daily repeat until reviewed');
});

test('a staging ticket reminder carries the test link; a verdict stops reminders', () => {
  const { app, mod, sent } = mountTickets();
  const admin = makeAdmin('rem2@test.local');
  const staff = makeAdmin('stagewait@test.local');
  const t = mod.createTicket({ user: staff, type: 'improvement', title: 'New filter', body: 'x' });
  setStatus(app, admin, t.id, { status: 'staging', testUrl: 'https://staging.test/app' });

  backdate(t.id, 'review_asked_at', 25);
  const before = sent.length;
  mod.sweepReviewReminders();
  assert.equal(sent.length, before + 1);
  assert.match(sent[sent.length - 1].text, /staging site/);
  assert.match(sent[sent.length - 1].text, /https:\/\/staging\.test\/app/);

  // The reporter approves on staging (verdict set, status stays staging) → done.
  db.db.prepare("UPDATE tickets SET client_verdict='approved' WHERE id=?").run(t.id);
  backdate(t.id, 'review_reminder_at', 25);
  mod.sweepReviewReminders();
  assert.equal(sent.length, before + 1, 'no reminders after a verdict');
});

test('reminders wait for a deferred review ask, and adopt pre-feature tickets gently', () => {
  const { app, mod, sent } = mountTickets();
  const admin = makeAdmin('rem3@test.local');
  const staff = makeAdmin('deferwait@test.local');
  const t = mod.createTicket({ user: staff, type: 'bug', title: 'Old one', body: 'x' });
  ship(app, admin, t.id);

  // Deploy-deferred ask still pending → no reminder even if the clock is old.
  backdate(t.id, 'review_asked_at', 30);
  db.db.prepare("UPDATE tickets SET notify_wait=? WHERE id=?").run('{"env":"production"}', t.id);
  const before = sent.length;
  mod.sweepReviewReminders();
  assert.equal(sent.length, before, 'no reminder while the ask itself is deferred');

  // A ticket shipped before the feature existed (no clock): the sweep starts the
  // clock instead of firing immediately.
  db.db.prepare("UPDATE tickets SET notify_wait='', review_asked_at='' WHERE id=?").run(t.id);
  mod.sweepReviewReminders();
  assert.equal(sent.length, before, 'first sweep only starts the clock');
  const row = db.db.prepare('SELECT review_asked_at FROM tickets WHERE id=?').get(t.id);
  assert.ok(row.review_asked_at, 'clock initialised');
});
