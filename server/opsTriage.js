// ─── Ops-alert triage agent — disposable module ───────────────────────────────
// SELF-CONTAINED. Turns production ops alerts into product-board tickets so
// nobody has to screenshot #pulse-monitoring (docs/whats-next/
// 2026-07-23__ops-alert-triage-agent.md).
//
// The loop: ops.alert() feeds every occurrence into an `ops_alerts` LEDGER,
// deduped by FINGERPRINT (message with volatile parts — UUIDs, request refs,
// numbers — normalised away, so three "GET /api/journeys/<uuid>/... is not a
// function" alerts are ONE row). A periodic triage pass asks the AI to classify
// each new fingerprint (bug | capacity | billing | config | noise), grounded in
// the server's OWN SOURCE on disk (we grep server/*.js for the route / symbol
// named in the alert and show the model the actual code). Classified bugs are
// auto-filed on the product board (source 'ops', one ticket per fingerprint,
// recurrences bump the row's count); billing/capacity/config verdicts post an
// action line to the ops channel instead — those need a human, not a PR.
//
// Rails: kill switch `ops_triage_enabled`, cadence `ops_triage_cadence_min`
// (default 30), daily auto-ticket cap `ops_triage_daily_cap` (default 5; rows
// that hit the cap park as 'capped' and file first next day, no re-classify).
//
// Phase 2 — auto-dispatch tier (`ops_triage_dispatch`: off | plan | build,
// default 'plan'): a HIGH-CONFIDENCE bug ticket is also sent straight to
// GitHub for Claude. 'plan' asks Claude to comment a diagnosis + plan (no
// code); 'build' lets high-severity + high-confidence bugs go straight to a
// build (everything else still gets plan mode). Auto-dispatch ALWAYS targets
// staging — the existing safety geometry (reporter verification on staging,
// human promote-to-production release train) is untouched; for ops tickets any
// admin stands in as the verifier. Capped at `ops_triage_dispatch_cap`/day
// (default 3), and only ever at filing time — re-dispatch stays human.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { asyncHandler, HttpError } = require('./http');

// ── Fingerprinting ──────────────────────────────────────────────────────────
// Normalise away the parts that vary per occurrence so the same defect always
// lands on the same row. Conservative: identifiers and numbers only.
function normalise(message) {
  return String(message || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\breq_[A-Za-z0-9]{6,}\b/g, '<req>')
    .replace(/\(ref [^)]+\)/g, '(ref <ref>)')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
function fingerprintOf(kind, message) {
  return crypto.createHash('sha1').update(`${kind}|${normalise(message)}`).digest('hex').slice(0, 20);
}

// ── Code grounding ──────────────────────────────────────────────────────────
// The deployed service ships with its own source — so triage can read the code
// an alert points at instead of guessing from the message. Pull greppable
// tokens (API route segments, `x.y is not a function` symbols, quoted strings,
// camelCase identifiers) and return the first few matching snippets.
function tokensFrom(message) {
  const m = String(message || '');
  const t = [];
  const push = (x) => { if (x && x.length >= 4 && !t.includes(x)) t.push(x); };
  for (const sym of m.match(/[\w$]+\.[\w$]+(?= is not a function)/g) || []) { push(sym); push(sym.split('.')[1]); }
  for (const p of m.match(/\/api\/[A-Za-z0-9/_:.-]+/g) || []) {
    for (const seg of p.split('/')) if (/^[a-zA-Z][a-zA-Z-]{3,}$/.test(seg) && seg !== 'api') push(seg);
  }
  for (const q of m.match(/'[^']{6,80}'|"[^"]{6,80}"/g) || []) push(q.slice(1, -1));
  for (const c of m.match(/\b[a-z][a-zA-Z0-9]{5,}[A-Z][a-zA-Z0-9]*\b/g) || []) push(c);
  return t.slice(0, 8);
}
function codeContext(message, srcDir = __dirname) {
  const tokens = tokensFrom(message);
  if (!tokens.length) return '';
  const out = [];
  const seen = new Set();
  let files = [];
  try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')); } catch { return ''; }
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(path.join(srcDir, f), 'utf8')); } catch { cache.set(f, ''); } }
    return cache.get(f);
  };
  for (const tok of tokens) {
    for (const f of files) {
      const src = read(f);
      const idx = src.indexOf(tok);
      if (idx === -1) continue;
      const lines = src.split('\n');
      const at = src.slice(0, idx).split('\n').length - 1;
      const keyLoc = `${f}:${Math.floor(at / 10)}`; // dedupe near-identical hits
      if (seen.has(keyLoc)) continue;
      seen.add(keyLoc);
      const from = Math.max(0, at - 10);
      const snippet = lines.slice(from, at + 12).join('\n').slice(0, 2000);
      out.push(`── ${f} (around line ${at + 1}, matched "${tok}") ──\n${snippet}`);
      if (out.length >= 3) return out.join('\n\n');
      break; // one snippet per token is plenty
    }
  }
  return out.join('\n\n');
}

// ── Triage prompt (exposed via promptRegistry → Admin → AI audit) ───────────
const OPS_TRIAGE_SYSTEM = `You triage production error alerts for Pulse (a Node/Express + SQLite app). You are shown one deduplicated alert (its kind, latest message, occurrence count) and, where found, the ACTUAL server source code the alert points at.

Classify it and respond with ONLY a JSON object (no markdown fences, no prose):
{
  "classification": "bug" | "capacity" | "billing" | "config" | "noise",
  "severity": "low" | "medium" | "high",
  "confidence": "low" | "medium" | "high",
  "title": "",
  "hypothesis": "",
  "opsAction": ""
}

Definitions:
- "bug": a defect in THIS codebase a code change would fix (wrong call, missing export, bad input handling, logic error). Only choose bug when the message or the shown code supports it — be conservative.
- "capacity": load/queue/timeout pressure (a busy upstream, rate limits, slow queries). Not fixable by a one-line code change; needs tuning or scaling.
- "billing": an external service refusing service over credits/quota/payment (e.g. an AI provider's credit balance).
- "config": a missing or wrong setting, key, webhook or environment variable.
- "noise": expected/transient failures not worth a human's time (a client disconnect, a one-off network blip).

Fields:
- "title": a short imperative bug title (max 90 chars), e.g. "Fix listJourneys crash on the Journeys recipes route". Empty unless classification is "bug".
- "hypothesis": for bugs, the most likely root cause and where to look (file/function names from the shown code when possible), 2-5 sentences. For non-bugs, one sentence on what is happening.
- "opsAction": for capacity/billing/config, the concrete action a human should take (top up X, raise env var Y, set webhook Z). Empty for bug/noise.

severity reflects user impact (high = a user-facing feature is broken or all AI calls fail); confidence reflects how sure the evidence makes you. Never invent code that was not shown.`;

function promptRegistry() {
  return [{ key: 'opsTriage', label: 'Ops alert triage', scope: 'Classifies deduplicated production alerts (bug/capacity/billing/config/noise) before auto-filing product-board tickets', text: OPS_TRIAGE_SYSTEM }];
}

// ── Module ──────────────────────────────────────────────────────────────────
function mount(app, { db, auth, insights, adminAnthropicKey, ops, tickets, srcDir }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS ops_alerts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    sample TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    classification TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT '',
    hypothesis TEXT NOT NULL DEFAULT '',
    ops_action TEXT NOT NULL DEFAULT '',
    ticket_id TEXT NOT NULL DEFAULT '',
    triaged_at TEXT NOT NULL DEFAULT ''
  )`);
  // status: 'new' (awaiting triage) → 'ticketed' | 'action' | 'noise' | 'capped'
  // (bug verdict parked on the daily cap) | 'ignored' (human said stop).
  { // add-column migrations (the table already exists on deployed instances)
    const cols = sql.prepare('PRAGMA table_info(ops_alerts)').all().map((c) => c.name);
    if (!cols.includes('dispatch')) sql.exec("ALTER TABLE ops_alerts ADD COLUMN dispatch TEXT NOT NULL DEFAULT ''");          // '' | 'plan' | 'build'
    if (!cols.includes('dispatched_at')) sql.exec("ALTER TABLE ops_alerts ADD COLUMN dispatched_at TEXT NOT NULL DEFAULT ''");
  }

  const now = () => new Date().toISOString();
  const enabled = () => db.getSetting('ops_triage_enabled', '1') !== '0';
  // Numeric setting reader that respects an explicit 0 (`n || dflt` would turn
  // "cap 0 = never" back into the default).
  const numSetting = (key, dflt) => { const raw = String(db.getSetting(key, '') || ''); const n = Number(raw); return raw !== '' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : dflt; };
  const cadenceMin = () => Math.max(5, numSetting('ops_triage_cadence_min', 30));
  const dailyCap = () => numSetting('ops_triage_daily_cap', 5);
  const dispatchTier = () => { const v = db.getSetting('ops_triage_dispatch', 'plan'); return ['off', 'plan', 'build'].includes(v) ? v : 'plan'; };
  const dispatchCap = () => numSetting('ops_triage_dispatch_cap', 3);

  const upsert = sql.prepare(`INSERT INTO ops_alerts (id, kind, pattern, sample, count, first_seen, last_seen)
    VALUES (?,?,?,?,1,?,?)
    ON CONFLICT(id) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, sample = excluded.sample`);

  // Every alert occurrence lands here (ops.alert() listener). Must never throw.
  function record(kind, message) {
    try {
      if (kind === 'triage') return; // never ledger our own failure alerts (loop guard)
      const ts = now();
      upsert.run(fingerprintOf(kind, message), String(kind || '').slice(0, 80), normalise(message), String(message || '').slice(0, 2000), ts, ts);
    } catch (e) { console.error('[opsTriage] record failed:', e.message); }
  }

  async function classify(row) {
    const apiKey = adminAnthropicKey();
    const c = insights.requireClient(apiKey);
    const ctx = codeContext(row.sample, srcDir);
    const user = [
      `ALERT (kind: ${row.kind})`,
      `Occurrences: ${row.count} (first ${row.first_seen}, last ${row.last_seen})`,
      'Latest message:',
      row.sample,
      ctx ? `\nRELEVANT SERVER SOURCE (greppped from the running app's own code):\n${ctx}` : '\n(No matching source snippet found for this message.)',
    ].join('\n');
    const resp = await require('./aiUsage').run({ entityId: null, kind: 'ops_triage' }, () => c.messages.create({
      model: insights.MODEL, max_tokens: 1500, output_config: { effort: 'low' },
      system: insights.systemWith(OPS_TRIAGE_SYSTEM, db.getSetting('ai_instructions')),
      messages: [{ role: 'user', content: user }],
    }));
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const v = await insights.parseModelJsonResilient(c, text, 'alert triage');
    const pick = (val, allowed, dflt) => (allowed.includes(val) ? val : dflt);
    return {
      classification: pick(v.classification, ['bug', 'capacity', 'billing', 'config', 'noise'], 'noise'),
      severity: pick(v.severity, ['low', 'medium', 'high'], 'low'),
      confidence: pick(v.confidence, ['low', 'medium', 'high'], 'low'),
      title: String(v.title || '').slice(0, 120),
      hypothesis: String(v.hypothesis || '').slice(0, 4000),
      opsAction: String(v.opsAction || '').slice(0, 1000),
    };
  }

  const ticketsFiledToday = () =>
    sql.prepare("SELECT COUNT(*) AS n FROM ops_alerts WHERE ticket_id != '' AND substr(triaged_at, 1, 10) = ?").get(now().slice(0, 10)).n;

  // The agent's identity on the board — reporter fields come from this, so ops
  // tickets are unmistakably machine-filed (and filterable by source 'ops').
  const OPS_REPORTER = { id: 'ops-triage-agent', email: 'ops-triage@pulse.internal', name: 'Pulse Ops Agent', role: 'admin', entityIds: [] };

  function fileTicket(row, v) {
    // The spec doubles as the Claude build brief (claudeBrief() leads with
    // ai_summary), so it carries the full diagnosis: raw alert, occurrence
    // pattern, and the code-grounded hypothesis — a dispatched build starts
    // from the diagnosis, not the bare error message.
    const spec = [
      `**Production ops alert (auto-filed by the triage agent).**`,
      '',
      `- **Alert kind:** ${row.kind}`,
      `- **Latest message:** ${row.sample}`,
      `- **Occurrences:** ${row.count} (first ${row.first_seen}, last ${row.last_seen})`,
      `- **Triage verdict:** bug — severity ${v.severity}, confidence ${v.confidence}`,
      '',
      '**Root-cause hypothesis (AI triage, grounded in the server source):**',
      '',
      v.hypothesis || '(none)',
      '',
      '**Acceptance criteria:** the alert stops recurring — fix the root cause (verify the hypothesis first; it is a strong lead, not gospel) and add a regression test that pins the fix.',
    ].join('\n');
    const t = tickets.createTicket({
      user: OPS_REPORTER, type: 'bug', source: 'ops',
      title: v.title || `[ops] ${row.pattern.slice(0, 120)}`,
      body: spec, screen: 'ops-alert',
      urgency: v.severity === 'high' ? 'high' : 'normal',
      aiTitle: v.title, aiSummary: spec, // pre-drafted — skips the background draft
    });
    return t;
  }

  // Phase 2: auto-dispatch a just-filed HIGH-CONFIDENCE bug ticket to Claude on
  // GitHub. Tier 'plan' → Claude comments a plan and waits for a human
  // "@claude go ahead"; tier 'build' → high-severity bugs go straight to a
  // build (the rest still plan). Always targets STAGING; capped per day; only
  // ever called at filing time (no auto-redispatch). Fail-soft: a dispatch
  // error leaves a normal inbox ticket, exactly as if the tier were off.
  const dispatchedToday = () =>
    sql.prepare("SELECT COUNT(*) AS n FROM ops_alerts WHERE dispatch != '' AND substr(dispatched_at, 1, 10) = ?").get(now().slice(0, 10)).n;
  async function maybeDispatch(row, v, ticketId) {
    const tier = dispatchTier();
    if (tier === 'off' || v.confidence !== 'high') return '';
    if (dispatchedToday() >= dispatchCap()) return '';
    const mode = tier === 'build' && v.severity === 'high' ? 'build' : 'plan';
    try {
      const r = await tickets.sendTicketToGitHub(ticketId, { mode, target: 'staging', actorEmail: OPS_REPORTER.email });
      if (!r || !r.issue) return ''; // GitHub not configured / already linked — nothing dispatched
      sql.prepare('UPDATE ops_alerts SET dispatch = ?, dispatched_at = ? WHERE id = ?').run(mode, now(), row.id);
      ops.notify(`🤖 [pulse:triage] Auto-dispatched to Claude in ${mode.toUpperCase()} mode (staging): ${r.issue.url}`);
      return mode;
    } catch (e) { console.error('[opsTriage] auto-dispatch failed:', e.message); return ''; }
  }

  // One triage pass: classify up to `batch` fingerprints, file bug tickets up
  // to the daily cap ('capped' rows file FIRST, without re-classifying).
  async function runPass({ force = false, batch = 5 } = {}) {
    if (!enabled() && !force) return { skipped: 'disabled' };
    if (!insights.isConfigured(adminAnthropicKey())) return { skipped: 'ai-not-configured' };
    const out = { classified: 0, ticketed: 0, dispatched: 0, actions: 0, noise: 0, capped: 0 };

    // Yesterday's cap parkings first — verdict already stored, no AI needed.
    for (const row of sql.prepare("SELECT * FROM ops_alerts WHERE status = 'capped' ORDER BY last_seen DESC").all()) {
      if (ticketsFiledToday() >= dailyCap()) break;
      const stored = { title: row.pattern.slice(0, 120), hypothesis: row.hypothesis, severity: row.severity, confidence: row.confidence };
      const t = fileTicket(row, stored);
      sql.prepare("UPDATE ops_alerts SET status = 'ticketed', ticket_id = ?, triaged_at = ? WHERE id = ?").run(t.id, now(), row.id);
      ops.notify(`🎫 [pulse:triage] Filed parked bug ticket "${row.pattern.slice(0, 90)}" → board ticket ${t.id}`);
      out.ticketed += 1;
      out.dispatched += (await maybeDispatch(row, stored, t.id)) ? 1 : 0;
    }

    const fresh = sql.prepare("SELECT * FROM ops_alerts WHERE status = 'new' ORDER BY last_seen DESC LIMIT ?").all(batch);
    for (const row of fresh) {
      let v;
      try { v = await classify(row); } catch (e) {
        console.error('[opsTriage] classify failed:', e.message);
        continue; // stays 'new' — retried next pass
      }
      out.classified += 1;
      const stamp = { c: v.classification, s: v.severity, cf: v.confidence };
      const base = "UPDATE ops_alerts SET classification = ?, severity = ?, confidence = ?, hypothesis = ?, ops_action = ?, triaged_at = ?, status = ?";
      if (v.classification === 'bug') {
        if (ticketsFiledToday() >= dailyCap()) {
          sql.prepare(`${base} WHERE id = ?`).run(stamp.c, stamp.s, stamp.cf, v.hypothesis, v.opsAction, now(), 'capped', row.id);
          out.capped += 1;
        } else {
          const t = fileTicket(row, v);
          sql.prepare(`${base}, ticket_id = ? WHERE id = ?`).run(stamp.c, stamp.s, stamp.cf, v.hypothesis, v.opsAction, now(), 'ticketed', t.id, row.id);
          ops.notify(`🎫 [pulse:triage] Bug (${v.severity}/${v.confidence}): "${v.title}" — filed on the product board (${row.count}× seen). Ticket ${t.id}`);
          out.ticketed += 1;
          out.dispatched += (await maybeDispatch(row, v, t.id)) ? 1 : 0;
        }
      } else if (v.classification === 'noise') {
        sql.prepare(`${base} WHERE id = ?`).run(stamp.c, stamp.s, stamp.cf, v.hypothesis, v.opsAction, now(), 'noise', row.id);
        out.noise += 1;
      } else {
        sql.prepare(`${base} WHERE id = ?`).run(stamp.c, stamp.s, stamp.cf, v.hypothesis, v.opsAction, now(), 'action', row.id);
        ops.notify(`🛠 [pulse:triage] ${v.classification} (${v.severity}) — ${row.kind}: ${v.opsAction || v.hypothesis} (${row.count}× seen; not a code bug, no ticket filed)`);
        out.actions += 1;
      }
    }
    db.setSetting('ops_triage_last_run', now());
    return out;
  }

  // Cadence tick — piggybacks a light interval; unref'd so it never holds the
  // process open. Fire-and-forget: a failed pass logs and retries next tick.
  const due = () => {
    const last = db.getSetting('ops_triage_last_run', '');
    return !last || Date.now() - Date.parse(last) >= cadenceMin() * 60_000;
  };
  const timer = setInterval(() => {
    if (!enabled() || !due()) return;
    runPass().catch((e) => console.error('[opsTriage] pass failed:', e.message));
  }, 5 * 60_000);
  if (timer.unref) timer.unref();

  ops.onAlert(record); // subscribe the ledger to every alert occurrence

  // ── Admin routes (internal tooling — the board is the UI; these power a
  // future ledger view + manual control) ─────────────────────────────────────
  app.get('/api/admin/ops-alerts', auth.requireAdmin, (_req, res) => {
    const alerts = sql.prepare('SELECT * FROM ops_alerts ORDER BY last_seen DESC LIMIT 200').all();
    res.json({ enabled: enabled(), cadenceMin: cadenceMin(), dailyCap: dailyCap(), filedToday: ticketsFiledToday(), dispatchTier: dispatchTier(), dispatchCap: dispatchCap(), dispatchedToday: dispatchedToday(), alerts });
  });
  app.post('/api/admin/ops-alerts/run', auth.requireAdmin, asyncHandler(async (_req, res) => {
    res.json(await runPass({ force: true }));
  }));
  app.post('/api/admin/ops-alerts/:id/ignore', auth.requireAdmin, (req, res) => {
    const r = sql.prepare("UPDATE ops_alerts SET status = 'ignored' WHERE id = ?").run(req.params.id);
    if (!r.changes) throw new HttpError(404, 'Alert not found');
    res.json({ ok: true });
  });
  app.post('/api/admin/ops-alerts/:id/reopen', auth.requireAdmin, (req, res) => {
    const r = sql.prepare("UPDATE ops_alerts SET status = 'new', ticket_id = '' WHERE id = ?").run(req.params.id);
    if (!r.changes) throw new HttpError(404, 'Alert not found');
    res.json({ ok: true });
  });

  return { record, runPass, fingerprintOf, normalise };
}

module.exports = { mount, promptRegistry, fingerprintOf, normalise, tokensFrom, codeContext, OPS_TRIAGE_SYSTEM };
