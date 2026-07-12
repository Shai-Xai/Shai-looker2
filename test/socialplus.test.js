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
    // Even a client's OWN key sees NOTHING until communities are linked —
    // pasted keys are the shared network key in practice (the G&G leak).
    const own = makeEntity('OwnKey', 'OrgSPQ');
    db.setEntityIntegrations(own.id, { socialplusApiKey: 'own-key' });
    assert.deepEqual(sp.scopeFor(own.id), { all: false, ids: [] });
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
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'c1,c2,ch1' }); // reads are scope-filtered
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
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'ultra' }); // reads are scope-filtered
  const ins = db.db.prepare(`INSERT INTO socialplus_posts (entity_id, post_id, community_id, community_name, text, reactions, comments, reach)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entity_id, post_id) DO UPDATE SET reactions=excluded.reactions`);
  ins.run(e.id, 'p1', 'ultra', 'Ultra', 'favorite memory?', 2, 1, 358);
  ins.run(e.id, 'p2', 'ultra', 'Ultra', 'afterglow tickets', 8, 0, 471);
  ins.run(e.id, 'p2', 'ultra', 'Ultra', 'afterglow tickets', 9, 0, 471); // restate → no dup
  const top = sp.topPosts(e.id, { sort: 'reactions', limit: 10 });
  assert.equal(top.length, 2);
  assert.equal(top[0].postId, 'p2');                       // highest reactions first
  assert.equal(top[0].reactions, 9);
  // 'recent' flips to newest-first regardless of engagement.
  db.db.prepare('UPDATE socialplus_posts SET posted_at=? WHERE entity_id=? AND post_id=?').run('2026-07-11T08:00:00Z', e.id, 'p1');
  db.db.prepare('UPDATE socialplus_posts SET posted_at=? WHERE entity_id=? AND post_id=?').run('2026-07-01T08:00:00Z', e.id, 'p2');
  const recent = sp.topPosts(e.id, { sort: 'recent', limit: 10 });
  assert.equal(recent[0].postId, 'p1');                    // newer wins despite fewer reactions
});

test('reads re-apply the scope — stale rows from a wider sync never leak', () => {
  const e = makeEntity('StaleScope', 'OrgSPS');
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'k-stale' });
  // A previous (wider) sync left the WHOLE network in this entity's tables.
  const insC = db.db.prepare('INSERT INTO socialplus_communities (entity_id, community_id, display_name, members, posts) VALUES (?,?,?,?,?)');
  insC.run(e.id, 'mine', 'Their event', 500, 3);
  insC.run(e.id, 'other', 'Someone else\'s festival', 61000, 50);
  db.db.prepare('INSERT INTO socialplus_channels (entity_id, channel_id, display_name, members, messages) VALUES (?,?,?,?,?)')
    .run(e.id, 'event_111_main', 'Their chat', 100, 10);
  db.db.prepare('INSERT INTO socialplus_channels (entity_id, channel_id, display_name, members, messages) VALUES (?,?,?,?,?)')
    .run(e.id, 'event_999_main', 'Someone else\'s chat', 4000, 300);
  db.db.prepare('INSERT INTO socialplus_posts (entity_id, post_id, community_id, reactions, comments) VALUES (?,?,?,?,?)')
    .run(e.id, 'p-mine', 'mine', 5, 1);
  db.db.prepare('INSERT INTO socialplus_posts (entity_id, post_id, community_id, reactions, comments) VALUES (?,?,?,?,?)')
    .run(e.id, 'p-other', 'other', 900, 40);
  // Now the admin links ONLY their community + event chat group.
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'mine,event_111' });
  assert.deepEqual(sp.communities(e.id).map((c) => c.communityId), ['mine']);
  assert.deepEqual(sp.channels(e.id).map((c) => c.channelId), ['event_111_main']);
  assert.deepEqual(sp.topPosts(e.id).map((p) => p.postId), ['p-mine']);
  const t = sp.totals(e.id);
  assert.equal(t.members, 500);
  assert.equal(t.messages, 10);
  assert.equal(t.reactions, 5);
  // Nothing linked at all → nothing visible, whatever the tables hold.
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: '' });
  assert.deepEqual(sp.communities(e.id), []);
  assert.equal(sp.totals(e.id).members, 0);
  assert.equal(sp.summary(e.id).assigned, false);
});

test('a scope CHANGE wipes the daily history (it mixes scopes and lies)', async () => {
  const e = makeEntity('SigWipe', 'OrgSPW');
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'k-sig', socialplusCommunityIds: 'c1' });
  const insDaily = db.db.prepare('INSERT INTO socialplus_daily (entity_id, date, members) VALUES (?,?,?)');
  insDaily.run(e.id, '2026-07-01', 130000); // written under the OLD (network-wide) scope
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    await sp.syncEntity(e.id); // errors at the session — but the wipe runs first
    assert.equal(db.db.prepare('SELECT COUNT(*) c FROM socialplus_daily WHERE entity_id=?').get(e.id).c, 0, 'lying history gone');
    // Same scope again → no wipe: rows written after the sig stick around.
    insDaily.run(e.id, '2026-07-02', 500);
    await sp.syncEntity(e.id);
    assert.equal(db.db.prepare('SELECT COUNT(*) c FROM socialplus_daily WHERE entity_id=?').get(e.id).c, 1, 'unchanged scope keeps history');
  } finally { global.fetch = realFetch; }
});

test('communitySeries + todayActivity derive per-community numbers from joins/posts', () => {
  const e = makeEntity('PerCommunity', 'OrgSPX');
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'c1,c2' });
  const day = new Date().toISOString().slice(0, 10);
  const yday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  db.db.prepare('INSERT INTO socialplus_communities (entity_id, community_id, display_name, members) VALUES (?,?,?,?)').run(e.id, 'c1', 'Mine', 100);
  const insJ = db.db.prepare('INSERT INTO socialplus_joins (entity_id, community_id, date, joins) VALUES (?,?,?,?)');
  insJ.run(e.id, 'c1', yday, 10);
  insJ.run(e.id, 'c1', day, 5);
  insJ.run(e.id, 'c2', day, 99); // other community — must not bleed in
  db.db.prepare('INSERT INTO socialplus_posts (entity_id, post_id, community_id, posted_at) VALUES (?,?,?,?)').run(e.id, 'p1', 'c1', `${day}T10:00:00Z`);
  // Members curve: yesterday = 100 − 5 still to come; today = 100.
  const curve = sp.communitySeries(e.id, 'c1', { metric: 'members', days: 30 });
  assert.deepEqual(curve.slice(-2).map((p) => p.value), [95, 100]);
  const nm = sp.communitySeries(e.id, 'c1', { metric: 'new_members', days: 30 });
  assert.deepEqual(nm.map((p) => p.value), [10, 5]);
  assert.deepEqual(sp.communitySeries(e.id, 'c1', { metric: 'posts', days: 30 }), [{ date: day, value: 1 }]);
  // Today's activity: per community counts joins + posts for THAT community only.
  const a1 = sp.todayActivity(e.id, 'c1');
  assert.equal(a1.newMembers, 5);
  assert.equal(a1.posts, 1);
  assert.equal(a1.messages, null); // per-community deltas have no history
  // Entity-wide: joins across scope + counter deltas vs yesterday's snapshot.
  db.db.prepare('INSERT INTO socialplus_daily (entity_id, date, messages, comments, reactions) VALUES (?,?,?,?,?)').run(e.id, yday, 100, 20, 50);
  db.db.prepare('INSERT INTO socialplus_daily (entity_id, date, messages, comments, reactions) VALUES (?,?,?,?,?)').run(e.id, day, 130, 22, 48);
  const a = sp.todayActivity(e.id);
  assert.equal(a.newMembers, 5 + 99);
  assert.equal(a.messages, 30);
  assert.equal(a.comments, 2);
  assert.equal(a.reactions, 0); // counters can restate down — never negative
});

test('a community SELECTION narrows totals + activity + series — and sums across many', () => {
  const e = makeEntity('MultiSel', 'OrgSPM');
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'c1,c2,c3' });
  const day = new Date().toISOString().slice(0, 10);
  const insC = db.db.prepare('INSERT INTO socialplus_communities (entity_id, community_id, display_name, members, posts) VALUES (?,?,?,?,?)');
  insC.run(e.id, 'c1', 'One', 100, 4); insC.run(e.id, 'c2', 'Two', 50, 1); insC.run(e.id, 'c3', 'Three', 9, 0);
  const insP = db.db.prepare('INSERT INTO socialplus_posts (entity_id, post_id, community_id, comments, reactions, posted_at) VALUES (?,?,?,?,?,?)');
  insP.run(e.id, 'p1', 'c1', 2, 10, `${day}T09:00:00Z`);
  insP.run(e.id, 'p2', 'c2', 1, 5, `${day}T10:00:00Z`);
  insP.run(e.id, 'p3', 'c3', 7, 70, `${day}T11:00:00Z`);
  const insJ = db.db.prepare('INSERT INTO socialplus_joins (entity_id, community_id, date, joins) VALUES (?,?,?,?)');
  insJ.run(e.id, 'c1', day, 3); insJ.run(e.id, 'c2', day, 2); insJ.run(e.id, 'c3', day, 90);
  // THE regression the screenshot caught: totals must follow the selection.
  assert.equal(sp.totals(e.id).members, 159, 'unfiltered = everything in scope');
  assert.equal(sp.totals(e.id, ['c1']).members, 100);
  assert.deepEqual([sp.totals(e.id, ['c1', 'c2']).members, sp.totals(e.id, ['c1', 'c2']).posts], [150, 5], 'multi-select sums the selection');
  assert.equal(sp.totals(e.id, ['c1', 'c2']).reactions, 15);
  assert.equal(sp.totals(e.id, ['c1', 'c2']).comments, 3);
  // A bare-string selection must EXACT-match, never substring-match.
  assert.equal(sp.totals(e.id, 'c1').members, 100);
  // Today's activity + the trend sum across the selection the same way.
  const a = sp.todayActivity(e.id, ['c1', 'c2']);
  assert.equal(a.newMembers, 5);
  assert.equal(a.posts, 2);
  const nm = sp.communitySeries(e.id, ['c1', 'c2'], { metric: 'new_members', days: 30 });
  assert.deepEqual(nm.map((p) => p.value), [5]);
  const curve = sp.communitySeries(e.id, ['c1', 'c2'], { metric: 'members', days: 30 });
  assert.equal(curve.at(-1).value, 150, 'members curve ends at the selection total');
});

test('engagement counts DISTINCT contributing fans (staff excluded) against members', () => {
  const e = makeEntity('Engaged', 'OrgSPY');
  db.setEntityIntegrations(e.id, { socialplusCommunityIds: 'c1,event_42' });
  db.db.prepare('INSERT INTO socialplus_communities (entity_id, community_id, display_name, members) VALUES (?,?,?,?)').run(e.id, 'c1', 'Mine', 1000);
  const day = new Date().toISOString().slice(0, 10);
  const old = '2026-01-01T10:00:00Z';
  const ins = db.db.prepare('INSERT INTO socialplus_actors (entity_id, community_id, user_id, kind, last_at) VALUES (?,?,?,?,?)');
  ins.run(e.id, 'c1', 'fan1', 'reaction', `${day}T09:00:00Z`);   // active this week
  ins.run(e.id, 'c1', 'fan1', 'post', old);                      // same fan, older post — still ONE fan
  ins.run(e.id, 'event_42', 'fan2', 'message', `${day}T08:00:00Z`); // chatter via the event group
  ins.run(e.id, 'c1', 'fan3', 'reaction', old);                  // engaged once, long ago
  ins.run(e.id, 'other', 'fan4', 'reaction', `${day}T07:00:00Z`); // OUT of scope — invisible
  const g = sp.engagement(e.id);
  assert.equal(g.members, 1000);
  assert.equal(g.active7d, 2);   // fan1 + fan2
  assert.equal(g.ever, 3);       // + fan3
  assert.equal(g.breakdown.reactors, 1);
  assert.equal(g.breakdown.chatters, 1);
  // Per-community: only c1's actors count (the chat group is its own bucket).
  assert.equal(sp.engagement(e.id, 'c1').ever, 2);
});

test('computePresence joins member ids against the app (PostHog) in chunks', async () => {
  const e = makeEntity('Presence', 'OrgSPZ');
  const insM = db.db.prepare('INSERT INTO socialplus_members (entity_id, community_id, user_id) VALUES (?,?,?)');
  insM.run(e.id, 'c1', '111'); insM.run(e.id, 'c1', '222'); insM.run(e.id, 'c2', '333');
  const day = new Date().toISOString().slice(0, 10);
  const queries = [];
  sp.setAppQuery({
    isConfigured: () => true,
    hogql: async (q) => {
      queries.push(q);
      if (q.includes('GROUP BY d')) return [{ d: day, n: 2 }, { d: '2026-07-01', n: 1 }];
      return [{ d7: 2, d30: 2, d90: 3 }];
    },
  });
  try {
    await sp.computePresence(e.id);
    const p = JSON.parse(db.getSetting(`socialplus_presence:${e.id}`, ''));
    assert.equal(p.members, 3);
    assert.equal(p.today, 2);
    assert.equal(p.d30, 2);
    assert.equal(p.matched, 3);
    assert.equal(db.db.prepare('SELECT active_members FROM socialplus_presence WHERE entity_id=? AND date=?').get(e.id, day).active_members, 2);
    // The trend metric reads the stored series.
    const series = sp.series(e.id, { metric: 'app_actives', days: 30 });
    assert.ok(series.some((r) => r.date === day && r.value === 2));
    // All member ids ride in the IN-list (one chunk here).
    assert.ok(queries[0].includes("'111'") && queries[0].includes("'333'"));
  } finally { sp.setAppQuery(null); }
  // Without a PostHog wire-up, presence is silently skipped.
  await sp.computePresence(e.id); // no throw, no queries
});

test('buildMembersCurve reconstructs the growth curve from join dates', () => {
  // 100 members today; 5 joined today, 10 yesterday, 0 the day before, 20 before that.
  const joins = { '2026-07-11': 5, '2026-07-10': 10, '2026-07-08': 20 };
  const curve = sp.buildMembersCurve(100, joins, '2026-07-08', '2026-07-11');
  assert.deepEqual(curve, [
    { date: '2026-07-08', members: 85 },  // end of day: the 20 who joined that day count; the later 15 don't
    { date: '2026-07-09', members: 85 },  // quiet day — flat
    { date: '2026-07-10', members: 95 },  // 100 − 5 still to come
    { date: '2026-07-11', members: 100 }, // today = the live total
  ]);
  // Curve monotonically climbs to today's total (joins only — leavers approximate).
  assert.equal(curve[curve.length - 1].members, 100);
  assert.ok(curve.every((p, i) => i === 0 || p.members >= curve[i - 1].members));
});

test('syncIfStale skips when fresh, syncs when stale, no-ops unconfigured', async () => {
  const e = makeEntity('AutoRefresh', 'OrgSPR');
  // Unconfigured → explicit no-op.
  assert.deepEqual(await sp.syncIfStale(e.id), { ok: false, error: 'not_configured', refreshed: false });
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'k-refresh', socialplusCommunityIds: 'c1' }); // linked, so a sync attempts the network
  // Freshly synced → skipped, and the network is never touched.
  db.db.prepare(`INSERT INTO socialplus_sync (entity_id, last_status, last_synced) VALUES (?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET last_synced=excluded.last_synced`).run(e.id, 'ok', new Date().toISOString());
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network must not be hit when fresh'); };
  try {
    const r = await sp.syncIfStale(e.id);
    assert.equal(r.refreshed, false);
    assert.equal(r.ok, true);
    // Stale (an hour old) → it answers immediately with `started` and kicks the
    // sync in the BACKGROUND (our stub makes that attempt fail fast).
    db.db.prepare('UPDATE socialplus_sync SET last_synced=? WHERE entity_id=?').run(new Date(Date.now() - 3600_000).toISOString(), e.id);
    const r2 = await sp.syncIfStale(e.id);
    assert.equal(r2.refreshed, true);
    assert.ok(r2.started, 'returns the kick time for the UI to poll past');
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the background sync settle
    const s = sp.summary(e.id);
    assert.equal(s.lastStatus, 'error'); // the stubbed network refused — but it tried
    assert.match(s.lastError, /network must not be hit when fresh/);
  } finally { global.fetch = realFetch; }
});

test('summary rolls up totals + sync health; failed syncs surface their error', async () => {
  const e = makeEntity('Summary', 'OrgSPE');
  db.setEntityIntegrations(e.id, { socialplusApiKey: 'bad-key', socialplusRegion: 'eu', socialplusCommunityIds: 'c1' });
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
