// The inbound social-metrics module pulls organic stats INTO Pulse. It must:
//   • be a graceful no-op until a client connects a platform,
//   • report which platforms are connected from the per-client integrations,
//   • upsert account/post rows idempotently (re-pulls restate, never duplicate),
//   • and expose them through the query helpers that feed the Social page + tiles.
// No live Meta/TikTok calls here (no creds) — this locks the schema + plumbing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeEntity } = require('./helpers');
const social = require('../server/socialMetrics');

social.init({ db });

test('no-op cleanly when a client has connected nothing', () => {
  const e = makeEntity('Unconnected', 'OrgA');
  assert.equal(social.isConfigured(e.id), false);
  assert.deepEqual(social.configuredPlatforms(e.id), []);
  assert.equal(social.summary(e.id).configured, false);
  assert.deepEqual(social.accounts(e.id), []);
  assert.deepEqual(social.accountSeries(e.id, { metric: 'reach' }), []);
  assert.deepEqual(social.topPosts(e.id), []);
});

test('configuredPlatforms reflects which assets are set', () => {
  const e = makeEntity('Connected', 'OrgB');
  db.setEntityIntegrations(e.id, { metaAccessToken: 'tok', metaIgUserId: '178414' });
  assert.deepEqual(social.configuredPlatforms(e.id), ['instagram']);

  db.setEntityIntegrations(e.id, { metaPageId: '99', tiktokAccessToken: 'tt' });
  assert.deepEqual(social.configuredPlatforms(e.id).sort(), ['facebook', 'instagram', 'tiktok']);
  assert.equal(social.isConfigured(e.id), true);

  // A token without any asset id is NOT connected (Meta needs a page/ig id).
  const e2 = makeEntity('TokenOnly', 'OrgC');
  db.setEntityIntegrations(e2.id, { metaAccessToken: 'tok' });
  assert.deepEqual(social.configuredPlatforms(e2.id), []);
});

test('account + post metrics upsert idempotently and surface via helpers', () => {
  const e = makeEntity('Metrics', 'OrgD');
  const ins = db.db.prepare(`INSERT INTO social_account_metrics (entity_id, platform, account_ref, date, followers, reach, engagement)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(entity_id, platform, account_ref, date) DO UPDATE SET reach=excluded.reach`);
  ins.run(e.id, 'instagram', 'ig1', '2026-06-01', 1000, 500, 40);
  ins.run(e.id, 'instagram', 'ig1', '2026-06-02', 1010, 600, 55);
  ins.run(e.id, 'instagram', 'ig1', '2026-06-02', 1010, 650, 55); // restate same day → no dup

  const series = social.accountSeries(e.id, { platform: 'instagram', accountRef: 'ig1', metric: 'reach', days: 30 });
  assert.equal(series.length, 2);                       // two distinct days, not three
  assert.deepEqual(series.map((r) => r.value), [500, 650]); // oldest→newest, restated value wins

  db.db.prepare(`INSERT INTO social_post_metrics (entity_id, platform, account_ref, post_id, caption, engagement, reach)
    VALUES (?,?,?,?,?,?,?)`).run(e.id, 'instagram', 'ig1', 'p1', 'hello', 120, 900);
  db.db.prepare(`INSERT INTO social_post_metrics (entity_id, platform, account_ref, post_id, caption, engagement, reach)
    VALUES (?,?,?,?,?,?,?)`).run(e.id, 'instagram', 'ig1', 'p2', 'world', 30, 200);
  const top = social.topPosts(e.id, { platform: 'instagram', sort: 'engagement', limit: 10 });
  assert.equal(top.length, 2);
  assert.equal(top[0].postId, 'p1');                    // highest engagement first
});

test('summary rolls up connected accounts and errors', () => {
  const e = makeEntity('Summary', 'OrgE');
  db.setEntityIntegrations(e.id, { metaAccessToken: 'tok', metaIgUserId: 'ig9' });
  db.db.prepare(`INSERT INTO social_accounts (entity_id, platform, account_ref, name, followers, last_status, last_error, last_synced)
    VALUES (?,?,?,?,?,?,?,?)`).run(e.id, 'instagram', 'ig9', 'Acme', 2500, 'error', 'token expired', '2026-06-20T00:00:00Z');
  const s = social.summary(e.id);
  assert.equal(s.configured, true);
  assert.equal(s.accountCount, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.lastError.platform, 'instagram');
});
