// First name / surname / mobile on users: persisted at creation, partial-updatable,
// surfaced via publicUser (never the password hash), through both the db layer and
// the auth wrapper that the admin + team endpoints call.

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const db = h.db;
const auth = h.auth;

test('db.createUser persists names + mobile and computes fullName', () => {
  const u = db.createUser({ email: `a-${Date.now()}@t.com`, password: 'pw123456', role: 'client', firstName: 'Ada', lastName: 'Lovelace', mobile: '+27820001111' });
  assert.equal(u.firstName, 'Ada');
  assert.equal(u.lastName, 'Lovelace');
  assert.equal(u.fullName, 'Ada Lovelace');
  assert.equal(u.mobile, '+27820001111');
  assert.ok(!('passwordHash' in u), 'publicUser never exposes the hash');
  const got = db.getUser(u.id);
  assert.equal(got.fullName, 'Ada Lovelace');
  assert.equal(got.mobile, '+27820001111');
});

test('db.updateUser patches names/mobile and leaves untouched fields alone', () => {
  const u = db.createUser({ email: `b-${Date.now()}@t.com`, password: 'pw123456', role: 'client', firstName: 'Grace', lastName: 'Hopper', mobile: '+27820002222' });
  const upd = db.updateUser(u.id, { firstName: 'Gracie', mobile: '+27829998888' });
  assert.equal(upd.fullName, 'Gracie Hopper', 'surname preserved');
  assert.equal(upd.mobile, '+27829998888');
});

test('legacy users (no name) get blank fields, not undefined', () => {
  const u = db.createUser({ email: `c-${Date.now()}@t.com`, password: 'pw123456', role: 'client' });
  const got = db.getUser(u.id);
  assert.equal(got.firstName, '');
  assert.equal(got.fullName, '');
  assert.equal(got.mobile, '');
});

test('auth.createUser + auth.publicUser thread the fields (the endpoint path)', () => {
  const pub = auth.createUser({ email: `d-${Date.now()}@t.com`, password: 'pw123456', role: 'admin', firstName: 'Alan', lastName: 'Turing', mobile: '+27820003333' });
  assert.equal(pub.fullName, 'Alan Turing');
  assert.equal(pub.mobile, '+27820003333');
  assert.ok(!('passwordHash' in pub));
  // round-trips through getUser → publicUser too
  const re = auth.publicUser(db.getUser(pub.id));
  assert.equal(re.fullName, 'Alan Turing');
});
