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

test('verifyCredentials accepts the right password and rejects the wrong one', async () => {
  h.db.createUser({ email: 'login@test.local', password: 'correct-horse', role: 'client' });
  assert.ok(await h.db.verifyCredentials('login@test.local', 'correct-horse'), 'correct password verifies');
  assert.equal(await h.db.verifyCredentials('login@test.local', 'wrong'), null, 'wrong password rejected');
  assert.equal(await h.db.verifyCredentials('nobody@test.local', 'whatever'), null, 'unknown user rejected');
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

// ── Session invalidation (token_version) ─────────────────────────────────────
// A password change must evict every previously-issued session JWT — a captured
// cookie can't outlive the reset meant to kill it. Exercised through the real
// issueCookie → attachUser path (no reaching for the signing secret).
function cookieFor(user) {
  let jar = '';
  h.auth.issueCookie({ cookie: (name, val) => { jar = `${name}=${val}`; } }, user);
  return jar;
}
function userFromCookie(cookieStr) {
  const name = h.auth.COOKIE;
  const val = cookieStr.slice(name.length + 1);
  const req = { cookies: { [name]: val } };
  h.auth.attachUser(req, {}, () => {});
  return req.user;
}

test('a password change bumps token_version and old session cookies stop authenticating', () => {
  const pub = h.db.createUser({ email: 'session@test.local', password: 'first-pass-1', role: 'client' });
  const user = h.db.getUser(pub.id);
  assert.equal(user.tokenVersion, 0);

  const oldCookie = cookieFor(user);
  assert.equal(userFromCookie(oldCookie)?.id, pub.id, 'cookie authenticates before reset');

  h.db.updateUser(pub.id, { password: 'second-pass-2' });
  h.auth.invalidateUser(pub.id); // mirror the reset route (evict the 2s cache)
  assert.equal(h.db.getUser(pub.id).tokenVersion, 1, 'token_version bumped');
  assert.equal(userFromCookie(oldCookie), null, 'the old cookie no longer authenticates');

  // A fresh cookie at the new epoch works; an unrelated edit doesn't churn it.
  const freshCookie = cookieFor(h.db.getUser(pub.id));
  assert.equal(userFromCookie(freshCookie)?.id, pub.id);
  h.db.updateUser(pub.id, { firstName: 'Sam' });
  h.auth.invalidateUser(pub.id);
  assert.equal(h.db.getUser(pub.id).tokenVersion, 1, 'unrelated edit leaves token_version untouched');
  assert.equal(userFromCookie(freshCookie)?.id, pub.id, 'fresh cookie still valid after unrelated edit');
});

test('a tampered / wrong-epoch cookie does not authenticate', () => {
  const pub = h.db.createUser({ email: 'tamper@test.local', password: 'pw-123456', role: 'client' });
  const good = cookieFor(h.db.getUser(pub.id));
  const tampered = good.slice(0, -3) + 'zzz'; // corrupt the signature
  assert.equal(userFromCookie(tampered), null);
});
