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
