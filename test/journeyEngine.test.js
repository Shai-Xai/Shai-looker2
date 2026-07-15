// The branching journey engine (server/journeys.js): compile the stored tree
// into a walkable graph, pick behaviour branches by severity with early-advance,
// fork attribute splits instantly, and walk real enrolment rows through sends,
// waits, decisions and exits — with stubbed senders and an in-memory DB (no
// network, no real mail).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const j = require('../server/journeys');

const msg = (over = {}) => ({ type: 'message', channel: 'email', delayHours: 0, subject: 's', body: 'b', ctaText: 'c', ...over });

function stamped(nodes) { return j.validateJourney({ name: 'T', nodes }).nodes; }

test('validateJourney stamps ids, steps, when-predicates and split defaults', () => {
  const nodes = stamped([
    msg({ subject: 'first' }),
    { type: 'decision', question: 'Did they buy?', waitHours: 48, branches: [
      { label: 'Bought', nodes: [msg({ subject: 'thanks' })] },
      { label: 'No response', nodes: [msg({ channel: 'sms', body: 'oi' })] },
    ] },
  ]);
  assert.equal(nodes[0].id, 'm1');
  assert.equal(nodes[0].step, 0);
  assert.equal(nodes[1].kind, 'behaviour');
  assert.equal(nodes[1].branches[0].when, 'bought');
  assert.equal(nodes[1].branches[1].when, 'timeout');
  // message steps number depth-first across branches
  assert.equal(nodes[1].branches[0].nodes[0].step, 1);
  assert.equal(nodes[1].branches[1].nodes[0].step, 2);
  const split = stamped([
    { type: 'decision', kind: 'split', question: 'VIP?', field: 'core_ticket_types.name', branches: [
      { label: 'VIP', values: ['VIP'], nodes: [msg()] },
      { label: 'Everyone else', nodes: [msg()] },
    ] },
  ]);
  assert.equal(split[0].kind, 'split');
  assert.equal(split[0].branches[1].values, null); // catch-all stamped
});

test('compile links branch tails to the node after the decision', () => {
  const nodes = stamped([
    msg(),
    { type: 'decision', question: 'q', waitHours: 24, branches: [
      { label: 'Clicked', nodes: [msg()] },
      { label: 'No response', nodes: [msg()] },
    ] },
    msg({ subject: 'after' }),
  ]);
  const { map, entryId } = j.compile(nodes);
  assert.equal(entryId, nodes[0].id);
  const afterId = nodes[2].id;
  for (const b of nodes[1].branches) assert.equal(map.get(b.nodes[0].id).nextId, afterId);
  assert.equal(map.get(afterId).nextId, null);
});

test('pickBranch: severity order, early advance, timeout only on expiry', () => {
  const d = stamped([msg(), { type: 'decision', question: 'q', waitHours: 24, branches: [
    { label: 'Bought', nodes: [msg()] },
    { label: 'Clicked', nodes: [msg()] },
    { label: 'No response', nodes: [msg()] },
  ] }])[1];
  assert.equal(j.pickBranch(d, { bought: true, clicked: true, expired: false }).when, 'bought');
  assert.equal(j.pickBranch(d, { clicked: true, expired: false }).when, 'clicked');
  assert.equal(j.pickBranch(d, { expired: false }), null); // keep waiting
  assert.equal(j.pickBranch(d, { expired: true }).when, 'timeout');
});

test('pickSplit: value match (case-insensitive) with everyone-else fallback', () => {
  const d = stamped([{ type: 'decision', kind: 'split', question: 'q', field: 'tt', branches: [
    { label: 'VIP', values: ['VIP', 'VVIP'], nodes: [msg({ subject: 'vip' })] },
    { label: 'Else', nodes: [msg({ subject: 'ga' })] },
  ] }])[0];
  assert.equal(j.pickSplit(d, { tt: 'vip' }).label, 'VIP');
  assert.equal(j.pickSplit(d, { tt: 'General' }).label, 'Else');
  assert.equal(j.pickSplit(d, {}).label, 'Else');
});

// ── Integration: walk people through sends, waits, clicks and splits ──────────
function makeDb() {
  const sql = new Database(':memory:');
  sql.exec(`
    CREATE TABLE action_enrollments (action_id TEXT, email TEXT, name TEXT DEFAULT '', ticket TEXT DEFAULT '', phone TEXT DEFAULT '',
      anchor_at TEXT DEFAULT '', step_index INTEGER DEFAULT 0, next_at TEXT, status TEXT DEFAULT 'active',
      enrolled_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', PRIMARY KEY (action_id, email));
    CREATE TABLE action_clicks (action_id TEXT, email TEXT, at TEXT, channel TEXT DEFAULT '', step INTEGER DEFAULT -1);
    CREATE TABLE action_opens (action_id TEXT, email TEXT, at TEXT, step INTEGER DEFAULT -1);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return sql;
}
function makeDeps(sql, { reachable = new Map(), convSet = null } = {}) {
  const sends = [];
  return {
    sends,
    deps: {
      sql, now: () => new Date().toISOString(), reachable, convSet, sup: new Set(),
      renderFor: (a, rcpt, step) => ({ html: '<p>x</p>', text: 'x', subject: step.subject }),
      renderSmsFor: (a, rcpt, step) => step.body,
      mailer: { send: async ({ to, subject }) => { sends.push({ channel: 'email', to, subject }); return { ok: true }; } },
      messaging: { sendSms: async ({ to, text }) => { sends.push({ channel: 'sms', to, text }); return { ok: true }; } },
      branding: { senderName: 'Test' },
      saveResults: () => {},
    },
  };
}
const enrol = (sql, actionId, email, over = {}) => sql.prepare(
  "INSERT INTO action_enrollments (action_id,email,name,phone,anchor_at,next_at,status,enrolled_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
).run(actionId, email, over.name || 'T', over.phone || '', new Date().toISOString(), over.nextAt || new Date(Date.now() - 1000).toISOString(), 'active', new Date().toISOString(), new Date().toISOString());
const row = (sql, actionId, email) => sql.prepare('SELECT * FROM action_enrollments WHERE action_id=? AND email=?').get(actionId, email);

test('engine: send → wait at decision → early-advance on click → branch send → done', async () => {
  const sql = makeDb();
  const journey = j.validateJourney({ name: 'T', nodes: [
    msg({ subject: 'opener' }),
    { type: 'decision', question: 'Clicked?', waitHours: 48, branches: [
      { label: 'Clicked', nodes: [msg({ subject: 'hot-lead' })] },
      { label: 'No response', nodes: [msg({ channel: 'sms', body: 'nudge' })] },
    ] },
  ] });
  const a = { id: 'a1', entityId: 'e1', title: 'T', config: { journey }, results: {} };
  const reachable = new Map([['p@x.com', { emailOk: true, smsOk: true, attributes: {} }]]);
  const { deps, sends } = makeDeps(sql, { reachable, convSet: new Set() }); // convSet empty = nobody bought
  enrol(sql, 'a1', 'p@x.com');
  await j.processAction(a, deps); // tick 1: opener sends, parks at the decision
  assert.deepEqual(sends.map((s) => s.subject || s.text), ['opener']);
  let r = row(sql, 'a1', 'p@x.com');
  assert.equal(r.status, 'active');
  assert.ok(r.wait_until > new Date().toISOString(), 'wait window is open');
  sql.prepare('INSERT INTO action_clicks (action_id,email,at,step) VALUES (?,?,?,0)').run('a1', 'p@x.com', new Date().toISOString());
  sql.prepare('UPDATE action_enrollments SET next_at=? WHERE email=?').run(new Date(Date.now() - 1000).toISOString(), 'p@x.com');
  await j.processAction(a, deps); // tick 2: click routes immediately (no 48h wait)
  assert.deepEqual(sends.map((s) => s.subject || s.text), ['opener', 'hot-lead']);
  assert.equal(row(sql, 'a1', 'p@x.com').status, 'done');
});

test('engine: timeout branch fires only after the window expires (SMS per-node channel)', async () => {
  const sql = makeDb();
  const journey = j.validateJourney({ name: 'T', nodes: [
    msg({ subject: 'opener' }),
    { type: 'decision', question: 'Clicked?', waitHours: 48, branches: [
      { label: 'Clicked', nodes: [msg({ subject: 'hot' })] },
      { label: 'No response', nodes: [msg({ channel: 'sms', body: 'nudge-sms' })] },
    ] },
  ] });
  const a = { id: 'a2', entityId: 'e1', title: 'T', config: { journey }, results: {} };
  const reachable = new Map([['q@x.com', { emailOk: true, smsOk: true, attributes: {} }]]);
  const { deps, sends } = makeDeps(sql, { reachable, convSet: new Set() });
  enrol(sql, 'a2', 'q@x.com', { phone: '+2782' });
  await j.processAction(a, deps); // opener + park
  sql.prepare('UPDATE action_enrollments SET next_at=? WHERE email=?').run(new Date(Date.now() - 1000).toISOString(), 'q@x.com');
  await j.processAction(a, deps); // still inside window, no click → keeps waiting
  assert.equal(sends.length, 1);
  sql.prepare('UPDATE action_enrollments SET wait_until=?, next_at=? WHERE email=?').run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), 'q@x.com');
  await j.processAction(a, deps); // window expired → timeout branch, SMS node sends SMS
  assert.deepEqual(sends[1], { channel: 'sms', to: '+2782', text: 'nudge-sms' });
  assert.equal(row(sql, 'a2', 'q@x.com').status, 'done');
});

test('engine: an in_segment branch watches its OWN list (authored order, per-branch segments)', async () => {
  const sql = makeDb();
  const journey = j.validateJourney({ name: 'T', nodes: [
    msg({ subject: 'opener' }),
    { type: 'decision', question: 'On the attended list?', waitHours: 24, branches: [
      { label: 'Attended', when: 'in_segment', segmentName: 'Attended', segmentId: 'seg9', nodes: [msg({ subject: 'thanks-for-coming' })] },
      { label: 'No response', nodes: [msg({ subject: 'missed-you' })] },
    ] },
  ] });
  const a = { id: 'a4', entityId: 'e1', title: 'T', config: { journey }, results: {} };
  const reachable = new Map([['in@x.com', { emailOk: true, attributes: {} }], ['out@x.com', { emailOk: true, attributes: {} }]]);
  const { deps, sends } = makeDeps(sql, { reachable, convSet: new Set() });
  deps.sysUser = { role: 'admin' };
  deps.audienceFor = async (entityId, cfg) => (cfg.audience.segmentId === 'seg9' ? { list: [{ email: 'in@x.com' }] } : { list: [] });
  enrol(sql, 'a4', 'in@x.com'); enrol(sql, 'a4', 'out@x.com');
  await j.processAction(a, deps); // openers send, both park at the decision
  sql.prepare("UPDATE action_enrollments SET next_at=?").run(new Date(Date.now() - 1000).toISOString());
  await j.processAction(a, deps); // in@ is on the watched list → routed; out@ keeps waiting
  const subjects = sends.map((s) => s.subject);
  assert.ok(subjects.includes('thanks-for-coming'), 'segment member routed down the in_segment branch');
  assert.ok(!subjects.includes('missed-you'), 'non-member has not taken the timeout branch yet');
  assert.equal(row(sql, 'a4', 'out@x.com').status, 'active');
});

test('engine: attribute split routes VIP vs everyone-else instantly; bought routes to converted', async () => {
  const sql = makeDb();
  const journey = j.validateJourney({ name: 'T', nodes: [
    { type: 'decision', kind: 'split', question: 'VIP?', field: 'core_ticket_types.name', branches: [
      { label: 'VIP', values: ['VIP'], nodes: [msg({ subject: 'vip-mail' })] },
      { label: 'Everyone else', nodes: [msg({ subject: 'ga-mail' })] },
    ] },
    { type: 'decision', question: 'Bought?', waitHours: 24, branches: [
      { label: 'Bought', nodes: [msg({ subject: 'thanks' })] },
      { label: 'No response', nodes: [msg({ subject: 'reminder' })] },
    ] },
  ] });
  const a = { id: 'a3', entityId: 'e1', title: 'T', config: { journey }, results: {} };
  const reachable = new Map([
    ['vip@x.com', { emailOk: true, attributes: { 'core_ticket_types.name': 'VIP' } }],
    ['ga@x.com', { emailOk: true, attributes: { 'core_ticket_types.name': 'General' } }],
  ]);
  const convSet = new Set(['vip@x.com']); // the VIP has bought (conversion source)
  const { deps, sends } = makeDeps(sql, { reachable, convSet });
  enrol(sql, 'a3', 'vip@x.com'); enrol(sql, 'a3', 'ga@x.com');
  await j.processAction(a, deps);
  const subjects = sends.map((s) => s.subject);
  assert.ok(subjects.includes('vip-mail') && subjects.includes('ga-mail'), 'split sent each side its own mail');
  assert.ok(subjects.includes('thanks'), 'bought signal routed the VIP to the thank-you without waiting');
  assert.equal(row(sql, 'a3', 'vip@x.com').status, 'converted');
  assert.equal(row(sql, 'a3', 'ga@x.com').status, 'active'); // GA waits at the decision
});
