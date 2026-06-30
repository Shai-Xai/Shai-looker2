// owlMemory — scope-aware (client + event) memory store + the rememberFact act-tool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const owlMemory = require('../server/owlMemory');

// Tiny in-memory settings stub standing in for db.getSetting/setSetting.
function fakeDb() {
  const store = new Map();
  return { getSetting: (k, d = '') => (store.has(k) ? store.get(k) : d), setSetting: (k, v) => store.set(k, v) };
}

test('client + event memory are separate stores, de-duped case-insensitively', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  m.add('client', 'ent1', 'They report revenue excluding fees');
  m.add('client', 'ent1', 'they REPORT revenue EXCLUDING fees'); // dupe → ignored
  m.add('event', 'suiteA', '3-day camping festival');
  assert.equal(m.read('client', 'ent1').length, 1);
  assert.equal(m.read('event', 'suiteA').length, 1);
  assert.deepEqual(m.read('event', 'ent1'), []); // event store for ent1 is its own (empty)
  assert.deepEqual(m.read('client', 'nope'), []); // unknown → empty, never another scope's facts
});

test('memoryNote merges client + this-event facts, labelled', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  m.add('client', 'ent1', 'VIP is the priority tier');
  m.add('event', 'suiteA', 'This event sells add-ons heavily');
  const note = owlMemory.memoryNote(db, 'ent1', 'suiteA');
  assert.match(note, /about this client/);
  assert.match(note, /VIP is the priority tier/);
  assert.match(note, /THIS EVENT/);
  assert.match(note, /add-ons heavily/);
  // No event in scope → only client facts.
  assert.doesNotMatch(owlMemory.memoryNote(db, 'ent1', ''), /THIS EVENT/);
});

test('rememberFact tool drafts at the chosen scope (event needs a suite in context)', () => {
  // scope=event with a suite → event draft
  const ev = owlMemory.tool.run({ fact: 'camping festival', scope: 'event' }, { entityId: 'ent1', suiteId: 'suiteA', user: { entityIds: ['ent1'] } });
  assert.equal(ev.action.memScope, 'event');
  assert.equal(ev.action.targetId, 'suiteA');
  // scope=event but NO suite → falls back to client
  const noSuite = owlMemory.tool.run({ fact: 'x', scope: 'event' }, { entityId: 'ent1', user: { entityIds: ['ent1'] } });
  assert.equal(noSuite.action.memScope, 'client');
  assert.equal(noSuite.action.targetId, 'ent1');
  // default scope = client
  const cl = owlMemory.tool.run({ fact: 'y' }, { entityId: 'ent1', user: { entityIds: ['ent1'] } });
  assert.equal(cl.action.memScope, 'client');
});
