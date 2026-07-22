// ─── Training — practical exams taken INSIDE Pulse ────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `training_exams` +
// `training_attempts` tables and every /api/*/training route. Mounted from
// index.js with injected deps; remove that line + this file to uninstall.
//
// The idea: sales & client-services training ends with a PRACTICAL exam where
// trainees drive the real system, not a quiz about it. A trainer builds an exam
// from a catalog of auto-verifiable tasks and points it at a SANDBOX client.
// Each trainee gets a personal exam code (e.g. PX-7Q2M) and must complete real
// work in Pulse — create a segment, draft & submit a campaign, set a goal, build
// a dashboard… — naming everything with their code. "Check my work" then greps
// the live database for evidence of each task and grades automatically: the
// exam marker is the system state itself, so there is nothing to hand-mark.
//
// Trainees are Howler staff (admin logins), so every route is requireAdmin; the
// trainee surface additionally matches attempts to the logged-in email.
const crypto = require('crypto');
const { asyncHandler, HttpError } = require('./http');

// Personal exam codes: unambiguous alphabet (no 0/O/1/I) so they survive being
// typed into names by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  const b = crypto.randomBytes(4);
  return `PX-${[...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('')}`;
}

// ── The task catalog ──────────────────────────────────────────────────────────
// Each task: what the trainee is told to do (brief, with {CODE} substituted per
// attempt) and a deterministic SQL check that finds the evidence. Checks match
// the exam code in object names (SQLite LIKE is case-insensitive), scoped to the
// exam's sandbox client wherever the table carries an entity. No Looker, no AI —
// grading is instant and identical for everyone.
const TASK_CATALOG = [
  {
    key: 'suite_create', area: 'Setup', emoji: '🗓️', points: 10,
    title: 'Create an event suite',
    brief: "In Admin → Clients → the sandbox client → Suites, create a new event suite named '{CODE} …' and attach at least one dashboard set to it.",
    check({ sql, entityId, like }) {
      const s = sql.prepare('SELECT * FROM suites WHERE entity_id=? AND name LIKE ?').get(entityId, like);
      if (!s) return { done: false };
      const sets = sql.prepare('SELECT COUNT(*) c FROM suite_sets WHERE suite_id=?').get(s.id).c;
      if (!sets) return { done: false, evidence: `Suite “${s.name}” exists but has no dashboard sets attached yet` };
      return { done: true, evidence: `Suite “${s.name}” with ${sets} set(s) attached` };
    },
  },
  {
    key: 'login_create', area: 'Setup', emoji: '🧑', points: 10,
    title: 'Create a client login',
    brief: "In the sandbox client's Logins, create a client login whose EMAIL contains your exam code (e.g. {code}@exam.howler.co.za), assigned to the sandbox client with a sensible role.",
    check({ sql, entityId, like }) {
      const u = sql.prepare('SELECT u.email FROM users u JOIN user_entities ue ON ue.user_id=u.id WHERE ue.entity_id=? AND u.email LIKE ?').get(entityId, like);
      return u ? { done: true, evidence: `Login ${u.email} assigned to the sandbox client` } : { done: false };
    },
  },
  {
    key: 'dashboard_build', area: 'Insight', emoji: '📊', points: 15,
    title: 'Build a dashboard',
    brief: "From the dashboard studio, create a new dashboard titled '{CODE} …' with at least 2 tiles on it.",
    check({ sql, like }) {
      for (const r of sql.prepare('SELECT title, def FROM dashboards WHERE title LIKE ?').all(like)) {
        let tiles = 0; try { tiles = (JSON.parse(r.def || '{}').tiles || []).length; } catch { /* unreadable def */ }
        if (tiles >= 2) return { done: true, evidence: `Dashboard “${r.title}” with ${tiles} tiles` };
        return { done: false, evidence: `Dashboard “${r.title}” exists but has ${tiles} tile(s) — it needs at least 2` };
      }
      return { done: false };
    },
  },
  {
    key: 'segment_create', area: 'Engage', emoji: '👥', points: 10,
    title: 'Create a segment',
    brief: "In Engage → Segments for the sandbox client, create a reusable segment named '{CODE} …' from any source (a dashboard tile or a pasted list).",
    check({ sql, entityId, like }) {
      const s = sql.prepare('SELECT name, source, last_count FROM segments WHERE entity_id=? AND name LIKE ?').get(entityId, like);
      return s ? { done: true, evidence: `Segment “${s.name}” (source: ${s.source}${s.last_count >= 0 ? `, ${s.last_count} people` : ''})` } : { done: false };
    },
  },
  {
    key: 'campaign_draft', area: 'Engage', emoji: '✉️', points: 15,
    title: 'Draft an email campaign',
    brief: "In Engage → Campaigns, draft an EMAIL campaign titled '{CODE} …' with a subject line and body copy, targeting any audience. Leave it as a draft or submit it — do NOT send.",
    check({ sql, entityId, like }) {
      const a = sql.prepare('SELECT title, status, config FROM actions WHERE entity_id=? AND title LIKE ?').get(entityId, like);
      if (!a) return { done: false };
      let cfg = {}; try { cfg = JSON.parse(a.config || '{}'); } catch { /* unreadable */ }
      const subject = cfg.subject || (Array.isArray(cfg.steps) && cfg.steps[0] && cfg.steps[0].subject) || '';
      const body = cfg.body || cfg.customHtml || (Array.isArray(cfg.steps) && cfg.steps[0] && cfg.steps[0].body) || '';
      if (!subject) return { done: false, evidence: `Campaign “${a.title}” exists but has no subject line yet` };
      if (!body) return { done: false, evidence: `Campaign “${a.title}” exists but has no body copy yet` };
      return { done: true, evidence: `Campaign “${a.title}” — subject “${String(subject).slice(0, 60)}”` };
    },
  },
  {
    key: 'campaign_submit', area: 'Engage', emoji: '✅', points: 10,
    title: 'Submit the campaign for approval',
    brief: "Add at least one approver to your '{CODE}' campaign and submit it for approval (its status becomes 'awaiting approval'). Do NOT approve or send it.",
    check({ sql, entityId, like }) {
      const a = sql.prepare('SELECT title, status, config FROM actions WHERE entity_id=? AND title LIKE ?').get(entityId, like);
      if (!a) return { done: false };
      if (a.status === 'draft') return { done: false, evidence: `Campaign “${a.title}” is still a draft — submit it for approval` };
      let approvers = 0; try { approvers = (JSON.parse(a.config || '{}').approvers || []).length; } catch { /* unreadable */ }
      return { done: true, evidence: `Campaign “${a.title}” is ${a.status === 'pending' ? 'awaiting approval' : a.status}${approvers ? ` (${approvers} approver(s))` : ''}` };
    },
  },
  {
    key: 'goal_create', area: 'Results', emoji: '🎯', points: 10,
    title: 'Set an event goal',
    brief: "In Goals for the sandbox client's event, create a goal named '{CODE} …' with a numeric target (and ideally a by-date).",
    check({ sql, entityId, like }) {
      const g = sql.prepare('SELECT name, target_value, unit, by_date FROM goals WHERE entity_id=? AND name LIKE ?').get(entityId, like);
      if (!g) return { done: false };
      if (!(g.target_value > 0)) return { done: false, evidence: `Goal “${g.name}” exists but has no numeric target` };
      return { done: true, evidence: `Goal “${g.name}” — target ${g.target_value}${g.unit ? ` ${g.unit}` : ''}${g.by_date ? ` by ${g.by_date}` : ''}` };
    },
  },
  {
    key: 'alert_create', area: 'Results', emoji: '🚨', points: 10,
    title: 'Create a metric alert',
    brief: "Create an alert named '{CODE} …' on any tile or metric, with a threshold and at least one delivery channel.",
    check({ sql, entityId, like }) {
      const a = sql.prepare('SELECT name, rule_type, threshold, channels FROM alerts WHERE entity_id=? AND name LIKE ?').get(entityId, like);
      if (!a) return { done: false };
      let channels = []; try { channels = JSON.parse(a.channels || '[]'); } catch { /* unreadable */ }
      if (!channels.length) return { done: false, evidence: `Alert “${a.name}” exists but has no delivery channel` };
      if (a.rule_type === 'threshold' && !(a.threshold > 0)) return { done: false, evidence: `Alert “${a.name}” exists but its threshold is not set` };
      return { done: true, evidence: `Alert “${a.name}” (${a.rule_type}${a.rule_type === 'threshold' ? ` at ${a.threshold}` : ''}, via ${channels.join('+')})` };
    },
  },
  {
    key: 'digest_schedule', area: 'Comms', emoji: '📬', points: 10,
    title: 'Schedule a digest',
    brief: "In Digests for the sandbox client, schedule a digest titled '{CODE} …' with at least one email recipient.",
    check({ sql, entityId, like }) {
      const j = sql.prepare("SELECT title, cadence, recipients FROM scheduled_jobs WHERE entity_id=? AND type='digest' AND title LIKE ?").get(entityId, like);
      if (!j) return { done: false };
      let rec = []; try { rec = JSON.parse(j.recipients || '[]'); } catch { /* unreadable */ }
      if (!rec.length) return { done: false, evidence: `Digest “${j.title}” exists but has no recipients` };
      return { done: true, evidence: `Digest “${j.title}” (${j.cadence}, ${rec.length} recipient(s))` };
    },
  },
  {
    key: 'inbox_thread', area: 'Comms', emoji: '💬', points: 10,
    title: 'Start an inbox conversation',
    brief: "In the Inbox, start a new thread to the sandbox client titled '{CODE} …' and send a first message of at least 20 characters.",
    check({ sql, entityId, like }) {
      const t = sql.prepare('SELECT id, title FROM os_threads WHERE entity_id=? AND title LIKE ?').get(entityId, like);
      if (!t) return { done: false };
      const m = sql.prepare('SELECT COUNT(*) c FROM os_messages WHERE thread_id=? AND LENGTH(body)>=20').get(t.id).c;
      if (!m) return { done: false, evidence: `Thread “${t.title}” exists but has no proper first message yet` };
      return { done: true, evidence: `Thread “${t.title}” with ${m} message(s)` };
    },
  },
];
const TASKS_BY_KEY = Object.fromEntries(TASK_CATALOG.map((t) => [t.key, t]));

// Personalize a task brief for one attempt's code.
const briefFor = (task, code) => task.brief.replaceAll('{CODE}', code).replaceAll('{code}', code.toLowerCase());

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS training_exams (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      entity_id      TEXT NOT NULL,                 -- the SANDBOX client the exam runs against
      task_keys      TEXT NOT NULL DEFAULT '[]',
      pass_pct       INTEGER NOT NULL DEFAULT 70,
      time_limit_min INTEGER NOT NULL DEFAULT 0,    -- 0 = untimed
      notes          TEXT NOT NULL DEFAULT '',      -- briefing shown to trainees
      status         TEXT NOT NULL DEFAULT 'open',  -- open | closed
      created_by     TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS training_attempts (
      id            TEXT PRIMARY KEY,
      exam_id       TEXT NOT NULL,
      trainee_email TEXT NOT NULL,
      trainee_name  TEXT NOT NULL DEFAULT '',
      code          TEXT NOT NULL,                  -- personal exam code (PX-XXXX)
      status        TEXT NOT NULL DEFAULT 'assigned', -- assigned | in_progress | passed | failed
      task_state    TEXT NOT NULL DEFAULT '{}',     -- {taskKey: {done, evidence, at}}
      score_pct     INTEGER NOT NULL DEFAULT -1,    -- -1 until submitted
      started_at    TEXT NOT NULL DEFAULT '',
      finished_at   TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_attempts_exam ON training_attempts(exam_id);
    CREATE INDEX IF NOT EXISTS idx_training_attempts_email ON training_attempts(trainee_email);
  `);

  const rowToExam = (r) => r && ({
    id: r.id, title: r.title, entityId: r.entity_id, taskKeys: JSON.parse(r.task_keys || '[]'),
    passPct: r.pass_pct, timeLimitMin: r.time_limit_min, notes: r.notes, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const rowToAttempt = (r) => r && ({
    id: r.id, examId: r.exam_id, traineeEmail: r.trainee_email, traineeName: r.trainee_name,
    code: r.code, status: r.status, taskState: JSON.parse(r.task_state || '{}'),
    scorePct: r.score_pct, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at,
  });

  // A check can reference a table owned by a module that isn't mounted (tests,
  // partial installs). Treat that as "no evidence", never a crash.
  function runCheck(task, ctx) {
    try { return task.check(ctx) || { done: false }; }
    catch { return { done: false, evidence: '' }; }
  }

  function createExam({ title, entityId, taskKeys, passPct, timeLimitMin, notes, createdBy }) {
    if (!String(title || '').trim()) throw new HttpError(400, 'A title is required');
    if (!db.getEntity(entityId)) throw new HttpError(400, 'Pick the sandbox client the exam runs against');
    const keys = (Array.isArray(taskKeys) ? taskKeys : []).filter((k) => TASKS_BY_KEY[k]);
    if (!keys.length) throw new HttpError(400, 'Pick at least one task');
    const id = uuid(); const t = now();
    sql.prepare('INSERT INTO training_exams (id, title, entity_id, task_keys, pass_pct, time_limit_min, notes, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(title).trim(), entityId, JSON.stringify(keys),
        Math.min(100, Math.max(1, passPct | 0 || 70)), Math.max(0, timeLimitMin | 0),
        String(notes || ''), 'open', String(createdBy || ''), t, t);
    return rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(id));
  }

  function updateExam(id, patch = {}) {
    const cur = sql.prepare('SELECT * FROM training_exams WHERE id=?').get(id);
    if (!cur) throw new HttpError(404, 'No such exam');
    const keys = Array.isArray(patch.taskKeys) ? patch.taskKeys.filter((k) => TASKS_BY_KEY[k]) : null;
    sql.prepare('UPDATE training_exams SET title=?, task_keys=?, pass_pct=?, time_limit_min=?, notes=?, status=?, updated_at=? WHERE id=?')
      .run(patch.title != null ? String(patch.title).trim() || cur.title : cur.title,
        keys && keys.length ? JSON.stringify(keys) : cur.task_keys,
        patch.passPct != null ? Math.min(100, Math.max(1, patch.passPct | 0)) : cur.pass_pct,
        patch.timeLimitMin != null ? Math.max(0, patch.timeLimitMin | 0) : cur.time_limit_min,
        patch.notes != null ? String(patch.notes) : cur.notes,
        ['open', 'closed'].includes(patch.status) ? patch.status : cur.status,
        now(), id);
    return rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(id));
  }

  function addAttempts(examId, trainees = []) {
    const exam = sql.prepare('SELECT * FROM training_exams WHERE id=?').get(examId);
    if (!exam) throw new HttpError(404, 'No such exam');
    const out = [];
    for (const t of trainees) {
      const email = String((t && t.email) || '').trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      if (sql.prepare('SELECT 1 FROM training_attempts WHERE exam_id=? AND trainee_email=?').get(examId, email)) continue;
      const id = uuid();
      sql.prepare('INSERT INTO training_attempts (id, exam_id, trainee_email, trainee_name, code, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, examId, email, String((t && t.name) || '').trim(), makeCode(), now());
      out.push(rowToAttempt(sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(id)));
    }
    return out;
  }

  // Run every task check for one attempt and persist the evidence. Pure reads —
  // safe to run as often as the trainee clicks "Check my work".
  function runChecks(attemptId) {
    const a = sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(attemptId);
    if (!a) throw new HttpError(404, 'No such attempt');
    const exam = rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(a.exam_id));
    if (!exam) throw new HttpError(404, 'No such exam');
    const prev = JSON.parse(a.task_state || '{}');
    const ctx = { sql, db, entityId: exam.entityId, code: a.code, like: `%${a.code}%`, email: a.trainee_email };
    const state = {};
    for (const key of exam.taskKeys) {
      const res = runCheck(TASKS_BY_KEY[key], ctx);
      state[key] = { done: !!res.done, evidence: res.evidence || '', at: res.done ? ((prev[key] && prev[key].done && prev[key].at) || now()) : '' };
    }
    sql.prepare('UPDATE training_attempts SET task_state=? WHERE id=?').run(JSON.stringify(state), attemptId);
    return { exam, attempt: rowToAttempt(sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(attemptId)) };
  }

  const scoreOf = (exam, taskState) => {
    const total = exam.taskKeys.reduce((s, k) => s + (TASKS_BY_KEY[k].points || 0), 0);
    const got = exam.taskKeys.reduce((s, k) => s + ((taskState[k] && taskState[k].done) ? (TASKS_BY_KEY[k].points || 0) : 0), 0);
    return total ? Math.round((got / total) * 100) : 0;
  };

  function startAttempt(attemptId) {
    const a = sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(attemptId);
    if (!a) throw new HttpError(404, 'No such attempt');
    if (a.status === 'assigned') sql.prepare("UPDATE training_attempts SET status='in_progress', started_at=? WHERE id=?").run(now(), attemptId);
    return rowToAttempt(sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(attemptId));
  }

  // Submit = one final fresh check, then lock in the score against the pass mark.
  function submitAttempt(attemptId) {
    const { exam, attempt } = runChecks(attemptId);
    if (['passed', 'failed'].includes(attempt.status)) throw new HttpError(400, 'This attempt is already submitted');
    const pct = scoreOf(exam, attempt.taskState);
    const status = pct >= exam.passPct ? 'passed' : 'failed';
    sql.prepare('UPDATE training_attempts SET status=?, score_pct=?, finished_at=? WHERE id=?').run(status, pct, now(), attemptId);
    return rowToAttempt(sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(attemptId));
  }

  // The trainee-facing shape: exam + personalized tasks + live progress. Late is
  // computed on the fly against the time limit — informational, never a lockout.
  function attemptView(attempt, exam) {
    const entity = db.getEntity(exam.entityId);
    const deadline = attempt.startedAt && exam.timeLimitMin
      ? new Date(new Date(attempt.startedAt).getTime() + exam.timeLimitMin * 60000).toISOString() : '';
    return {
      id: attempt.id, code: attempt.code, status: attempt.status, scorePct: attempt.scorePct,
      startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, deadline,
      late: !!(deadline && (attempt.finishedAt || now()) > deadline),
      progressPct: scoreOf(exam, attempt.taskState),
      exam: {
        id: exam.id, title: exam.title, notes: exam.notes, passPct: exam.passPct,
        timeLimitMin: exam.timeLimitMin, status: exam.status,
        entityId: exam.entityId, entityName: (entity && entity.name) || '',
      },
      tasks: exam.taskKeys.map((k) => {
        const t = TASKS_BY_KEY[k]; const s = attempt.taskState[k] || {};
        return { key: k, area: t.area, emoji: t.emoji, title: t.title, points: t.points, brief: briefFor(t, attempt.code), done: !!s.done, evidence: s.evidence || '', at: s.at || '' };
      }),
    };
  }

  // ── Trainer surface (Admin → Training) ──────────────────────────────────────
  app.get('/api/admin/training/catalog', auth.requireAdmin, (_req, res) => {
    res.json({ tasks: TASK_CATALOG.map((t) => ({ key: t.key, area: t.area, emoji: t.emoji, title: t.title, points: t.points, brief: t.brief })) });
  });
  app.get('/api/admin/training/exams', auth.requireAdmin, (_req, res) => {
    const exams = sql.prepare('SELECT * FROM training_exams ORDER BY created_at DESC').all().map(rowToExam);
    const counts = Object.fromEntries(sql.prepare('SELECT exam_id, COUNT(*) c FROM training_attempts GROUP BY exam_id').all().map((r) => [r.exam_id, r.c]));
    res.json({ exams: exams.map((e) => ({ ...e, entityName: (db.getEntity(e.entityId) || {}).name || '', attempts: counts[e.id] || 0 })) });
  });
  app.post('/api/admin/training/exams', auth.requireAdmin, (req, res) => {
    res.json({ exam: createExam({ ...(req.body || {}), createdBy: req.user.email }) });
  });
  app.put('/api/admin/training/exams/:id', auth.requireAdmin, (req, res) => {
    res.json({ exam: updateExam(req.params.id, req.body || {}) });
  });
  app.delete('/api/admin/training/exams/:id', auth.requireAdmin, (req, res) => {
    sql.prepare('DELETE FROM training_attempts WHERE exam_id=?').run(req.params.id);
    sql.prepare('DELETE FROM training_exams WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/training/exams/:id/attempts', auth.requireAdmin, (req, res) => {
    res.json({ attempts: addAttempts(req.params.id, (req.body || {}).trainees || []) });
  });
  app.delete('/api/admin/training/attempts/:id', auth.requireAdmin, (req, res) => {
    sql.prepare('DELETE FROM training_attempts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  // The results board: every attempt with live-rechecked evidence per task.
  app.get('/api/admin/training/exams/:id/results', auth.requireAdmin, asyncHandler(async (req, res) => {
    const exam = rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(req.params.id));
    if (!exam) throw new HttpError(404, 'No such exam');
    const attempts = sql.prepare('SELECT * FROM training_attempts WHERE exam_id=? ORDER BY created_at').all(req.params.id)
      .map((r) => attemptView(runChecks(r.id).attempt, exam));
    res.json({ exam: { ...exam, entityName: (db.getEntity(exam.entityId) || {}).name || '' }, attempts, trainees: sql.prepare('SELECT id, trainee_email, trainee_name, code FROM training_attempts WHERE exam_id=? ORDER BY created_at').all(req.params.id).map((r) => ({ id: r.id, email: r.trainee_email, name: r.trainee_name, code: r.code })) });
  }));

  // ── Trainee surface ("My exams") ────────────────────────────────────────────
  const myAttempt = (req) => {
    const a = sql.prepare('SELECT * FROM training_attempts WHERE id=?').get(req.params.id);
    if (!a) throw new HttpError(404, 'No such attempt');
    if (a.trainee_email !== String(req.user.email || '').toLowerCase()) throw new HttpError(403, 'Not your exam');
    return a;
  };
  app.get('/api/training/my', auth.requireAdmin, (req, res) => {
    const rows = sql.prepare('SELECT * FROM training_attempts WHERE trainee_email=? ORDER BY created_at DESC').all(String(req.user.email || '').toLowerCase());
    const out = [];
    for (const r of rows) {
      const exam = rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(r.exam_id));
      if (exam) out.push(attemptView(rowToAttempt(r), exam));
    }
    res.json({ attempts: out });
  });
  app.post('/api/training/my/:id/start', auth.requireAdmin, (req, res) => {
    const a = myAttempt(req);
    const exam = rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(a.exam_id));
    if (exam.status !== 'open') throw new HttpError(400, 'This exam is closed');
    res.json({ attempt: attemptView(startAttempt(a.id), exam) });
  });
  app.post('/api/training/my/:id/check', auth.requireAdmin, (req, res) => {
    const a = myAttempt(req);
    const { exam, attempt } = runChecks(a.id);
    res.json({ attempt: attemptView(attempt, exam) });
  });
  app.post('/api/training/my/:id/submit', auth.requireAdmin, (req, res) => {
    const a = myAttempt(req);
    if (a.status === 'assigned') throw new HttpError(400, 'Start the exam first');
    const attempt = submitAttempt(a.id);
    const exam = rowToExam(sql.prepare('SELECT * FROM training_exams WHERE id=?').get(a.exam_id));
    res.json({ attempt: attemptView(attempt, exam) });
  });

  return { TASK_CATALOG, createExam, updateExam, addAttempts, runChecks, startAttempt, submitAttempt, attemptView, scoreOf, _internals: { makeCode, briefFor } };
}

module.exports = { mount, TASK_CATALOG, makeCode, briefFor };
