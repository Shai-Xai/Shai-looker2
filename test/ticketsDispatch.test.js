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
  verifyWebhook: () => true, // signature validity is github.js's concern, not this test's
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

// ── Pre-submit AI preview (reporter reviews the redraft BEFORE it files) ──────
test('preview is fail-soft: AI unavailable returns empty fields, never an error', async () => {
  const ent = h.makeEntity('Preview Co', 'preview-org');
  const client = h.makeClient(`preview-${Date.now()}@test.local`, [ent.id]);
  const r = await call('POST /api/my/tickets/preview', { _body: true, params: {}, user: client, body: { type: 'bug', title: 'Broken thing', body: 'It broke' }, headers: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { aiTitle: '', aiSummary: '' }, 'widget falls back to a direct submit');
});

test('preview rejects an empty report', async () => {
  const ent = h.makeEntity('Preview2 Co', 'preview2-org');
  const client = h.makeClient(`preview2-${Date.now()}@test.local`, [ent.id]);
  const r = await call('POST /api/my/tickets/preview', { _body: true, params: {}, user: client, body: {}, headers: {} });
  assert.equal(r.status, 400);
});

test('submit with a reviewed draft lands pre-drafted (ai_status ready, reporter-approved text)', async () => {
  const ent = h.makeEntity('Draft Co', 'draft-org');
  const client = h.makeClient(`draft-${Date.now()}@test.local`, [ent.id]);
  const r = await call('POST /api/my/tickets', {
    _body: true, params: {}, user: client, headers: {},
    body: { type: 'bug', title: 'raw title', body: 'raw words', aiTitle: 'Polished title', aiSummary: '## Spec\nThe polished, reporter-edited version.' },
  });
  assert.equal(r.status, 201);
  const row = sql.prepare('SELECT * FROM tickets WHERE id=?').get(r.json.ticket.id);
  assert.equal(row.ai_status, 'ready', 'background redraft skipped');
  assert.equal(row.ai_title, 'Polished title');
  assert.match(row.ai_summary, /reporter-edited/);
  assert.equal(row.body, 'raw words', 'original words preserved alongside');
});

// ── CI failures → the ops-triage ledger (workflow_run webhook) ────────────────
const opsTriageMod = require('../server/opsTriage');
test('a failed workflow run on main becomes a github-ci ops alert', async () => {
  const alerts = [];
  require('../server/ops').onAlert((kind, msg) => alerts.push({ kind, msg }));
  const payload = { action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure', head_branch: 'main', html_url: 'https://github.com/x/y/actions/runs/111' } };
  const req = { _body: true, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': 'sig' }, get(h) { return this.headers[h.toLowerCase()]; }, body: Buffer.from(JSON.stringify(payload)), params: {} };
  const r = await call('POST /api/github/webhook', req);
  assert.equal(r.status, 200);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'github-ci');
  assert.match(alerts[0].msg, /workflow "CI" failure on main/);
  assert.match(alerts[0].msg, /actions\/runs\/111/);
});

test('successful runs and claude/** branch failures never reach the ledger', async () => {
  const alerts = [];
  require('../server/ops').onAlert((kind) => alerts.push(kind));
  const mk = (run) => ({ _body: true, headers: { 'x-github-event': 'workflow_run' }, get(h) { return this.headers[h.toLowerCase()]; }, body: Buffer.from(JSON.stringify({ action: 'completed', workflow_run: run })), params: {} });
  await call('POST /api/github/webhook', mk({ name: 'CI', conclusion: 'success', head_branch: 'main', html_url: 'u' }));
  await call('POST /api/github/webhook', mk({ name: 'CI', conclusion: 'failure', head_branch: 'claude/some-branch', html_url: 'u' }));
  assert.equal(alerts.length, 0);
});

test('repeated failures of the same workflow+branch collapse to one fingerprint (run ids normalised)', () => {
  const a = opsTriageMod.fingerprintOf('github-ci', 'workflow "CI" failure on main: https://github.com/x/y/actions/runs/29998512987');
  const b = opsTriageMod.fingerprintOf('github-ci', 'workflow "CI" failure on main: https://github.com/x/y/actions/runs/30001240553');
  const c = opsTriageMod.fingerprintOf('github-ci', 'workflow "Sync staging with main" failure on main: https://github.com/x/y/actions/runs/30001240553');
  assert.equal(a, b, 'same defect, different run id → one ledger row');
  assert.notEqual(a, c, 'a different workflow is a different row');
});

// ── Re-shipped-after-rejection tickets re-enter the review-reminder sweep ─────
// Found by the daily code-health review (issue #77): the shipped transitions
// kept a stale client_verdict='rejected', so the 24h re-nudge sweep (which
// selects client_verdict='') skipped exactly the tickets on their SECOND
// review round.
test('a rejected ticket whose fix PR merges to production gets a fresh verdict slate', async () => {
  const ent = h.makeEntity('Reship Co', 'reship-org');
  const reporter = h.makeClient(`reship-${Date.now()}@test.local`, [ent.id]);
  const t = tickets.createTicket({ user: reporter, type: 'bug', title: 'Reship bug', body: 'broken', entityId: ent.id });
  sql.prepare("UPDATE tickets SET github_issue_number=41, status='rejected', client_verdict='rejected', client_verdict_note='still broken', client_verdict_at='2026-07-22T00:00:00Z' WHERE id=?").run(t.id);
  const payload = { action: 'closed', pull_request: { number: 9, merged: true, title: 'fix: reship', html_url: 'https://github.test/pr/9', body: 'Fixes #41', base: { ref: 'main' }, head: { ref: 'claude/fix-41' } } };
  const req = { _body: true, headers: { 'x-github-event': 'pull_request' }, get(h2) { return this.headers[h2.toLowerCase()]; }, body: Buffer.from(JSON.stringify(payload)), params: {} };
  const r = await call('POST /api/github/webhook', req);
  assert.equal(r.status, 200);
  const row = sql.prepare('SELECT * FROM tickets WHERE id=?').get(t.id);
  assert.equal(row.status, 'shipped');
  assert.equal(row.client_verdict, '', 'stale rejection cleared — fresh production review');
  assert.equal(row.client_verdict_note, '');
  // The essence of the fix: the row is back inside the re-nudge sweep's SELECT.
  const swept = sql.prepare("SELECT id FROM tickets WHERE status IN ('shipped','staging') AND client_verdict=''").all().map((x) => x.id);
  assert.ok(swept.includes(t.id), 'sweep covers the re-shipped ticket again');
});
