// Loyalty phase 1 — the identity handshake (server/loyalty.js): the OTP flow's
// gates (validation, rate limits, attempts, expiry), the derived-profile maths,
// the fail-closed organiser scope on the history lookup, consent staying
// untouched by verification, and the flag-gated verified chip on /api/fan/boot.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');
const rateLimit = require('../server/ratelimit');
const { errorMiddleware } = require('../server/http');
const { createLoyalty, deriveProfile } = require('../server/loyalty');

delete process.env.ANTHROPIC_API_KEY; // never call out from tests
process.env.FANOWL_ADMIN_ALLOW = 'all'; // open the settings dogfood gate for the preview test

// ── deriveProfile (pure) ─────────────────────────────────────────────────────────
const row = (ev, date, type, sold, rev, cur = 'ZAR', count = sold) => ({
  'core_events.name': ev, 'core_events.start_date': date, 'core_events.currency': cur,
  'core_ticket_types.name': type, 'core_tickets.sold_tickets': sold, 'core_tickets.count': count,
  'core_tickets.sum_revenue_decimal': rev,
});

test('deriveProfile: no history → new tier, no signals', () => {
  const d = deriveProfile([]);
  assert.equal(d.tier, 'new');
  assert.equal(d.signals.group_buyer, false);
  assert.equal(d.traits.eventsCount, 0);
});

test('deriveProfile: the ladder — 1 → returning, 2 → loyal, 4+ → superfan', () => {
  assert.equal(deriveProfile([row('Fest A', '2025-08-01', 'GA', 1, 950)]).tier, 'returning');
  const d = deriveProfile([row('Fest A', '2025-08-01', 'GA', 1, 950), row('Fest B', '2024-08-01', 'GA', 2, 1800)]);
  assert.equal(d.tier, 'loyal');
  assert.equal(d.traits.eventsCount, 2);
  assert.equal(d.traits.totalTickets, 3);
  assert.equal(d.traits.totalSpend, 2750);
  assert.equal(d.traits.lastEvent.name, 'Fest A'); // most recent by start_date
  const superfan = deriveProfile([1, 2, 3, 4].map((y) => row(`Fest ${y}`, `202${y}-08-01`, 'GA', 1, 950)));
  assert.equal(superfan.tier, 'superfan');
});

test('deriveProfile: streak counts CONSECUTIVE years from the most recent; gaps break it', () => {
  const streak = deriveProfile([row('F26', '2026-08-01', 'GA', 1, 1), row('F25', '2025-08-01', 'GA', 1, 1), row('F24', '2024-08-01', 'GA', 1, 1)]);
  assert.equal(streak.traits.streakYears, 3);
  const gap = deriveProfile([row('F26', '2026-08-01', 'GA', 1, 1), row('F23', '2023-08-01', 'GA', 1, 1)]);
  assert.equal(gap.traits.streakYears, 1); // 2023 doesn't chain to 2026
  assert.equal(deriveProfile([]).traits.streakYears, 0);
});

test('deriveProfile: 4+ tickets at one event → group_buyer; favourite type by volume', () => {
  const d = deriveProfile([
    row('Fest A', '2025-08-01', 'GA', 4, 3800),
    row('Fest A', '2025-08-01', 'VIP', 1, 1500),
  ]);
  assert.equal(d.signals.group_buyer, true);
  assert.equal(d.traits.favTicketType, 'GA');
  assert.equal(d.traits.maxTicketsOneEvent, 5);
  assert.equal(d.traits.currency, 'ZAR');
  // Itemised history: event × ticket-type grain, biggest type first.
  assert.deepEqual(d.traits.history[0].types, ['4× GA', '1× VIP']);
});

test('deriveProfile: zero-ticket rows (refund noise) do not count as events', () => {
  const d = deriveProfile([row('Fest A', '2025-08-01', 'GA', 0, 0)]);
  assert.equal(d.tier, 'new');
});

test('deriveProfile: a comp ticket still counts as attendance (sold=0, count=1)', () => {
  const d = deriveProfile([row('Fest A', '2025-08-01', 'GA', 0, 0, 'ZAR', 1)]);
  assert.equal(d.tier, 'returning');
  assert.equal(d.traits.totalTickets, 1);
  assert.equal(d.traits.totalSpend, 0);
  // …but the paid view stays separate, so reward pools can exclude comps.
  assert.equal(d.traits.paidEventsCount, 0);
  assert.equal(d.signals.comp_guest, true);
});

// ── The OTP flow + profile cache (against the real test DB) ─────────────────────
let app, entity, entityNoLock, site, loyalty, sent, lookerCalls, lookerRows;
const mkSession = () => {
  const id = crypto.randomUUID();
  h.db.db.prepare('INSERT INTO fan_sessions (id,site_id,anon_id,page_url,created_at) VALUES (?,?,?,?,?)')
    .run(id, site.id, '', '', new Date().toISOString());
  return h.db.db.prepare('SELECT * FROM fan_sessions WHERE id = ?').get(id);
};
const crypto = require('crypto');
const stubMailer = { isConfigured: () => true, send: async (m) => { sent.push(m); } };
const stubRunQuery = async (path, body) => { lookerCalls.push(body); return lookerRows; };
const codeFrom = (m) => (m.subject.match(/^(\d{6}) /) || [])[1];

before(async () => {
  entity = h.makeEntity('Loyalty Fest', 'Test Organiser');
  entityNoLock = h.makeEntity('Unscoped Client', null);
  app = await startApp((expressApp) => {
    const mounted = require('../server/fanOwl').mount(expressApp, {
      db: h.db, auth: h.auth, insights: require('../server/insights'), rateLimit,
      anthropicKeyForEntity: () => '',
    });
    mounted.saveConfig(entity.id, { sites: [{ name: 'Loyalty Fest', enabled: true, domains: [] }] });
    site = h.db.db.prepare('SELECT * FROM fan_sites WHERE entity_id = ?').get(entity.id);
    expressApp.use(errorMiddleware);
  });
  loyalty = createLoyalty({ db: h.db, auth: h.auth, mailer: stubMailer, runQuery: stubRunQuery });
});
after(async () => { if (app) await app.close(); });

test('startVerification: validates the email and sends a 6-digit code', async () => {
  sent = []; lookerCalls = [];
  const session = mkSession();
  const bad = await loyalty.startVerification(site, session, { email: 'not-an-email' });
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'bad_email');
  const r = await loyalty.startVerification(site, session, { email: 'Thandi@Example.com' });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'thandi@example.com'); // normalised
  assert.match(codeFrom(sent[0]), /^\d{6}$/);
  assert.ok(sent[0].text.includes(codeFrom(sent[0])));
});

test('confirmVerification: wrong code fails, right code verifies + derives the profile', async () => {
  sent = []; lookerCalls = [];
  lookerRows = [row('Fest A', '2025-08-01', 'GA', 4, 3800), row('Fest B', '2024-08-01', 'VIP', 1, 1500)];
  const session = mkSession();
  await loyalty.startVerification(site, session, { email: 'sipho@example.com' });
  const code = codeFrom(sent[0]);
  const wrong = await loyalty.confirmVerification(site, session, { code: code === '000000' ? '000001' : '000000' });
  assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'wrong_code');
  const r = await loyalty.confirmVerification(site, session, { code });
  assert.equal(r.ok, true);
  assert.equal(r.profile.tier, 'loyal');
  assert.equal(r.profile.signals.group_buyer, true);
  assert.equal(r.profile.favTicketType, 'GA');
  // The history query ran ONCE, scoped to the fan's email AND the organiser lock.
  assert.equal(lookerCalls.length, 1);
  assert.equal(lookerCalls[0].filters['core_purchasers.email'], 'sipho@example.com');
  assert.equal(lookerCalls[0].filters[h.ORG_FIELD], 'Test Organiser');
  // Session linked; profile verified; consent UNTOUCHED by verification.
  const p = h.db.db.prepare('SELECT * FROM fan_profiles WHERE entity_id = ? AND email = ?').get(entity.id, 'sipho@example.com');
  assert.ok(p.verified_at);
  assert.equal(p.consent_marketing, 0);
  assert.equal(h.db.db.prepare('SELECT profile_id FROM fan_sessions WHERE id = ?').get(session.id).profile_id, p.id);
  // …and the session now reads as verified with a cached tier.
  assert.equal(loyalty.verifiedProfile(session).tier, 'loyal');
  assert.match(loyalty.contextBlock(site, session), /VERIFIED FAN/);
  assert.match(loyalty.contextBlock(site, session), /loyal/);
});

test('no organiser lock on the entity → history lookup fails CLOSED (no query at all)', async () => {
  sent = []; lookerCalls = [];
  const unscopedSite = { id: 'site-x', entity_id: entityNoLock.id, name: 'Unscoped' };
  const session = mkSession(); // session's site doesn't matter for the lib calls
  await loyalty.startVerification(unscopedSite, session, { email: 'lerato@example.com' });
  const r = await loyalty.confirmVerification(unscopedSite, session, { code: codeFrom(sent[0]) });
  assert.equal(r.ok, true);
  assert.equal(lookerCalls.length, 0); // never queried without an organiser scope
  assert.equal(r.profile.tier, 'new');
  assert.equal(r.profile.historyUnavailable, true);
});

test('rate limits: 3 codes per session per 10 minutes, then back off', async () => {
  sent = [];
  const session = mkSession();
  for (let i = 0; i < 3; i++) assert.equal((await loyalty.startVerification(site, session, { email: `rl${i}@example.com` })).ok, true);
  const r4 = await loyalty.startVerification(site, session, { email: 'rl4@example.com' });
  assert.equal(r4.ok, false); assert.equal(r4.reason, 'rate_limited');
});

test('attempts lock after 5 wrong guesses; expired codes are dead; resend recovers', async () => {
  sent = [];
  const session = mkSession();
  await loyalty.startVerification(site, session, { email: 'guess@example.com' });
  for (let i = 0; i < 5; i++) await loyalty.confirmVerification(site, session, { code: '999999' });
  const locked = await loyalty.confirmVerification(site, session, { code: codeFrom(sent[0]) });
  assert.equal(locked.ok, false); assert.equal(locked.reason, 'locked');
  // Expiry: age the latest pending row out.
  await loyalty.startVerification(site, session, { email: 'guess@example.com' });
  h.db.db.prepare("UPDATE fan_verifications SET expires_at = ? WHERE session_id = ? AND verified_at = ''")
    .run(new Date(Date.now() - 60_000).toISOString(), session.id);
  const expired = await loyalty.confirmVerification(site, session, { code: codeFrom(sent[1]) });
  assert.equal(expired.ok, false); assert.equal(expired.reason, 'expired');
});

test('staging test code: works ONLY with the outbound brake on; no email sent', async () => {
  sent = []; lookerCalls = []; lookerRows = [];
  const noMailer = { isConfigured: () => false, send: async () => { throw new Error('must not send'); } };
  const l2 = createLoyalty({ db: h.db, auth: h.auth, mailer: noMailer, runQuery: stubRunQuery });
  // Test code WITHOUT the outbound brake → ignored (fails closed, like prod).
  process.env.FAN_OTP_TEST_CODE = '424242';
  delete process.env.OUTBOUND_DISABLED;
  const s1 = mkSession();
  assert.equal((await l2.startVerification(site, s1, { email: 'qa@howler.co.za' })).reason, 'unavailable');
  // Brake on + test code → verifies with the shared code, zero sends.
  process.env.OUTBOUND_DISABLED = '1';
  const s2 = mkSession();
  const start = await l2.startVerification(site, s2, { email: 'qa@howler.co.za' });
  assert.equal(start.ok, true); assert.equal(start.sent, false);
  assert.equal((await l2.confirmVerification(site, s2, { code: '123456' })).reason, 'wrong_code');
  assert.equal((await l2.confirmVerification(site, s2, { code: '424242' })).ok, true);
  delete process.env.OUTBOUND_DISABLED; delete process.env.FAN_OTP_TEST_CODE;
});

test('context preview returns the EXACT chat instructions (admin, per site)', async () => {
  const admin = h.makeAdmin('loyalty-admin@test.local');
  const r = await app.req('GET', `/api/admin/entities/${entity.id}/fan-owl/context-preview?url=https://fest.example/`, { as: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.siteId, site.id);
  assert.match(r.body.instructions, /EVENT CONTEXT: Loyalty Fest/);
  assert.match(r.body.instructions, /CATALOGUE/);
  assert.match(r.body.system, /booking guide|the Owl/i);
  // Anonymous callers never see it.
  assert.equal((await app.req('GET', `/api/admin/entities/${entity.id}/fan-owl/context-preview`)).status, 401);
});

test('unverified + flag on → the proactive-offer rules + turn counter reach the context', async () => {
  const flags = require('../server/flags');
  flags.init(h.db);
  h.db.db.prepare('INSERT OR REPLACE INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?)')
    .run(entity.id, 'fanowl.loyalty', 'on', 'test', new Date().toISOString());
  const admin = h.makeAdmin('loyalty-admin2@test.local');
  const r = await app.req('GET', `/api/admin/entities/${entity.id}/fan-owl/context-preview`, { as: admin });
  assert.match(r.body.instructions, /PROACTIVE OFFER/);
  assert.match(r.body.instructions, /REWARD-CHECK STATE: this fan is UNVERIFIED; the message you are answering is fan message #1/);
  // Leave the flag as we found it — the defaults-off test below depends on it.
  h.db.db.prepare('DELETE FROM feature_flags WHERE entity_id = ? AND flag = ?').run(entity.id, 'fanowl.loyalty');
});

// ── Flag gating + the boot chip ──────────────────────────────────────────────────
test('fanowl.loyalty defaults OFF; boot omits the chip until flag on + verified', async () => {
  const flags = require('../server/flags');
  flags.init(h.db);
  assert.equal(flags.enabled(entity.id, 'fanowl.loyalty'), false); // default off
  const ctx = (await app.req('POST', '/api/fan/context', { body: { siteKey: site.site_key, url: 'https://fest.example/' } })).body;
  const boot = async () => (await app.req('GET', `/api/fan/boot?sid=${ctx.sessionId}`)).body;
  assert.equal((await boot()).verified ?? null, null); // flag off → no chip
  h.db.db.prepare('INSERT OR REPLACE INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?)')
    .run(entity.id, 'fanowl.loyalty', 'on', 'test', new Date().toISOString());
  assert.equal(flags.enabled(entity.id, 'fanowl.loyalty'), true);
  assert.equal((await boot()).verified, null); // flag on, session unverified → null
  sent = []; lookerCalls = []; lookerRows = [row('Fest A', '2025-08-01', 'GA', 1, 950)];
  const session = h.db.db.prepare('SELECT * FROM fan_sessions WHERE id = ?').get(ctx.sessionId);
  await loyalty.startVerification(site, session, { email: 'chip@example.com' });
  await loyalty.confirmVerification(site, session, { code: codeFrom(sent[0]) });
  const b = await boot();
  assert.deepEqual(b.verified, { email: 'chip@example.com', tier: 'returning' });
});
