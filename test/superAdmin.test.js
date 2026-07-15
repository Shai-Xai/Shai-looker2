// Super Admin role: gates the highest-risk global controls (billing master,
// integrations, status notices, backup/restore) and delegates client-level fee
// edits to the administering account manager. Exercises the real role helper,
// the middleware, the escalation guard, and the boot-time bootstrap.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// A minimal Express-style res that records the status/JSON a middleware sends.
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
// Run a middleware and report whether it called next() (i.e. allowed the request).
function run(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

function makeSuperAdmin(email) {
  const admin = h.makeAdmin(email);
  h.db.updateUser(admin.id, { roles: ['super_admin'] });
  return h.db.getUser(admin.id);
}

test('isSuperAdmin: only a Howler admin carrying the tag qualifies', () => {
  const plainAdmin = h.makeAdmin('sa-plain@test.local');
  const superAdmin = makeSuperAdmin('sa-super@test.local');
  const ent = h.makeEntity('SA Co', 'sa-org');
  const taggedClient = h.makeClient('sa-client@test.local', [ent.id]);
  h.db.updateUser(taggedClient.id, { roles: ['super_admin'] });

  assert.equal(h.roles.isSuperAdmin(plainAdmin), false, 'a generic admin is NOT a super admin');
  assert.equal(h.roles.isSuperAdmin(superAdmin), true, 'a tagged admin is a super admin');
  assert.equal(h.roles.isSuperAdmin(h.db.getUser(taggedClient.id)), false, 'a client with the tag is NOT a super admin');
  assert.equal(h.roles.isSuperAdmin(null), false, 'no user → false');
});

test('requireSuperAdmin: 401 anon · 403 generic admin · pass super admin', () => {
  const mw = h.auth.requireSuperAdmin;
  assert.equal(run(mw, { user: null }).status, 401, 'anonymous → 401');
  assert.equal(run(mw, { user: h.makeAdmin('rs-admin@test.local') }).status, 403, 'generic admin → 403');
  assert.equal(run(mw, { user: makeSuperAdmin('rs-super@test.local') }).passed, true, 'super admin passes');
});

test('administersEntity / requireEntityAdmin: an AM edits only their clients; a super admin edits any', () => {
  const am = h.makeAdmin('am@test.local');       // account manager
  const other = h.makeAdmin('am-other@test.local'); // an unrelated admin
  const superAdmin = makeSuperAdmin('am-super@test.local');
  const ent = h.makeEntity('AM Client', 'am-org');
  h.db.setEntityHowlerSupport(ent.id, [am.id]);   // am administers this client

  assert.equal(h.auth.administersEntity(am, ent.id), true, 'the assigned AM administers the client');
  assert.equal(h.auth.administersEntity(other, ent.id), false, 'an unrelated admin does not');
  assert.equal(h.auth.administersEntity(superAdmin, ent.id), true, 'a super admin administers every client');

  const mw = h.auth.requireEntityAdmin();
  assert.equal(run(mw, { user: am, params: { id: ent.id } }).passed, true, 'AM passes for their client');
  assert.equal(run(mw, { user: other, params: { id: ent.id } }).status, 403, 'other admin blocked (403)');
  assert.equal(run(mw, { user: superAdmin, params: { id: ent.id } }).passed, true, 'super admin passes');
});

test('guardSuperAdminTag: a non-super admin cannot grant or revoke the tag; a super admin can', () => {
  const mw = h.auth.guardSuperAdminTag;
  const editor = h.makeAdmin('guard-editor@test.local'); // NOT a super admin
  const superEditor = makeSuperAdmin('guard-super@test.local');

  // A plain user the editor is trying to promote → tag stripped.
  const target = h.makeAdmin('guard-target@test.local');
  const grant = { user: editor, params: { id: target.id }, body: { roles: ['super_admin', 'dev'] } };
  run(mw, grant);
  assert.deepEqual(grant.body.roles, ['dev'], 'non-super editor cannot ADD super_admin');

  // An existing super admin the editor is trying to demote → tag preserved.
  const existing = makeSuperAdmin('guard-existing@test.local');
  const revoke = { user: editor, params: { id: existing.id }, body: { roles: [] } };
  run(mw, revoke);
  assert.deepEqual(revoke.body.roles, ['super_admin'], 'non-super editor cannot REMOVE super_admin');

  // A super editor keeps full control.
  const ok = { user: superEditor, params: { id: target.id }, body: { roles: ['super_admin'] } };
  run(mw, ok);
  assert.deepEqual(ok.body.roles, ['super_admin'], 'super editor can grant the tag');
});

test('ensureSuperAdmins bootstrap: with none configured, the oldest admin is promoted (no lockout)', () => {
  // The file shares one DB, so earlier tests already tagged super admins —
  // demote them all to simulate the fresh-deploy "no super admin" state.
  h.makeAdmin('boot-first@test.local');
  h.makeAdmin('boot-second@test.local');
  for (const u of h.db.listUsers()) {
    if (h.roles.isSuperAdmin(u)) h.db.updateUser(u.id, { roles: (u.roles || []).filter((r) => r !== 'super_admin') });
  }
  assert.equal(h.db.listUsers().some((u) => h.roles.isSuperAdmin(u)), false, 'no super admin yet');

  delete process.env.SUPER_ADMIN_EMAILS;
  h.auth.ensureSuperAdmins();

  const oldest = h.db.listUsers().filter((u) => u.role === 'admin')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
  const supers = h.db.listUsers().filter((u) => h.roles.isSuperAdmin(u));
  assert.equal(supers.length, 1, 'exactly one admin bootstrapped');
  assert.equal(supers[0].email, oldest.email, 'the oldest admin was promoted');

  // Idempotent: a second run doesn't promote anyone else.
  h.auth.ensureSuperAdmins();
  assert.equal(h.db.listUsers().filter((u) => h.roles.isSuperAdmin(u)).length, 1, 'still just one');
});
