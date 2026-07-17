// ─── Surveys: post-event fan feedback (Pulse ⇄ Howler app) ───────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `surveys` + `survey_responses` tables
// and every survey route. Mounted from index.js with one line + injected deps
// ({ db, auth, rateLimit }). Contract: docs/specs/SURVEY_CONTRACT.md (v1, doc rev
// v1.1) — an IDENTICAL copy lives in the Howler app repo and the app's wire-format
// tests are locked to the contract's examples, so the public JSON shapes here must
// not drift from that document.
//
// Three surfaces:
//   • PUBLIC app-facing (/api/app/surveys...) — NO auth (a fan's phone can't hold a
//     secret); protected by rate limits + strict validation + size caps. Fans only
//     ever see LIVE surveys inside their open window.
//   • Admin (/api/admin/entities/:id/surveys...) — Howler staff manage any client's.
//   • Client self-service (/api/my/surveys...) — entity-scoped via the existing
//     campaigns permissions (surveys live in Engage next to campaigns):
//     campaigns.view → see surveys + results, campaigns.approve → create/edit/publish.
//
// Lifecycle: draft → live → closed. PUBLISHED SURVEYS ARE IMMUTABLE (answers
// reference option positions): content edits are draft-only; a live survey only
// allows extending/curtailing `closesAt`; to change questions, close + duplicate +
// republish. Responses upsert per (survey_id, howler_user_id) — resubmit replaces.
// Option text is SNAPSHOTTED onto each stored answer at write time so results stay
// readable even if a survey row were ever hand-edited.
//
// Global kill switch: settings key `surveys_enabled` ('0' → public routes 404).
// TO REMOVE: delete this file + its mount line in index.js, drop the two tables.

const crypto = require('crypto');
const { HttpError } = require('./http');
const flags = require('./flags'); // per-client gate: engage.surveys (default OFF, beta)

const QUESTION_TYPES = ['rating', 'single_choice', 'multiple_choice', 'text'];
const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice']);
const LAYOUTS = ['form', 'cards'];
const STATUSES = ['draft', 'live', 'closed'];
const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;
const MAX_TEXT_ANSWER = 1000; // per contract §2
const MAX_BODY_CHARS = 64_000; // serialized response payload cap

const rid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('base64url')}`;
const nowIso = () => new Date().toISOString();
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ── Validation (shared by admin + my routes) ──────────────────────────────────

// Normalize + validate a questions array per contract §2. Draft saves allow an
// empty list (work in progress); publish requires ≥1 (enforced at publish time).
function normalizeQuestions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'questions must be an array');
  if (raw.length > MAX_QUESTIONS) throw new HttpError(400, `A survey is capped at ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  return raw.map((q, i) => {
    if (!q || typeof q !== 'object') throw new HttpError(400, `Question ${i + 1} is invalid`);
    const type = String(q.type || '');
    if (!QUESTION_TYPES.includes(type)) throw new HttpError(400, `Question ${i + 1}: type must be one of ${QUESTION_TYPES.join(', ')}`);
    const text = str(q.text, 500);
    if (!text) throw new HttpError(400, `Question ${i + 1}: text is required`);
    let id = str(q.id, 60).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) id = `q_${i + 1}`;
    if (seen.has(id)) throw new HttpError(400, `Duplicate question id "${id}"`);
    seen.add(id);
    const out = { id, type, text, required: q.required === true };
    if (CHOICE_TYPES.has(type)) {
      const options = Array.isArray(q.options) ? q.options.map((o) => str(o, 120)).filter(Boolean) : [];
      if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
        throw new HttpError(400, `Question ${i + 1}: choice questions need ${MIN_OPTIONS}–${MAX_OPTIONS} options`);
      }
      out.options = options;
    } else if (q.options != null && Array.isArray(q.options) && q.options.length) {
      throw new HttpError(400, `Question ${i + 1}: ${type} questions must not have options`);
    }
    return out;
  });
}

// Validate the editable survey fields (create + draft edit). Returns a clean patch.
function normalizeSurveyFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) {
    out.title = str(body.title, 200);
    if (!out.title) throw new HttpError(400, 'title is required');
  }
  if (!partial || has('eventId')) {
    out.event_id = str(body.eventId, 32);
    if (!/^[0-9]{1,32}$/.test(out.event_id)) throw new HttpError(400, 'eventId must be the numeric Howler event id');
  }
  if (has('eventName')) out.event_name = str(body.eventName, 200);
  if (has('description')) out.description = str(body.description, 1000);
  if (has('suiteId')) out.suite_id = str(body.suiteId, 60);
  if (has('layout')) {
    out.layout = String(body.layout || 'form');
    if (!LAYOUTS.includes(out.layout)) throw new HttpError(400, `layout must be ${LAYOUTS.join(' or ')}`);
  }
  for (const k of ['opensAt', 'closesAt']) {
    if (has(k)) {
      const v = body[k];
      if (v != null && v !== '' && !isIso(v)) throw new HttpError(400, `${k} must be an ISO-8601 timestamp or null`);
      out[k === 'opensAt' ? 'opens_at' : 'closes_at'] = v ? new Date(v).toISOString() : null;
    }
  }
  if (has('questions')) out.questions = JSON.stringify(normalizeQuestions(body.questions));
  return out;
}

function mount(app, { db, auth, rateLimit }) {
  const sql = db.db;

  sql.exec(`
    CREATE TABLE IF NOT EXISTS surveys (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      suite_id     TEXT NOT NULL DEFAULT '',
      event_id     TEXT NOT NULL DEFAULT '',
      event_name   TEXT NOT NULL DEFAULT '',
      title        TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'draft',
      layout       TEXT NOT NULL DEFAULT 'form',
      opens_at     TEXT,
      closes_at    TEXT,
      questions    TEXT NOT NULL DEFAULT '[]',
      published_at TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_surveys_event  ON surveys(event_id);
    CREATE INDEX IF NOT EXISTS idx_surveys_entity ON surveys(entity_id);

    CREATE TABLE IF NOT EXISTS survey_responses (
      id             TEXT PRIMARY KEY,
      survey_id      TEXT NOT NULL,
      howler_user_id TEXT NOT NULL,
      display_name   TEXT NOT NULL DEFAULT '',
      email          TEXT NOT NULL DEFAULT '',
      platform       TEXT NOT NULL DEFAULT '',
      app_version    TEXT NOT NULL DEFAULT '',
      answers        TEXT NOT NULL DEFAULT '[]',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(survey_id, howler_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
  `);

  const enabled = () => db.getSetting('surveys_enabled', '1') !== '0'; // global kill switch
  // Per-client flag — the REAL boundary for the public surface: a client whose
  // engage.surveys flag is off must be invisible to the app entirely.
  const flagOn = (entityId) => { try { return !!flags.enabled(entityId, 'engage.surveys'); } catch { return false; } };
  const getSurvey = (id) => sql.prepare('SELECT * FROM surveys WHERE id=?').get(String(id || ''));
  const questionsOf = (row) => { try { return JSON.parse(row.questions) || []; } catch { return []; } };
  const responseCount = (id) => sql.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id=?').get(id).c;

  // Effective public state — a 'live' survey outside its window is not answerable.
  // 'scheduled' = live but opensAt is in the future; 'closed' also covers closesAt passed.
  function effectiveState(row, at = Date.now()) {
    if (row.status !== 'live') return row.status; // draft | closed
    if (row.opens_at && Date.parse(row.opens_at) > at) return 'scheduled';
    if (row.closes_at && Date.parse(row.closes_at) < at) return 'closed';
    return 'live';
  }

  // ── Contract wire shapes (§2) — key ORDER matters: the app's tests are locked
  // to the contract examples, so build objects in exactly that order. ──────────
  function publicQuestion(q) {
    const out = { id: q.id, type: q.type, text: q.text, required: q.required === true };
    if (CHOICE_TYPES.has(q.type)) out.options = q.options || [];
    return out;
  }
  function publicSurvey(row) {
    return {
      contractVersion: 1,
      id: row.id,
      eventId: String(row.event_id),
      eventName: row.event_name || '',
      title: row.title,
      description: row.description || '',
      status: 'live', // fans only ever receive live surveys
      layout: LAYOUTS.includes(row.layout) ? row.layout : 'form',
      opensAt: row.opens_at || null,
      closesAt: row.closes_at || null,
      questions: questionsOf(row).map(publicQuestion),
    };
  }

  // Internal (admin/client) shape — richer than the public one, camelCase.
  function internalSurvey(row) {
    return {
      id: row.id,
      entityId: row.entity_id,
      suiteId: row.suite_id || '',
      eventId: String(row.event_id),
      eventName: row.event_name || '',
      title: row.title,
      description: row.description || '',
      status: row.status,
      effectiveState: effectiveState(row),
      layout: row.layout,
      opensAt: row.opens_at || null,
      closesAt: row.closes_at || null,
      questions: questionsOf(row),
      responseCount: responseCount(row.id),
      publishedAt: row.published_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Answer validation (§3) — returns answers enriched with option-text
  // snapshots, ready to store. Throws HttpError(400) with a precise message. ───
  function validateAnswers(row, body) {
    if (JSON.stringify(body || {}).length > MAX_BODY_CHARS) throw new HttpError(400, 'Payload too large');
    const questions = new Map(questionsOf(row).map((q) => [q.id, q]));
    const respondent = (body && body.respondent) || {};
    const howlerUserId = str(respondent.howlerUserId, 64);
    if (!howlerUserId) throw new HttpError(400, 'respondent.howlerUserId is required');
    if (body.surveyId && String(body.surveyId) !== row.id) throw new HttpError(400, 'surveyId does not match the URL');
    if (!Array.isArray(body.answers)) throw new HttpError(400, 'answers must be an array');

    const seen = new Set();
    const answers = [];
    for (const a of body.answers) {
      if (!a || typeof a !== 'object') throw new HttpError(400, 'Each answer must be an object');
      const q = questions.get(String(a.questionId || ''));
      if (!q) throw new HttpError(400, `Unknown questionId "${str(a.questionId, 60)}"`);
      if (seen.has(q.id)) throw new HttpError(400, `Duplicate answer for question "${q.id}"`);
      if (a.type && a.type !== q.type) throw new HttpError(400, `Question "${q.id}" is ${q.type}, not ${str(a.type, 30)}`);
      const out = { questionId: q.id, type: q.type };
      if (q.type === 'rating') {
        if (!Number.isInteger(a.rating) || a.rating < 1 || a.rating > 5) throw new HttpError(400, `Question "${q.id}": rating must be an integer 1–5`);
        out.rating = a.rating;
      } else if (q.type === 'single_choice') {
        if (!Number.isInteger(a.selectedIndex) || a.selectedIndex < 0 || a.selectedIndex >= q.options.length) {
          throw new HttpError(400, `Question "${q.id}": selectedIndex out of range`);
        }
        out.selectedIndex = a.selectedIndex;
        out.selectedText = q.options[a.selectedIndex]; // snapshot
      } else if (q.type === 'multiple_choice') {
        const idx = Array.isArray(a.selectedIndices) ? a.selectedIndices : null;
        if (!idx) throw new HttpError(400, `Question "${q.id}": selectedIndices must be an array`);
        if (!idx.length) continue; // empty selection = unanswered optional
        if (idx.some((n) => !Number.isInteger(n) || n < 0 || n >= q.options.length)) {
          throw new HttpError(400, `Question "${q.id}": selectedIndices out of range`);
        }
        out.selectedIndices = [...new Set(idx)].sort((x, y) => x - y);
        out.selectedTexts = out.selectedIndices.map((n) => q.options[n]); // snapshot
      } else { // text
        const t = str(a.text, MAX_TEXT_ANSWER + 1);
        if (t.length > MAX_TEXT_ANSWER) throw new HttpError(400, `Question "${q.id}": text answers are capped at ${MAX_TEXT_ANSWER} characters`);
        if (!t) continue; // empty text = unanswered optional
        out.text = t;
      }
      seen.add(q.id);
      answers.push(out);
    }
    for (const q of questions.values()) {
      if (q.required && !seen.has(q.id)) throw new HttpError(400, `Question "${q.id}" is required`);
    }
    const client = (body && body.client) || {};
    return {
      howlerUserId,
      displayName: str(respondent.displayName, 200),
      email: str(respondent.email, 200),
      platform: str(client.platform, 40),
      appVersion: str(client.appVersion, 40),
      answers,
    };
  }

  // ── PUBLIC app-facing routes (contract §4) — no auth, rate-limited ───────────

  const readLimit = rateLimit({ windowMs: 60_000, max: 60, by: 'ip', scope: 'survey_read' });
  const submitLimitIp = rateLimit({ windowMs: 10 * 60_000, max: 30, by: 'ip', scope: 'survey_submit_ip' });
  const submitLimitUser = rateLimit({
    windowMs: 10 * 60_000, max: 10, scope: 'survey_submit_user',
    by: (req) => `hu:${str(req.body?.respondent?.howlerUserId, 64) || 'anon'}`,
  });

  // Live surveys for an event. ALWAYS `{ surveys: [...] }` — empty list, never 404.
  app.get('/api/app/surveys', readLimit, (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'Surveys are disabled' });
    const eventId = str(req.query.eventId, 32);
    if (!/^[0-9]{1,32}$/.test(eventId)) return res.status(400).json({ error: 'eventId (numeric) is required' });
    const rows = sql.prepare("SELECT * FROM surveys WHERE event_id=? AND status='live' ORDER BY created_at").all(eventId);
    res.json({ surveys: rows.filter((r) => effectiveState(r) === 'live' && flagOn(r.entity_id)).map(publicSurvey) });
  });

  app.get('/api/app/surveys/:id', readLimit, (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'Surveys are disabled' });
    const row = getSurvey(req.params.id);
    if (!row || effectiveState(row) !== 'live' || !flagOn(row.entity_id)) return res.status(404).json({ error: 'Survey not found' });
    res.json(publicSurvey(row));
  });

  app.post('/api/app/surveys/:id/responses', submitLimitIp, submitLimitUser, (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'Surveys are disabled' });
    const row = getSurvey(req.params.id);
    if (!row || row.status === 'draft' || !flagOn(row.entity_id)) return res.status(404).json({ error: 'Survey not found' });
    const state = effectiveState(row);
    if (state === 'closed') return res.status(409).json({ error: 'This survey has closed' });
    if (state === 'scheduled') return res.status(409).json({ error: 'This survey is not open yet' });
    const clean = validateAnswers(row, req.body || {}); // throws HttpError(400) — sync, caught by Express
    const t = nowIso();
    const existing = sql.prepare('SELECT id FROM survey_responses WHERE survey_id=? AND howler_user_id=?').get(row.id, clean.howlerUserId);
    const id = existing ? existing.id : rid('rsp');
    if (existing) {
      sql.prepare('UPDATE survey_responses SET display_name=?, email=?, platform=?, app_version=?, answers=?, updated_at=? WHERE id=?')
        .run(clean.displayName, clean.email, clean.platform, clean.appVersion, JSON.stringify(clean.answers), t, id);
    } else {
      sql.prepare('INSERT INTO survey_responses (id, survey_id, howler_user_id, display_name, email, platform, app_version, answers, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, row.id, clean.howlerUserId, clean.displayName, clean.email, clean.platform, clean.appVersion, JSON.stringify(clean.answers), t, t);
    }
    res.json({ ok: true, responseId: id });
  });

  // ── Shared management core (admin + my routes both land here) ────────────────

  function createSurvey(entityId, body) {
    const fields = normalizeSurveyFields(body || {});
    const t = nowIso();
    const id = rid('srv');
    sql.prepare(`INSERT INTO surveys (id, entity_id, suite_id, event_id, event_name, title, description, status, layout, opens_at, closes_at, questions, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entityId, fields.suite_id || '', fields.event_id, fields.event_name || '', fields.title,
        fields.description || '', 'draft', fields.layout || 'form', fields.opens_at || null, fields.closes_at || null,
        fields.questions || '[]', t, t);
    return internalSurvey(getSurvey(id));
  }

  // Draft-only content edits; a LIVE survey only allows moving `closesAt`
  // (extend/curtail the window). Anything else on live/closed → 409 (immutability).
  function updateSurvey(row, body) {
    const partial = normalizeSurveyFields(body || {}, { partial: true });
    if (row.status !== 'draft') {
      const keys = Object.keys(partial);
      const allowed = keys.every((k) => k === 'closes_at');
      if (!keys.length || !allowed || row.status === 'closed') {
        throw new HttpError(409, 'Published surveys are immutable — close it and use Duplicate to make an editable copy. (A live survey may only change its close date.)');
      }
    }
    const sets = Object.keys(partial).map((k) => `${k}=?`).join(', ');
    if (sets) sql.prepare(`UPDATE surveys SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(partial), nowIso(), row.id);
    return internalSurvey(getSurvey(row.id));
  }

  function publishSurvey(row) {
    if (row.status === 'live') return internalSurvey(row);
    const qs = questionsOf(row);
    if (!qs.length) throw new HttpError(400, 'Add at least one question before publishing');
    if (!/^[0-9]{1,32}$/.test(String(row.event_id))) throw new HttpError(400, 'Set the Howler event id before publishing');
    normalizeQuestions(qs); // belt-and-braces: stored draft must still be contract-valid
    sql.prepare("UPDATE surveys SET status='live', published_at=COALESCE(published_at,?), updated_at=? WHERE id=?").run(nowIso(), nowIso(), row.id);
    return internalSurvey(getSurvey(row.id));
  }

  function closeSurvey(row) {
    sql.prepare("UPDATE surveys SET status='closed', updated_at=? WHERE id=?").run(nowIso(), row.id);
    return internalSurvey(getSurvey(row.id));
  }

  function duplicateSurvey(row) {
    return createSurvey(row.entity_id, {
      title: `${row.title} (copy)`.slice(0, 200),
      description: row.description,
      eventId: String(row.event_id),
      eventName: row.event_name,
      suiteId: row.suite_id,
      layout: row.layout,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      questions: questionsOf(row),
    });
  }

  function deleteSurvey(row) {
    if (row.status !== 'draft' && responseCount(row.id) > 0) {
      throw new HttpError(409, 'This survey has responses — close it instead of deleting, so results are kept');
    }
    sql.prepare('DELETE FROM survey_responses WHERE survey_id=?').run(row.id);
    sql.prepare('DELETE FROM surveys WHERE id=?').run(row.id);
  }

  // Results: per-question aggregates using the SNAPSHOTTED option text.
  function surveyResults(row) {
    const rows = sql.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY updated_at DESC').all(row.id);
    const parsed = rows.map((r) => ({ row: r, answers: (() => { try { return JSON.parse(r.answers) || []; } catch { return []; } })() }));
    const byQ = new Map();
    for (const { row: r, answers } of parsed) {
      for (const a of answers) {
        if (!byQ.has(a.questionId)) byQ.set(a.questionId, []);
        byQ.get(a.questionId).push({ a, at: r.updated_at });
      }
    }
    const questions = questionsOf(row).map((q) => {
      const got = byQ.get(q.id) || [];
      const base = { id: q.id, type: q.type, text: q.text, answered: got.length };
      if (q.type === 'rating') {
        const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let sum = 0;
        for (const { a } of got) { counts[a.rating] = (counts[a.rating] || 0) + 1; sum += a.rating; }
        return { ...base, average: got.length ? Math.round((sum / got.length) * 100) / 100 : null, counts };
      }
      if (CHOICE_TYPES.has(q.type)) {
        const counts = q.options.map((text, index) => ({ index, text, count: 0 }));
        for (const { a } of got) {
          const idx = q.type === 'single_choice' ? [a.selectedIndex] : (a.selectedIndices || []);
          for (const n of idx) if (counts[n]) counts[n].count += 1;
        }
        return { ...base, options: counts };
      }
      return { ...base, answers: got.slice(0, 500).map(({ a, at }) => ({ text: a.text, at })) };
    });
    return {
      surveyId: row.id, title: row.title, status: row.status, effectiveState: effectiveState(row),
      responseCount: parsed.length, questions,
    };
  }

  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function resultsCsv(row) {
    const qs = questionsOf(row);
    const rows = sql.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY updated_at').all(row.id);
    const head = ['response_id', 'howler_user_id', 'platform', 'app_version', 'submitted_at', ...qs.map((q) => q.text)];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) {
      let answers = []; try { answers = JSON.parse(r.answers) || []; } catch { /* skip */ }
      const byId = new Map(answers.map((a) => [a.questionId, a]));
      const cells = qs.map((q) => {
        const a = byId.get(q.id);
        if (!a) return '';
        if (q.type === 'rating') return a.rating;
        if (q.type === 'single_choice') return a.selectedText;
        if (q.type === 'multiple_choice') return (a.selectedTexts || []).join('; ');
        return a.text;
      });
      lines.push([r.id, r.howler_user_id, r.platform, r.app_version, r.updated_at, ...cells].map(csvCell).join(','));
    }
    return lines.join('\n');
  }

  // ── Access helpers (checks live IN handlers, mirroring eventops.js, so the
  // guards are exercised by the captured-handler test pattern) ─────────────────
  const P = { view: 'campaigns.view', manage: 'campaigns.approve' };
  function requireUser(req, res) {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    return req.user;
  }
  // For /api/my routes: the survey (or explicit entityId) must belong to one of the
  // caller's entities AND the caller needs the given permission on it.
  function myEntityCheck(req, res, entityId, perm) {
    const user = requireUser(req, res);
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!entityId || !(user.entityIds || []).includes(entityId) || !auth.hasPermission(user, entityId, perm)) {
      res.status(403).json({ error: 'Not allowed' });
      return false;
    }
    return true;
  }
  function adminCheck(req, res) {
    const user = requireUser(req, res);
    if (!user) return false;
    if (user.role !== 'admin') { res.status(403).json({ error: 'Admins only' }); return false; }
    return true;
  }
  // Fetch a survey for a my-route, enforcing ownership + permission. Null = already responded.
  function mySurvey(req, res, perm) {
    const row = getSurvey(req.params.id);
    if (!row) { res.status(404).json({ error: 'Survey not found' }); return null; }
    return myEntityCheck(req, res, row.entity_id, perm) ? row : null;
  }
  function adminSurvey(req, res) {
    if (!adminCheck(req, res)) return null;
    const row = getSurvey(req.params.surveyId);
    if (!row || row.entity_id !== req.params.entityId) { res.status(404).json({ error: 'Survey not found' }); return null; }
    return row;
  }

  // ── Admin surface ────────────────────────────────────────────────────────────
  app.get('/api/admin/entities/:entityId/surveys', (req, res) => {
    if (!adminCheck(req, res)) return;
    const rows = sql.prepare('SELECT * FROM surveys WHERE entity_id=? ORDER BY created_at DESC').all(req.params.entityId);
    res.json({ surveys: rows.map(internalSurvey) });
  });
  app.post('/api/admin/entities/:entityId/surveys', (req, res) => {
    if (!adminCheck(req, res)) return;
    if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Unknown client' });
    res.json(createSurvey(req.params.entityId, req.body));
  });
  app.put('/api/admin/entities/:entityId/surveys/:surveyId', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.json(updateSurvey(row, req.body));
  });
  app.post('/api/admin/entities/:entityId/surveys/:surveyId/publish', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.json(publishSurvey(row));
  });
  app.post('/api/admin/entities/:entityId/surveys/:surveyId/close', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.json(closeSurvey(row));
  });
  app.post('/api/admin/entities/:entityId/surveys/:surveyId/duplicate', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.json(duplicateSurvey(row));
  });
  app.delete('/api/admin/entities/:entityId/surveys/:surveyId', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    deleteSurvey(row);
    res.json({ ok: true });
  });
  app.get('/api/admin/entities/:entityId/surveys/:surveyId/results', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.json(surveyResults(row));
  });
  app.get('/api/admin/entities/:entityId/surveys/:surveyId/results.csv', (req, res) => {
    const row = adminSurvey(req, res); if (!row) return;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="survey-${row.id}-results.csv"`);
    res.send(resultsCsv(row));
  });

  // ── Client self-service surface (/api/my) ────────────────────────────────────
  app.get('/api/my/surveys', (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const eids = user.role === 'admin'
      ? (db.listEntities() || []).map((e) => e.id)
      : (user.entityIds || []).filter((eid) => auth.hasPermission(user, eid, P.view));
    const rows = [];
    for (const eid of eids) rows.push(...sql.prepare('SELECT * FROM surveys WHERE entity_id=? ORDER BY created_at DESC').all(eid));
    res.json({ surveys: rows.map(internalSurvey) });
  });
  app.post('/api/my/surveys', (req, res) => {
    const entityId = str((req.body || {}).entityId, 60) || (req.user?.entityIds || [])[0] || '';
    if (!myEntityCheck(req, res, entityId, P.manage)) return;
    if (!db.getEntity(entityId)) return res.status(404).json({ error: 'Unknown client' });
    res.json(createSurvey(entityId, req.body));
  });
  app.put('/api/my/surveys/:id', (req, res) => {
    const row = mySurvey(req, res, P.manage); if (!row) return;
    res.json(updateSurvey(row, req.body));
  });
  app.post('/api/my/surveys/:id/publish', (req, res) => {
    const row = mySurvey(req, res, P.manage); if (!row) return;
    res.json(publishSurvey(row));
  });
  app.post('/api/my/surveys/:id/close', (req, res) => {
    const row = mySurvey(req, res, P.manage); if (!row) return;
    res.json(closeSurvey(row));
  });
  app.post('/api/my/surveys/:id/duplicate', (req, res) => {
    const row = mySurvey(req, res, P.manage); if (!row) return;
    res.json(duplicateSurvey(row));
  });
  app.delete('/api/my/surveys/:id', (req, res) => {
    const row = mySurvey(req, res, P.manage); if (!row) return;
    deleteSurvey(row);
    res.json({ ok: true });
  });
  app.get('/api/my/surveys/:id/results', (req, res) => {
    const row = mySurvey(req, res, P.view); if (!row) return;
    res.json(surveyResults(row));
  });
  app.get('/api/my/surveys/:id/results.csv', (req, res) => {
    const row = mySurvey(req, res, P.view); if (!row) return;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="survey-${row.id}-results.csv"`);
    res.send(resultsCsv(row));
  });

  return { publicSurvey, effectiveState, validateAnswers, surveyResults, resultsCsv, createSurvey };
}

module.exports = { mount, normalizeQuestions, normalizeSurveyFields };
