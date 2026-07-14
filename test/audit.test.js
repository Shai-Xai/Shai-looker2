// User-action audit: the db layer (last_login + user_actions readers) and the
// audit middleware that turns successful mutating requests into labelled actions.
// Driven over real HTTP through the shared harness so the middleware's req.user /
// status-code / route-matching behaviour is exercised exactly as in production.

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { startApp } = require('./http');

const db = h.db;
const tick = () => new Promise((r) => setTimeout(r, 60)); // let res.on('finish') run

// Mount the audit middleware + a handful of fake routes whose paths match real
// rules, so we test the matcher without booting the whole server.
function mountAudit(app) {
  require('../server/audit').mount(app, { db });
  app.post('/api/segments/:entityId', (req, res) => res.json({ ok: true }));
  app.post('/api/segments/:entityId/:id/preview', (req, res) => res.json({ ok: true })); // NOT in the map
  app.post('/api/actions/:entityId/:id/approve', (req, res) => res.json({ ok: true }));
  app.put('/api/admin/users/:id', (req, res) => res.status(400).json({ error: 'nope' })); // a 4xx
  app.get('/api/my/digest-history/:entityId/:id', (req, res) => res.json({ ok: true })); // a throttled view
}

test('touchLastLogin stamps the user and surfaces on getUser', () => {
  const u = db.createUser({ email: `ll-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  assert.equal(db.getUser(u.id).lastLogin, null);
  db.touchLastLogin(u.id);
  assert.ok(db.getUser(u.id).lastLogin, 'lastLogin is set after touch');
});

test('recordAction + readers (list, batch-latest, batch-last-view)', () => {
  const u = db.createUser({ email: `ra-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  db.recordAction({ userId: u.id, action: 'campaign.send', label: 'Sent a campaign', entityId: 'e1', targetId: 'c1' });
  db.recordAction({ userId: u.id, action: 'segment.create', label: 'Created a segment', entityId: 'e1' });
  const list = db.listActionsForUser(u.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'Created a segment', 'newest first');
  const last = db.lastActionsForUsers()[u.id];
  assert.equal(last.action, 'segment.create');
  // recordView feeds the "last active" batch reader.
  db.recordView(u.id, '', 'dash1');
  assert.ok(db.lastViewForUsers()[u.id], 'last view recorded');
});

test('middleware logs a successful mutation with the right label + entity + detail', async () => {
  const u = db.createUser({ email: `mw-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  const app = await startApp(mountAudit);
  try {
    const r = await app.req('POST', '/api/segments/ent-9', { as: db.getUser(u.id), body: { name: 'VIP buyers' } });
    assert.equal(r.status, 200);
    await tick();
    const list = db.listActionsForUser(u.id);
    const a = list.find((x) => x.action === 'segment.create');
    assert.ok(a, 'segment.create was audited');
    assert.equal(a.label, 'Created a segment');
    assert.equal(a.entityId, 'ent-9', 'entity resolved from the path');
    assert.equal(a.detail.name, 'VIP buyers', 'body name captured into detail');
  } finally { await app.close(); }
});

test('middleware ignores unauthenticated, failed (4xx) and unmapped requests', async () => {
  const u = db.createUser({ email: `neg-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  const user = db.getUser(u.id);
  const app = await startApp(mountAudit);
  try {
    await app.req('POST', '/api/segments/ent-1', { body: { name: 'x' } });            // no `as` → unauthenticated
    await app.req('PUT', '/api/admin/users/abc', { as: user, body: {} });             // 4xx → not logged
    await app.req('POST', '/api/segments/ent-1/seg-1/preview', { as: user, body: {} }); // unmapped → not logged
    await tick();
    assert.equal(db.listActionsForUser(user.id).length, 0, 'nothing audited');
  } finally { await app.close(); }
});

test('a background (?bg=1) view is not recorded as an action', async () => {
  const u = db.createUser({ email: `bg-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  const user = db.getUser(u.id);
  const app = await startApp(mountAudit);
  try {
    await app.req('GET', '/api/my/digest-history/ent-3/dig-9?bg=1', { as: user }); // widget fetch
    await tick();
    assert.equal(db.listActionsForUser(user.id).filter((a) => a.action === 'digest.view').length, 0, 'background view not logged');
    await app.req('GET', '/api/my/digest-history/ent-3/dig-9', { as: user }); // deliberate view
    await tick();
    assert.equal(db.listActionsForUser(user.id).filter((a) => a.action === 'digest.view').length, 1, 'deliberate view still logged');
  } finally { await app.close(); }
});

test('view rules are throttled — repeated views collapse to one row', async () => {
  const u = db.createUser({ email: `view-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  const user = db.getUser(u.id);
  const app = await startApp(mountAudit);
  try {
    await app.req('GET', '/api/my/digest-history/ent-2/dig-7', { as: user });
    await app.req('GET', '/api/my/digest-history/ent-2/dig-7', { as: user });
    await tick();
    const views = db.listActionsForUser(user.id).filter((a) => a.action === 'digest.view');
    assert.equal(views.length, 1, 'second identical view within the window is skipped');
  } finally { await app.close(); }
});
