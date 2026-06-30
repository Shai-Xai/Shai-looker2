// owlMemory — the durable per-client memory store + the rememberFact act-tool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const owlMemory = require('../server/owlMemory');

// Tiny in-memory settings stub standing in for db.getSetting/setSetting.
function fakeDb() {
  const store = new Map();
  return { getSetting: (k, d = '') => (store.has(k) ? store.get(k) : d), setSetting: (k, v) => store.set(k, v) };
}

test('add stores a fact scoped to its client, de-duped case-insensitively', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  m.add('ent1', 'VIP is the priority tier', 'a@b.com');
  m.add('ent1', 'vip is the PRIORITY tier', 'a@b.com'); // dupe → ignored
  m.add('ent2', 'Flagship event is KFF', 'a@b.com');
  assert.equal(m.read('ent1').length, 1);
  assert.equal(m.read('ent2').length, 1);
  assert.equal(m.read('ent1')[0].text, 'VIP is the priority tier');
  assert.deepEqual(m.read('nope'), []); // unknown client → empty, never another client's facts
});

test('memoryNote injects the facts (or nothing when empty)', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  assert.equal(owlMemory.memoryNote(db, 'ent1'), '');
  m.add('ent1', 'They report revenue excluding fees');
  const note = owlMemory.memoryNote(db, 'ent1');
  assert.match(note, /REMEMBER/);
  assert.match(note, /excluding fees/);
});

test('save replaces the list and drops empties', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  m.save('ent1', [{ text: 'Fact A' }, { text: '   ' }, { text: 'Fact B' }]);
  assert.deepEqual(m.read('ent1').map((x) => x.text), ['Fact A', 'Fact B']);
});

test('rememberFact tool DRAFTS (confirm) and needs a client', () => {
  const noClient = owlMemory.tool.run({ fact: 'X' }, { user: { entityIds: ['a', 'b'] } });
  assert.equal(noClient.ok, false); // ambiguous client → refuse
  const ok = owlMemory.tool.run({ fact: 'VIP first' }, { entityId: 'ent1', user: { entityIds: ['ent1'] } });
  assert.equal(ok.confirm, true);
  assert.equal(ok.action.kind, 'rememberFact');
  assert.equal(ok.action.entityId, 'ent1');
  assert.equal(ok.action.fact, 'VIP first');
});
