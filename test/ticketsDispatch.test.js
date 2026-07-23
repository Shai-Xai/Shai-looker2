// Phase 2 plumbing in server/tickets.js: the extracted sendTicketToGitHub()
// (shared by the admin route and the ops-triage auto-dispatch), and the
// ops-ticket verdict rules (an admin stands in for the machine reporter so a
// staged ops ticket can never jam the promote release train).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const routes = {};
const fakeApp = {
  get: (p, ...fns) => { routes[`GET ${p}`] = fns; },
  post: (p, ...fns) => { routes[`POST ${p}`] = fns; },
  put: (p, ...fns) => { routes[`PUT ${p}`] = fns; },
  patch: (p, ...fns) => { routes[`PATCH ${p}`] = fns; },
  delete: (p, ...fns) => { routes[`DELETE ${p}`] = fns; },
  use: () => {},
};
// Auth fakes pass through; req.user is set by the caller.
const pass = (_req, _res, next) => next();
const fakeAuth = { requireAuth: pass, requireAdmin: pass, requireSuperAdmin: pass };

const issues = [];
let githubUp = true;
const fakeGithub = {
  isConfigured: () => githubUp,
  dispatchEnabled: () => false, // no implicit build unless mode says so
  createIssue: async ({ title, body }) => { issues.push({ title, body }); return { number: issues.length, url: `https://github.test/issues/${issues.length}` }; },
  newIssueUrl: ({ title }) => `https://github.test/new?title=${encodeURIComponent(title)}`,
  prodBranch: () => 'main',
  stagingBranch: () => 'staging',
};
const fakeInsights = { isConfigured: () => false }; // no background AI drafting in tests

const tickets = require('../server/tickets').mount(fakeApp, {
  db: h.db, auth: fakeAuth, insights: fakeInsights,
  adminAnthropicKey: () => '', os: null, github: fakeGithub, push: null, mailer: null,
});
const sql = h.db.db;

// Invoke a captured route chain with a fake req/res; resolves with { status, json }.
function call(key, req) {
  return new Promise((resolve, reject) => {
    const fns = routes[key];
    if (!fns) return reject(new Error(`route not registered: ${key}`));
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, json: payload }); },
    };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      const fn = fns[i++];
      if (!fn) return reject(new Error('route chain exhausted'));
      Promise.resolve(fn(req, res, next)).catch(reject);
    };
    next();
  });
}

const OPS_REPORTER = { id: 'ops-triage-agent', email: 'ops-triage@pulse.internal', name: 'Pulse Ops Agent', role: 'admin', entityIds: [] };
const opsSpec = '**Production ops alert.**\n\n**Root-cause hypothesis:** listJourneys missing export.';
function makeOpsTicket() {
  return tickets.createTicket({
    user: OPS_REPORTER, type: 'bug', source: 'ops',
    title: 'Fix listJourneys crash', body: opsSpec, screen: 'ops-alert', urgency: 'high',
    aiTitle: 'Fix listJourneys crash', aiSummary: opsSpec,
  });
}

test('createTicket stores source ops (not coerced to widget)', () => {
  const t = makeOpsTicket();
  assert.equal(sql.prepare('SELECT source FROM tickets WHERE id=?').get(t.id).source, 'ops');
});

test('sendTicketToGitHub in plan mode: issue carries the diagnosis and the plan-only @claude ask', async () => {
  issues.length = 0;
  const t = makeOpsTicket();
  const r = await tickets.sendTicketToGitHub(t.id, { mode: 'plan', target: 'staging', actorEmail: OPS_REPORTER.email });
  assert.ok(r.issue, 'issue created');
  const { body } = issues[0];
  assert.match(body, /Root-cause hypothesis/, 'the triage diagnosis reaches the build brief');
  assert.match(body, /@claude review this ticket/, 'plan-mode ask');
  assert.match(body, /Do NOT write code or open a pull request yet/);
  assert.match(body, /against the `staging` branch/, 'targets staging');
  const row = sql.prepare('SELECT * FROM tickets WHERE id=?').get(t.id);
  assert.equal(row.github_issue_number, r.issue.number);
  assert.equal(row.status, 'accepted', 'sending IS the acceptance act');
  assert.equal(row.target, 'staging');
});

test('sendTicketToGitHub in build mode asks for a PR against staging', async () => {
  issues.length = 0;
  const t = makeOpsTicket();
  await tickets.sendTicketToGitHub(t.id, { mode: 'build', target: 'staging' });
  assert.match(issues[0].body, /@claude please implement this ticket and open a pull request against the `staging` branch/);
});

test('a second send is a no-op (alreadyLinked) — the no-auto-redispatch rail', async () => {
  issues.length = 0;
  const t = makeOpsTicket();
  await tickets.sendTicketToGitHub(t.id, { mode: 'plan' });
  const r2 = await tickets.sendTicketToGitHub(t.id, { mode: 'build' });
  assert.equal(r2.alreadyLinked, true);
  assert.equal(issues.length, 1, 'one issue ever');
});

test('GitHub unconfigured → needsConfig + prefill URL, nothing dispatched', async () => {
  issues.length = 0;
  githubUp = false;
  const t = makeOpsTicket();
  const r = await tickets.sendTicketToGitHub(t.id, { mode: 'plan' });
  githubUp = true;
  assert.equal(r.needsConfig, true);
  assert.ok(r.prefillUrl.includes('github.test/new'));
  assert.equal(issues.length, 0);
});

test('verdict on an ops ticket: any admin may approve (the release train never jams)', async () => {
  const t = makeOpsTicket();
  sql.prepare("UPDATE tickets SET status='staging' WHERE id=?").run(t.id);
  const admin = h.makeAdmin(`verdict-admin-${Date.now()}@test.local`);
  const r = await call('POST /api/my/tickets/:id/verdict', { params: { id: t.id }, user: admin, body: { verdict: 'approved' } });
  assert.equal(r.status, 200);
  assert.equal(sql.prepare('SELECT client_verdict FROM tickets WHERE id=?').get(t.id).client_verdict, 'approved');
});

test('verdict on an ops ticket: a non-admin who is not the reporter is still refused', async () => {
  const t = makeOpsTicket();
  sql.prepare("UPDATE tickets SET status='staging' WHERE id=?").run(t.id);
  const ent = h.makeEntity('Verdict Co', 'verdict-org');
  const client = h.makeClient(`verdict-client-${Date.now()}@test.local`, [ent.id]);
  const r = await call('POST /api/my/tickets/:id/verdict', { params: { id: t.id }, user: client, body: { verdict: 'approved' } });
  assert.equal(r.status, 403);
});

test("verdict on a NORMAL ticket still requires the reporter — admins can't override a client's review", async () => {
  const ent = h.makeEntity('Owner Co', 'owner-org');
  const reporter = h.makeClient(`owner-${Date.now()}@test.local`, [ent.id]);
  const t = tickets.createTicket({ user: reporter, type: 'bug', title: 'Client bug', body: 'broken', entityId: ent.id });
  sql.prepare("UPDATE tickets SET status='staging' WHERE id=?").run(t.id);
  const admin = h.makeAdmin(`other-admin-${Date.now()}@test.local`);
  const r = await call('POST /api/my/tickets/:id/verdict', { params: { id: t.id }, user: admin, body: { verdict: 'approved' } });
  assert.equal(r.status, 403, 'the reporter-owns-the-verdict rule holds for human tickets');
});
