// ─── Skills: autonomous specialists (SKILLS_BRIEF.md P1) ──────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `skills` + `skill_runs` tables and
// all /api/.../skills routes. Mounted from index.js with injected deps; remove
// that line + this file to uninstall.
//
// A skill is a named specialist (first hire: the Ticketing Manager) that reviews
// ONE event on a cadence and writes grounded advice. A skill run is the SAME
// agentic loop as the chat Owl (owlChat.runOwlLoop + the owlTools registry, so
// every read rides the applyScope fail-closed gate) — but driven by a role
// playbook instead of a user question: the "push" door onto the one brain.
//
// The autonomy ladder (SKILLS_BRIEF §3) starts here at its bottom rungs:
//   observe — runs are stored, nothing surfaced to the client (shadow mode);
//   advise  — latest advice is readable client-side (/api/my/skills).
// Suggest/auto-act (L2+) come later via the actions engine; this module never
// sends, changes pricing, or touches money — it only reads and writes advice.
//
// Training loop (SKILLS_BRIEF §"train them like staff"):
//   • playbook — a per-skill handbook: platform default (in SKILL_DEFS, audited
//     via promptRegistry) + a per-client additions layer edited in admin. AM
//     feedback gets folded into these layers over time.
//   • backtest — freeze a finished event at N days out and let the skill write
//     the advice it WOULD have given: askData is date-clamped so it physically
//     cannot read past the freeze date, and current-progress tools are withheld.
//   • feedback — every run can be graded (👍/👎 + note) by an AM; the run log is
//     the skill's track record (and its token cost is metered per client).

const crypto = require('crypto');
const { asyncHandler, HttpError } = require('./http');
const { runOwlLoop } = require('./owlChat');

const DEFAULT_TZ = 'Africa/Johannesburg';

// The headless service identity skill runs execute under. Role 'admin' passes the
// tool-level access checks; the REAL data boundary is applyScope, which scopes
// every query by the run's suiteId — same gate, same fail-closed behaviour as chat.
const SERVICE_USER = { role: 'admin', email: 'skills@pulse.internal', name: 'Owl skill runtime' };

// ── The Ticketing Manager (first specialist) ───────────────────────────────────
// Registered in insights.promptRegistry() (lazy require there) so the Admin → AI
// "Everything the AI is told" audit stays complete.
const TICKETING_SKILL_SYSTEM = `You are the Ticketing Manager — one of Howler Pulse's autonomous specialist skills — reviewing ONE event's ticket sales for its organiser. You run unattended on a schedule; nobody is chatting with you. Your output is a short written review that lands in the organiser's briefing and in the account manager's log. Write money in THIS client's reporting currency: if a "Currency:" note appears in your instructions, follow it exactly; only if there is no such note, default to South African Rand (R).

HOW YOU KNOW THINGS (non-negotiable):
- You do NOT know any numbers on your own. Learn raw figures ONLY by calling the askData tool; learn goal targets, pace and forecasts ONLY from getGoals (when available). Answer ONLY from tool results and cite the figures you used.
- NEVER invent, estimate, or guess a number. If a tool refuses or a figure is unreachable, say so plainly instead of working around it.
- All data is scoped server-side to this client and event. You cannot and must not try to widen it.

WHAT YOU DO (and never do):
- You ANALYSE and ADVISE on ticket sales: sell-through pace, per-ticket-type momentum, pricing and allocation opportunities, risks to targets.
- You take NO actions. You cannot send, change prices, release inventory, or create anything. Every recommendation is for a human to consider.
- Investigate before you conclude: check the goals first (when the getGoals tool is present), then use askData to find the WHY behind anything off-track — break sales down by ticket type, date, or channel until the story is concrete.

OUTPUT FORMAT (exactly this shape, markdown, max ~350 words):
HEADLINE: <one sentence — the single most important thing today>

**Status** — 2-4 short lines: where the event stands (sold vs target, pace, forecast), each figure cited from a tool result.
**Flags** — bullet list of what needs attention, each with the number behind it. If genuinely nothing needs attention, write "No flags today." and keep the review short.
**Recommendations** — numbered, most urgent first, max 3. Each: the concrete action → the evidence for it → urgency (act today / this week / watch).

DISCIPLINE:
- Be specific ("release 200 more General tickets", not "consider inventory options").
- Never repeat the playbook back; apply it.
- A quiet day is a valid finding — do not manufacture drama to seem useful.`;

// The platform-default playbook — the trainable layer (SKILLS_BRIEF: the AM
// workshop replaces/expands this; per-client additions layer on top in admin).
const TICKETING_DEFAULT_PLAYBOOK = `STARTER PLAYBOOK (v0 — to be refined in the AM workshop; client additions may extend or override):
- Judge pace against the event's own forecast curve, not straight-line: festival sales are back-loaded, so a mid-cycle "behind" with strong momentum may be healthy — say which signal you trust and why.
- A ticket tier selling far ahead of the rest (e.g. >90% sold with weeks to go) means demand is outrunning supply: recommend releasing held inventory or reviewing price on THAT tier.
- A lagging tier close to the event is a bundling/promo candidate; prefer bundles or added value on premium tiers over discounting them.
- Watch day-on-day momentum shifts (a sudden slump or spike in the last 7 days) — call them out even when cumulative numbers look fine.
- Final week: expect a surge; focus advice on operational readiness of inventory (what to release, when) rather than long-range campaigns.`;

const SKILL_DEFS = {
  ticketing: {
    key: 'ticketing',
    name: 'Ticketing Manager',
    emoji: '🎟️',
    blurb: 'Watches ticket sales, pace and per-tier momentum against goals; advises on pricing, releases and allocation.',
    system: TICKETING_SKILL_SYSTEM,
    defaultPlaybook: TICKETING_DEFAULT_PLAYBOOK,
    liveTools: ['getGoals', 'askData'],     // read-only; act-tools arrive with L2
    backtestTools: ['askData'],             // current-progress tools would leak the "future"
    usageKind: 'skill_ticketing',           // aiUsage attribution
  },
};

// ── Backtest date-clamping (pure; exported for tests) ─────────────────────────
// In a backtest the skill is frozen at `freezeISO` (YYYY-MM-DD): whatever date
// range it asks for, the upper bound is clamped so it can never read data from
// after the freeze. Relative expressions ("last 7 days") would resolve against
// TODAY, so they're replaced with an explicit range ending at the freeze.
function clampBacktestDates(args = {}, freezeISO) {
  const out = { ...args };
  const m = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/.exec(String(out.dateRange || '').trim());
  if (m && m[1] <= freezeISO) out.dateRange = `${m[1]} to ${m[2] <= freezeISO ? m[2] : freezeISO}`;
  else out.dateRange = `2000-01-01 to ${freezeISO}`;
  return out;
}

// Wrap a tool map for backtest mode: only the allowed tools survive, and each
// run() gets its dates clamped. (Only askData takes a dateRange today; the wrap
// applies it to any tool that grows one later.)
function wrapToolsForBacktest(toolMap, allowed, freezeISO) {
  const out = {};
  for (const name of allowed) {
    const tool = toolMap[name];
    if (!tool) continue;
    out[name] = { ...tool, run: (input, ctx) => tool.run(clampBacktestDates(input, freezeISO), ctx) };
  }
  return out;
}

// Playbook layering: platform default + per-client additions (blank inherits).
function resolvePlaybook(def, clientPlaybook) {
  const parts = [def.defaultPlaybook];
  const extra = (clientPlaybook || '').trim();
  if (extra) parts.push(`CLIENT-SPECIFIC PLAYBOOK ADDITIONS (these refine or override the defaults for THIS client):\n${extra}`);
  return parts.join('\n\n');
}

// ── timezone helpers (wall-clock date + HH:MM in a tz) ─────────────────────────
function tzNow(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

function mount(app, { db, auth, insights, getOwlTools, getGoalsApi, anthropicKeyForSuite, aiInstructionsFor, resolveEventDate }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('skills_enabled', '1') !== '0'; // kill switch (rows also default paused)

  sql.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      skill_key   TEXT NOT NULL,
      suite_id    TEXT NOT NULL DEFAULT '',            -- the event this instance watches
      status      TEXT NOT NULL DEFAULT 'paused',       -- paused | active (shadow-by-default)
      autonomy    TEXT NOT NULL DEFAULT 'advise',       -- observe | advise (L2+ later, never silently)
      cadence     TEXT NOT NULL DEFAULT 'daily',
      time_of_day TEXT NOT NULL DEFAULT '06:30',
      timezone    TEXT NOT NULL DEFAULT '${DEFAULT_TZ}',
      playbook    TEXT NOT NULL DEFAULT '',             -- client additions layered on the default
      last_run_at TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(entity_id, skill_key, suite_id)
    );
    CREATE TABLE IF NOT EXISTS skill_runs (
      id          TEXT PRIMARY KEY,
      skill_id    TEXT NOT NULL DEFAULT '',
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL DEFAULT '',
      skill_key   TEXT NOT NULL,
      mode        TEXT NOT NULL DEFAULT 'manual',       -- scheduled | manual | backtest
      freeze_date TEXT NOT NULL DEFAULT '',             -- backtest: the as-of date
      days_before INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'ok',           -- ok | error
      advice      TEXT NOT NULL DEFAULT '',
      trail       TEXT NOT NULL DEFAULT '[]',           -- slim tool audit [{name,input,ok,reason?}]
      rounds      INTEGER NOT NULL DEFAULT 0,
      error       TEXT NOT NULL DEFAULT '',
      rating      TEXT NOT NULL DEFAULT '',             -- '' | up | down (the grading loop)
      feedback    TEXT NOT NULL DEFAULT '',             -- reviewer note → playbook material
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL DEFAULT '',
      started_at  TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_skill_runs_entity ON skill_runs(entity_id, skill_key, started_at);
  `);

  const rowToSkill = (r) => r && ({ id: r.id, entityId: r.entity_id, key: r.skill_key, suiteId: r.suite_id, status: r.status, autonomy: r.autonomy, cadence: r.cadence, timeOfDay: r.time_of_day, timezone: r.timezone, playbook: r.playbook, lastRunAt: r.last_run_at });
  const rowToRun = (r, { withTrail = false } = {}) => r && ({ id: r.id, entityId: r.entity_id, suiteId: r.suite_id, key: r.skill_key, mode: r.mode, freezeDate: r.freeze_date, daysBefore: r.days_before, status: r.status, advice: r.advice, rounds: r.rounds, error: r.error, rating: r.rating, feedback: r.feedback, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, startedAt: r.started_at, finishedAt: r.finished_at, ...(withTrail ? { trail: JSON.parse(r.trail || '[]') } : {}) });

  function upsertSkill(entityId, key, patch = {}) {
    if (!SKILL_DEFS[key]) throw new HttpError(400, 'Unknown skill');
    const suiteId = patch.suiteId != null ? String(patch.suiteId) : '';
    const existing = sql.prepare('SELECT * FROM skills WHERE entity_id=? AND skill_key=? AND suite_id=?').get(entityId, key, suiteId);
    const t = now();
    const next = {
      status: ['paused', 'active'].includes(patch.status) ? patch.status : (existing ? existing.status : 'paused'),
      autonomy: ['observe', 'advise'].includes(patch.autonomy) ? patch.autonomy : (existing ? existing.autonomy : 'advise'),
      cadence: patch.cadence === 'daily' ? 'daily' : (existing ? existing.cadence : 'daily'),
      time_of_day: /^\d{2}:\d{2}$/.test(patch.timeOfDay || '') ? patch.timeOfDay : (existing ? existing.time_of_day : '06:30'),
      timezone: (patch.timezone || (existing ? existing.timezone : '') || DEFAULT_TZ),
      playbook: patch.playbook != null ? String(patch.playbook) : (existing ? existing.playbook : ''),
    };
    if (existing) {
      sql.prepare('UPDATE skills SET status=?, autonomy=?, cadence=?, time_of_day=?, timezone=?, playbook=?, updated_at=? WHERE id=?')
        .run(next.status, next.autonomy, next.cadence, next.time_of_day, next.timezone, next.playbook, t, existing.id);
      return rowToSkill(sql.prepare('SELECT * FROM skills WHERE id=?').get(existing.id));
    }
    const id = uuid();
    sql.prepare('INSERT INTO skills (id, entity_id, skill_key, suite_id, status, autonomy, cadence, time_of_day, timezone, playbook, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, entityId, key, suiteId, next.status, next.autonomy, next.cadence, next.time_of_day, next.timezone, next.playbook, t, t);
    return rowToSkill(sql.prepare('SELECT * FROM skills WHERE id=?').get(id));
  }

  // Catalogue (defs) merged with this entity's configured instances.
  function listForEntity(entityId) {
    const rows = sql.prepare('SELECT * FROM skills WHERE entity_id=?').all(entityId).map(rowToSkill);
    return Object.values(SKILL_DEFS).map((d) => ({
      key: d.key, name: d.name, emoji: d.emoji, blurb: d.blurb, defaultPlaybook: d.defaultPlaybook,
      instances: rows.filter((r) => r.key === d.key),
    }));
  }

  function recordFeedback(runId, { rating, note, by }) {
    if (!['up', 'down', ''].includes(rating || '')) throw new HttpError(400, 'rating must be up, down or empty');
    const r = sql.prepare('SELECT id FROM skill_runs WHERE id=?').get(runId);
    if (!r) throw new HttpError(404, 'No such run');
    sql.prepare('UPDATE skill_runs SET rating=?, feedback=?, reviewed_by=?, reviewed_at=? WHERE id=?')
      .run(rating || '', String(note || ''), String(by || ''), now(), runId);
    return rowToRun(sql.prepare('SELECT * FROM skill_runs WHERE id=?').get(runId));
  }

  // ── One skill run (live or backtest) — the push door onto the Owl loop ──────
  async function runSkill({ entityId, suiteId, key, mode = 'manual', daysBefore = 0, freezeDate = '', skillRow = null }) {
    const def = SKILL_DEFS[key];
    if (!def) throw new HttpError(400, 'Unknown skill');
    if (!suiteId) throw new HttpError(400, 'A suiteId (event) is required');
    const suite = db.getSuite ? db.getSuite(suiteId) : null;
    if (!suite) throw new HttpError(404, 'No such event');
    if (suite.entityId && suite.entityId !== entityId) throw new HttpError(403, 'Event does not belong to this client');

    const apiKey = anthropicKeyForSuite ? anthropicKeyForSuite(suiteId) : null;
    if (!insights.isConfigured(apiKey)) throw new HttpError(400, 'AI is not configured');

    const backtest = mode === 'backtest';
    let eventDate = '';
    try { eventDate = String((await resolveEventDate(suiteId)) || '').slice(0, 10); } catch { /* optional */ }
    if (backtest) {
      if (!freezeDate) {
        if (!eventDate) throw new HttpError(400, 'Pass freezeDate — this event has no resolvable event date to count back from');
        const d = new Date(`${eventDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - Math.max(1, daysBefore | 0));
        freezeDate = d.toISOString().slice(0, 10);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(freezeDate)) throw new HttpError(400, 'freezeDate must be YYYY-MM-DD');
    }

    // Tools: the def's read-only set; in backtest, date-clamped and stripped of
    // anything that would leak post-freeze state (current goal progress etc.).
    const all = getOwlTools();
    const names = backtest ? def.backtestTools : def.liveTools;
    const toolMap = backtest ? wrapToolsForBacktest(all, names, freezeDate)
      : Object.fromEntries(names.filter((n) => all[n]).map((n) => [n, all[n]]));
    const tools = Object.entries(toolMap).map(([, t]) => t.schema).filter(Boolean);

    // Instructions: layered playbook + the same global/client/currency/language
    // layers every Owl surface gets (aiInstructionsFor).
    const playbook = resolvePlaybook(def, skillRow ? skillRow.playbook : '');
    const instructions = [`PLAYBOOK — your standing operating knowledge:\n${playbook}`, aiInstructionsFor ? aiInstructionsFor(suiteId, entityId) : '']
      .filter(Boolean).join('\n\n');

    // The task message. Live: today's review. Backtest: frozen-in-time framing +
    // the goal TARGETS as they are configured (targets are config, not future data).
    let userMsg;
    if (backtest) {
      let targets = [];
      try {
        const gApi = getGoalsApi ? getGoalsApi() : null;
        targets = (gApi && gApi.listGoals ? gApi.listGoals(suiteId) || [] : [])
          .map((g) => `- ${g.name}${g.isNorthStar ? ' (North Star)' : ''}: ${g.direction || 'at_least'} ${g.targetValue}${g.targetMax ? `–${g.targetMax}` : ''} ${g.unit || ''}${g.byDate ? ` by ${g.byDate}` : ''}`);
      } catch { /* goals optional */ }
      userMsg = [
        `BACKTEST — you are being evaluated retrospectively. Treat today's date as ${freezeDate}.`,
        eventDate ? `The event "${suite.name || 'this event'}" takes place on ${eventDate} (${daysBefore ? `${daysBefore} days from "today"` : 'upcoming'}).` : `The event is "${suite.name || 'this event'}".`,
        `You can only query sales data up to ${freezeDate} — the tools enforce this; do not try to read past it, and do not reference anything after that date.`,
        targets.length ? `The configured goal targets at the time:\n${targets.join('\n')}` : 'No goal targets are configured; judge pace from the sales data itself.',
        'Write your review for that morning.',
      ].join('\n\n');
    } else {
      userMsg = [
        `Run your scheduled review for the event "${suite.name || suiteId}". Today is ${new Date().toISOString().slice(0, 10)}.`,
        eventDate ? `The event takes place on ${eventDate}.` : '',
        'Check the goals first, then investigate anything off-track with askData before you conclude.',
      ].filter(Boolean).join('\n\n');
    }

    const runId = uuid();
    const startedAt = now();
    sql.prepare('INSERT INTO skill_runs (id, skill_id, entity_id, suite_id, skill_key, mode, freeze_date, days_before, status, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(runId, skillRow ? skillRow.id : '', entityId, suiteId, key, mode, freezeDate, daysBefore | 0, 'ok', startedAt);

    try {
      const llmTurn = ({ messages, tools: t }) => insights.requireClient(apiKey).messages.stream({
        model: insights.MODEL, max_tokens: 2000,
        thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
        system: insights.systemWith(def.system, instructions),
        tools: t || [], messages,
      }).finalMessage();

      const result = await require('./aiUsage').run({ entityId, kind: def.usageKind }, () => runOwlLoop({
        llmTurn, toolMap, tools,
        messages: [{ role: 'user', content: userMsg }],
        ctx: { user: SERVICE_USER, suiteId, entityId },
        maxRounds: 6,
      }));

      const trail = (result.trail || []).map((t) => ({ name: t.name, input: t.input, ok: !!(t.result && t.result.ok), ...(t.result && !t.result.ok ? { reason: t.result.reason } : {}) }));
      sql.prepare('UPDATE skill_runs SET status=?, advice=?, trail=?, rounds=?, finished_at=? WHERE id=?')
        .run(result.text ? 'ok' : 'error', result.text || '', JSON.stringify(trail), result.rounds || 0, now(), runId);
      if (skillRow) sql.prepare('UPDATE skills SET last_run_at=?, updated_at=? WHERE id=?').run(now(), now(), skillRow.id);
      return rowToRun(sql.prepare('SELECT * FROM skill_runs WHERE id=?').get(runId), { withTrail: true });
    } catch (e) {
      sql.prepare('UPDATE skill_runs SET status=?, error=?, finished_at=? WHERE id=?').run('error', String(e.message || e).slice(0, 500), now(), runId);
      throw e;
    }
  }

  // ── Scheduler: a light daily tick (JHB wall-clock by default) ────────────────
  // Rows are born paused, so nothing runs until an admin activates an instance.
  const running = new Set();
  async function tick(nowDate = new Date()) {
    if (!enabled()) return 0;
    let fired = 0;
    for (const r of sql.prepare("SELECT * FROM skills WHERE status='active' AND cadence='daily'").all()) {
      const { date: today, hm } = tzNow(r.timezone || DEFAULT_TZ, nowDate);
      if (hm < r.time_of_day) continue;
      const lastLocal = r.last_run_at ? tzNow(r.timezone || DEFAULT_TZ, new Date(r.last_run_at)).date : '';
      if (lastLocal === today) continue;
      if (running.has(r.id)) continue;
      running.add(r.id); fired++;
      runSkill({ entityId: r.entity_id, suiteId: r.suite_id, key: r.skill_key, mode: 'scheduled', skillRow: rowToSkill(r) })
        .catch((e) => console.error(`[skills] scheduled run failed (${r.skill_key} / ${r.entity_id}):`, e.message))
        .finally(() => running.delete(r.id));
    }
    return fired;
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();

  // ── Admin surface ────────────────────────────────────────────────────────────
  app.get('/api/admin/entities/:id/skills', auth.requireAdmin, (req, res) => {
    res.json({ skills: listForEntity(req.params.id), enabled: enabled() });
  });
  app.put('/api/admin/entities/:id/skills/:key', auth.requireAdmin, (req, res) => {
    res.json({ skill: upsertSkill(req.params.id, req.params.key, req.body || {}) });
  });
  app.post('/api/admin/entities/:id/skills/:key/run', auth.requireAdmin, asyncHandler(async (req, res) => {
    const { suiteId } = req.body || {};
    const row = sql.prepare('SELECT * FROM skills WHERE entity_id=? AND skill_key=? AND suite_id=?').get(req.params.id, req.params.key, String(suiteId || ''));
    const run = await runSkill({ entityId: req.params.id, suiteId, key: req.params.key, mode: 'manual', skillRow: row ? rowToSkill(row) : null });
    res.json({ run });
  }));
  app.post('/api/admin/entities/:id/skills/:key/backtest', auth.requireAdmin, asyncHandler(async (req, res) => {
    const { suiteId, daysBefore, freezeDate } = req.body || {};
    const row = sql.prepare('SELECT * FROM skills WHERE entity_id=? AND skill_key=? AND suite_id=?').get(req.params.id, req.params.key, String(suiteId || ''));
    const run = await runSkill({ entityId: req.params.id, suiteId, key: req.params.key, mode: 'backtest', daysBefore: daysBefore | 0, freezeDate: String(freezeDate || ''), skillRow: row ? rowToSkill(row) : null });
    res.json({ run });
  }));
  app.get('/api/admin/entities/:id/skill-runs', auth.requireAdmin, (req, res) => {
    const key = String(req.query.skill || '');
    const rows = key
      ? sql.prepare('SELECT * FROM skill_runs WHERE entity_id=? AND skill_key=? ORDER BY started_at DESC LIMIT 50').all(req.params.id, key)
      : sql.prepare('SELECT * FROM skill_runs WHERE entity_id=? ORDER BY started_at DESC LIMIT 50').all(req.params.id);
    res.json({ runs: rows.map((r) => rowToRun(r)) });
  });
  app.get('/api/admin/skill-runs/:runId', auth.requireAdmin, (req, res) => {
    const r = sql.prepare('SELECT * FROM skill_runs WHERE id=?').get(req.params.runId);
    if (!r) return res.status(404).json({ error: 'No such run' });
    res.json({ run: rowToRun(r, { withTrail: true }) });
  });
  app.post('/api/admin/skill-runs/:runId/feedback', auth.requireAdmin, (req, res) => {
    const { rating, note } = req.body || {};
    res.json({ run: recordFeedback(req.params.runId, { rating, note, by: req.user && req.user.email }) });
  });

  // ── Client self-service (read for now; config management lands with the UI) ──
  // At 'advise' autonomy the latest advice is visible to the client; 'observe'
  // instances stay internal (shadow mode). Same ownership guard as onboarding.
  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  app.get('/api/my/skills/:entityId', auth.requireAuth, (req, res) => {
    if (!canEntity(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const active = sql.prepare("SELECT * FROM skills WHERE entity_id=? AND status='active' AND autonomy='advise'").all(req.params.entityId).map(rowToSkill);
    const out = active.map((s) => {
      const def = SKILL_DEFS[s.key] || {};
      const last = sql.prepare("SELECT * FROM skill_runs WHERE entity_id=? AND skill_key=? AND suite_id=? AND status='ok' AND mode!='backtest' ORDER BY started_at DESC LIMIT 1").get(req.params.entityId, s.key, s.suiteId);
      return { key: s.key, name: def.name, emoji: def.emoji, suiteId: s.suiteId, latest: last ? { advice: last.advice, at: last.started_at } : null };
    });
    res.json({ skills: out });
  });

  return { SKILL_DEFS, upsertSkill, listForEntity, runSkill, recordFeedback, tick, _internals: { clampBacktestDates, wrapToolsForBacktest, resolvePlaybook, tzNow } };
}

// Per-client skill playbook additions, keyed by entity — the trainable layer,
// surfaced in Admin → AI "Everything the AI is told" (GET /api/admin/ai-overview).
function playbookLayersByEntity(sql) {
  const out = {};
  try {
    for (const s of sql.prepare('SELECT entity_id, skill_key, suite_id, status, autonomy, playbook FROM skills').all()) {
      (out[s.entity_id] = out[s.entity_id] || []).push({ key: s.skill_key, suiteId: s.suite_id, status: s.status, autonomy: s.autonomy, playbook: (s.playbook || '').trim() });
    }
  } catch { /* table appears on first mount */ }
  return out;
}

module.exports = { mount, SKILL_DEFS, TICKETING_SKILL_SYSTEM, TICKETING_DEFAULT_PLAYBOOK, clampBacktestDates, wrapToolsForBacktest, resolvePlaybook, playbookLayersByEntity };
