// Ops-alert triage agent (server/opsTriage.js): fingerprint dedup, the triage
// pass (bug → auto-filed board ticket; billing/capacity → ops action, no
// ticket; noise → silent), the daily cap parking, and the kill switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const opsTriage = require('../server/opsTriage');

// ── Fakes ─────────────────────────────────────────────────────────────────────
const notifications = [];
const createdTickets = [];
let classifyCalls = 0;
let verdictQueue = []; // each classify() shifts one

const fakeApp = { get: () => {}, post: () => {}, use: () => {} };
const fakeAuth = { requireAdmin: (_req, _res, next) => next && next() };
const fakeOps = { onAlert: () => {}, notify: (t) => notifications.push(String(t)) };
const fakeClient = {
  messages: {
    create: async () => {
      classifyCalls += 1;
      const v = verdictQueue.shift();
      if (!v) throw new Error('test: no verdict queued');
      return { content: [{ type: 'text', text: JSON.stringify(v) }] };
    },
  },
};
const fakeInsights = {
  MODEL: 'test-model',
  isConfigured: () => true,
  requireClient: () => fakeClient,
  systemWith: (base) => base,
  parseModelJsonResilient: async (_c, text) => JSON.parse(text),
};
const dispatches = [];
let dispatchShouldFail = false;
const fakeTickets = {
  createTicket: (args) => { createdTickets.push(args); return { id: `T${createdTickets.length}` }; },
  sendTicketToGitHub: async (ticketId, opts) => {
    if (dispatchShouldFail) throw new Error('test: github down');
    dispatches.push({ ticketId, ...opts });
    return { issue: { number: dispatches.length, url: `https://github.test/issues/${dispatches.length}` } };
  },
};

const api = opsTriage.mount(fakeApp, {
  db: h.db, auth: fakeAuth, insights: fakeInsights,
  adminAnthropicKey: () => 'test-key', ops: fakeOps, tickets: fakeTickets,
});
const sql = h.db.db;
const rows = () => sql.prepare('SELECT * FROM ops_alerts ORDER BY first_seen').all();
const reset = () => { sql.exec('DELETE FROM ops_alerts'); notifications.length = 0; createdTickets.length = 0; dispatches.length = 0; dispatchShouldFail = false; classifyCalls = 0; verdictQueue = []; h.db.setSetting('ops_triage_daily_cap', '5'); h.db.setSetting('ops_triage_enabled', '1'); h.db.setSetting('ops_triage_dispatch', 'off'); h.db.setSetting('ops_triage_dispatch_cap', '3'); };

const BUG = { classification: 'bug', severity: 'high', confidence: 'high', title: 'Fix listJourneys crash on the recipes route', hypothesis: 'journeys.js calls actionTemplates.listJourneys() but actionTemplates.js does not export it.', opsAction: '' };

// ── Fingerprinting ────────────────────────────────────────────────────────────
test('the same defect with different UUIDs / refs / numbers collapses to ONE fingerprint', () => {
  reset();
  api.record('http5xx', 'GET /api/journeys/a3f31364-1d7b-40c3-a3e7-82d4ef21de3b/recipes: actionTemplates.listJourneys is not a function (ref NHFeVSwj)');
  api.record('http5xx', 'GET /api/journeys/d626724d-38b5-4117-b3d2-59d6f6fe7357/recipes: actionTemplates.listJourneys is not a function (ref JcvvJkLJ)');
  const r = rows();
  assert.equal(r.length, 1, 'one ledger row');
  assert.equal(r[0].count, 2, 'both occurrences counted');
  assert.match(r[0].pattern, /<uuid>/);
});

test('different kinds (or genuinely different messages) get separate rows', () => {
  reset();
  api.record('http5xx', 'something broke');
  api.record('backup', 'something broke');
  api.record('http5xx', 'a completely different failure');
  assert.equal(rows().length, 3);
});

test("the agent's own 'triage' alerts are never ledgered (loop guard)", () => {
  reset();
  api.record('triage', 'classify failed: boom');
  assert.equal(rows().length, 0);
});

// ── The triage pass ───────────────────────────────────────────────────────────
test('a bug verdict auto-files a product-board ticket (source ops, pre-drafted)', async () => {
  reset();
  api.record('http5xx', 'GET /api/journeys/a3f31364-1d7b-40c3-a3e7-82d4ef21de3b/recipes: actionTemplates.listJourneys is not a function (ref x)');
  verdictQueue = [BUG];
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 1);
  assert.equal(createdTickets.length, 1);
  const t = createdTickets[0];
  assert.equal(t.source, 'ops');
  assert.equal(t.type, 'bug');
  assert.equal(t.urgency, 'high');
  assert.equal(t.aiTitle, BUG.title, 'pre-drafted — skips the background AI draft');
  assert.match(t.body, /listJourneys/);
  const r = rows()[0];
  assert.equal(r.status, 'ticketed');
  assert.equal(r.ticket_id, 'T1');
  assert.ok(notifications.some((n) => n.includes('Filed') || n.includes('filed')), 'verdict posted to the ops channel');
});

test('a ticketed fingerprint recurring bumps the count — never a duplicate ticket', async () => {
  // continues from the previous test's DB state? No — each test file shares one
  // process; reset explicitly and rebuild the ticketed state.
  reset();
  api.record('http5xx', 'actionTemplates.listJourneys is not a function (ref a)');
  verdictQueue = [BUG];
  await api.runPass({ force: true });
  assert.equal(createdTickets.length, 1);
  api.record('http5xx', 'actionTemplates.listJourneys is not a function (ref b)'); // recurs after ticketing
  const out = await api.runPass({ force: true });
  assert.equal(out.classified, 0, 'nothing new to classify');
  assert.equal(createdTickets.length, 1, 'still one ticket');
  assert.equal(rows()[0].count, 2);
  assert.equal(rows()[0].status, 'ticketed');
});

test('billing / capacity verdicts post an ops ACTION and never file a ticket', async () => {
  reset();
  api.record('http5xx', 'handler: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
  verdictQueue = [{ classification: 'billing', severity: 'high', confidence: 'high', title: '', hypothesis: 'The Anthropic account is out of credits.', opsAction: 'Top up credits at console.anthropic.com → Plans & Billing.' }];
  const out = await api.runPass({ force: true });
  assert.equal(out.actions, 1);
  assert.equal(createdTickets.length, 0, 'billing is a human action, not a PR');
  assert.equal(rows()[0].status, 'action');
  assert.ok(notifications.some((n) => n.includes('Top up')), 'the concrete action reaches the channel');
});

test('noise is marked and stays silent', async () => {
  reset();
  api.record('http5xx', 'client disconnected mid-stream');
  verdictQueue = [{ classification: 'noise', severity: 'low', confidence: 'high', title: '', hypothesis: 'Transient client disconnect.', opsAction: '' }];
  const out = await api.runPass({ force: true });
  assert.equal(out.noise, 1);
  assert.equal(createdTickets.length, 0);
  assert.equal(notifications.length, 0, 'noise never pings the channel');
});

test('daily cap parks extra bugs as capped; they file next window WITHOUT re-classifying', async () => {
  reset();
  h.db.setSetting('ops_triage_daily_cap', '1');
  api.record('http5xx', 'bug one: fooBarBaz is not a function');
  api.record('http5xx', 'bug two: quxQuux is not a function');
  verdictQueue = [
    { ...BUG, title: 'Fix bug A' },
    { ...BUG, title: 'Fix bug B' },
  ];
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed + out.capped, 2);
  assert.equal(out.ticketed, 1, 'cap respected');
  assert.equal(out.capped, 1);
  assert.equal(createdTickets.length, 1);
  // Cap lifts (next day / raised cap): the parked row files from its STORED verdict.
  h.db.setSetting('ops_triage_daily_cap', '5');
  const before = classifyCalls;
  const out2 = await api.runPass({ force: true });
  assert.equal(out2.ticketed, 1, 'parked bug filed');
  assert.equal(classifyCalls, before, 'no second AI classification for a parked row');
  assert.equal(createdTickets.length, 2);
  assert.ok(rows().every((r) => r.status === 'ticketed'));
});

test('a failed classification leaves the row new — retried next pass, never lost', async () => {
  reset();
  api.record('http5xx', 'mystery failure');
  verdictQueue = []; // fakeClient throws when the queue is empty
  const out = await api.runPass({ force: true });
  assert.equal(out.classified, 0);
  assert.equal(rows()[0].status, 'new');
});

test('kill switch: disabled skips the pass but the ledger keeps recording', async () => {
  reset();
  h.db.setSetting('ops_triage_enabled', '0');
  api.record('http5xx', 'recorded while disabled');
  const out = await api.runPass();
  assert.equal(out.skipped, 'disabled');
  assert.equal(rows().length, 1, 'recording is free and always on');
  assert.equal(rows()[0].status, 'new');
});

// ── Code grounding ────────────────────────────────────────────────────────────
test('codeContext greps the real server source for the symbol an alert names', () => {
  const ctx = opsTriage.codeContext('GET /api/journeys/x/recipes: actionTemplates.listJourneys is not a function');
  assert.ok(ctx.includes('listJourneys'), 'finds the call site / export in server/*.js');
  assert.match(ctx, /── \w+.*\.js \(around line \d+/, 'snippets are labelled with file + line');
});

test('promptRegistry exposes the triage prompt for the Admin → AI audit', () => {
  const [p] = opsTriage.promptRegistry();
  assert.equal(p.key, 'opsTriage');
  assert.ok(p.label && p.scope && p.text.length > 100);
});

// ── Phase 2: auto-dispatch tier ───────────────────────────────────────────────
test('plan tier: a HIGH-confidence bug is auto-dispatched to Claude in plan mode, on staging', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'plan');
  api.record('http5xx', 'planTier fooBar is not a function');
  verdictQueue = [BUG]; // high severity, high confidence
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 1);
  assert.equal(out.dispatched, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].mode, 'plan', 'plan tier never sends build');
  assert.equal(dispatches[0].target, 'staging', 'auto-dispatch always targets staging');
  assert.equal(dispatches[0].ticketId, 'T1');
  assert.equal(rows()[0].dispatch, 'plan');
  assert.ok(notifications.some((n) => n.includes('PLAN mode')), 'dispatch announced in the ops channel');
});

test('medium confidence never auto-dispatches — the ticket just waits in the inbox', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'plan');
  api.record('http5xx', 'mediumConfidence bug here');
  verdictQueue = [{ ...BUG, confidence: 'medium' }];
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 1);
  assert.equal(out.dispatched, 0);
  assert.equal(dispatches.length, 0);
});

test('build tier: high severity + high confidence goes straight to build; lesser severity still plans', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'build');
  api.record('http5xx', 'buildTier alpha is not a function');
  api.record('http5xx', 'buildTier beta failed differently');
  verdictQueue = [
    { ...BUG, title: 'Fix alpha', severity: 'high' },
    { ...BUG, title: 'Fix beta', severity: 'medium' },
  ];
  const out = await api.runPass({ force: true });
  assert.equal(out.dispatched, 2);
  const modes = dispatches.map((d) => d.mode).sort();
  assert.deepEqual(modes, ['build', 'plan']);
});

test('dispatch cap: beyond the daily cap tickets still file but stay undispached', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'plan');
  h.db.setSetting('ops_triage_dispatch_cap', '1');
  api.record('http5xx', 'capA is not a function');
  api.record('http5xx', 'capB is not a function');
  verdictQueue = [{ ...BUG, title: 'Fix A' }, { ...BUG, title: 'Fix B' }];
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 2, 'ticket filing is not capped by the dispatch cap');
  assert.equal(out.dispatched, 1, 'only one auto-dispatch today');
  assert.equal(dispatches.length, 1);
});

test('a dispatch failure is fail-soft: the ticket still lands in the inbox', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'plan');
  dispatchShouldFail = true;
  api.record('http5xx', 'ghDown is not a function');
  verdictQueue = [BUG];
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 1, 'filing unaffected');
  assert.equal(out.dispatched, 0);
  assert.equal(rows()[0].status, 'ticketed');
  assert.equal(rows()[0].dispatch, '', 'no dispatch recorded');
});

test('a parked (capped) bug that files next window also rides the dispatch tier', async () => {
  reset();
  h.db.setSetting('ops_triage_dispatch', 'plan');
  h.db.setSetting('ops_triage_daily_cap', '0'); // everything parks
  api.record('http5xx', 'parkedDispatch is not a function');
  verdictQueue = [BUG];
  await api.runPass({ force: true });
  assert.equal(rows()[0].status, 'capped');
  h.db.setSetting('ops_triage_daily_cap', '5'); // window opens
  const out = await api.runPass({ force: true });
  assert.equal(out.ticketed, 1);
  assert.equal(out.dispatched, 1);
  assert.equal(dispatches[0].mode, 'plan');
});
