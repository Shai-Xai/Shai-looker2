// Authentication & role-permission tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test('passwords are bcrypt-hashed, never stored or returned in plaintext', () => {
  const pub = h.db.createUser({ email: 'pw@test.local', password: 'secret123', role: 'client' });
  assert.ok(!('passwordHash' in pub), 'public user object must not carry the hash');

  const full = h.db.getUser(pub.id);
  assert.notEqual(full.passwordHash, 'secret123', 'must not store plaintext');
  assert.match(full.passwordHash, /^\$2[aby]\$/, 'looks like a bcrypt hash');
});

test('verifyCredentials accepts the right password and rejects the wrong one', () => {
  h.db.createUser({ email: 'login@test.local', password: 'correct-horse', role: 'client' });
  assert.ok(h.db.verifyCredentials('login@test.local', 'correct-horse'), 'correct password verifies');
  assert.equal(h.db.verifyCredentials('login@test.local', 'wrong'), null, 'wrong password rejected');
  assert.equal(h.db.verifyCredentials('nobody@test.local', 'whatever'), null, 'unknown user rejected');
});

test('an admin has every permission on any entity', () => {
  const admin = h.makeAdmin('perms-admin@test.local');
  const ent = h.makeEntity('Any Co', 'org');
  for (const perm of Object.values(h.roles.PERMISSIONS)) {
    assert.ok(h.auth.hasPermission(admin, ent.id, perm), `admin should hold ${perm}`);
  }
});

test('a client has no permissions on an entity they do not belong to', () => {
  const entA = h.makeEntity('A', 'A-org');
  const entB = h.makeEntity('B', 'B-org');
  const user = h.makeClient('only-a@test.local', [entA.id]); // member of A only
  for (const perm of Object.values(h.roles.PERMISSIONS)) {
    assert.equal(h.auth.hasPermission(user, entB.id, perm), false, `must NOT hold ${perm} on B`);
  }
});

test('role permissions are enforced: finance can view settlements but not approve campaigns', () => {
  const ent = h.makeEntity('Finance Co', 'fin-org');
  const user = h.makeClient('fin@test.local', [ent.id], 'finance');
  const P = h.roles.PERMISSIONS;
  assert.ok(h.auth.hasPermission(user, ent.id, P.SETTLEMENTS_VIEW), 'finance sees settlements');
  assert.ok(h.auth.hasPermission(user, ent.id, P.DASHBOARDS_VIEW), 'finance sees dashboards');
  assert.equal(h.auth.hasPermission(user, ent.id, P.CAMPAIGNS_APPROVE), false, 'finance cannot approve campaigns');
  assert.equal(h.auth.hasPermission(user, ent.id, P.INTEGRATIONS_MANAGE), false, 'finance cannot manage integrations');
});

test('goals.manage: owner/manager/marketing/finance can set goals; a viewer cannot', () => {
  const ent = h.makeEntity('Goals Perm Co', 'gp-org');
  const P = h.roles.PERMISSIONS;
  for (const role of ['owner', 'manager', 'marketing', 'finance']) {
    assert.ok(h.auth.hasPermission(h.makeClient(`gm-${role}@test.local`, [ent.id], role), ent.id, P.GOALS_MANAGE), `${role} can manage goals`);
  }
  assert.equal(h.auth.hasPermission(h.makeClient('gm-viewer@test.local', [ent.id], 'viewer'), ent.id, P.GOALS_MANAGE), false, 'viewer cannot');
});

test('a viewer is read-only: dashboards yes, everything else no', () => {
  const ent = h.makeEntity('Viewer Co', 'v-org');
  const user = h.makeClient('viewer@test.local', [ent.id], 'viewer');
  const P = h.roles.PERMISSIONS;
  assert.ok(h.auth.hasPermission(user, ent.id, P.DASHBOARDS_VIEW));
  assert.equal(h.auth.hasPermission(user, ent.id, P.CAMPAIGNS_APPROVE), false);
  assert.equal(h.auth.hasPermission(user, ent.id, P.TEAM_MANAGE), false);
  assert.equal(h.auth.hasPermission(user, ent.id, P.DIGESTS_MANAGE), false);
});
