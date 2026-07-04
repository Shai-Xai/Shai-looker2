// The persisted briefing cache + warmer (server/briefingCache.js) — the thing
// that makes the home briefing load instantly (served from disk, refreshed in the
// background) instead of paying the 1-3s Looker+LLM cost on every cold load. Pure
// logic with injected deps; tested against a real in-memory SQLite, no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createBriefingCache = require('../server/briefingCache');

function setup({ getUser } = {}) {
  const sql = new Database(':memory:');
  const calls = [];
  const store = createBriefingCache({
    sql,
    getUser: getUser || ((id) => ({ id })),
    regenerate: async (user, entityId, segment) => { calls.push([user.id, entityId, segment]); },
    log: { log() {}, error() {} },
  });
  return { sql, store, calls };
}

test('save + get round-trips the briefing payload', () => {
  const { store } = setup();
  store.save('u1:e1:morning', { headline: 'Sales up 12%', bullets: ['a'] });
  const got = store.get('u1:e1:morning');
  assert.equal(got.payload.headline, 'Sales up 12%');
  assert.ok(got.at > 0);
  assert.equal(store.get('nope'), null);
});

test('a warmer re-save refreshes payload + generated-at but NOT last_used', () => {
  const { store, sql } = setup();
  store.save('k', { v: 1 });
  store.touch('k'); // a real user serve marks activity
  const usedBefore = sql.prepare('SELECT last_used FROM briefing_cache WHERE key=?').get('k').last_used;
  store.save('k', { v: 2 }); // background regenerate
  const row = sql.prepare('SELECT payload, last_used FROM briefing_cache WHERE key=?').get('k');
  assert.equal(JSON.parse(row.payload).v, 2, 'payload refreshed');
  assert.equal(row.last_used, usedBefore, 'last_used unchanged — a warmer re-save is not user activity');
});

test('warm() regenerates only active+stale briefings, dedupes per (user,entity,segment), skips missing users', async () => {
  const { sql, store, calls } = setup({ getUser: (id) => (id === 'gone' ? null : { id }) });
  const now = Date.now();
  const ins = sql.prepare('INSERT INTO briefing_cache (key, payload, at, last_used) VALUES (?,?,?,?)');
  ins.run('u1:e1:morning', '{}', now - 20 * 60e3, now - 60e3);              // active + stale → warm
  ins.run('u1:e1:morning:overall:s1', '{}', now - 20 * 60e3, now - 60e3);  // same (u,e,seg) → deduped
  ins.run('u2:e2:midday', '{}', now - 60e3, now - 60e3);                   // FRESH (just generated) → skip
  ins.run('u3:e3:evening', '{}', now - 20 * 60e3, now - 48 * 3600e3);      // INACTIVE (old last_used) → skip
  ins.run('gone:e9:morning', '{}', now - 20 * 60e3, now - 60e3);           // user no longer exists → skip

  await store.warm();

  assert.deepEqual(calls.sort(), [['u1', 'e1', 'morning']],
    'exactly one regen: the active + stale briefing, deduped across its overall key, user present');
});

test('clearAll() wipes memory AND persisted briefings so the next load regenerates', () => {
  const { sql, store } = setup();
  store.put('u1:e1:morning', { v: 1 }); // memory + disk
  store.put('u2:e2:evening', { v: 2 });
  assert.deepEqual(store.serve('u1:e1:morning', async () => {}), { v: 1 }, 'sanity: served from cache before the flush');
  const wiped = store.clearAll();
  assert.equal(wiped, 2, 'reports how many persisted briefings were dropped');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM briefing_cache').get().n, 0, 'persisted copies gone');
  assert.equal(store.serve('u1:e1:morning', async () => {}), null, 'nothing served from memory or disk after a full flush');
});

test('warm() prunes briefings unused for over 30 days', async () => {
  const { sql, store } = setup();
  const now = Date.now();
  const ins = sql.prepare('INSERT INTO briefing_cache (key, payload, at, last_used) VALUES (?,?,?,?)');
  ins.run('stale:e:morning', '{}', now - 40 * 864e5, now - 40 * 864e5); // unused 40 days
  ins.run('fresh:e:morning', '{}', now - 60e3, now - 60e3);
  await store.warm();
  const keys = sql.prepare('SELECT key FROM briefing_cache').all().map((r) => r.key);
  assert.ok(!keys.includes('stale:e:morning'), 'the 40-day-unused entry was pruned');
  assert.ok(keys.includes('fresh:e:morning'), 'the active entry is kept');
});
