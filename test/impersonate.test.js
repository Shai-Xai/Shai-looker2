// 👁 View as user: the cookie swap is safe — target session carries imp claim,
// exit only restores a RETURN token that verifies as a live admin, and admins
// can never be impersonated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const auth = require('../server/auth');

function fakeRes() { const jar = {}; return { jar, cookie(n, v) { jar[n] = v; }, clearCookie(n) { delete jar[n]; } }; }
const reqWith = (jar) => ({ cookies: { ...jar } });
function attach(jar) { const req = reqWith(jar); auth.attachUser(req, {}, () => {}); return req.user; }

test('impersonation swaps to the target session and exit restores the admin', () => {
  const ent = h.makeEntity('Imp Co', 'Imp Org');
  const admin = h.makeAdmin ? h.makeAdmin('imp-admin@test') : auth.createUser({ email: 'imp-admin@test', password: 'x12345678', role: 'admin' });
  const target = auth.createUser({ email: 'imp-user@test', password: 'x12345678', role: 'client', entityIds: [ent.id] });
  // Admin logs in (normal cookie)…
  const r1 = fakeRes(); auth.issueCookie(r1, h.db.getUser(admin.id));
  assert.equal(attach(r1.jar)?.id, admin.id);
  // …then views as the target.
  const r2 = fakeRes(); Object.assign(r2.jar, r1.jar);
  auth.issueImpersonationCookie(reqWith(r1.jar), r2, h.db.getUser(target.id), h.db.getUser(admin.id));
  assert.equal(attach(r2.jar)?.id, target.id, 'session now IS the target user');
  assert.ok(r2.jar.howler_viewing_as.includes('imp-user'), 'UI hint cookie set');
  // Exit restores the admin.
  const r3 = fakeRes();
  const back = auth.endImpersonation(reqWith(r2.jar), r3);
  assert.equal(back?.id, admin.id);
  assert.equal(attach({ ...r2.jar, ...r3.jar })?.id, admin.id, 'admin session restored');
});

test('exit with a tampered/absent return token never mints admin access', () => {
  const r = fakeRes();
  assert.equal(auth.endImpersonation(reqWith({}), r), null, 'no return cookie → null + session cleared');
  const r2 = fakeRes();
  assert.equal(auth.endImpersonation(reqWith({ howler_admin_return: 'garbage.token.here' }), r2), null);
});
