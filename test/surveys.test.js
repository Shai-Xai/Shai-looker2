// Surveys (Pulse ⇄ Howler app, docs/specs/SURVEY_CONTRACT.md) — exercises the
// public wire format the app's tests are locked to, the draft→live→closed
// lifecycle with published-survey immutability, response validation + upsert,
// the entity-scope guards on the my/admin surfaces, and results aggregation.
// Routes are invoked directly via captured handlers (no HTTP), mirroring
// test/eventops.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const surveys = require('../server/surveys');
const flags = require('../server/flags');

const rateLimit = require('../server/ratelimit');
flags.init(db);
const setFlag = (entityId, value) => db.db
  .prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?, 'engage.surveys', ?, 'test', ?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value")
  .run(entityId, value, new Date().toISOString());

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  surveys.mount(app, { db, auth, rateLimit });
  return routes;
}
const routes = mount();

// Express catches a SYNC throw and routes it to errorMiddleware; mirror that here
// so handlers that `throw new HttpError(...)` behave as they do in production.
function call(key, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload, text;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { text = d; return res; },
    set() { return res; },
  };
  try {
    routes[key]({ user, params, body, query, ip: '1.2.3.4' }, res);
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.expose || (code >= 400 && code < 500) ? e.message : 'Something went wrong on our end.' };
  }
  return { code, body: payload, text };
}

// The contract §2 survey, verbatim (questions + fields from the doc's example).
const CONTRACT_QUESTIONS = [
  { id: 'q_overall', type: 'rating', text: 'How would you rate the event overall?', required: true },
  { id: 'q_fav', type: 'single_choice', text: 'What was the highlight?', required: false, options: ['Music', 'Food & drink', 'Atmosphere', 'Production'] },
  { id: 'q_improve', type: 'multiple_choice', text: 'What should we improve? (pick any)', required: false, options: ['Queues', 'Parking', 'Sound', 'Food options', 'Signage'] },
  { id: 'q_comments', type: 'text', text: "Anything else you'd like to tell us?", required: false },
];

let seq = 0;
function seedClient() {
  seq += 1;
  const entity = makeEntity(`Org ${seq}`, `org-${seq}`);
  setFlag(entity.id, 'on'); // engage.surveys defaults OFF — tests opt their client in
  const owner = makeClient(`owner-${seq}@test.local`, [entity.id], 'owner');
  const viewer = makeClient(`viewer-${seq}@test.local`, [entity.id], 'viewer');
  const outsider = makeClient(`outsider-${seq}@test.local`, [makeEntity(`Rival ${seq}`, `rival-${seq}`).id], 'owner');
  const admin = makeAdmin(`admin-${seq}@test.local`);
  return { entity, owner, viewer, outsider, admin };
}

function makeLiveSurvey({ owner, eventId = '19203', extra = {} } = {}) {
  const created = call('POST /api/my/surveys', {
    user: owner,
    body: {
      title: 'How was Bushfire?', description: '2 minutes — help us make next year better.',
      eventId, eventName: 'Bushfire Festival 2026', questions: CONTRACT_QUESTIONS, ...extra,
    },
  });
  assert.equal(created.code, 200, JSON.stringify(created.body));
  const pub = call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: created.body.id } });
  assert.equal(pub.code, 200, JSON.stringify(pub.body));
  return pub.body;
}

// ── Public wire format (the acceptance check the app holds us to) ─────────────

test('GET /api/app/surveys returns { surveys: [] } when none — not 404', () => {
  const r = call('GET /api/app/surveys', { query: { eventId: '424242' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { surveys: [] });
});

test('public survey JSON matches contract §2: exact keys, exact order', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, extra: { layout: 'form' } });
  const r = call('GET /api/app/surveys', { query: { eventId: '19203' } });
  assert.equal(r.code, 200);
  const got = r.body.surveys.find((x) => x.id === s.id);
  assert.ok(got, 'published survey listed for its event');
  assert.deepEqual(Object.keys(got), [
    'contractVersion', 'id', 'eventId', 'eventName', 'title', 'description',
    'status', 'layout', 'opensAt', 'closesAt', 'questions',
  ]);
  assert.equal(got.contractVersion, 1);
  assert.equal(got.status, 'live');
  assert.equal(got.layout, 'form');
  assert.equal(got.eventId, '19203');
  // Questions serialize exactly as the contract example (incl. no options key on
  // rating/text, options key present on choice types).
  assert.deepEqual(got.questions, CONTRACT_QUESTIONS);
  assert.deepEqual(Object.keys(got.questions[0]), ['id', 'type', 'text', 'required']);
  assert.deepEqual(Object.keys(got.questions[1]), ['id', 'type', 'text', 'required', 'options']);
  // And GET by id returns the same object.
  const one = call('GET /api/app/surveys/:id', { params: { id: s.id } });
  assert.deepEqual(one.body, got);
});

test('layout defaults to form when omitted; cards when chosen', () => {
  const { owner } = seedClient();
  const plain = makeLiveSurvey({ owner, eventId: '31001' });
  assert.equal(call('GET /api/app/surveys/:id', { params: { id: plain.id } }).body.layout, 'form');
  const cards = makeLiveSurvey({ owner, eventId: '31001', extra: { layout: 'cards' } });
  assert.equal(call('GET /api/app/surveys/:id', { params: { id: cards.id } }).body.layout, 'cards');
  const bad = call('POST /api/my/surveys', { user: owner, body: { title: 'x', eventId: '31001', layout: 'sideways' } });
  assert.equal(bad.code, 400);
});

test('draft and closed surveys are invisible to the app (404 / excluded)', () => {
  const { owner } = seedClient();
  const draft = call('POST /api/my/surveys', { user: owner, body: { title: 'Draft', eventId: '55001', questions: CONTRACT_QUESTIONS } }).body;
  assert.equal(call('GET /api/app/surveys/:id', { params: { id: draft.id } }).code, 404);
  assert.deepEqual(call('GET /api/app/surveys', { query: { eventId: '55001' } }).body, { surveys: [] });
  const live = makeLiveSurvey({ owner, eventId: '55001' });
  call('POST /api/my/surveys/:id/close', { user: owner, params: { id: live.id } });
  assert.equal(call('GET /api/app/surveys/:id', { params: { id: live.id } }).code, 404);
});

test('a live survey outside its window is not served or answerable', () => {
  const { owner } = seedClient();
  const past = makeLiveSurvey({ owner, eventId: '55002', extra: { closesAt: '2000-01-01T00:00:00Z' } });
  assert.deepEqual(call('GET /api/app/surveys', { query: { eventId: '55002' } }).body, { surveys: [] });
  const r = call('POST /api/app/surveys/:id/responses', {
    params: { id: past.id },
    body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
  });
  assert.equal(r.code, 409);
  const future = makeLiveSurvey({ owner, eventId: '55002', extra: { opensAt: '2999-01-01T00:00:00Z' } });
  const r2 = call('POST /api/app/surveys/:id/responses', {
    params: { id: future.id },
    body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
  });
  assert.equal(r2.code, 409);
});

// ── Responses: happy path, upsert, validation ─────────────────────────────────

test('POST response: contract shape in, { ok, responseId } out, upsert replaces', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19204' });
  const body = {
    contractVersion: 1,
    surveyId: s.id,
    respondent: { howlerUserId: '662076', displayName: null, email: null },
    client: { platform: 'ios', appVersion: '3.78.1+214' },
    answers: [
      { questionId: 'q_overall', type: 'rating', rating: 4 },
      { questionId: 'q_fav', type: 'single_choice', selectedIndex: 2 },
      { questionId: 'q_improve', type: 'multiple_choice', selectedIndices: [0, 3] },
      { questionId: 'q_comments', type: 'text', text: 'Loved it. More water points please.' },
    ],
  };
  const r = call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.responseId, /^rsp_/);
  assert.deepEqual(Object.keys(r.body), ['ok', 'responseId']);
  // Resubmit → same responseId, still one row, answers replaced.
  const r2 = call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id },
    body: { ...body, answers: [{ questionId: 'q_overall', type: 'rating', rating: 2 }] },
  });
  assert.equal(r2.body.responseId, r.body.responseId);
  const results = call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id } }).body;
  assert.equal(results.responseCount, 1);
  assert.equal(results.questions[0].average, 2);
});

test('response validation: precise 400s', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19205' });
  const submit = (answers, respondent = { howlerUserId: 'u9' }) =>
    call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body: { respondent, answers } });
  assert.equal(submit([{ questionId: 'q_overall', rating: 9 }]).code, 400);          // rating out of range
  assert.equal(submit([{ questionId: 'q_overall', rating: 4.5 }]).code, 400);        // non-integer
  assert.equal(submit([{ questionId: 'nope', rating: 4 }]).code, 400);               // unknown question
  assert.equal(submit([{ questionId: 'q_fav', selectedIndex: 99 }]).code, 400);      // index out of range
  assert.equal(submit([{ questionId: 'q_fav', selectedIndex: 0 }]).code, 400);       // missing required q_overall
  assert.equal(submit([{ questionId: 'q_overall', rating: 4 }], {}).code, 400);      // no howlerUserId
  assert.equal(submit([{ questionId: 'q_overall', rating: 4 }, { questionId: 'q_comments', text: 'x'.repeat(1001) }]).code, 400); // text cap
  // Unknown survey id → 404, not 400.
  assert.equal(call('POST /api/app/surveys/:id/responses', { params: { id: 'srv_missing' }, body: {} }).code, 404);
});

test('option text is snapshotted onto stored answers (results + CSV read it back)', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19206' });
  call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id },
    body: {
      respondent: { howlerUserId: 'snap1' },
      answers: [
        { questionId: 'q_overall', rating: 5 },
        { questionId: 'q_fav', selectedIndex: 1 },
        { questionId: 'q_improve', selectedIndices: [1, 2] },
      ],
    },
  });
  const res = call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id } }).body;
  const fav = res.questions.find((q) => q.id === 'q_fav');
  assert.deepEqual(fav.options.find((o) => o.index === 1), { index: 1, text: 'Food & drink', count: 1 });
  const csv = call('GET /api/my/surveys/:id/results.csv', { user: owner, params: { id: s.id } }).text;
  assert.match(csv, /Food & drink/);
  assert.match(csv, /Parking; Sound/);
  assert.match(csv, /snap1/);
});

// ── Lifecycle & immutability ──────────────────────────────────────────────────

test('published surveys are immutable; only closesAt may move while live', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19207' });
  const edit = call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { title: 'Sneaky rename' } });
  assert.equal(edit.code, 409);
  const qEdit = call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { questions: [] } });
  assert.equal(qEdit.code, 409);
  const extend = call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { closesAt: '2999-01-01T00:00:00Z' } });
  assert.equal(extend.code, 200, JSON.stringify(extend.body));
  assert.equal(extend.body.closesAt, '2999-01-01T00:00:00.000Z');
  // Closed: nothing editable, but duplicate gives an editable draft copy.
  call('POST /api/my/surveys/:id/close', { user: owner, params: { id: s.id } });
  assert.equal(call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { closesAt: null } }).code, 409);
  const dup = call('POST /api/my/surveys/:id/duplicate', { user: owner, params: { id: s.id } });
  assert.equal(dup.body.status, 'draft');
  assert.equal(dup.body.title, 'How was Bushfire? (copy)');
  assert.deepEqual(dup.body.questions, CONTRACT_QUESTIONS);
});

test('publish requires questions + numeric event id; empty drafts stay draftable', () => {
  const { owner } = seedClient();
  const bare = call('POST /api/my/surveys', { user: owner, body: { title: 'WIP', eventId: '19208' } });
  assert.equal(bare.code, 200);
  assert.equal(call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: bare.body.id } }).code, 400);
  const badEvent = call('POST /api/my/surveys', { user: owner, body: { title: 'x', eventId: 'not-a-number' } });
  assert.equal(badEvent.code, 400);
});

test('delete: drafts freely; surveys with responses refuse (close instead)', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19209' });
  call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id }, body: { respondent: { howlerUserId: 'keep' }, answers: [{ questionId: 'q_overall', rating: 3 }] },
  });
  assert.equal(call('DELETE /api/my/surveys/:id', { user: owner, params: { id: s.id } }).code, 409);
  const draft = call('POST /api/my/surveys', { user: owner, body: { title: 'bin me', eventId: '19209' } }).body;
  assert.equal(call('DELETE /api/my/surveys/:id', { user: owner, params: { id: draft.id } }).code, 200);
});

// ── Scope & permissions (the multi-tenant boundary) ───────────────────────────

test('my-routes: outsiders 403, viewers can see results but not manage', () => {
  const { owner, viewer, outsider } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19210' });
  assert.equal(call('PUT /api/my/surveys/:id', { user: outsider, params: { id: s.id }, body: { closesAt: null } }).code, 403);
  assert.equal(call('GET /api/my/surveys/:id/results', { user: outsider, params: { id: s.id } }).code, 403);
  assert.equal(call('GET /api/my/surveys/:id/results', { user: viewer, params: { id: s.id } }).code, 403); // viewer lacks campaigns.view
  assert.equal(call('POST /api/my/surveys', { user: viewer, body: { title: 'x', eventId: '1' } }).code, 403);
  assert.equal(call('POST /api/my/surveys', { user: null, body: {} }).code, 401);
  // My list only shows my entities' surveys.
  const mine = call('GET /api/my/surveys', { user: outsider }).body.surveys.map((x) => x.id);
  assert.ok(!mine.includes(s.id));
});

test('admin surface: full manage on any entity; wrong-entity survey id 404s', () => {
  const { entity, owner, admin } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19211' });
  const list = call('GET /api/admin/entities/:entityId/surveys', { user: admin, params: { entityId: entity.id } });
  assert.ok(list.body.surveys.some((x) => x.id === s.id));
  assert.equal(call('GET /api/admin/entities/:entityId/surveys', { user: owner, params: { entityId: entity.id } }).code, 403);
  const other = makeEntity('Someone else', 'else-org');
  assert.equal(call('GET /api/admin/entities/:entityId/surveys/:surveyId/results', { user: admin, params: { entityId: other.id, surveyId: s.id } }).code, 404);
});

// ── Kill switch ───────────────────────────────────────────────────────────────

test('engage.surveys flag off (the default) hides that client from the app', () => {
  const { entity, owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19213' });
  setFlag(entity.id, 'off');
  try {
    assert.deepEqual(call('GET /api/app/surveys', { query: { eventId: '19213' } }).body, { surveys: [] });
    assert.equal(call('GET /api/app/surveys/:id', { params: { id: s.id } }).code, 404);
    const r = call('POST /api/app/surveys/:id/responses', {
      params: { id: s.id },
      body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
    });
    assert.equal(r.code, 404);
  } finally {
    setFlag(entity.id, 'on');
  }
});

test('surveys_enabled=0 hides the public surface', () => {
  const { owner } = seedClient();
  const s = makeLiveSurvey({ owner, eventId: '19212' });
  db.setSetting('surveys_enabled', '0');
  try {
    assert.equal(call('GET /api/app/surveys', { query: { eventId: '19212' } }).code, 404);
    assert.equal(call('GET /api/app/surveys/:id', { params: { id: s.id } }).code, 404);
    assert.equal(call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body: {} }).code, 404);
  } finally {
    db.setSetting('surveys_enabled', '1');
  }
});
