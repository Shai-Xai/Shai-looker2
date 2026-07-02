// Money-path tests for the campaign engine (server/actions.js) — the revenue-
// and-compliance code that had NO coverage. Driven over real HTTP against the
// mounted routes (see test/http.js) so the permission gates, tenant guards and
// the approval workflow are exercised exactly as in production.
//
// What this pins:
//   1. Tenant isolation — a client cannot read/list another client's campaigns,
//      nor smuggle another tenant's campaign id under their own entity.
//   2. The scoped opens/clicks rollup on the list route (reconcileClicks heals
//      cached counters from action_clicks; one tenant's clicks never leak into
//      another's numbers). Regression-guards the scan fix in the list route.
//   3. The approval governance gate — when a client requires sign-off, a draft
//      cannot be sent directly; only a named approver can approve.
//   4. Per-channel consent enforced AT SEND — email-consented-but-not-SMS gets
//      email only; the transactional ignoreConsent toggle bypasses both.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Channel adapters: record every recipient instead of sending. resolveImpl is
// swapped per-test to control the resolved audience (the Looker tile resolver).
const sent = { email: [], sms: [] };
let resolveImpl = async () => ({ rows: [], fields: [] });

const mailer = {
  send: async ({ to }) => { sent.email.push(to); return { ok: true }; },
  baseUrl: () => 'http://test.local',
  resolveBranding: () => ({ senderName: 'Test Sender' }),
  campaignEmail: ({ subject, bodyText }) => ({ html: `<p>${bodyText || ''}</p>`, text: bodyText || '' }),
};
const messaging = { sendSms: async ({ to }) => { sent.sms.push(to); return { ok: true }; } };
const noop = new Proxy({}, { get: () => () => {} }); // permissive push/os stub
const billing = { costFor: () => ({ total: 0 }), masterRates: () => ({ currency: 'ZAR' }) };

let app;
before(async () => {
  app = await startApp((expressApp) => {
    require('../server/actions').mount(expressApp, {
      db: h.db,
      auth: h.auth,
      mailer,
      push: noop,
      messaging,
      os: noop,
      billing,
      resolveAudience: (args) => resolveImpl(args),
      draftCopy: async () => ({ subject: 's', body: 'b' }),
      listEvents: async () => [],
    });
  });
});

beforeEach(() => { sent.email = []; sent.sms = []; resolveImpl = async () => ({ rows: [], fields: [] }); });
after(async () => { if (app) await app.close(); });

// Wait for an async campaign send to reach a terminal status (runCampaign runs
// fire-and-forget off the approve route, ~120ms per recipient).
async function waitForStatus(entId, actionId, want, as) {
  for (let i = 0; i < 60; i++) {
    const { body } = await app.req('GET', `/api/actions/${entId}`, { as });
    const a = (body.actions || []).find((x) => x.id === actionId);
    if (a && a.status === want) return a;
    await sleep(50);
  }
  throw new Error(`timed out waiting for status ${want}`);
}

// ── 1. Tenant isolation ──────────────────────────────────────────────────────
test('a client cannot list or read another client\'s campaigns', async () => {
  const entA = h.makeEntity('Tenant A', 'A-org');
  const entB = h.makeEntity('Tenant B', 'B-org');
  const ownerA = h.makeClient('owner-a@test.local', [entA.id], 'owner');
  const ownerB = h.makeClient('owner-b@test.local', [entB.id], 'owner');

  // A creates a campaign in A.
  const created = await app.req('POST', `/api/actions/${entA.id}`, {
    as: ownerA, body: { title: 'A only', channel: 'email', subject: 'Hi', body: 'Hello', audience: { mode: 'paste', pasted: 'x@a.com' } },
  });
  assert.equal(created.status, 201);
  const aid = created.body.action.id;

  // B cannot list A's campaigns (not a member of A) → 403.
  const list = await app.req('GET', `/api/actions/${entA.id}`, { as: ownerB });
  assert.equal(list.status, 403);

  // B cannot read A's campaign report by hitting A's path → 403.
  const rep = await app.req('GET', `/api/actions/${entA.id}/${aid}/report`, { as: ownerB });
  assert.equal(rep.status, 403);

  // B cannot smuggle A's campaign id under B's OWN entity → 404 (entity mismatch).
  const smuggle = await app.req('GET', `/api/actions/${entB.id}/${aid}/report`, { as: ownerB });
  assert.equal(smuggle.status, 404);
});

test('campaigns.view permission is required to see the campaign list', async () => {
  const ent = h.makeEntity('Perm Co', 'perm-org');
  const viewer = h.makeClient('viewer@test.local', [ent.id], 'viewer'); // dashboards only
  const res = await app.req('GET', `/api/actions/${ent.id}`, { as: viewer });
  assert.equal(res.status, 403);
});

// ── 2. Scoped opens/clicks rollup + counter heal ─────────────────────────────
test('the list heals click counters from action_clicks, scoped per channel, per tenant', async () => {
  const entA = h.makeEntity('Roll A', 'rollA-org');
  const entB = h.makeEntity('Roll B', 'rollB-org');
  const ownerA = h.makeClient('roll-a@test.local', [entA.id], 'owner');
  const sql = h.db.db;

  // A campaign in A whose cached counter is STALE (1) and a noisy campaign in B.
  const a = await app.req('POST', `/api/actions/${entA.id}`, { as: ownerA, body: { title: 'Heal me', channel: 'both', subject: 'S', body: 'B', audience: { mode: 'paste', pasted: 'x@a.com' } } });
  const aid = a.body.action.id;
  const b = await app.req('POST', `/api/actions/${entB.id}`, { as: h.makeClient('roll-b@test.local', [entB.id], 'owner'), body: { title: 'Noise', channel: 'email', subject: 'S', body: 'B', audience: { mode: 'paste', pasted: 'y@b.com' } } });
  const bid = b.body.action.id;

  // Seed: A's campaign got 3 email + 2 SMS clicks and 4 unique opens; sent to 10.
  // B's campaign got 100 clicks (must NOT bleed into A's numbers).
  const clk = sql.prepare('INSERT INTO action_clicks (action_id, email, at, channel, step) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 3; i++) clk.run(aid, `e${i}@a.com`, '2026-06-18', 'email', 0);
  for (let i = 0; i < 2; i++) clk.run(aid, `s${i}@a.com`, '2026-06-18', 'sms', 0);
  for (let i = 0; i < 100; i++) clk.run(bid, `n${i}@b.com`, '2026-06-18', 'email', 0);
  const opn = sql.prepare('INSERT INTO action_opens (action_id, email, at, step) VALUES (?,?,?,?)');
  for (let i = 0; i < 4; i++) opn.run(aid, `o${i}@a.com`, '2026-06-18', 0);
  // Stale cached results: clicks=1, sent=10.
  sql.prepare("UPDATE actions SET results=? WHERE id=?").run(JSON.stringify({ sent: 10, clicks: 1 }), aid);

  const { body } = await app.req('GET', `/api/actions/${entA.id}`, { as: ownerA });
  const action = body.actions.find((x) => x.id === aid);
  assert.equal(action.results.clicks, 5, 'total clicks healed upward (3 email + 2 sms), B\'s 100 not counted');
  assert.equal(action.results.emailClicks, 3);
  assert.equal(action.results.smsClicks, 2);
  assert.equal(action.openRate, 40, 'open rate = 4 unique openers / 10 sent');
});

// ── 3. Approval governance gate ──────────────────────────────────────────────
test('when approval is required, a draft cannot be sent directly — only a named approver can', async () => {
  const ent = h.makeEntity('Gated Co', 'gated-org');
  const author = h.makeClient('author@test.local', [ent.id], 'owner');
  const approver = h.makeClient('approver@test.local', [ent.id], 'owner');
  const outsider = h.makeClient('outsider@test.local', [ent.id], 'manager'); // can approve, but not named
  h.db.setSetting(`approval_required:${ent.id}`, '1');

  const created = await app.req('POST', `/api/actions/${ent.id}`, { as: author, body: { title: 'Gated', channel: 'email', subject: 'S', body: 'B', audience: { mode: 'paste', pasted: 'appr@x.com' } } });
  const aid = created.body.action.id;

  // Direct approve of a draft is blocked by the governance gate.
  const direct = await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: author });
  assert.equal(direct.status, 400);

  // Submit for approval → pending.
  const submit = await app.req('POST', `/api/actions/${ent.id}/${aid}/submit`, { as: author, body: { approvers: [{ type: 'user', userId: approver.id, email: approver.email }] } });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.pending, true);

  // A user who is NOT a named approver cannot approve, even with the permission.
  const wrong = await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: outsider });
  assert.equal(wrong.status, 403);

  // The named approver completes the approval → it sends.
  const ok = await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: approver });
  assert.equal(ok.status, 200);
  const done = await waitForStatus(ent.id, aid, 'done', author);
  assert.equal(done.results.sent, 1);
  assert.deepEqual(sent.email, ['appr@x.com']);
});

// ── 4. Per-channel consent enforced at send ──────────────────────────────────
test('per-channel consent is enforced at send (email-only vs sms-only)', async () => {
  const ent = h.makeEntity('Consent Co', 'consent-org');
  const owner = h.makeClient('consent@test.local', [ent.id], 'owner');

  // Tile resolves three people with different per-channel consent.
  resolveImpl = async () => ({
    fields: [{ name: 'email', label: 'Email' }, { name: 'phone', label: 'Phone' }, { name: 'em', label: 'EmailOK' }, { name: 'sm', label: 'SmsOK' }],
    rows: [
      { email: 'both@x.com', phone: '0820000001', em: 'yes', sm: 'yes' },
      { email: 'noemail@x.com', phone: '0820000002', em: 'no', sm: 'yes' },
      { email: 'nosms@x.com', phone: '0820000003', em: 'yes', sm: 'no' },
    ],
  });

  const created = await app.req('POST', `/api/actions/${ent.id}`, {
    as: owner,
    body: {
      title: 'Consent test', channel: 'both', subject: 'Hi', body: 'Hello',
      audience: { mode: 'tile', dashboardId: 'd1', tileId: 't1', emailField: 'email', phoneField: 'phone', emailConsentField: 'em', smsConsentField: 'sm' },
    },
  });
  const aid = created.body.action.id;

  const approve = await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: owner });
  assert.equal(approve.status, 200);
  await waitForStatus(ent.id, aid, 'done', owner);

  // Email goes to email-consenters only (both@, nosms@); SMS to sms-consenters
  // only (both@'s phone, noemail@'s phone). The non-consenting channel is dropped.
  assert.deepEqual(sent.email.sort(), ['both@x.com', 'nosms@x.com']);
  assert.deepEqual(sent.sms.sort(), ['0820000001', '0820000002']);
});

test('ignoreConsent (transactional) bypasses both consent columns', async () => {
  const ent = h.makeEntity('Txn Co', 'txn-org');
  const owner = h.makeClient('txn@test.local', [ent.id], 'owner');
  resolveImpl = async () => ({
    fields: [{ name: 'email', label: 'Email' }, { name: 'phone', label: 'Phone' }, { name: 'em', label: 'EmailOK' }, { name: 'sm', label: 'SmsOK' }],
    rows: [
      { email: 'a@x.com', phone: '0820000001', em: 'no', sm: 'no' },
      { email: 'b@x.com', phone: '0820000002', em: 'no', sm: 'no' },
    ],
  });

  const created = await app.req('POST', `/api/actions/${ent.id}`, {
    as: owner,
    body: {
      title: 'Txn', channel: 'both', subject: 'Hi', body: 'Hello', ignoreConsent: true,
      audience: { mode: 'tile', dashboardId: 'd1', tileId: 't1', emailField: 'email', phoneField: 'phone', emailConsentField: 'em', smsConsentField: 'sm' },
    },
  });
  const aid = created.body.action.id;
  await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: owner });
  await waitForStatus(ent.id, aid, 'done', owner);

  // Despite em=no / sm=no for everyone, the transactional override reaches all.
  assert.deepEqual(sent.email.sort(), ['a@x.com', 'b@x.com']);
  assert.deepEqual(sent.sms.sort(), ['0820000001', '0820000002']);
});

// ── 5. Public tracking routes (actionTracking.js) ────────────────────────────
// Regression for the open-storm fix: /o and /c resolve the campaign via the
// idx_actions_click_token expression index (point lookup, no table scan, no
// audience parse) and the list API never ships the audience blob.
test('open pixel and tracked click resolve by token, bump counters, and redirect with UTMs', async () => {
  const ent = h.makeEntity('Track Co', 'track-org');
  const owner = h.makeClient('track@test.local', [ent.id], 'owner');
  const created = await app.req('POST', `/api/actions/${ent.id}`, {
    as: owner,
    body: { title: 'Tracked', channel: 'email', subject: 'S', body: 'B', ctaUrl: 'https://shop.example/buy?x=1', utm: { source: 'pulse', campaign: 'launch' }, audience: { mode: 'paste', pasted: 'a@x.com\nb@x.com' } },
  });
  const aid = created.body.action.id;
  const token = JSON.parse(h.db.db.prepare('SELECT config FROM actions WHERE id=?').get(aid).config).clickToken;
  assert.ok(token);

  // The lookup must ride the expression index — not scan the table.
  const plan = h.db.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM actions WHERE json_extract(config,'$.clickToken')=?`).all(token);
  assert.match(JSON.stringify(plan), /idx_actions_click_token/);

  const px = await app.req('GET', `/o/${token}`, {});
  assert.equal(px.status, 200);
  // Raw fetch with manual redirect — app.req would follow the 302 off-box.
  const clk = await fetch(`${app.base}/c/${token}/x/e/0`, { redirect: 'manual' });
  assert.equal(clk.status, 302);
  const dest = new URL(clk.headers.get('location'));
  assert.equal(dest.searchParams.get('utm_source'), 'pulse');
  assert.equal(dest.searchParams.get('x'), '1'); // existing keys survive

  const { body } = await app.req('GET', `/api/actions/${ent.id}`, { as: owner });
  const a = body.actions.find((x) => x.id === aid);
  assert.equal(a.results.opens, 1);
  assert.equal(a.results.emailClicks, 1);
});

test('the campaign list carries audienceCount but NEVER the audience blob', async () => {
  const ent = h.makeEntity('Lazy Co', 'lazy-org');
  const owner = h.makeClient('lazy@test.local', [ent.id], 'owner');
  const created = await app.req('POST', `/api/actions/${ent.id}`, {
    as: owner, body: { title: 'Lazy', channel: 'email', subject: 'S', body: 'B', audience: { mode: 'paste', pasted: 'p1@x.com\np2@x.com\np3@x.com' } },
  });
  const aid = created.body.action.id;
  // Approve snapshots the audience into the row (3 recipients).
  await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: owner });
  await waitForStatus(ent.id, aid, 'done', owner);

  const { body } = await app.req('GET', `/api/actions/${ent.id}`, { as: owner });
  const a = body.actions.find((x) => x.id === aid);
  assert.equal(a.audienceCount, 3);
  assert.equal('audience' in a, false); // the blob never leaves the server on list
});

// ── 6. Crash-safe sends (action_sends ledger) ────────────────────────────────
test('a resumed campaign skips recipients already in the send ledger — nobody is emailed twice', async () => {
  const ent = h.makeEntity('Resume Co', 'resume-org');
  const owner = h.makeClient('resume@test.local', [ent.id], 'owner');
  const created = await app.req('POST', `/api/actions/${ent.id}`, {
    as: owner, body: { title: 'Resumable', channel: 'email', subject: 'S', body: 'B', audience: { mode: 'paste', pasted: 'r1@x.com\nr2@x.com\nr3@x.com' } },
  });
  const aid = created.body.action.id;
  // Simulate a blast that died after reaching r1: ledger row exists (written at
  // delivery time), status left 'running' by the crash — this is exactly the
  // state a mid-deploy kill leaves behind.
  h.db.db.prepare('INSERT INTO action_sends (action_id, recipient, channel, at) VALUES (?,?,?,?)')
    .run(aid, 'r1@x.com', 'email', '2026-06-01');

  await app.req('POST', `/api/actions/${ent.id}/${aid}/approve`, { as: owner });
  const a = await waitForStatus(ent.id, aid, 'done', owner);

  // r1 was NOT re-sent; r2/r3 were; the counters still account for all three.
  assert.deepEqual(sent.email.sort(), ['r2@x.com', 'r3@x.com']);
  assert.equal(a.results.sent, 3);
  assert.equal(a.results.emailSent, 3);
  // Every delivery is ledgered for the next resume.
  const rows = h.db.db.prepare('SELECT recipient FROM action_sends WHERE action_id=? ORDER BY recipient').all(aid).map((r) => r.recipient);
  assert.deepEqual(rows, ['r1@x.com', 'r2@x.com', 'r3@x.com']);
});
