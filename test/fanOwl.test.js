// Route-level pins for the fan-facing Owl (server/fanOwl.js): the dual-surface
// config gates (admin + /api/my with entity ownership), the public widget boot
// (site key + origin allowlist + session mint), page→offer mapping, the
// consent-first lead capture rules, and the event funnel. The chat loop itself is
// pinned only up to its gates (no live model in tests).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');
const rateLimit = require('../server/ratelimit');
const { errorMiddleware } = require('../server/http');

delete process.env.ANTHROPIC_API_KEY; // chat must 503 (unconfigured), never call out
process.env.FANOWL_ADMIN_ALLOW = 'all'; // open the dogfood gate for these tests (re-locked in its own test)

let app;
before(async () => {
  app = await startApp((expressApp) => {
    require('../server/fanOwl').mount(expressApp, {
      db: h.db, auth: h.auth, insights: require('../server/insights'), rateLimit,
      anthropicKeyForEntity: () => '',
    });
    expressApp.use(errorMiddleware);
  });
});
after(async () => { if (app) await app.close(); });

const CONFIG = (site = {}) => ({
  sites: [{ name: 'Test site', enabled: true, domains: ['fest.example'], teaser: 'Tickets are live',
    owlName: 'Kappa Guide', owlAvatar: 'https://fest.example/owl.png', owlIntro: 'Ciao! Ask me anything', persona: 'cheeky, proudly local', guardrails: 'always mention the waiting list when sold out', defaultLang: 'it', widgetTheme: 'dark', navStyle: 'pills', pages: [
    { urlPattern: '/artists/*', pageType: 'artist', itemIds: [], note: 'artist pages', content: 'Artists play across two stages; day passes cover that day only.', starters: ['Who plays Saturday?'], pitch: 'Catch every artist with a Weekend Pass' },
  ], ...site }],
  catalogue: [
    { label: 'Weekend Pass', kind: 'ticket', price: '950', currency: 'ZAR', deepLink: 'https://fest.example/buy?t=wk', availability: 'selling fast', public: true },
    { label: 'Camping', kind: 'addon', price: '300', currency: 'ZAR', deepLink: 'https://fest.example/buy?t=camp', public: true, images: ['https://fest.example/img/camp1.jpg', 'not-a-url'] },
    { label: 'Glamping Pod', kind: 'accommodation', price: '1500', currency: 'ZAR', deepLink: 'https://fest.example/buy?t=pod', public: true },
    { label: 'Crew comp', kind: 'ticket', price: '0', currency: 'ZAR', deepLink: '', public: false },
  ],
  knowledge: [
    { kind: 'policy', question: 'What is the refund policy?', body: 'Tickets are refundable until 30 days before the event.' },
    { kind: 'faq', question: 'Can I bring kids?', body: 'Under-12s enter free with a ticketed adult.' },
    { kind: 'tip', question: 'East gate', body: 'The east gate has no queue after 6pm.' },
  ],
});

test('config routes: admin-only on /api/admin, entity-ownership on /api/my', async () => {
  const e = h.makeEntity('FanCfg Co', 'fancfg-org');
  const other = h.makeEntity('FanOther Co', 'fanother-org');
  const client = h.makeClient('fan-cfg@test.local', [e.id], 'owner');
  assert.equal((await app.req('GET', `/api/admin/entities/${e.id}/fan-owl`)).status, 401);
  assert.equal((await app.req('GET', `/api/admin/entities/${e.id}/fan-owl`, { as: client })).status, 403);
  assert.equal((await app.req('GET', `/api/my/fan-owl/${e.id}`, { as: client })).status, 200);
  assert.equal((await app.req('GET', `/api/my/fan-owl/${other.id}`, { as: client })).status, 403);
  assert.equal((await app.req('PUT', `/api/my/fan-owl/${other.id}`, { as: client, body: CONFIG() })).status, 403);
});

test('save: site key minted server-side, domains normalised, public flag + non-public items kept', async () => {
  const e = h.makeEntity('FanSave Co', 'fansave-org');
  const admin = h.makeAdmin('fan-admin@test.local');
  const body = CONFIG({ domains: ['https://Fest.Example/some/path', 'fest.example'] });
  const r = await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body });
  assert.equal(r.status, 200);
  const site = r.body.sites[0];
  assert.match(site.siteKey, /^fw_[0-9a-f]{24}$/);
  assert.deepEqual(site.domains, ['fest.example']); // scheme/path stripped, deduped
  assert.equal(site.pages.length, 1);
  assert.match(site.pages[0].content, /two stages/); // page info round-trips
  assert.deepEqual(site.pages[0].starters, ['Who plays Saturday?']); // per-page chips round-trip
  assert.deepEqual(r.body.catalogue.find((c) => c.label === 'Camping').images, ['https://fest.example/img/camp1.jpg']); // non-URL dropped
  assert.equal(r.body.catalogue.length, 4);
  assert.equal(r.body.catalogue.find((c) => c.label === 'Crew comp').public, false);
  assert.equal(r.body.catalogue.find((c) => c.label === 'Glamping Pod').kind, 'accommodation'); // new kinds round-trip
  assert.equal(site.pages[0].pitch, 'Catch every artist with a Weekend Pass'); // pitch round-trips
  assert.equal(r.body.knowledge.length, 3);
  assert.equal(r.body.knowledge.find((k) => k.kind === 'tip').body, 'The east gate has no queue after 6pm.'); // tips are knowledge entries
  // Personality round-trips; a non-URL avatar is dropped, not stored.
  assert.equal(site.owlName, 'Kappa Guide');
  assert.equal(site.owlAvatar, 'https://fest.example/owl.png');
  assert.equal(site.owlIntro, 'Ciao! Ask me anything');
  assert.equal(site.persona, 'cheeky, proudly local');
  assert.equal(site.guardrails, 'always mention the waiting list when sold out');
  assert.equal(site.defaultLang, 'it');
  assert.equal(site.widgetTheme, 'dark');
  assert.equal(site.navStyle, 'pills');
  assert.ok(r.body.inherited.brandColor); // the editor's "blank adopts your brand" hint
  const junk = await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [{ ...site, owlAvatar: 'javascript:alert(1)', defaultLang: 'x!!', widgetTheme: 'neon', navStyle: 'sideways' }] } });
  assert.equal(junk.body.sites[0].owlAvatar, '');
  assert.equal(junk.body.sites[0].defaultLang, ''); // junk codes dropped
  assert.equal(junk.body.sites[0].widgetTheme, ''); // unknown theme → auto
  assert.equal(junk.body.sites[0].navStyle, ''); // unknown nav style → default
  // Saving again with the same site id keeps the key stable.
  const r2 = await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [{ ...site, name: 'Renamed' }] } });
  assert.equal(r2.body.sites[0].siteKey, site.siteKey);
  assert.equal(r2.body.sites[0].name, 'Renamed');
});

async function provision(orgSuffix, siteOverrides = {}) {
  const e = h.makeEntity(`FanProv${orgSuffix} Co`, `fanprov-${orgSuffix}`);
  const admin = h.makeAdmin(`fan-prov-${orgSuffix}@test.local`);
  const saved = await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: CONFIG(siteOverrides) });
  const site = saved.body.sites[0];
  // Map the artist page to Camping so page-mapping precedence is observable.
  const campingId = saved.body.catalogue.find((c) => c.label === 'Camping').id;
  const withMap = { ...site, pages: [{ ...site.pages[0], itemIds: [campingId] }] };
  await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [withMap] } });
  return { e, admin, site, campingId };
}
const ORIGIN = { Origin: 'https://fest.example' };

test('public context: bad key 404s, wrong origin 403s, allowed origin mints a session + ribbon offer', async () => {
  const { site } = await provision('ctx');
  assert.equal((await app.req('POST', '/api/fan/context', { body: { siteKey: 'fw_nope', url: 'https://fest.example/' } })).status, 404);
  assert.equal((await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://x.example/' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const r = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/tickets', anonId: 'a1' }, headers: ORIGIN });
  assert.equal(r.status, 200);
  assert.ok(r.body.sessionId);
  assert.equal(r.body.offer.label, 'Weekend Pass'); // unmapped page → catalogue order, public only
  assert.equal(r.body.site.teaser, 'Tickets are live');
  assert.equal(r.body.site.owlName, 'Kappa Guide'); // persona rides the public payloads
  assert.equal(r.body.site.owlAvatar, 'https://fest.example/owl.png');
  assert.equal(r.body.site.theme, 'dark');
  // No site colour set → the widget adopts the client's Pulse brand colour.
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(r.body.site.brandColor));
  // Page mapping wins on a matching URL (and the wildcard matches).
  const r2 = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/artists/luna-x' }, headers: ORIGIN });
  assert.equal(r2.body.pageType, 'artist');
  assert.equal(r2.body.offer.label, 'Camping');
  // Moving between pages REUSES the session and follows the new page: same
  // session id, ribbon offer switches to the new page's mapping (and back).
  const r3 = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/artists/luna-x', sessionId: r.body.sessionId }, headers: ORIGIN });
  assert.equal(r3.body.sessionId, r.body.sessionId);
  assert.equal(r3.body.offer.label, 'Camping');
  const r4 = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/tickets', sessionId: r.body.sessionId }, headers: ORIGIN });
  assert.equal(r4.body.sessionId, r.body.sessionId);
  assert.equal(r4.body.offer.label, 'Weekend Pass');
  // Boot on a mapped page serves that page's chips + the offer's images.
  const back = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/artists/luna-x', sessionId: r.body.sessionId }, headers: ORIGIN });
  const boot = await app.req('GET', `/api/fan/boot?sid=${back.body.sessionId}`);
  assert.deepEqual(boot.body.starters, ['Who plays Saturday?']);
  assert.deepEqual(boot.body.offer.images, ['https://fest.example/img/camp1.jpg']);
  // The "you are here" pill: boot names the matched page; unmatched pages carry none.
  assert.deepEqual(boot.body.page, { pageType: 'artist', note: 'artist pages', urlPattern: '/artists/*' });
  assert.equal(boot.body.site.owlIntro, 'Ciao! Ask me anything');
  // Quick-nav buttons derive from the page mappings; the fan's page is active.
  assert.equal(boot.body.navStyle, 'pills');
  assert.deepEqual(boot.body.nav, [{ pageType: 'artist', path: '/artists/', note: 'artist pages', active: true }]);
  const rHome = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/tickets' }, headers: ORIGIN });
  const bootHome = await app.req('GET', `/api/fan/boot?sid=${rHome.body.sessionId}`);
  assert.equal(bootHome.body.page, null);
  // Language: no device language → the site default; a device language (sent by
  // the loader from navigator.language) wins; unmapped pages send no starters
  // (the widget localises its own generic ones).
  assert.equal(bootHome.body.lang, 'it');
  assert.equal(bootHome.body.nav[0].active, false); // different page → nav button not active
  assert.deepEqual(bootHome.body.starters, []);
  const rDe = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/tickets', lang: 'de-DE' }, headers: ORIGIN });
  assert.equal((await app.req('GET', `/api/fan/boot?sid=${rDe.body.sessionId}`)).body.lang, 'de-de');
  // pageChanged: first boot no (nothing to compare), reopening on the SAME page
  // no, reopening after moving to another page yes → the widget re-surfaces
  // the new page's pitch/offer/starters.
  assert.equal(boot.body.pageChanged, false);
  assert.equal((await app.req('GET', `/api/fan/boot?sid=${back.body.sessionId}`)).body.pageChanged, false);
  await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/tickets', sessionId: back.body.sessionId }, headers: ORIGIN });
  assert.equal((await app.req('GET', `/api/fan/boot?sid=${back.body.sessionId}`)).body.pageChanged, true);
  assert.equal((await app.req('GET', `/api/fan/boot?sid=${back.body.sessionId}`)).body.pageChanged, false);
});

test('a matched page with NO ticked items still leads with what fits the page type', async () => {
  const { e, admin, site } = await provision('ptype');
  await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [{ ...site, pages: [{ urlPattern: '/venue', pageType: 'venue', itemIds: [], note: '' }, { urlPattern: '/sleep', pageType: 'accommodation', itemIds: [], note: '' }] }] } });
  const r = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/venue' }, headers: ORIGIN });
  assert.equal(r.body.pageType, 'venue');
  assert.equal(r.body.offer.label, 'Camping'); // venue: transport then add-ons first
  const r2 = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/sleep' }, headers: ORIGIN });
  assert.equal(r2.body.offer.label, 'Glamping Pod'); // accommodation pages lead with accommodation
});

test('pitches endpoint: gated + needs a real site + configured AI; context serves the saved pitch', async () => {
  const { e, admin, site } = await provision('pitch');
  assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/pitches`, { body: { siteId: site.id } })).status, 401);
  assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/pitches`, { as: admin, body: { siteId: 'nope' } })).status, 404);
  const r = await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/pitches`, { as: admin, body: { siteId: site.id } });
  assert.equal(r.status, 400); // AI unconfigured in tests — clear error, no call out
  assert.match(r.body.error, /AI is not configured/);
  // The saved pitch rides the public context payload for its page.
  const ctx = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/artists/luna-x' }, headers: ORIGIN });
  assert.equal(ctx.body.pitch, 'Catch every artist with a Weekend Pass');
});

test('disabled site serves nothing, and non-public items never reach fans', async () => {
  const { e, admin, site } = await provision('off');
  const r = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN });
  const boot = await app.req('GET', `/api/fan/boot?sid=${r.body.sessionId}`);
  assert.equal(boot.status, 200);
  assert.ok(!JSON.stringify(boot.body.items).includes('Crew comp'), 'non-public items must never be served');
  await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [{ ...site, enabled: false }] } });
  assert.equal((await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN })).status, 404);
  assert.equal((await app.req('GET', `/api/fan/boot?sid=${r.body.sessionId}`)).status, 404);
});

test('chat gate: no session 404s; unconfigured AI degrades with 503 (never a crash)', async () => {
  const { site } = await provision('chat');
  assert.equal((await app.req('POST', '/api/fan/chat', { body: { sessionId: 'nope', message: 'hi' } })).status, 404);
  const ctx = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN });
  assert.equal((await app.req('POST', '/api/fan/chat', { body: { sessionId: ctx.body.sessionId, message: '' } })).status, 400);
  assert.equal((await app.req('POST', '/api/fan/chat', { body: { sessionId: ctx.body.sessionId, message: 'Which ticket do I need?' } })).status, 503);
});

test('lead capture: consent is explicit, sticky, and surfaces on the admin lead list', async () => {
  const { e, admin, site } = await provision('lead');
  const ctx = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN });
  const sid = ctx.body.sessionId;
  assert.equal((await app.req('POST', '/api/fan/lead', { body: { sessionId: sid, email: 'not-an-email' } })).status, 400);
  // Saved without consent → stored, NOT opted in.
  const r1 = await app.req('POST', '/api/fan/lead', { body: { sessionId: sid, email: 'Fan@Example.com', name: 'Fan One' } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.optedIn, false);
  // Explicit consent turns it on…
  const r2 = await app.req('POST', '/api/fan/lead', { body: { sessionId: sid, email: 'fan@example.com', marketingConsent: true } });
  assert.equal(r2.body.optedIn, true);
  // …and a later save WITHOUT the flag (and with no name) never silently revokes
  // the consent, nor wipes the stored name to ''.
  const r3 = await app.req('POST', '/api/fan/lead', { body: { sessionId: sid, email: 'fan@example.com' } });
  assert.equal(r3.body.optedIn, true);
  const leads = await app.req('GET', `/api/admin/entities/${e.id}/fan-owl/leads`, { as: admin });
  assert.equal(leads.body.leads.length, 1); // same email upserts, never duplicates
  assert.equal(leads.body.leads[0].email, 'fan@example.com');
  assert.equal(leads.body.leads[0].consentMarketing, true);
  assert.equal(leads.body.leads[0].name, 'Fan One'); // a later blank/name change never wipes the name to ''
});

test('dogfood gate: settings routes are allowlisted (FANOWL_ADMIN_ALLOW); public widget unaffected', async () => {
  const { e, admin, site } = await provision('gate');
  process.env.FANOWL_ADMIN_ALLOW = 'shai.evian@howler.co.za';
  try {
    // A random admin (not on the list) is refused on every settings surface…
    assert.equal((await app.req('GET', `/api/admin/entities/${e.id}/fan-owl`, { as: admin })).status, 403);
    assert.equal((await app.req('GET', `/api/admin/entities/${e.id}/fan-owl/leads`, { as: admin })).status, 403);
    assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/ingest`, { as: admin, body: { url: 'https://x.example' } })).status, 403);
    // …the allowlisted account gets in…
    const shai = h.makeAdmin('shai.evian@howler.co.za');
    assert.equal((await app.req('GET', `/api/admin/entities/${e.id}/fan-owl`, { as: shai })).status, 200);
    // …and FANS are untouched: the public widget keeps working regardless.
    const ctx = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN });
    assert.equal(ctx.status, 200);
  } finally { process.env.FANOWL_ADMIN_ALLOW = 'all'; }
});

test('preview page: serves the widget for a valid key, hints on off/unknown, rejects junk', async () => {
  const { e, admin, site } = await provision('prev');
  const html = await fetch(`${app.base}/fan-owl-test?k=${site.siteKey}`).then((r) => r.text());
  assert.ok(html.includes(`data-site-key="${site.siteKey}"`), 'widget script wired to the key');
  assert.ok(!html.includes('⚠️'), 'no warning for an enabled site');
  assert.ok(html.includes('path=/artists/'), 'nav links generated from the site’s real page mappings');
  await app.req('PUT', `/api/admin/entities/${e.id}/fan-owl`, { as: admin, body: { sites: [{ ...site, enabled: false }] } });
  assert.ok((await fetch(`${app.base}/fan-owl-test?k=${site.siteKey}`).then((r) => r.text())).includes('switched OFF'));
  assert.equal((await fetch(`${app.base}/fan-owl-test?k=<script>alert(1)</script>`)).status, 400);
  // Same-host preview passes even with a domain allowlist set (the promoter's lock
  // must not break Pulse's own preview page).
  const r = await app.req('POST', '/api/fan/context', { body: { siteKey: (await provision('prev2')).site.siteKey, url: `${app.base}/fan-owl-test` }, headers: { Origin: app.base } });
  assert.equal(r.status, 200);
});

test('website ingest: gated like config (admin / own entity), needs a real URL + configured AI', async () => {
  const e = h.makeEntity('FanIngest Co', 'faningest-org');
  const other = h.makeEntity('FanIngest2 Co', 'faningest2-org');
  const client = h.makeClient('fan-ingest@test.local', [e.id], 'owner');
  assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/ingest`, { body: { url: 'https://x.example' } })).status, 401);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${other.id}/ingest`, { as: client, body: { url: 'https://x.example' } })).status, 403);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${e.id}/ingest`, { as: client, body: { url: 'not a url' } })).status, 400);
  // Valid URL but no Anthropic key configured → a clear 400, never a crawl.
  const r = await app.req('POST', `/api/my/fan-owl/${e.id}/ingest`, { as: client, body: { url: 'https://example.com' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /AI is not configured/);
});

test('ticket-site catalogue reader: gated like config, needs a real URL + configured AI', async () => {
  const e = h.makeEntity('FanCatIngest Co', 'fancating-org');
  const other = h.makeEntity('FanCatIngOther Co', 'fancating-other-org');
  const client = h.makeClient('fan-cating@test.local', [e.id], 'owner');
  assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/ingest-catalogue`, { body: { url: 'https://x.example' } })).status, 401);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${other.id}/ingest-catalogue`, { as: client, body: { url: 'https://x.example' } })).status, 403);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${e.id}/ingest-catalogue`, { as: client, body: { url: 'not a url' } })).status, 400);
  // Valid URL but no Anthropic key configured → a clear 400, never a crawl.
  const r = await app.req('POST', `/api/my/fan-owl/${e.id}/ingest-catalogue`, { as: client, body: { url: 'https://example.com/tickets' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /AI is not configured/);
});

test('funnel: beacons are whitelisted and roll up in the insights view', async () => {
  const { e, admin, site } = await provision('funnel');
  const ctx = await app.req('POST', '/api/fan/context', { body: { siteKey: site.siteKey, url: 'https://fest.example/' }, headers: ORIGIN });
  const sid = ctx.body.sessionId;
  await app.req('POST', '/api/fan/event', { body: { sessionId: sid, kind: 'deeplink_click', payload: { itemId: 'x' } } });
  await app.req('POST', '/api/fan/event', { body: { sessionId: sid, kind: 'nav_click', payload: { path: '/artists/' } } }); // Owl-driven page hop
  await app.req('POST', '/api/fan/event', { body: { sessionId: sid, kind: 'drop_table', payload: {} } }); // not whitelisted → ignored
  const s = await app.req('GET', `/api/admin/entities/${e.id}/fan-owl/insights`, { as: admin });
  const funnel = s.body.sites[0].funnel;
  assert.equal(funnel.ribbon_view, 1);
  assert.equal(funnel.deeplink_click, 1);
  assert.equal(funnel.nav_click, 1);
  assert.equal(funnel.drop_table, undefined);
});

test('coerceOwlJson tolerates fences and prose around the ingest JSON', () => {
  const { coerceOwlJson } = require('../server/fanOwl');
  const obj = { knowledge: [{ kind: 'faq', body: 'x' }], pages: [] };
  assert.deepEqual(coerceOwlJson(JSON.stringify(obj)), obj);                       // bare JSON
  assert.deepEqual(coerceOwlJson('```json\n' + JSON.stringify(obj) + '\n```'), obj); // fenced
  assert.deepEqual(coerceOwlJson('Here is the JSON:\n```\n' + JSON.stringify(obj) + '\n```\nHope this helps'), obj); // prose + fence
  assert.deepEqual(coerceOwlJson('Sure! ' + JSON.stringify(obj)), obj);            // leading prose, no fence
  assert.throws(() => coerceOwlJson('{"knowledge":[{"kind":"faq","body":"trunca')); // truncated → throws
});

test('catalogue image uploads: gated like config, stored + served publicly, orphans swept on save', async () => {
  const e = h.makeEntity('FanImg Co', 'fanimg-org');
  const other = h.makeEntity('FanImgOther Co', 'fanimg-other-org');
  const client = h.makeClient('fan-img@test.local', [e.id], 'owner');
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // Gates: anonymous 401s, wrong entity 403s, non-image data 400s.
  assert.equal((await app.req('POST', `/api/admin/entities/${e.id}/fan-owl/images`, { body: { dataUrl: px } })).status, 401);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${other.id}/images`, { as: client, body: { dataUrl: px } })).status, 403);
  assert.equal((await app.req('POST', `/api/my/fan-owl/${e.id}/images`, { as: client, body: { dataUrl: 'data:text/html;base64,PGI+aGk=' } })).status, 400);
  // Upload → hosted absolute URL (the save filter + embed only accept https?://).
  const up = await app.req('POST', `/api/my/fan-owl/${e.id}/images`, { as: client, body: { dataUrl: px } });
  assert.equal(up.status, 200);
  assert.match(up.body.url, /^https?:\/\/.+\/fan-owl-assets\/[0-9a-f]{32}$/);
  const token = up.body.url.split('/').pop();
  assert.equal((await app.req('GET', `/fan-owl-assets/${token}`)).status, 200); // public — fan-facing by definition
  assert.equal((await app.req('GET', '/fan-owl-assets/nope')).status, 404);
  // Sweep: a save keeps referenced uploads (even old ones) and reaps old orphans;
  // fresh unreferenced uploads survive the day's grace.
  const orphan = await app.req('POST', `/api/my/fan-owl/${e.id}/images`, { as: client, body: { dataUrl: px } });
  const orphanToken = orphan.body.url.split('/').pop();
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  h.db.db.prepare('UPDATE fan_assets SET created_at = ? WHERE token IN (?, ?)').run(old, token, orphanToken);
  const fresh = await app.req('POST', `/api/my/fan-owl/${e.id}/images`, { as: client, body: { dataUrl: px } });
  const freshToken = fresh.body.url.split('/').pop();
  const save = await app.req('PUT', `/api/my/fan-owl/${e.id}`, { as: client, body: { catalogue: [{ label: 'Pass', kind: 'ticket', images: [up.body.url] }] } });
  assert.equal(save.status, 200);
  assert.deepEqual(save.body.catalogue[0].images, [up.body.url]);
  assert.equal((await app.req('GET', `/fan-owl-assets/${token}`)).status, 200); // referenced → kept
  assert.equal((await app.req('GET', `/fan-owl-assets/${orphanToken}`)).status, 404); // old orphan → swept
  assert.equal((await app.req('GET', `/fan-owl-assets/${freshToken}`)).status, 200); // fresh → grace period
});
