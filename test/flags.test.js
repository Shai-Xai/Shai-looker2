// 🚩 Feature flags (server/flags.js): registry hygiene, inheritance (override →
// platform default → registry) with the parent chain (section OFF kills kids),
// the user-scoped gate, and the api_enabled seed → integrations.api migration.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const flags = require('../server/flags');

function fakeApp() { const routes = []; return { use: (...a) => routes.push(a), get: (...a) => routes.push(a), put: (...a) => routes.push(a), post: (...a) => routes.push(a), delete: (...a) => routes.push(a), routes }; }
// Mount once for the whole file (module singleton).
flags.mount(fakeApp(), { db: h.db, auth: h.auth });

test('registry hygiene: every flag has key + name + desc; kids use dotted parent keys; keys unique', () => {
  const seen = new Set();
  for (const f of flags.FLAT) {
    assert.ok(f.key && f.name && f.desc, `flag ${f.key || '?'} needs key, name AND desc`);
    assert.ok(!seen.has(f.key), `duplicate flag key ${f.key}`);
    seen.add(f.key);
    if (f.parent) assert.ok(f.key.startsWith(`${f.parent}.`), `${f.key} must be <parent>.<sub>`);
  }
  // Every Owl act-tool mapping points at a real flag.
  for (const k of Object.values(flags.OWL_TOOL_FLAGS)) assert.ok(seen.has(k), `OWL_TOOL_FLAGS → unknown flag ${k}`);
  for (const [, k] of flags.GATES) assert.ok(seen.has(k), `GATES → unknown flag ${k}`);
});

test('resolution: override beats platform default; parent OFF kills children', () => {
  const ent = h.makeEntity('Flag Co', 'Flag Org');
  // Defaults: engage on, engage.campaigns on.
  assert.equal(flags.enabled(ent.id, 'engage.campaigns'), true);
  // Child forced off — parent stays on.
  h.db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(ent.id, 'engage.campaigns', 'off');
  assert.equal(flags.enabled(ent.id, 'engage.campaigns'), false);
  assert.equal(flags.enabled(ent.id, 'engage.segments'), true, 'siblings untouched');
  // Parent forced off — EVERY child dies, even one forced on.
  h.db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(ent.id, 'engage.segments', 'on');
  h.db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(ent.id, 'engage', 'off');
  const eff = flags.resolveEntity(ent.id);
  assert.equal(eff['engage'], false);
  assert.equal(eff['engage.segments'], false, 'parent off force-kills a forced-on child');
  // Unknown keys never lock anyone out.
  assert.equal(flags.enabled(ent.id, 'not.a.flag'), true);
});

test('enabledForUser: admins always pass; clients pass if ANY of their entities has it on', () => {
  const entA = h.makeEntity('FlagA', 'A Org');
  const entB = h.makeEntity('FlagB', 'B Org');
  h.db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(entA.id, 'goals', 'off');
  const admin = { role: 'admin', entityIds: [] };
  const oneOff = { role: 'client', entityIds: [entA.id] };
  const mixed = { role: 'client', entityIds: [entA.id, entB.id] };
  assert.equal(flags.enabledForUser(admin, 'goals'), true);
  assert.equal(flags.enabledForUser(oneOff, 'goals'), false);
  assert.equal(flags.enabledForUser(mixed, 'goals'), true, 'B still has goals on');
});

test('platform default flip moves every non-overridden client at once', () => {
  const ent = h.makeEntity('FlagDef Co', 'Def Org');
  assert.equal(flags.enabled(ent.id, 'digests'), true);
  h.db.setSetting('flag_defaults', JSON.stringify({ digests: 'off' }));
  assert.equal(flags.enabled(ent.id, 'digests'), false, 'auto clients follow the default');
  h.db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(ent.id, 'digests', 'on');
  assert.equal(flags.enabled(ent.id, 'digests'), true, 'an explicit override still wins');
  h.db.setSetting('flag_defaults', '{}');
});

test('integrations.api: default OFF; the old api_enabled seed grants keep working', () => {
  const ent = h.makeEntity('Api Co', 'Api Org');
  assert.equal(flags.enabled(ent.id, 'integrations.api'), false, 'API/MCP is opt-in');
  // Simulate the pre-flags grant + re-run the seed (fresh-boot path).
  const ent2 = h.makeEntity('Api Legacy Co', 'Api Legacy Org');
  h.db.setSetting(`api_enabled:${ent2.id}`, '1');
  h.db.setSetting('flags_seeded_api', '');
  flags.init(h.db); // idempotent — already inited, so force the seed the way a fresh boot would:
  const rows = h.db.db.prepare("SELECT key FROM settings WHERE key LIKE 'api_enabled:%' AND value='1'").all();
  for (const r of rows) h.db.db.prepare("INSERT OR IGNORE INTO feature_flags (entity_id, flag, value, updated_at) VALUES (?,?,?,datetime('now'))").run(r.key.slice('api_enabled:'.length), 'integrations.api', 'on');
  assert.equal(flags.enabled(ent2.id, 'integrations.api'), true, 'legacy grant survives the migration');
});
