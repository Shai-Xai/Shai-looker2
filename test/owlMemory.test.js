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

test('memoryNote merges client + this-event + this-user facts, labelled', () => {
  const db = fakeDb(); const m = owlMemory.build(db);
  m.add('client', 'ent1', 'VIP is the priority tier');
  m.add('event', 'suiteA', 'This event sells add-ons heavily');
  m.add('user', 'usr1', 'Prefers short bullet answers');
  const note = owlMemory.memoryNote(db, 'ent1', 'suiteA', 'usr1');
  assert.match(note, /about this client/);
  assert.match(note, /VIP is the priority tier/);
  assert.match(note, /THIS EVENT/);
  assert.match(note, /add-ons heavily/);
  assert.match(note, /THIS USER/);
  assert.match(note, /short bullet answers/);
  // No event in scope → only client facts.
  assert.doesNotMatch(owlMemory.memoryNote(db, 'ent1', ''), /THIS EVENT/);
  // No user in scope → no personal-preference block.
  assert.doesNotMatch(owlMemory.memoryNote(db, 'ent1', 'suiteA'), /THIS USER/);
  // user store is its own — not reachable via client/event ids.
  assert.deepEqual(m.read('user', 'ent1'), []);
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
  // scope=user with a user in context → user draft, targeted at the user id
  const us = owlMemory.tool.run({ fact: 'short answers please', scope: 'user' }, { entityId: 'ent1', user: { id: 'usr1', entityIds: ['ent1'] } });
  assert.equal(us.action.memScope, 'user');
  assert.equal(us.action.targetId, 'usr1');
  // scope=user but NO user id → falls back to client
  const noUser = owlMemory.tool.run({ fact: 'z', scope: 'user' }, { entityId: 'ent1', user: { entityIds: ['ent1'] } });
  assert.equal(noUser.action.memScope, 'client');
});
