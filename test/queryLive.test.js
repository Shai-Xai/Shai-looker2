// A user-forced refresh must bypass BOTH cache layers: ours (qCache) and
// Looker's own result cache (?cache=false) — otherwise "refresh" can return a
// Looker-cached run up to ~1h old (the live event-day capacity-tile bug).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const looker = require('../server/looker');
const engine = require('../server/query')({ looker, auth: h.auth });

let paths = [];
const orig = looker.lookerRequest;
beforeEach(() => { paths = []; looker.lookerRequest = async (_m, path) => { paths.push(path); return { data: [] }; }; });
afterEach(() => { looker.lookerRequest = orig; });

test('forced refresh does NOT join an in-flight cached run (it starts its own live one)', async () => {
  // Slow "cached" run in flight (a background serve-stale refresh / warmer)…
  let releaseCached;
  const gate = new Promise((r) => { releaseCached = r; });
  looker.lookerRequest = async (_m, path) => {
    paths.push(path);
    if (!path.includes('cache=false')) { await gate; return { data: [{ v: 'stale' }] }; }
    return { data: [{ v: 'fresh' }] };
  };
  const body = { model: 'm', view: 'v', fields: ['cap'] };
  const bg = engine.runLookerQuery('/queries/run/json_detail', body);            // cached run starts
  const live = await engine.runLookerQuery('/queries/run/json_detail', body, undefined, true); // user hits Refresh
  assert.equal(live.data[0].v, 'fresh');                    // refresh returned LIVE data, not the joined stale run
  assert.ok(paths.some((p) => p.includes('cache=false')));  // a real cache=false run was made
  releaseCached();
  await bg;
  // …and the late stale run must not clobber the cache entry the live run wrote.
  const after = await engine.runLookerQuery('/queries/run/json_detail', body);
  assert.equal(after.data[0].v, 'fresh');
  // Two identical CACHED runs still coalesce (dedupe kept for the normal path).
  paths = [];
  const b2 = { model: 'm', view: 'v', fields: ['other'] };
  looker.lookerRequest = async (_m, path) => { paths.push(path); return { data: [] }; };
  await Promise.all([engine.runLookerQuery('/x', b2), engine.runLookerQuery('/x', b2)]);
  assert.equal(paths.length, 1);
});

test('forced refresh busts Looker\'s cache; normal misses do not', async () => {
  await engine.runLookerQuery('/queries/run/json_detail', { model: 'm', view: 'v', fields: ['a'] }); // cold miss
  assert.equal(paths[0], '/queries/run/json_detail');
  await engine.runLookerQuery('/queries/run/json_detail', { model: 'm', view: 'v', fields: ['a'] }, undefined, true); // user refresh
  assert.equal(paths[1], '/queries/run/json_detail?cache=false');
  // The live run refreshed the SHARED entry — a follow-up normal read is served
  // from our cache (no third Looker call).
  await engine.runLookerQuery('/queries/run/json_detail', { model: 'm', view: 'v', fields: ['a'] });
  assert.equal(paths.length, 2);
});
