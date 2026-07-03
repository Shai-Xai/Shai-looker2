// The Skills runtime (server/skills.js) is the autonomous "push" door onto the
// Owl: scheduled specialist runs over one event. These tests lock the
// deterministic foundation — no model calls, no Looker:
//   • tables + config upsert (born paused, per-entity/per-event instances),
//   • playbook layering (platform default + client additions),
//   • the backtest freeze: date-clamping so a frozen run can NEVER read data
//     from after the freeze date, and current-progress tools are withheld,
//   • the AM grading loop (rating + note on a run),
//   • the daily tick only fires active instances, once per local day.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeEntity } = require('./helpers');
const skills = require('../server/skills');

// A route-swallowing app: mount() registers routes we exercise via the returned API.
const fakeApp = { get: () => {}, post: () => {}, put: () => {}, delete: () => {} };
const fakeAuth = { requireAuth: (_q, _s, n) => n && n(), requireAdmin: (_q, _s, n) => n && n() };

// Tools stub: an askData that records what it was asked (to verify clamping).
const askDataCalls = [];
const stubTools = () => ({
  askData: { schema: { name: 'askData' }, run: async (args) => { askDataCalls.push(args); return { ok: true, rows: [] }; } },
  getGoals: { schema: { name: 'getGoals' }, run: async () => ({ ok: true, goals: [] }) },
});

const api = skills.mount(fakeApp, {
  db,
  auth: fakeAuth,
  insights: { isConfigured: () => false, requireClient: () => { throw new Error('no model in tests'); }, systemWith: (a, b) => `${a}\n${b}`, MODEL: 'test' },
  getOwlTools: stubTools,
  getGoalsApi: () => ({ listGoals: () => [] }),
  anthropicKeyForSuite: () => null,
  aiInstructionsFor: () => '',
  resolveEventDate: async () => null,
});

test('skill catalogue lists defs; instances are born paused at advise autonomy', () => {
  const e = makeEntity('SkillsCo', 'OrgS');
  const listed = api.listForEntity(e.id);
  assert.ok(listed.find((s) => s.key === 'ticketing'), 'ticketing def is in the catalogue');
  assert.deepEqual(listed.find((s) => s.key === 'ticketing').instances, []);

  const inst = api.upsertSkill(e.id, 'ticketing', { suiteId: 'suite-1' });
  assert.equal(inst.status, 'paused', 'shadow-by-default: nothing runs until activated');
  assert.equal(inst.autonomy, 'advise');
  assert.equal(inst.cadence, 'daily');

  // Upsert is idempotent per (entity, skill, suite) and patches in place.
  const upd = api.upsertSkill(e.id, 'ticketing', { suiteId: 'suite-1', status: 'active', timeOfDay: '07:15', playbook: 'Never discount VIP.' });
  assert.equal(upd.id, inst.id);
  assert.equal(upd.status, 'active');
  assert.equal(upd.timeOfDay, '07:15');
  assert.equal(upd.playbook, 'Never discount VIP.');
  assert.equal(api.listForEntity(e.id).find((s) => s.key === 'ticketing').instances.length, 1);

  assert.throws(() => api.upsertSkill(e.id, 'nope', {}), /Unknown skill/);

  // Park it again so the scheduler-tick test below starts from a clean slate.
  assert.equal(api.upsertSkill(e.id, 'ticketing', { suiteId: 'suite-1', status: 'paused' }).status, 'paused');
});

test('playbook layering: default only when blank; client additions layered on top', () => {
  const def = skills.SKILL_DEFS.ticketing;
  const base = skills.resolvePlaybook(def, '');
  assert.equal(base, def.defaultPlaybook, 'blank client layer inherits the platform default');
  const layered = skills.resolvePlaybook(def, 'Comps cap: 5% of capacity.');
  assert.ok(layered.startsWith(def.defaultPlaybook), 'default always present');
  assert.match(layered, /CLIENT-SPECIFIC PLAYBOOK ADDITIONS/);
  assert.match(layered, /Comps cap: 5% of capacity\./);
});

test('platform tier: an admin-edited playbook replaces the built-in seed; blank inherits it', () => {
  const def = skills.SKILL_DEFS.ticketing;

  // Pure layering: platform override replaces the built-in; client additions still append.
  const withPlatform = skills.resolvePlaybook(def, 'Never discount VIP.', 'WORKSHOP PLAYBOOK v1: judge by momentum.');
  assert.ok(withPlatform.startsWith('WORKSHOP PLAYBOOK v1'), 'platform override replaces the built-in seed');
  assert.ok(!withPlatform.includes('STARTER PLAYBOOK'), 'built-in seed is fully replaced, not appended');
  assert.match(withPlatform, /Never discount VIP\./);

  // End to end through the setting: listForEntity + the audit reflect the override.
  const e = makeEntity('PlatformCo', 'OrgP');
  db.setSetting('skill_playbook:ticketing', 'WORKSHOP PLAYBOOK v1: judge by momentum.');
  const ticketing = api.listForEntity(e.id).find((s) => s.key === 'ticketing');
  assert.equal(ticketing.defaultPlaybook, 'WORKSHOP PLAYBOOK v1: judge by momentum.');
  assert.equal(ticketing.defaultOverridden, true);
  const audit = skills.defaultsAudit(db).find((s) => s.key === 'ticketing');
  assert.equal(audit.overridden, true);
  assert.equal(audit.text, 'WORKSHOP PLAYBOOK v1: judge by momentum.');

  // Clearing the setting falls back to the built-in seed (blank inherits).
  db.setSetting('skill_playbook:ticketing', '');
  const back = api.listForEntity(e.id).find((s) => s.key === 'ticketing');
  assert.equal(back.defaultPlaybook, def.defaultPlaybook);
  assert.equal(back.defaultOverridden, false);
  assert.equal(skills.defaultsAudit(db).find((s) => s.key === 'ticketing').overridden, false);
});

test('backtest clamp: relative ranges are replaced, explicit ends are capped at the freeze', () => {
  const F = '2026-05-20';
  // Relative expression would resolve against TODAY → forced to an explicit range ending at the freeze.
  assert.equal(skills.clampBacktestDates({ dateRange: 'last 7 days' }, F).dateRange, `2000-01-01 to ${F}`);
  // No range at all → same forced ceiling.
  assert.equal(skills.clampBacktestDates({}, F).dateRange, `2000-01-01 to ${F}`);
  // Explicit range ending AFTER the freeze → end clamped, start kept.
  assert.equal(skills.clampBacktestDates({ dateRange: '2026-05-01 to 2026-06-15' }, F).dateRange, `2026-05-01 to ${F}`);
  // Explicit range fully before the freeze → untouched.
  assert.equal(skills.clampBacktestDates({ dateRange: '2026-04-01 to 2026-04-30' }, F).dateRange, '2026-04-01 to 2026-04-30');
  // A range STARTING after the freeze can't be honoured → forced ceiling.
  assert.equal(skills.clampBacktestDates({ dateRange: '2026-06-01 to 2026-06-30' }, F).dateRange, `2000-01-01 to ${F}`);
  // Other args ride through untouched.
  const out = skills.clampBacktestDates({ measure: 'tickets', dateRange: 'this month' }, F);
  assert.equal(out.measure, 'tickets');
});

test('backtest tool wrap: only allowed tools survive, and their dates are clamped', async () => {
  const F = '2026-05-20';
  askDataCalls.length = 0;
  const wrapped = skills.wrapToolsForBacktest(stubTools(), ['askData'], F);
  assert.deepEqual(Object.keys(wrapped), ['askData'], 'getGoals (current progress) is withheld in a backtest');
  await wrapped.askData.run({ measure: 'tickets', dateRange: 'last 30 days' }, {});
  assert.equal(askDataCalls[0].dateRange, `2000-01-01 to ${F}`, 'the tool physically cannot read past the freeze');
});

test('feedback grading: rating + note land on the run with reviewer + timestamp', () => {
  const e = makeEntity('GradeCo', 'OrgG');
  // Insert a run row directly (a live run needs the model; the grading loop does not).
  db.db.prepare("INSERT INTO skill_runs (id, entity_id, suite_id, skill_key, mode, status, advice, started_at) VALUES ('run-1', ?, 's1', 'ticketing', 'backtest', 'ok', 'HEADLINE: test', ?)").run(e.id, new Date().toISOString());
  const run = api.recordFeedback('run-1', { rating: 'down', note: 'Missed the VIP sell-out.', by: 'am@howler.co.za' });
  assert.equal(run.rating, 'down');
  assert.equal(run.feedback, 'Missed the VIP sell-out.');
  assert.equal(run.reviewedBy, 'am@howler.co.za');
  assert.ok(run.reviewedAt);
  assert.throws(() => api.recordFeedback('run-1', { rating: 'meh' }), /rating/);
  assert.throws(() => api.recordFeedback('nope', { rating: 'up' }), /No such run/);
});

test('daily tick: paused instances never fire; active ones fire once per local day', async () => {
  const e = makeEntity('TickCo', 'OrgT');
  // Paused instance → never due.
  api.upsertSkill(e.id, 'ticketing', { suiteId: 'suite-tick' });
  assert.equal(await api.tick(new Date()), 0, 'paused instances are not scheduled');

  // Activate with a time already passed today; the run itself will fail fast
  // (AI unconfigured in tests) but the tick must SELECT it as due exactly once.
  api.upsertSkill(e.id, 'ticketing', { suiteId: 'suite-tick', status: 'active', timeOfDay: '00:00' });
  const fired = await api.tick(new Date());
  assert.equal(fired, 1, 'active + past its time + not yet run today → due');
  // The kill switch stops everything.
  db.setSetting('skills_enabled', '0');
  assert.equal(await api.tick(new Date()), 0);
  db.setSetting('skills_enabled', '1');
});

test('skill prompts are registered in the AI audit (promptRegistry)', () => {
  const insights = require('../server/insights');
  const keys = insights.promptRegistry().map((p) => p.key);
  for (const k of ['skillTicketing', 'skillTicketingPlaybook', 'skillOps', 'skillOpsPlaybook']) {
    assert.ok(keys.includes(k), `${k} is auditable`);
  }
});

test('ops skill: in the catalogue, and ask_* wildcard expands to the client\'s extra explores', async () => {
  assert.ok(skills.SKILL_DEFS.ops, 'Chief of Operations is a registered specialist');

  // Wildcard expansion picks up whatever ask_<explore> tools this client has.
  const registry = {
    askData: { schema: { name: 'askData' }, run: async () => ({ ok: true }) },
    getGoals: { schema: { name: 'getGoals' }, run: async () => ({ ok: true }) },
    eventOps: { schema: { name: 'eventOps' }, run: async () => ({ ok: true }) },
    ask_cashless: { schema: { name: 'ask_cashless' }, run: async (a) => ({ ok: true, echo: a }) },
    ask_access_control: { schema: { name: 'ask_access_control' }, run: async () => ({ ok: true }) },
  };
  assert.deepEqual(
    skills.expandToolNames(skills.SKILL_DEFS.ops.liveTools, registry),
    ['getGoals', 'askData', 'eventOps', 'ask_cashless', 'ask_access_control'],
  );
  // Missing tools (client without eventOps/explores) are skipped, never an error.
  assert.deepEqual(skills.expandToolNames(skills.SKILL_DEFS.ops.liveTools, { askData: registry.askData }), ['askData']);

  // Ops backtests: present-state tools (getGoals, eventOps) withheld; ask_* clamped.
  const F = '2026-06-01';
  const wrapped = skills.wrapToolsForBacktest(registry, skills.SKILL_DEFS.ops.backtestTools, F);
  assert.deepEqual(Object.keys(wrapped).sort(), ['askData', 'ask_access_control', 'ask_cashless'].sort());
  const { echo } = await wrapped.ask_cashless.run({ measure: 'spend', dateRange: 'yesterday' }, {});
  assert.equal(echo.dateRange, `2000-01-01 to ${F}`, 'extra-explore reads are frozen too');
});
