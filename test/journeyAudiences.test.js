// The journey audience ledger (server/journeyAudiences.js): a journey `sync` node
// adds/removes individuals to a named Meta/TikTok audience over time. Since the
// connectors mirror a WHOLE membership, the ledger recomputes the full set on
// each add/remove and hands it to the connector. Verified with stub connectors —
// no live ad-account calls; this asserts OUR add/remove/fan-out/guard logic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function makeConn(configured = true) {
  const calls = [];
  return { calls, isConfigured: () => configured, syncAudience: async (a) => { calls.push({ segmentId: a.segmentId, name: a.name, emails: a.members.map((m) => m.email).sort() }); return { ok: true }; } };
}
const factory = require('../server/journeyAudiences');
const mk = ({ meta = makeConn(), tiktok = makeConn() } = {}) => { const db = { db: new Database(':memory:') }; return { sync: factory({ db, meta, tiktok }), meta, tiktok }; };

test('add unions members, accumulates across syncs, mirrors the FULL set each time', async () => {
  const { sync, meta } = mk();
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'Retarget', action: 'add', members: [{ email: 'a@x.com' }] });
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'Retarget', action: 'add', members: [{ email: 'b@x.com' }] });
  assert.equal(meta.calls.length, 2);
  assert.deepEqual(meta.calls[0].emails, ['a@x.com']);
  assert.deepEqual(meta.calls[1].emails, ['a@x.com', 'b@x.com']); // full membership, not just the delta
  assert.equal(meta.calls[1].segmentId, 'journey:Retarget');
});

test('remove subtracts from the audience', async () => {
  const { sync, meta } = mk();
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'add', members: [{ email: 'a@x.com' }, { email: 'b@x.com' }] });
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'remove', members: [{ email: 'a@x.com' }] });
  assert.deepEqual(meta.calls.at(-1).emails, ['b@x.com']);
});

test('dedupes by identity (email+phone), case-insensitive', async () => {
  const { sync, meta } = mk();
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'add', members: [{ email: 'A@x.com' }] });
  await sync({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'add', members: [{ email: 'a@x.com' }] });
  assert.deepEqual(meta.calls.at(-1).emails, ['a@x.com']); // one person, not two
});

test('"both" fans out to Meta AND TikTok, each with its own ledger', async () => {
  const { sync, meta, tiktok } = mk();
  await sync({ entityId: 'e1', platform: 'both', audienceName: 'R', action: 'add', members: [{ email: 'a@x.com' }] });
  assert.equal(meta.calls.length, 1);
  assert.equal(tiktok.calls.length, 1);
});

test('a not-connected platform is skipped — no connector call, no throw', async () => {
  const meta = makeConn(false); const tiktok = makeConn(true);
  const { sync } = mk({ meta, tiktok });
  const r = await sync({ entityId: 'e1', platform: 'both', audienceName: 'R', action: 'add', members: [{ email: 'a@x.com' }] });
  assert.equal(meta.calls.length, 0, 'unconnected Meta never called');
  assert.equal(tiktok.calls.length, 1, 'connected TikTok still synced');
  assert.ok(r.results.find((x) => x.platform === 'meta').skipped === 'not_connected');
});

test('the ledger persists across separate factory instances (same DB)', async () => {
  const db = { db: new Database(':memory:') };
  const meta = makeConn();
  await factory({ db, meta })({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'add', members: [{ email: 'a@x.com' }] });
  await factory({ db, meta })({ entityId: 'e1', platform: 'meta', audienceName: 'R', action: 'add', members: [{ email: 'b@x.com' }] });
  assert.deepEqual(meta.calls.at(-1).emails, ['a@x.com', 'b@x.com']); // second instance saw the first's membership
});
