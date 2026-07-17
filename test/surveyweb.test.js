// Survey email/web channel (server/surveyWeb.js) — personalised link minting
// (idempotent, suppression/targeting-aware), branded email sends via the stub
// mailer, the PUBLIC hosted page + token submit route (identity always from the
// LINK, channel email/web), share links, and the channel split in results.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const surveysMod = require('../server/surveys');
const surveyWeb = require('../server/surveyWeb');
const flags = require('../server/flags');
const rateLimit = require('../server/ratelimit');

flags.init(db);
const setFlag = (entityId, value) => db.db
  .prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?, 'engage.surveys', ?, 'test', ?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value")
  .run(entityId, value, new Date().toISOString());

const lookupEvent = async (eventId) => ({ ok: true, name: `Howler Event ${eventId}`, ticketTypes: [] });
const sentMails = [];
const mailerStub = {
  baseUrl: () => 'https://pulse.test',
  resolveBranding: () => ({ brandColor: '#FF385C', secondaryColor: '#FF6B35', wordmark: 'Test Org', senderName: 'Test Org', logo: '', footer: '' }),
  notificationEmail: ({ title, body, ctaPath }) => ({ html: `<a href="https://pulse.test${ctaPath}">${title}</a>`, text: `${title}\n${body}\nhttps://pulse.test${ctaPath}` }),
  send: async ({ to }) => (String(to).includes('bounce@') ? { skipped: true, reason: 'suppressed (bounced)' } : (sentMails.push(to), { ok: true, id: 'm_' + sentMails.length })),
};

// Segment stub: 'seg_ok' resolves to two consenting members + one without
// email consent + one with no address; anything else is unknown.
const segmentsStub = {
  resolveSegment: async (entityId, segmentId) => (segmentId === 'seg_ok'
    ? { list: [
        { email: 'seg1@fans.test', name: 'Seg One', ticket: 'VIP', emailOk: true },
        { email: 'seg2@fans.test', name: 'Seg Two', ticket: '', emailOk: true },
        { email: 'noconsent@fans.test', name: 'No Consent', emailOk: false },
        { email: '', name: 'No Address', emailOk: true },
      ] }
    : null),
};

const routes = {};
{
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  const surveys = surveysMod.mount(app, { db, auth, rateLimit, lookupEvent });
  surveyWeb.mount(app, { db, auth, rateLimit, mailer: mailerStub, surveys, getSegmentsApi: () => segmentsStub });
}

async function call(key, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload, text;
  const res = {
    status(c) { code = c; return res; },
    json(d) { payload = d; return res; },
    send(d) { text = d; return res; },
    set() { return res; },
  };
  try {
    await routes[key]({ user, params, body, query, ip: '9.9.9.9' }, res);
  } catch (e) {
    code = Number.isInteger(e.status) ? e.status : 500;
    payload = { error: e.expose || (code >= 400 && code < 500) ? e.message : 'Something went wrong on our end.' };
  }
  return { code, body: payload, text };
}

const QUESTIONS = [
  { id: 'q_overall', type: 'rating', text: 'Rate the event', required: true },
  { id: 'q_comments', type: 'text', text: 'Anything else?', required: false },
];

let seq = 100;
async function seedLive({ audience } = {}) {
  seq += 1;
  const entity = makeEntity(`WebOrg ${seq}`, `weborg-${seq}`);
  setFlag(entity.id, 'on');
  const owner = makeClient(`webowner-${seq}@test.local`, [entity.id], 'owner');
  const outsider = makeClient(`webout-${seq}@test.local`, [makeEntity(`WebRival ${seq}`, `webrival-${seq}`).id], 'owner');
  const created = await call('POST /api/my/surveys', {
    user: owner,
    body: { title: `Web survey ${seq} <script>`, description: 'Two minutes.', eventId: String(70000 + seq), questions: QUESTIONS, ...(audience ? { audienceTicketTypes: audience } : {}) },
  });
  assert.equal(created.code, 200, JSON.stringify(created.body));
  const pub = await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: created.body.id } });
  assert.equal(pub.code, 200, JSON.stringify(pub.body));
  return { entity, owner, outsider, survey: pub.body };
}

test('email send: mints idempotent personal links, skips invalid + suppressed', async () => {
  const { owner, survey } = await seedLive();
  const r = await call('POST /api/my/surveys/:id/email', {
    user: owner, params: { id: survey.id },
    body: { recipients: [
      { email: 'thandi@fans.test', displayName: 'Thandi', ticketType: 'VIP' },
      { email: 'THANDI@fans.test' },              // dupe (case-insensitive)
      { email: 'not-an-email' },                  // invalid
      { email: 'bounce@fans.test' },              // mailer suppression
    ] },
  });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.skipped.length, 2);
  const url1 = r.body.links.find((l) => l.email === 'thandi@fans.test').url;
  assert.match(url1, /^https:\/\/pulse\.test\/s\/svl_/);
  // Resend → same link, no duplicate row.
  const again = await call('POST /api/my/surveys/:id/email', {
    user: owner, params: { id: survey.id }, body: { recipients: [{ email: 'thandi@fans.test' }] },
  });
  assert.equal(again.body.links.find((l) => l.email === 'thandi@fans.test').url, url1);
  const links = await call('GET /api/my/surveys/:id/links', { user: owner, params: { id: survey.id } });
  assert.equal(links.body.links.filter((l) => l.email === 'thandi@fans.test').length, 1);
});

test('targeted surveys refuse recipients with a non-matching ticket type', async () => {
  const { owner, survey } = await seedLive({ audience: ['VIP'] });
  const r = await call('POST /api/my/surveys/:id/email', {
    user: owner, params: { id: survey.id },
    body: { recipients: [{ email: 'gen@fans.test', ticketType: 'General' }, { email: 'vip@fans.test', ticketType: 'VIP' }] },
  });
  assert.equal(r.body.sent, 1);
  assert.match(r.body.skipped[0].reason, /targets VIP/);
});

test('segment audience: preview counts emailable members; send mints + mails only them', async () => {
  const { owner, survey } = await seedLive();
  const before = sentMails.length;
  const preview = await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: survey.id }, body: { segmentId: 'seg_ok', preview: true } });
  assert.equal(preview.code, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.count, 2); // consent-less + address-less members excluded
  assert.match(preview.body.sample[0], /…@fans\.test$/); // masked
  const send = await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: survey.id }, body: { segmentId: 'seg_ok' } });
  assert.equal(send.body.sent, 2);
  assert.equal(sentMails.length, before + 2);
  // Ticket type rode in from the segment row → tagged on the link.
  const links = await call('GET /api/my/surveys/:id/links', { user: owner, params: { id: survey.id } });
  assert.equal(links.body.links.find((l) => l.email === 'seg1@fans.test').ticketType, 'VIP');
  assert.equal(links.body.sent, 2);
  // Unknown segment → 404.
  assert.equal((await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: survey.id }, body: { segmentId: 'seg_nope' } })).code, 404);
});

test('hosted page: renders escaped survey, marks opened; junk/draft tokens 404; closed 409', async () => {
  const { owner, survey } = await seedLive();
  const mint = await call('POST /api/my/surveys/:id/email', {
    user: owner, params: { id: survey.id }, body: { recipients: [{ email: 'page@fans.test', displayName: 'Pagey' }], send: false },
  });
  const token = mint.body.links[0].url.split('/s/')[1];
  const page = await call('GET /s/:token', { params: { token } });
  assert.equal(page.code, 200);
  assert.match(page.text, /Web survey \d+ &lt;script&gt;/); // client-authored text is escaped
  assert.match(page.text, /Rate the event/);
  const links = await call('GET /api/my/surveys/:id/links', { user: owner, params: { id: survey.id } });
  assert.equal(links.body.opened, 1);
  assert.equal((await call('GET /s/:token', { params: { token: 'svl_junk' } })).code, 404);
  await call('POST /api/my/surveys/:id/close', { user: owner, params: { id: survey.id } });
  assert.equal((await call('GET /s/:token', { params: { token } })).code, 409);
});

test('personal-token submit: identity from the LINK, channel=email, upsert per fan', async () => {
  const { owner, survey } = await seedLive();
  const mint = await call('POST /api/my/surveys/:id/email', {
    user: owner, params: { id: survey.id },
    body: { recipients: [{ email: 'fan@fans.test', displayName: 'Fan', ticketType: 'VIP' }], send: false },
  });
  const token = mint.body.links[0].url.split('/s/')[1];
  const submit = (rating) => call('POST /api/s/:token/responses', {
    params: { token },
    // Browser-supplied identity must be IGNORED — only answers count.
    body: { answers: [{ questionId: 'q_overall', rating }], respondent: { howlerUserId: 'spoofed', email: 'evil@x.test' } },
  });
  const r1 = await submit(5);
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  const r2 = await submit(3);
  assert.equal(r2.body.responseId, r1.body.responseId); // upsert per link/fan
  const results = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: survey.id } })).body;
  assert.equal(results.responseCount, 1);
  assert.deepEqual(results.byChannel, [{ channel: 'email', count: 1 }]);
  assert.deepEqual(results.byTicketType.map((t) => t.ticketType), ['VIP']);
  const drill = (await call('GET /api/my/surveys/:id/responses', { user: owner, params: { id: survey.id } })).body;
  assert.equal(drill.responses[0].email, 'fan@fans.test');
  assert.equal(drill.responses[0].channel, 'email');
  assert.equal(drill.responses[0].howlerUserId, 'email:fan@fans.test');
  // Required-question validation still applies through the token route.
  const bad = await call('POST /api/s/:token/responses', { params: { token }, body: { answers: [] } });
  assert.equal(bad.code, 400);
  // Link marked responded.
  assert.equal((await call('GET /api/my/surveys/:id/links', { user: owner, params: { id: survey.id } })).body.responded, 1);
});

test('share link: one per survey, anonymous visitors keyed by visitorId, channel=web', async () => {
  const { owner, survey } = await seedLive();
  const s1 = await call('POST /api/my/surveys/:id/share-link', { user: owner, params: { id: survey.id } });
  const s2 = await call('POST /api/my/surveys/:id/share-link', { user: owner, params: { id: survey.id } });
  assert.equal(s1.body.url, s2.body.url);
  const token = s1.body.url.split('/s/')[1];
  const submit = (visitorId, rating) => call('POST /api/s/:token/responses', { params: { token }, body: { visitorId, answers: [{ questionId: 'q_overall', rating }] } });
  assert.equal((await submit('visitor-a', 4)).code, 200);
  assert.equal((await submit('visitor-b', 2)).code, 200);
  const dup = await submit('visitor-a', 5); // same visitor → upsert
  const results = (await call('GET /api/my/surveys/:id/results', { user: owner, params: { id: survey.id } })).body;
  assert.equal(results.responseCount, 2);
  assert.deepEqual(results.byChannel, [{ channel: 'web', count: 2 }]);
  assert.ok(dup.body.ok);
});

test('management guards: outsiders 403, drafts cannot be emailed', async () => {
  const { owner, outsider, survey } = await seedLive();
  assert.equal((await call('POST /api/my/surveys/:id/email', { user: outsider, params: { id: survey.id }, body: { recipients: [{ email: 'x@y.test' }] } })).code, 403);
  assert.equal((await call('GET /api/my/surveys/:id/links', { user: outsider, params: { id: survey.id } })).code, 403);
  const draft = await call('POST /api/my/surveys', { user: owner, body: { title: 'Draft', eventId: '70999', questions: QUESTIONS } });
  assert.equal((await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: draft.body.id }, body: { recipients: [{ email: 'x@y.test' }] } })).code, 409);
});

test('channel switches gate the web surface: app-only surveys have no email/share', async () => {
  seq += 1000;
  const entity = makeEntity(`ChanOrg ${seq}`, `chanorg-${seq}`);
  setFlag(entity.id, 'on');
  const owner = makeClient(`chanowner-${seq}@test.local`, [entity.id], 'owner');
  const created = await call('POST /api/my/surveys', {
    user: owner, body: { title: 'App only', eventId: String(80000 + seq), questions: QUESTIONS, channels: ['app'] },
  });
  await call('POST /api/my/surveys/:id/publish', { user: owner, params: { id: created.body.id } });
  const mail = await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: created.body.id }, body: { recipients: [{ email: 'a@b.test' }] } });
  assert.equal(mail.code, 409);
  assert.match(mail.body.error, /Email channel/);
  assert.equal((await call('POST /api/my/surveys/:id/share-link', { user: owner, params: { id: created.body.id } })).code, 409);
});

test('flag off hides the hosted page too', async () => {
  const { entity, owner, survey } = await seedLive();
  const mint = await call('POST /api/my/surveys/:id/email', { user: owner, params: { id: survey.id }, body: { recipients: [{ email: 'f@f.test' }], send: false } });
  const token = mint.body.links[0].url.split('/s/')[1];
  setFlag(entity.id, 'off');
  try {
    assert.equal((await call('GET /s/:token', { params: { token } })).code, 404);
    assert.equal((await call('POST /api/s/:token/responses', { params: { token }, body: { answers: [] } })).code, 404);
  } finally { setFlag(entity.id, 'on'); }
});
