// Route-level pins for the extracted settlements/documents module
// (server/settlements.js). These lock the access-control behaviour that matters:
// per-entity scoping, Owl-draft (needs_review) hiding, and the admin-only gate —
// so the extraction from index.js is provably behaviour-preserving, and a future
// change to the module can't silently widen who sees a client's settlement.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

let app;
before(async () => {
  app = await startApp((expressApp) => {
    require('../server/settlements').mount(expressApp, {
      db: h.db,
      auth: h.auth,
      // Extraction endpoints aren't exercised here (they need a live key + PDF);
      // isConfigured:false makes them return a clean 400, which is fine.
      insights: { isConfigured: () => false, extractSettlement: async () => ({}), extractInvoice: async () => ({}) },
      anthropicKey: () => '',
    });
  });
});
after(async () => { if (app) await app.close(); });

test('a client sees only their own entity\'s settlements; another tenant\'s is invisible and 403', async () => {
  const entA = h.makeEntity('Settle A', 'A-org');
  const entB = h.makeEntity('Settle B', 'B-org');
  const clientA = h.makeClient('s-a@test.local', [entA.id], 'owner');
  const sA = h.db.createSettlement({ entityId: entA.id, title: 'A report', data: { meta: {} } });
  const sB = h.db.createSettlement({ entityId: entB.id, title: 'B report', data: { meta: {} } });

  const list = await app.req('GET', '/api/my/settlements', { as: clientA });
  assert.equal(list.status, 200);
  const ids = list.body.map((s) => s.id);
  assert.ok(ids.includes(sA.id), 'sees own settlement');
  assert.ok(!ids.includes(sB.id), 'does NOT see another tenant\'s settlement');

  assert.equal((await app.req('GET', `/api/settlements/${sA.id}`, { as: clientA })).status, 200);
  assert.equal((await app.req('GET', `/api/settlements/${sB.id}`, { as: clientA })).status, 403);
  assert.equal((await app.req('GET', '/api/settlements/does-not-exist', { as: clientA })).status, 404);
});

test('Owl-draft settlements (needs_review) are hidden from clients, visible to admins', async () => {
  const ent = h.makeEntity('Draft Co', 'draft-org');
  const client = h.makeClient('draft@test.local', [ent.id], 'owner');
  const admin = h.makeAdmin('settle-admin@test.local');
  const draft = h.db.createSettlement({ entityId: ent.id, title: 'Owl draft', data: { meta: {} }, source: 'email', needsReview: 1 });

  // Client: not in their list, and a direct read is forbidden.
  const clientList = await app.req('GET', '/api/my/settlements', { as: client });
  assert.ok(!clientList.body.some((s) => s.id === draft.id), 'draft hidden from client list');
  assert.equal((await app.req('GET', `/api/settlements/${draft.id}`, { as: client })).status, 403);

  // Admin: sees drafts (so they can review/publish).
  const adminList = await app.req('GET', '/api/my/settlements', { as: admin });
  assert.ok(adminList.body.some((s) => s.id === draft.id), 'admin sees the draft');
  assert.equal((await app.req('GET', `/api/settlements/${draft.id}`, { as: admin })).status, 200);
});

test('the admin settlements list is admin-only', async () => {
  const ent = h.makeEntity('Gate Co', 'gate-org');
  const client = h.makeClient('gate@test.local', [ent.id], 'owner');
  assert.equal((await app.req('GET', '/api/admin/settlements', { as: client })).status, 403);
  assert.equal((await app.req('GET', '/api/admin/settlements', { as: h.makeAdmin('gate-admin@test.local') })).status, 200);
});

test('an entitled client can save notes; a non-member cannot', async () => {
  const entA = h.makeEntity('Notes A', 'notesA-org');
  const entB = h.makeEntity('Notes B', 'notesB-org');
  const clientA = h.makeClient('n-a@test.local', [entA.id], 'owner');
  const clientB = h.makeClient('n-b@test.local', [entB.id], 'owner');
  const s = h.db.createSettlement({ entityId: entA.id, title: 'Notes report', data: { meta: {} } });

  const ok = await app.req('PUT', `/api/settlements/${s.id}/notes`, { as: clientA, body: { notes: [{ section: 'fees', text: 'Looks right' }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.notes.length, 1);
  assert.equal(ok.body.notes[0].text, 'Looks right');

  const denied = await app.req('PUT', `/api/settlements/${s.id}/notes`, { as: clientB, body: { notes: [{ section: 'x', text: 'nope' }] } });
  assert.equal(denied.status, 403);
});

test('documents are scoped per entity and drafts are hidden from clients', async () => {
  const entA = h.makeEntity('Doc A', 'docA-org');
  const entB = h.makeEntity('Doc B', 'docB-org');
  const clientA = h.makeClient('d-a@test.local', [entA.id], 'owner');
  const docA = h.db.createDocument({ entityId: entA.id, title: 'A invoice' });
  const docB = h.db.createDocument({ entityId: entB.id, title: 'B invoice' });
  const draft = h.db.createDocument({ entityId: entA.id, title: 'Owl invoice', source: 'email', needsReview: 1 });

  assert.equal((await app.req('GET', `/api/documents/${docA.id}`, { as: clientA })).status, 200);
  assert.equal((await app.req('GET', `/api/documents/${docB.id}`, { as: clientA })).status, 403);
  assert.equal((await app.req('GET', `/api/documents/${draft.id}`, { as: clientA })).status, 403, 'draft hidden from client');

  const list = await app.req('GET', '/api/my/documents', { as: clientA });
  const ids = list.body.map((d) => d.id);
  assert.ok(ids.includes(docA.id) && !ids.includes(docB.id) && !ids.includes(draft.id));
});
