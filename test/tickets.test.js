// Product board → reporter notifications. Focus: the resolution EMAIL that closes
// the loop when a report is marked resolved (shipped / declined). Asserts it is a
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

const ship = (app, admin, id, over = {}) =>
  invoke(app, 'PATCH', '/api/admin/tickets/:id', { user: admin, params: { id }, body: { status: 'shipped', shipNote: 'We fixed the crash on the sales page.', ...over } });

test('resolving a client report emails the reporter once, tenant-branded, with note + link', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am1@test.local');
  const ent = makeEntity('Acme Events', 'acme');
  const reporter = makeClient('reporter1@acme.test', [ent.id]);
  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Checkout is broken', body: 'It crashes', entityId: ent.id });

  ship(app, admin, t.id);

  assert.equal(sent.length, 1, 'exactly one email to the reporter');
  const e = sent[0];
  assert.equal(e.to, 'reporter1@acme.test');
  assert.match(e.subject, /Resolved/);
  assert.match(e.subject, /Checkout is broken/);          // report title in the subject
  assert.match(e.text, /We fixed the crash on the sales page\./); // resolution note = body
  assert.match(e.text, /https:\/\/pulse\.test\/product/); // link to view details
  assert.equal(e.fromName, `Brand-${ent.id}`, 'tenant sender/branding');
  assert.equal(e.entity, ent.id, 'scoped to the tenant for custom domain + logging');
  assert.equal(e.kind, 'ticket');

  // The inbox thread still lands, but with email dropped from its fan-out so the
  // reporter is emailed exactly once (via the dedicated resolution email above).
  const last = announced[announced.length - 1];
  assert.deepEqual(last.channels, ['push', 'slack']);
});

test('a resolved report to a staff reporter (no entity) still emails, with platform branding', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am2@test.local');
  const staff = makeAdmin('devreporter@test.local');
  const t = mod.createTicket({ user: staff, type: 'improvement', title: 'Tidy the nav', body: 'cramped' });

  ship(app, admin, t.id);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'devreporter@test.local');
  assert.equal(sent[0].fromName, 'Howler : Pulse', 'platform brand when there is no tenant');
  assert.equal(sent[0].entity, '');
  assert.equal(announced.length, 0, 'no entity → no inbox thread');
});

test('no resolution email when the reporter opted out of report updates', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am3@test.local');
  const ent = makeEntity('Beta Co', 'beta');
  const reporter = makeClient('optout@beta.test', [ent.id]);
  db.setNotifyMatrix(reporter.id, { email: { reports: false } }); // client self-service opt-out

  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Typo on page', body: 'x', entityId: ent.id });
  ship(app, admin, t.id);

  assert.equal(sent.length, 0, 'opt-out suppresses the email');
  // The in-app inbox thread still lands (opt-out is email-only), still without an
  // email fan-out so nothing sneaks an email through the messages channel.
  const last = announced[announced.length - 1];
  assert.deepEqual(last.channels, ['push', 'slack']);
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

  invoke(app, 'PATCH', '/api/admin/tickets/:id', {
    user: admin, params: { id: t.id }, body: { status: 'declined', declineReason: 'Out of scope for now.' },
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Update on your report/);
  assert.match(sent[0].text, /Out of scope for now\./);
});

test('a non-resolution status change does not send an email (and keeps the default inbox fan-out)', () => {
  const { app, mod, sent, announced } = mountTickets();
  const admin = makeAdmin('am7@test.local');
  const ent = makeEntity('Gamma', 'gamma');
  const reporter = makeClient('early@gamma.test', [ent.id]);
  const t = mod.createTicket({ user: reporter, type: 'bug', title: 'Slow page', body: 'x', entityId: ent.id });

  invoke(app, 'PATCH', '/api/admin/tickets/:id', { user: admin, params: { id: t.id }, body: { status: 'accepted' } });

  assert.equal(sent.length, 0, 'accepted is not a resolution → no dedicated email');
  const last = announced[announced.length - 1];
  assert.equal(last.channels, undefined, 'default fan-out (email included) for non-resolution updates');
});
