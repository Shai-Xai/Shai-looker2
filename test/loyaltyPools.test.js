// Loyalty phase 2 — reward pools (server/loyaltyPools.js): route auth on both
// surfaces, the eligibility matrix (tiers, signals, the comps count|ignore
// rule), unique-stock vs shared-code grants, one-grant-per-fan idempotency,
// stock exhaustion, burn-down counts, and the /api/my flag gate.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp } = require('./http');

let app, entity, other, pools, admin, client, outsider;

before(async () => {
  entity = h.makeEntity('Pool Fest', 'Pool Organiser');
  other = h.makeEntity('Other Client', 'Other Organiser');
  admin = h.makeAdmin('pool-admin@test.local');
  client = h.makeClient('pool-client@test.local', [entity.id]);
  outsider = h.makeClient('pool-outsider@test.local', [other.id]);
  app = await startApp((expressApp) => {
    pools = require('../server/loyaltyPools').mount(expressApp, { db: h.db, auth: h.auth });
  });
});
after(async () => { if (app) await app.close(); });

const site = () => ({ id: 'site-1', entity_id: entity.id, suite_id: '' });
const session = () => ({ id: crypto.randomUUID() });
const profile = () => ({ id: crypto.randomUUID() });
const POOL = (over = {}) => ({
  name: 'Loyal VIP upgrade', rewardKind: 'upgrade', valueLabel: '25% off VIP',
  target: { tiers: ['loyal'] }, rules: { comps: 'count' }, mode: 'unique', ...over,
});
const LOYAL = { tier: 'loyal', paidEventsCount: 2, signals: { group_buyer: true } };
const NEWBIE = { tier: 'new', paidEventsCount: 0, signals: {} };

test('route auth: admin + own client pass, outsider and anonymous do not', async () => {
  assert.equal((await app.req('GET', `/api/admin/entities/${entity.id}/loyalty/pools`)).status, 401);
  assert.equal((await app.req('GET', `/api/admin/entities/${entity.id}/loyalty/pools`, { as: client })).status, 403);
  assert.equal((await app.req('GET', `/api/admin/entities/${entity.id}/loyalty/pools`, { as: admin })).status, 200);
  assert.equal((await app.req('GET', `/api/my/loyalty/${entity.id}/pools`, { as: client })).status, 200);
  assert.equal((await app.req('GET', `/api/my/loyalty/${entity.id}/pools`, { as: outsider })).status, 403);
});

test('pool save validates + round-trips; code upload dedupes; burn-down counts', async () => {
  const saved = (await app.req('PUT', `/api/admin/entities/${entity.id}/loyalty/pools`, {
    as: admin, body: { pools: [POOL({ rewardKind: 'nonsense', target: { tiers: ['loyal', 'bogus'], signals: ['group_buyer', 'hack'] } })] },
  })).body;
  assert.equal(saved.pools.length, 1);
  const p = saved.pools[0];
  assert.equal(p.rewardKind, 'discount'); // junk kind falls back
  assert.deepEqual(p.target.tiers, ['loyal']); // junk tier dropped
  assert.deepEqual(p.target.signals, ['group_buyer']); // junk signal dropped
  const up = (await app.req('POST', `/api/admin/entities/${entity.id}/loyalty/pools/${p.id}/codes`, {
    as: admin, body: { codes: 'VIP-AAA\nVIP-BBB\nVIP-AAA\n  \nVIP-CCC' },
  })).body;
  assert.equal(up.added, 3); // dedup + blank dropped
  assert.equal(up.stock.available, 3);
  // Another client's admin URL can't touch this pool.
  assert.equal((await app.req('POST', `/api/admin/entities/${other.id}/loyalty/pools/${p.id}/codes`, { as: admin, body: { codes: 'X' } })).status, 404);
});

test('grant engine: eligibility, one-per-fan idempotency, stock exhaustion', async () => {
  const list = (await app.req('GET', `/api/admin/entities/${entity.id}/loyalty/pools`, { as: admin })).body;
  const poolId = list.pools[0].id;
  const s = site();
  // Ineligible fan → no reward, honest message.
  const miss = pools.grantFor(s, session(), profile(), NEWBIE);
  assert.equal(miss.ok, false); assert.equal(miss.reason, 'none');
  // Eligible fan → a unique code, and the SAME grant on every later call.
  const fan = profile();
  const r1 = pools.grantFor(s, session(), fan, LOYAL);
  assert.equal(r1.ok, true); assert.match(r1.reward.code, /^VIP-/);
  const r2 = pools.grantFor(s, session(), fan, LOYAL);
  assert.equal(r2.existing, true);
  assert.equal(r2.reward.code, r1.reward.code);
  // Two more fans drain the stock; the fourth gets nothing.
  assert.equal(pools.grantFor(s, session(), profile(), LOYAL).ok, true);
  assert.equal(pools.grantFor(s, session(), profile(), LOYAL).ok, true);
  assert.equal(pools.grantFor(s, session(), profile(), LOYAL).ok, false);
  assert.equal(pools.hasLiveRewards(s), false); // stock gone → no live rewards
  const counts = (await app.req('GET', `/api/admin/entities/${entity.id}/loyalty/pools`, { as: admin })).body.pools.find((x) => x.id === poolId).stock;
  assert.equal(counts.available, 0); assert.equal(counts.issued, 3); assert.equal(counts.granted, 3);
});

test('comps rule: ignore judges by PAID history only', async () => {
  await app.req('PUT', `/api/admin/entities/${entity.id}/loyalty/pools`, {
    as: admin,
    body: { pools: [POOL({ name: 'Buyers only', target: { tiers: ['loyal'] }, rules: { comps: 'ignore' }, mode: 'shared', sharedCode: 'BUY-ME', grantCap: 10 })] },
  });
  const s = site();
  // Attended twice on comps, never paid → 'loyal' by attendance, 'new' by paid → excluded.
  const compGuest = { tier: 'loyal', paidEventsCount: 0, signals: { comp_guest: true } };
  assert.equal(pools.grantFor(s, session(), profile(), compGuest).ok, false);
  // A paying loyal fan qualifies and gets the shared code.
  const r = pools.grantFor(s, session(), profile(), LOYAL);
  assert.equal(r.ok, true); assert.equal(r.reward.code, 'BUY-ME');
});

test('shared mode caps GRANTS; suite-scoped pools only apply to their event', async () => {
  await app.req('PUT', `/api/admin/entities/${entity.id}/loyalty/pools`, {
    as: admin,
    body: { pools: [POOL({ name: 'Capped', target: {}, mode: 'shared', sharedCode: 'CAP-2', grantCap: 2, suiteId: 'suite-A' })] },
  });
  const sA = { ...site(), suite_id: 'suite-A' };
  const sB = { ...site(), suite_id: 'suite-B' };
  assert.equal(pools.grantFor(sB, session(), profile(), LOYAL).ok, false); // wrong event
  assert.equal(pools.grantFor(sA, session(), profile(), LOYAL).ok, true);
  assert.equal(pools.grantFor(sA, session(), profile(), LOYAL).ok, true);
  assert.equal(pools.grantFor(sA, session(), profile(), LOYAL).ok, false); // cap hit
  assert.equal(pools.hasLiveRewards(sA), false);
});

test('expired pools and segment-targeted pools never grant (fail closed)', async () => {
  await app.req('PUT', `/api/admin/entities/${entity.id}/loyalty/pools`, {
    as: admin,
    body: { pools: [
      POOL({ name: 'Expired', target: {}, rules: { expiresAt: '2020-01-01' }, mode: 'shared', sharedCode: 'OLD', grantCap: 0 }),
      POOL({ name: 'Segmented', target: { segmentId: 'seg-1' }, mode: 'shared', sharedCode: 'SEG', grantCap: 0 }),
    ] },
  });
  assert.equal(pools.grantFor(site(), session(), profile(), LOYAL).ok, false);
  assert.equal(pools.hasLiveRewards(site()), false); // expired doesn't count as live
});
