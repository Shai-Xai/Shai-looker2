// Help bot (server/helpBot.js) — the in-app product help chatbot. Covers the
// retrieval brain that grounds answers: tokenizing, scoring (title > tags > body,
// role boost), feature-gating (cashless help never surfaces for a non-cashless
// event), the overview fallback, and tenant feature detection. The AI call itself
// isn't exercised (no key in tests) — retrieval is the part with the logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const helpBot = require('../server/helpBot');
const { applySeed } = require('../server/helpBotSeed');

const A = (over) => ({ id: over.title, slug: over.title, title: '', body: '', tags: '', roles: '', features: '', deepLink: '', published: true, ...over });

test('terms() drops stopwords and short tokens, dedupes', () => {
  const t = helpBot.terms('How do I set up my abandoned CART cart?');
  assert.ok(t.includes('abandoned'));
  assert.ok(t.includes('cart'));
  assert.equal(t.filter((x) => x === 'cart').length, 1, 'deduped');
  assert.ok(!t.includes('how') && !t.includes('set') && !t.includes('do'), 'stopwords/short removed');
});

test('retrieve() ranks a title match above a body-only match', () => {
  const rows = [
    A({ title: 'Abandoned cart campaigns', body: 'unrelated' }),
    A({ title: 'Something else', body: 'mentions abandoned cart deep in the body text' }),
  ];
  const out = helpBot.retrieve(rows, { query: 'abandoned cart', roleKey: '', features: new Set(), limit: 5 });
  assert.equal(out[0].title, 'Abandoned cart campaigns');
});

test('retrieve() gives a role-matched article a boost', () => {
  const rows = [
    A({ title: 'Campaigns overview', body: 'send email', tags: 'email' }),
    A({ title: 'Email sending', body: 'send email', tags: 'email', roles: 'marketing' }),
  ];
  const out = helpBot.retrieve(rows, { query: 'email', roleKey: 'marketing', features: new Set(), limit: 5 });
  assert.equal(out[0].roles, 'marketing', 'role-relevant article wins the tie');
});

test('retrieve() DROPS an article that needs a feature the tenant lacks', () => {
  const rows = [A({ title: 'Cashless spend', body: 'cashless top-ups', tags: 'cashless', features: 'cashless' })];
  const withoutCashless = helpBot.retrieve(rows, { query: 'cashless', roleKey: '', features: new Set(['dashboards']), limit: 5 });
  assert.equal(withoutCashless.length, 0, 'cashless help omitted for a non-cashless event');
  const withCashless = helpBot.retrieve(rows, { query: 'cashless', roleKey: '', features: new Set(['cashless']), limit: 5 });
  assert.equal(withCashless.length, 1, 'cashless help surfaces when the event has cashless');
});

test('retrieve() falls back to overview/getting-started when nothing matches', () => {
  const rows = [
    A({ title: 'Getting started', tags: 'overview getting-started', body: 'a tour' }),
    A({ title: 'Deep feature', tags: 'niche', body: 'obscure' }),
  ];
  const out = helpBot.retrieve(rows, { query: 'zzz nonsense query', roleKey: '', features: new Set(), limit: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Getting started');
});

test('retrieve() skips unpublished articles', () => {
  const rows = [A({ title: 'Draft article', body: 'abandoned cart', tags: 'abandoned cart', published: false })];
  const out = helpBot.retrieve(rows, { query: 'abandoned cart', roleKey: '', features: new Set(), limit: 5 });
  assert.equal(out.length, 0);
});

test('tenantFeatures(): cashless absent by default, present when a cashless explore is registered', () => {
  const base = helpBot.tenantFeatures(db, '');
  assert.ok(base.has('campaigns') && base.has('dashboards'), 'base features present');
  assert.ok(!base.has('cashless'), 'cashless not assumed');
  db.setSetting('owl_catalogue_explores', JSON.stringify([{ model: 'cashless', view: 'cashless_spend', label: 'Cashless' }]));
  assert.ok(helpBot.tenantFeatures(db, '').has('cashless'), 'cashless detected once a cashless explore is registered');
  db.setSetting('owl_catalogue_explores', '[]');
});

test('applySeed() plants the starter corpus once (idempotent, no duplicates)', () => {
  const store = new Map();
  const fakeApi = {
    upsertArticle: (a) => { store.set(a.slug, a); return a; },
  };
  const added1 = applySeed(db, fakeApi);
  assert.ok(added1 > 0, 'first run seeds articles');
  const before = store.size;
  const added2 = applySeed(db, fakeApi);
  assert.equal(added2, 0, 'second run adds nothing');
  assert.equal(store.size, before, 'no duplicates');
  assert.ok(store.has('abandoned-cart'), 'includes the abandoned-cart deep-link article');
  assert.equal(store.get('cashless').features, 'cashless', 'cashless article is feature-gated');
});
