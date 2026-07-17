// Surveys (Pulse ⇄ Howler app, docs/specs/SURVEY_CONTRACT.md) — exercises the
// public wire format the app's tests are locked to, the draft→live→closed
// lifecycle with published-survey immutability, the publish-time "event must be
// listed in the Howler app" gate, ticket-type targeting (v1.3), response
// validation + upsert, ticket-type slicing/filter/drill-down (v1.2), the
// entity-scope guards on the my/admin surfaces, and results aggregation.
// Routes are invoked directly via captured handlers (no HTTP), mirroring
// test/eventops.test.js; handlers may be async, so call() awaits them.

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

// Howler event lookup stub: event 40440404 is "not listed in the app";
// everything else verifies, with a listing name + two ticket types.
const UNLISTED = '40440404';
const lookupEvent = async (eventId) => (eventId === UNLISTED
  ? { ok: false }
  : { ok: true, name: `Howler Event ${eventId}`, ticketTypes: [{ id: '1', name: 'General' }, { id: '2', name: 'VIP' }] });

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  surveys.mount(app, { db, auth, rateLimit, lookupEvent, listEntityEventIds: async () => ['19203', '31001', UNLISTED] });
  return routes;
}
const routes = mount();

// Mirror Express: a SYNC throw or ASYNC rejection both land in errorMiddleware.
async function call(key, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload, text;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { text = d; return res; },
    set() { return res; },
  };
  try {
    await routes[key]({ user, params, body, query, ip: '1.2.3.4' }, res);
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

async function makeLiveSurvey({ owner, eventId = '19203', extra = {} } = {}) {
  const created = await call('POST /api/my/surveys', {
    user: owner,
    body: {
      title: 'How was Bushfire?', description: '2 minutes — help us make next year better.',
      eventId, eventName: 'Bushfire Festival 2026', questions: CONTRACT_QUESTIONS, ...extra,
    },
  });
  assert.equal(created.code, 200, JSON.stringify(created.body));
  const pub = await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: created.body.id } });
  assert.equal(pub.code, 200, JSON.stringify(pub.body));
  return pub.body;
}

// ── Public wire format (the acceptance check the app holds us to) ─────────────

test('GET /api/app/surveys returns { surveys: [] } when none — not 404', async () => {
  const r = await call('GET /api/app/surveys', { query: { eventId: '424242' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { surveys: [] });
});

test('public survey JSON matches contract §2: exact keys, exact order', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, extra: { layout: 'form' } });
  const r = await call('GET /api/app/surveys', { query: { eventId: '19203' } });
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
  // Publish verified the event with Howler and adopted the app's listing name.
  assert.equal(got.eventName, 'Howler Event 19203');
  // Questions serialize exactly as the contract example (incl. no options key on
  // rating/text, options key present on choice types).
  assert.deepEqual(got.questions, CONTRACT_QUESTIONS);
  assert.deepEqual(Object.keys(got.questions[0]), ['id', 'type', 'text', 'required']);
  assert.deepEqual(Object.keys(got.questions[1]), ['id', 'type', 'text', 'required', 'options']);
  // And GET by id returns the same object.
  const one = await call('GET /api/app/surveys/:id', { params: { id: s.id } });
  assert.deepEqual(one.body, got);
});

test('layout defaults to form when omitted; cards when chosen', async () => {
  const { owner } = seedClient();
  const plain = await makeLiveSurvey({ owner, eventId: '31001' });
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: plain.id } })).body.layout, 'form');
  const cards = await makeLiveSurvey({ owner, eventId: '31001', extra: { layout: 'cards' } });
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: cards.id } })).body.layout, 'cards');
  const bad = await call('POST /api/my/surveys', { user: owner, body: { title: 'x', eventId: '31001', layout: 'sideways' } });
  assert.equal(bad.code, 400);
});

test('draft and closed surveys are invisible to the app (404 / excluded)', async () => {
  const { owner } = seedClient();
  const draft = (await call('POST /api/my/surveys', { user: owner, body: { title: 'Draft', eventId: '55001', questions: CONTRACT_QUESTIONS } })).body;
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: draft.id } })).code, 404);
  assert.deepEqual((await call('GET /api/app/surveys', { query: { eventId: '55001' } })).body, { surveys: [] });
  const live = await makeLiveSurvey({ owner, eventId: '55001' });
  await call('POST /api/my/surveys/:id/close', { user: owner, params: { id: live.id } });
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: live.id } })).code, 404);
});

test('a live survey outside its window is not served or answerable', async () => {
  const { owner } = seedClient();
  const past = await makeLiveSurvey({ owner, eventId: '55002', extra: { closesAt: '2000-01-01T00:00:00Z' } });
  assert.deepEqual((await call('GET /api/app/surveys', { query: { eventId: '55002' } })).body, { surveys: [] });
  const r = await call('POST /api/app/surveys/:id/responses', {
    params: { id: past.id },
    body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
  });
  assert.equal(r.code, 409);
  const future = await makeLiveSurvey({ owner, eventId: '55002', extra: { opensAt: '2999-01-01T00:00:00Z' } });
  const r2 = await call('POST /api/app/surveys/:id/responses', {
    params: { id: future.id },
    body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
  });
  assert.equal(r2.code, 409);
});

// ── Publish gate: the event must be listed in the Howler app ──────────────────

test('publish is blocked for an event that is not listed in the Howler app', async () => {
  const { owner } = seedClient();
  const created = await call('POST /api/my/surveys', {
    user: owner, body: { title: 'Ghost event survey', eventId: UNLISTED, questions: CONTRACT_QUESTIONS },
  });
  assert.equal(created.code, 200);
  const pub = await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: created.body.id } });
  assert.equal(pub.code, 400);
  assert.match(pub.body.error, /isn't listed in the Howler app/);
  // Still a draft — nothing leaked to the app.
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: created.body.id } })).code, 404);
});

test('event-lookup endpoint verifies an event and returns its ticket types', async () => {
  const { owner } = seedClient();
  const hit = await call('GET /api/my/surveys/event-lookup', { user: owner, query: { eventId: '19203' } });
  assert.equal(hit.code, 200);
  assert.equal(hit.body.ok, true);
  assert.equal(hit.body.eventName, 'Howler Event 19203');
  assert.deepEqual(hit.body.ticketTypes.map((t) => t.name), ['General', 'VIP']);
  const miss = await call('GET /api/my/surveys/event-lookup', { user: owner, query: { eventId: UNLISTED } });
  assert.deepEqual(miss.body, { ok: false, eventId: UNLISTED });
  assert.equal((await call('GET /api/my/surveys/event-lookup', { user: owner, query: {} })).code, 400);
  assert.equal((await call('GET /api/my/surveys/event-lookup', { user: null, query: { eventId: '1' } })).code, 401);
});

test('events dropdown endpoint: entity-scoped, only app-listed events, named', async () => {
  const { owner, outsider } = seedClient();
  const r = await call('GET /api/my/surveys/events', { user: owner, query: { entityId: owner.entityIds[0] } });
  assert.equal(r.code, 200);
  // The unlisted id is dropped; the rest come back named, sorted.
  assert.deepEqual(r.body.events.map((e) => e.eventId).sort(), ['19203', '31001']);
  assert.ok(r.body.events.every((e) => e.name.startsWith('Howler Event ')));
  // Another client's entity → 403.
  assert.equal((await call('GET /api/my/surveys/events', { user: outsider, query: { entityId: owner.entityIds[0] } })).code, 403);
});

// ── Ticket-type targeting (v1.3) ──────────────────────────────────────────────

test('targeted surveys only reach fans with a matching ticket type', async () => {
  const { owner } = seedClient();
  const blanket = await makeLiveSurvey({ owner, eventId: '61001' });
  const vipOnly = await makeLiveSurvey({ owner, eventId: '61001', extra: { audienceTicketTypes: ['VIP', 'VIP Standing'] } });

  // No ticket type declared (old app builds): blanket only — targeted never leaks.
  const anon = (await call('GET /api/app/surveys', { query: { eventId: '61001' } })).body.surveys.map((s) => s.id);
  assert.deepEqual(anon, [blanket.id]);

  // Matching (case-insensitive) sees both; non-matching sees blanket only.
  const vip = (await call('GET /api/app/surveys', { query: { eventId: '61001', ticketType: 'vip' } })).body.surveys;
  assert.deepEqual(vip.map((s) => s.id).sort(), [blanket.id, vipOnly.id].sort());
  const gen = (await call('GET /api/app/surveys', { query: { eventId: '61001', ticketType: 'General' } })).body.surveys.map((s) => s.id);
  assert.deepEqual(gen, [blanket.id]);
  // Multi-ticket fan: comma-separated, any match counts.
  const multi = (await call('GET /api/app/surveys', { query: { eventId: '61001', ticketType: 'General, VIP' } })).body.surveys;
  assert.equal(multi.length, 2);

  // The audience key is present ONLY on targeted surveys (blanket = v1.1 shape).
  const vipWire = vip.find((s) => s.id === vipOnly.id);
  assert.deepEqual(vipWire.audienceTicketTypes, ['VIP', 'VIP Standing']);
  assert.ok(!('audienceTicketTypes' in vip.find((s) => s.id === blanket.id)));
  assert.deepEqual(Object.keys(vipWire), [
    'contractVersion', 'id', 'eventId', 'eventName', 'title', 'description',
    'status', 'layout', 'opensAt', 'closesAt', 'audienceTicketTypes', 'questions',
  ]);

  // Submitting with a declared NON-matching type is rejected; matching accepted;
  // undeclared accepted (the app only ever served it to a matching fan).
  const answers = [{ questionId: 'q_overall', rating: 4 }];
  const not = await call('POST /api/app/surveys/:id/responses', { params: { id: vipOnly.id }, body: { respondent: { howlerUserId: 'g1', ticketType: 'General' }, answers } });
  assert.equal(not.code, 400);
  assert.match(not.body.error, /VIP/);
  assert.equal((await call('POST /api/app/surveys/:id/responses', { params: { id: vipOnly.id }, body: { respondent: { howlerUserId: 'v1', ticketType: 'VIP' }, answers } })).code, 200);
  assert.equal((await call('POST /api/app/surveys/:id/responses', { params: { id: vipOnly.id }, body: { respondent: { howlerUserId: 'u0' }, answers } })).code, 200);
});

test('publishing overlapping audiences for one event returns a heads-up warning', async () => {
  const { owner } = seedClient();
  await makeLiveSurvey({ owner, eventId: '62001', extra: { audienceTicketTypes: ['VIP'] } });
  // Disjoint audience → no warning.
  const gen = await call('POST /api/my/surveys', { user: owner, body: { title: 'General survey', eventId: '62001', questions: CONTRACT_QUESTIONS, audienceTicketTypes: ['General'] } });
  const genPub = await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: gen.body.id } });
  assert.equal(genPub.body.warning, null);
  // Blanket survey overlaps BOTH live targeted ones → warning names them.
  const all = await call('POST /api/my/surveys', { user: owner, body: { title: 'Everyone survey', eventId: '62001', questions: CONTRACT_QUESTIONS } });
  const allPub = await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: all.body.id } });
  assert.match(allPub.body.warning, /also live for this event/);
  assert.match(allPub.body.warning, /VIP/);
  assert.match(allPub.body.warning, /General survey/);
});

// ── Responses: happy path, upsert, validation ─────────────────────────────────

test('POST response: contract shape in, { ok, responseId } out, upsert replaces', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19204' });
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
  const r = await call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.responseId, /^rsp_/);
  assert.deepEqual(Object.keys(r.body), ['ok', 'responseId']);
  // Resubmit → same responseId, still one row, answers replaced.
  const r2 = await call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id },
    body: { ...body, answers: [{ questionId: 'q_overall', type: 'rating', rating: 2 }] },
  });
  assert.equal(r2.body.responseId, r.body.responseId);
  const results = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id } })).body;
  assert.equal(results.responseCount, 1);
  assert.equal(results.questions[0].average, 2);
});

test('response validation: precise 400s', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19205' });
  const submit = (answers, respondent = { howlerUserId: 'u9' }) =>
    call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body: { respondent, answers } });
  assert.equal((await submit([{ questionId: 'q_overall', rating: 9 }])).code, 400);          // rating out of range
  assert.equal((await submit([{ questionId: 'q_overall', rating: 4.5 }])).code, 400);        // non-integer
  assert.equal((await submit([{ questionId: 'nope', rating: 4 }])).code, 400);               // unknown question
  assert.equal((await submit([{ questionId: 'q_fav', selectedIndex: 99 }])).code, 400);      // index out of range
  assert.equal((await submit([{ questionId: 'q_fav', selectedIndex: 0 }])).code, 400);       // missing required q_overall
  assert.equal((await submit([{ questionId: 'q_overall', rating: 4 }], {})).code, 400);      // no howlerUserId
  assert.equal((await submit([{ questionId: 'q_overall', rating: 4 }, { questionId: 'q_comments', text: 'x'.repeat(1001) }])).code, 400); // text cap
  // Unknown survey id → 404, not 400.
  assert.equal((await call('POST /api/app/surveys/:id/responses', { params: { id: 'srv_missing' }, body: {} })).code, 404);
});

test('option text is snapshotted onto stored answers (results + CSV read it back)', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19206' });
  await call('POST /api/app/surveys/:id/responses', {
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
  const res = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id } })).body;
  const fav = res.questions.find((q) => q.id === 'q_fav');
  assert.deepEqual(fav.options.find((o) => o.index === 1), { index: 1, text: 'Food & drink', count: 1 });
  const csv = (await call('GET /api/my/surveys/:id/results.csv', { user: owner, params: { id: s.id } })).text;
  assert.match(csv, /Food & drink/);
  assert.match(csv, /Parking; Sound/);
  assert.match(csv, /snap1/);
});

test('ticket type (contract v1.2): stored, sliced by day/type, filterable, drillable', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19214' });
  const submit = (uid, ticketType, rating, improve) => call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id },
    body: {
      respondent: { howlerUserId: uid, ticketType },
      answers: [{ questionId: 'q_overall', rating }, ...(improve ? [{ questionId: 'q_improve', selectedIndices: improve }] : [])],
    },
  });
  assert.equal((await submit('f1', 'General', 5, [0])).code, 200);
  assert.equal((await submit('f2', 'General', 3, [0, 2])).code, 200);
  assert.equal((await submit('f3', 'VIP', 4, null)).code, 200);
  assert.equal((await submit('f4', '', 2, null)).code, 200); // pre-v1.2 app build → Unknown

  const all = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id } })).body;
  assert.equal(all.responseCount, 4);
  assert.equal(all.byDay.length, 1); // all submitted today
  assert.equal(all.byDay[0].count, 4);
  assert.equal(all.byDay[0].avgRating, 3.5);
  assert.deepEqual(all.byTicketType.map((t) => [t.ticketType, t.count]), [['General', 2], ['VIP', 1], ['Unknown', 1]]);
  assert.deepEqual(all.ticketTypes, ['General', 'VIP', 'Unknown']);

  // Filter narrows the WHOLE report; the type breakdown stays whole-survey.
  const gen = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: s.id }, query: { ticketType: 'General' } })).body;
  assert.equal(gen.responseCount, 2);
  assert.equal(gen.totalResponseCount, 4);
  assert.equal(gen.filter.ticketType, 'General');
  assert.equal(gen.questions[0].average, 4); // (5+3)/2
  assert.equal(gen.byTicketType.length, 3);

  // Drill-down: who picked "Queues" (option 0 of q_improve)?
  const drill = (await call('GET /api/my/surveys/:id/responses', { user: owner, params: { id: s.id }, query: { questionId: 'q_improve', optionIndex: '0' } })).body;
  assert.equal(drill.total, 2);
  assert.deepEqual(drill.responses.map((r) => r.howlerUserId).sort(), ['f1', 'f2']);
  // …and only the VIPs who rated 4:
  const drill2 = (await call('GET /api/my/surveys/:id/responses', { user: owner, params: { id: s.id }, query: { questionId: 'q_overall', rating: '4', ticketType: 'VIP' } })).body;
  assert.deepEqual(drill2.responses.map((r) => r.howlerUserId), ['f3']);

  // CSV: ticket_type column present + filter respected.
  const csv = (await call('GET /api/my/surveys/:id/results.csv', { user: owner, params: { id: s.id }, query: { ticketType: 'VIP' } })).text;
  assert.match(csv.split('\n')[0], /ticket_type/);
  assert.match(csv.split('\n')[0], /email,ticket_type,channel/);
  assert.match(csv, /f3,,VIP,app/); // howler_user_id, (no email), ticket_type, channel
  assert.ok(!csv.includes('f1'));
});

test('channels: an email-only survey never reaches the app; results carry channel', async () => {
  const { owner } = seedClient();
  const emailOnly = await makeLiveSurvey({ owner, eventId: '63001', extra: { channels: ['email'] } });
  assert.deepEqual((await call('GET /api/app/surveys', { query: { eventId: '63001' } })).body, { surveys: [] });
  assert.equal((await call('GET /api/app/surveys/:id', { params: { id: emailOnly.id } })).code, 404);
  assert.equal((await call('POST /api/app/surveys/:id/responses', { params: { id: emailOnly.id }, body: { respondent: { howlerUserId: 'x' }, answers: [{ questionId: 'q_overall', rating: 4 }] } })).code, 404);
  assert.deepEqual(emailOnly.channels, ['email']);
  const appToo = await makeLiveSurvey({ owner, eventId: '63001' }); // default: all channels
  assert.deepEqual((await call('GET /api/app/surveys', { query: { eventId: '63001' } })).body.surveys.map((s) => s.id), [appToo.id]);
  assert.equal((await call('POST /api/my/surveys', { user: owner, body: { title: 'x', eventId: '63001', channels: [] } })).code, 400);
  // Channel filter narrows results (all these responses are channel 'app').
  await call('POST /api/app/surveys/:id/responses', { params: { id: appToo.id }, body: { respondent: { howlerUserId: 'c1' }, answers: [{ questionId: 'q_overall', rating: 5 }] } });
  const filtered = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: appToo.id }, query: { channel: 'email' } })).body;
  assert.equal(filtered.responseCount, 0);
  assert.equal(filtered.totalResponseCount, 1);
  assert.equal(filtered.filter.channel, 'email');
  const app = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: appToo.id }, query: { channel: 'app' } })).body;
  assert.equal(app.responseCount, 1);
});

test('event results: rollup across all of one event\'s surveys + long-format CSV', async () => {
  const { entity, owner } = seedClient();
  const vip = await makeLiveSurvey({ owner, eventId: '64001', extra: { audienceTicketTypes: ['VIP'] } });
  const gen = await makeLiveSurvey({ owner, eventId: '64001', extra: { audienceTicketTypes: ['General'] } });
  const submit = (sid, uid, ticketType, rating) => call('POST /api/app/surveys/:id/responses', {
    params: { id: sid }, body: { respondent: { howlerUserId: uid, ticketType }, answers: [{ questionId: 'q_overall', rating }, { questionId: 'q_comments', text: `note from ${uid}` }] },
  });
  assert.equal((await submit(vip.id, 'v1', 'VIP', 5)).code, 200);
  assert.equal((await submit(vip.id, 'v2', 'VIP', 4)).code, 200);
  assert.equal((await submit(gen.id, 'g1', 'General', 3)).code, 200);

  const r = (await call('GET /api/my/surveys/event-results', { user: owner, query: { entityId: entity.id, eventId: '64001' } })).body;
  assert.equal(r.responseCount, 3);
  assert.equal(r.avgRating, 4); // (5+4+3)/3
  assert.equal(r.byDay[0].count, 3);
  assert.deepEqual(r.byTicketType.map((t) => [t.ticketType, t.count]), [['VIP', 2], ['General', 1]]);
  assert.deepEqual(r.byChannel, [{ channel: 'app', count: 3 }]);
  assert.equal(r.surveys.length, 2);
  assert.equal(r.surveys.find((s) => s.id === vip.id).avgRating, 4.5);
  assert.equal(r.surveys.find((s) => s.id === gen.id).comments, 1);
  // Filter narrows the rollup too.
  const vipOnly = (await call('GET /api/my/surveys/event-results', { user: owner, query: { entityId: entity.id, eventId: '64001', ticketType: 'VIP' } })).body;
  assert.equal(vipOnly.responseCount, 2);
  // Long-format CSV: one row per ANSWER, survey + channel columns.
  const csv = (await call('GET /api/my/surveys/event-results.csv', { user: owner, query: { entityId: entity.id, eventId: '64001' } })).text;
  assert.match(csv.split('\n')[0], /survey,response_id.*channel.*question,answer/);
  assert.equal(csv.split('\n').length, 1 + 6); // header + 3 responses × 2 answers
  assert.match(csv, /note from g1/);
  // Outsiders blocked.
  const { outsider } = { outsider: null };
  assert.equal((await call('GET /api/my/surveys/event-results', { user: null, query: { entityId: entity.id, eventId: '64001' } })).code, 401);
});

// ── Lifecycle & immutability ──────────────────────────────────────────────────

test('published surveys are immutable; only closesAt may move while live', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19207' });
  const edit = await call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { title: 'Sneaky rename' } });
  assert.equal(edit.code, 409);
  const qEdit = await call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { questions: [] } });
  assert.equal(qEdit.code, 409);
  const extend = await call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { closesAt: '2999-01-01T00:00:00Z' } });
  assert.equal(extend.code, 200, JSON.stringify(extend.body));
  assert.equal(extend.body.closesAt, '2999-01-01T00:00:00.000Z');
  // Closed: nothing editable, but duplicate gives an editable draft copy.
  await call('POST /api/my/surveys/:id/close', { user: owner, params: { id: s.id } });
  assert.equal((await call('PUT /api/my/surveys/:id', { user: owner, params: { id: s.id }, body: { closesAt: null } })).code, 409);
  const dup = await call('POST /api/my/surveys/:id/duplicate', { user: owner, params: { id: s.id } });
  assert.equal(dup.body.status, 'draft');
  assert.equal(dup.body.title, 'How was Bushfire? (copy)');
  assert.deepEqual(dup.body.questions, CONTRACT_QUESTIONS);
});

test('publish requires questions + numeric event id; empty drafts stay draftable', async () => {
  const { owner } = seedClient();
  const bare = await call('POST /api/my/surveys', { user: owner, body: { title: 'WIP', eventId: '19208' } });
  assert.equal(bare.code, 200);
  assert.equal((await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: bare.body.id } })).code, 400);
  const badEvent = await call('POST /api/my/surveys', { user: owner, body: { title: 'x', eventId: 'not-a-number' } });
  assert.equal(badEvent.code, 400);
});

test('delete: drafts freely; surveys with responses refuse (close instead)', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19209' });
  await call('POST /api/app/surveys/:id/responses', {
    params: { id: s.id }, body: { respondent: { howlerUserId: 'keep' }, answers: [{ questionId: 'q_overall', rating: 3 }] },
  });
  assert.equal((await call('DELETE /api/my/surveys/:id', { user: owner, params: { id: s.id } })).code, 409);
  const draft = (await call('POST /api/my/surveys', { user: owner, body: { title: 'bin me', eventId: '19209' } })).body;
  assert.equal((await call('DELETE /api/my/surveys/:id', { user: owner, params: { id: draft.id } })).code, 200);
});

// ── Scope & permissions (the multi-tenant boundary) ───────────────────────────

test('my-routes: outsiders 403, viewers can see results but not manage', async () => {
  const { owner, viewer, outsider } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19210' });
  assert.equal((await call('PUT /api/my/surveys/:id', { user: outsider, params: { id: s.id }, body: { closesAt: null } })).code, 403);
  assert.equal((await call('GET /api/my/surveys/:id/results', { user: outsider, params: { id: s.id } })).code, 403);
  assert.equal((await call('GET /api/my/surveys/:id/results', { user: viewer, params: { id: s.id } })).code, 403); // viewer lacks campaigns.view
  assert.equal((await call('POST /api/my/surveys', { user: viewer, body: { title: 'x', eventId: '1' } })).code, 403);
  assert.equal((await call('POST /api/my/surveys', { user: null, body: {} })).code, 401);
  // My list only shows my entities' surveys.
  const mine = (await call('GET /api/my/surveys', { user: outsider })).body.surveys.map((x) => x.id);
  assert.ok(!mine.includes(s.id));
});

test('admin surface: full manage on any entity; wrong-entity survey id 404s', async () => {
  const { entity, owner, admin } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19211' });
  const list = await call('GET /api/admin/entities/:entityId/surveys', { user: admin, params: { entityId: entity.id } });
  assert.ok(list.body.surveys.some((x) => x.id === s.id));
  assert.equal((await call('GET /api/admin/entities/:entityId/surveys', { user: owner, params: { entityId: entity.id } })).code, 403);
  const other = makeEntity('Someone else', 'else-org');
  assert.equal((await call('GET /api/admin/entities/:entityId/surveys/:surveyId/results', { user: admin, params: { entityId: other.id, surveyId: s.id } })).code, 404);
});

// ── Kill switches ─────────────────────────────────────────────────────────────

test('engage.surveys flag off (the default) hides that client from the app', async () => {
  const { entity, owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19213' });
  setFlag(entity.id, 'off');
  try {
    assert.deepEqual((await call('GET /api/app/surveys', { query: { eventId: '19213' } })).body, { surveys: [] });
    assert.equal((await call('GET /api/app/surveys/:id', { params: { id: s.id } })).code, 404);
    const r = await call('POST /api/app/surveys/:id/responses', {
      params: { id: s.id },
      body: { respondent: { howlerUserId: 'u1' }, answers: [{ questionId: 'q_overall', rating: 5 }] },
    });
    assert.equal(r.code, 404);
  } finally {
    setFlag(entity.id, 'on');
  }
});

test('surveys_enabled=0 hides the public surface', async () => {
  const { owner } = seedClient();
  const s = await makeLiveSurvey({ owner, eventId: '19212' });
  db.setSetting('surveys_enabled', '0');
  try {
    assert.equal((await call('GET /api/app/surveys', { query: { eventId: '19212' } })).code, 404);
    assert.equal((await call('GET /api/app/surveys/:id', { params: { id: s.id } })).code, 404);
    assert.equal((await call('POST /api/app/surveys/:id/responses', { params: { id: s.id }, body: {} })).code, 404);
  } finally {
    db.setSetting('surveys_enabled', '1');
  }
});
