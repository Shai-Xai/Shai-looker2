// The Social+ (social.plus) inbound connector pulls in-app community analytics
// INTO Pulse. It must:
//   • be a graceful no-op until a client pastes their Social+ API key,
//   • report connection state from the per-client integrations (write-only key),
//   • upsert community/channel/post/daily rows idempotently (restate, never dup),
//   • roll totals + sync health up through summary()/series()/topPosts().
// No live Social+ calls here (no creds) — this locks the schema + plumbing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, makeEntity } = require('./helpers');
const sp = require('../server/socialplus');

sp.init({ db });

test('no-op cleanly when a client has not connected Social+', () => {
  const e = makeEntity('Unconnected', 'OrgSPA');
  assert.equal(sp.isConfigured(e.id), false);
  assert.equal(sp.summary(e.id).configured, false);
  assert.deepEqual(sp.communities(e.id), []);
  assert.deepEqual(sp.channels(e.id), []);
  assert.deepEqual(sp.series(e.id), []);
  assert.deepEqual(sp.topPosts(e.id), []);
});

test('connection reflects the per-client key + region (region defaults to eu)', () => {
  const e = makeEntity('Connected', 'OrgSPB');
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'k123456789' });
  assert.equal(sp.isConfigured(e.id), true);
  assert.equal(sp.connection(e.id).source, 'client');
  assert.equal(sp.connection(e.id).region, 'eu');           // default
  db.setEntityIntegrations(e.id, { socialplusRegion: 'sg' });
  assert.equal(sp.connection(e.id).region, 'sg');
  db.setEntityIntegrations(e.id, { socialplusRegion: 'nope' });
  assert.equal(sp.connection(e.id).region, 'eu');           // unknown region falls back
});

test('blank client fields inherit the platform key (and scope rules follow the source)', async () => {
  const e = makeEntity('PlatformRider', 'OrgSPP');
  db.setSetting('socialplus_api_key', 'platform-key');
  db.setSetting('socialplus_region', 'eu');
  try {
    const c = sp.connection(e.id);
    assert.equal(c.source, 'platform');
    assert.equal(c.apiKey, 'platform-key');
    // Shared key + nothing linked → scope is NOTHING (never leak the network)…
    assert.deepEqual(sp.scopeFor(e.id), { all: false, ids: [] });
    // …and a sync clears rather than pulls (no network call is even attempted).
    db.db.prepare('INSERT INTO socialplus_communities (entity_id, community_id, display_name) VALUES (?,?,?)').run(e.id, 'stale', 'Stale');
    const r = await sp.syncEntity(e.id);
    assert.equal(r.ok, true);
    assert.equal(r.unassigned, true);
    assert.deepEqual(sp.communities(e.id), []);
    // Linking communities narrows the scope to exactly those ids…
    db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'c1, event_35120' });
    const scope = sp.scopeFor(e.id);
    assert.equal(sp.communityInScope(scope, 'c1'), true);
    assert.equal(sp.communityInScope(scope, 'c2'), false);
    // …and chat channels follow the community id or the event_<id> group prefix.
    assert.equal(sp.channelInScope(scope, 'c1'), true);                 // community feed chat
    assert.equal(sp.channelInScope(scope, 'event_35120_main'), true);   // event chat group
    assert.equal(sp.channelInScope(scope, 'event_99999_main'), false);  // someone else's event
    // A client on their OWN key with no list sees everything.
    const own = makeEntity('OwnKey', 'OrgSPQ');
    db.setEntityIntegrations(own.id, { socialplusApiKey: 'own-key' });
    assert.deepEqual(sp.scopeFor(own.id), { all: true, ids: [] });
  } finally {
    db.setSetting('socialplus_api_key', '');
    db.setSetting('socialplus_region', '');
  }
});

test('applyPatch writes key/region write-only; view never leaks the key', () => {
  const store = {};
  const set = (k, v) => { store[k] = v; };
  sp.applyPatch({ socialplus: { apiKey: ' secret-key-abcd ', region: 'us' } }, set);
  assert.equal(store.socialplusApiKey, 'secret-key-abcd'); // trimmed
  assert.equal(store.socialplusRegion, 'us');
  sp.applyPatch({ socialplus: { clearApiKey: true, region: 'bogus' } }, set);
  assert.equal(store.socialplusApiKey, '');
  assert.equal(store.socialplusRegion, 'eu');              // bogus region normalised
  sp.applyPatch({ socialplus: { communityIds: ['c1', 'c1', ' event_35120 ', ''] } }, set);
  assert.equal(store.socialplusCommunityIds, 'c1,event_35120'); // deduped + trimmed
  // Untouched payload → nothing written.
  const store2 = {};
  sp.applyPatch({}, (k, v) => { store2[k] = v; });
  assert.deepEqual(store2, {});
  // The view reports set + hint only — never the value.
  const v = sp.view({ socialplusApiKey: 'secret-key-abcd', socialplusRegion: 'us' });
  assert.equal(v.keySet, true);
  assert.equal(v.region, 'us');
  assert.ok(!JSON.stringify(v).includes('secret-key-abcd'));
  assert.ok(v.keyHint.endsWith('abcd') && v.keyHint.startsWith('••••'));
});

test('community/channel/daily upserts restate idempotently and feed the helpers', () => {
  const e = makeEntity('Metrics', 'OrgSPC');
  const insC = db.db.prepare(`INSERT INTO socialplus_communities (entity_id, community_id, display_name, members, posts)
    VALUES (?,?,?,?,?) ON CONFLICT(entity_id, community_id) DO UPDATE SET members=excluded.members, posts=excluded.posts`);
  insC.run(e.id, 'c1', 'Ultra JHB', 10000, 20);
  insC.run(e.id, 'c1', 'Ultra JHB', 10822, 22);            // restate → no dup
  insC.run(e.id, 'c2', 'Bushfire', 7551, 28);
  const comms = sp.communities(e.id);
  assert.equal(comms.length, 2);
  assert.equal(comms[0].communityId, 'c1');                // sorted by members desc
  assert.equal(comms[0].members, 10822);                   // restated value wins

  db.db.prepare(`INSERT INTO socialplus_channels (entity_id, channel_id, display_name, type, members, messages)
    VALUES (?,?,?,?,?,?)`).run(e.id, 'ch1', 'Announcements', 'community', 87, 14);
  assert.equal(sp.channels(e.id)[0].messages, 14);

  const insD = db.db.prepare(`INSERT INTO socialplus_daily (entity_id, date, members, messages)
    VALUES (?,?,?,?) ON CONFLICT(entity_id, date) DO UPDATE SET members=excluded.members, messages=excluded.messages`);
  insD.run(e.id, '2026-07-01', 17000, 10);
  insD.run(e.id, '2026-07-02', 18000, 12);
  insD.run(e.id, '2026-07-02', 18373, 14);                 // restate same day → no dup
  const series = sp.series(e.id, { metric: 'members', days: 30 });
  assert.equal(series.length, 2);                          // two distinct days, not three
  assert.deepEqual(series.map((r) => r.value), [17000, 18373]); // oldest→newest

  // totals roll communities + channels + posts together.
  const t = sp.totals(e.id);
  assert.equal(t.communities, 2);
  assert.equal(t.members, 10822 + 7551);
  assert.equal(t.messages, 14);
});

test('posts upsert on post id and rank via topPosts', () => {
  const e = makeEntity('Posts', 'OrgSPD');
  const ins = db.db.prepare(`INSERT INTO socialplus_posts (entity_id, post_id, community_name, text, reactions, comments, reach)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(entity_id, post_id) DO UPDATE SET reactions=excluded.reactions`);
  ins.run(e.id, 'p1', 'Ultra', 'favorite memory?', 2, 1, 358);
  ins.run(e.id, 'p2', 'Ultra', 'afterglow tickets', 8, 0, 471);
  ins.run(e.id, 'p2', 'Ultra', 'afterglow tickets', 9, 0, 471); // restate → no dup
  const top = sp.topPosts(e.id, { sort: 'reactions', limit: 10 });
  assert.equal(top.length, 2);
  assert.equal(top[0].postId, 'p2');                       // highest reactions first
  assert.equal(top[0].reactions, 9);
});

test('summary rolls up totals + sync health; failed syncs surface their error', async () => {
  const e = makeEntity('Summary', 'OrgSPE');
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'bad-key', socialplusRegion: 'eu' });
  // syncEntity never throws — a bad key records an error on the sync row. Stub
  // fetch so the test makes no live network call.
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ status: 'error', message: 'Invalid API key' }) });
  try {
    const r = await sp.syncEntity(e.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid API key/);
  } finally { global.fetch = realFetch; }
  const s = sp.summary(e.id);
  assert.equal(s.configured, true);
  assert.equal(s.lastStatus, 'error');
  assert.match(s.lastError, /Invalid API key/);
  // Unconfigured entities short-circuit without touching the network.
  const e2 = makeEntity('NoKey', 'OrgSPF');
  assert.deepEqual(await sp.syncEntity(e2.id), { ok: false, error: 'not_configured' });
});
