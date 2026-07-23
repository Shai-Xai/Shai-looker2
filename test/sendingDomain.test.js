// Custom sending domain — validation, the verified-only from-address rule, and
// the entity-ownership guard. Resend is stubbed via global.fetch; the mailer is
// a stub capturing the registered resolver.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { mount, CLEAN_DOMAIN, CLEAN_LOCAL } = require('../server/sendingDomain');

const origFetch = global.fetch;
let resendCalls = [];
beforeEach(() => {
  resendCalls = [];
  global.fetch = async (url, opts = {}) => {
    resendCalls.push({ url: String(url), method: opts.method || 'GET' });
    const body = { id: 'dom_1', status: 'pending', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=abc', status: 'not_started' }] };
    if (String(url).endsWith('/verify')) return { ok: true, json: async () => ({}) };
    if ((opts.method || 'GET') === 'GET') return { ok: true, json: async () => ({ ...body, status: 'verified', records: [{ ...body.records[0], status: 'verified' }] }) };
    return { ok: true, json: async () => body };
  };
});
afterEach(() => { global.fetch = origFetch; });

// Capture routes on a fake app; run handlers directly with fake req/res.
function build() {
  const routes = {};
  const app = {};
  for (const m of ['get', 'put', 'post', 'delete']) app[m] = (path, ...fns) => { routes[`${m} ${path}`] = fns; };
  const sqlDb = new Database(':memory:');
  const db = { db: sqlDb, getSetting: (k) => (k === 'resend_api_key' ? 're_test_key' : '') };
  const auth = { requireAdmin: 'ADMIN', requireAuth: 'AUTH', requirePermission: () => 'PERM' };
  const mailer = { fromAddress: () => 'pulse@howler.co.za', resolver: null, setCustomFrom(fn) { this.resolver = fn; } };
  const apiRef = mount(app, { db, auth, mailer });
  const call = async (key, { params = {}, body = {}, user = { role: 'admin', entityIds: [] } } = {}) => {
    const fns = routes[key]; assert.ok(fns, `route ${key} exists`);
    const handler = fns[fns.length - 1];
    let out = null; let code = 200;
    const res = { json: (v) => { out = v; return res; }, status: (c) => { code = c; return res; } };
    await handler({ params, body, user }, res, () => {});
    return { out, code };
  };
  return { routes, call, mailer, apiRef };
}

test('domain + from-local validation shapes', () => {
  for (const good of ['mail.brand.com', 'brand.co.za', 'a-b.c-d.io']) assert.ok(CLEAN_DOMAIN.test(good), good);
  for (const bad of ['brand', '-x.com', 'x-.com', 'http://x.com', 'x.com/path', 'X.COM ']) assert.ok(!CLEAN_DOMAIN.test(bad), bad);
  for (const good of ['events', 'no.reply', 'hey_there-1']) assert.ok(CLEAN_LOCAL.test(good), good);
  for (const bad of ['.dot', 'sp ace', 'a@b']) assert.ok(!CLEAN_LOCAL.test(bad), bad);
});

test('set → pending (no custom from yet) → verify → custom from active', async () => {
  const { call, mailer } = build();
  const put = await call('put /api/admin/entities/:entityId/sending-domain', { params: { entityId: 'e1' }, body: { domain: 'Mail.Brand.com', fromLocal: 'Events' } });
  assert.equal(put.out.domain, 'mail.brand.com'); // normalised
  assert.equal(put.out.status, 'pending');
  assert.equal(put.out.active, false);
  assert.equal(mailer.resolver('e1'), '', 'pending domain must NOT change the from address');
  const ver = await call('post /api/admin/entities/:entityId/sending-domain/verify', { params: { entityId: 'e1' } });
  assert.equal(ver.out.status, 'verified');
  assert.equal(ver.out.active, true);
  assert.equal(mailer.resolver('e1'), 'events@mail.brand.com');
  assert.equal(mailer.resolver('other'), '', 'other entities unaffected');
});

test('remove falls back to the platform address', async () => {
  const { call, mailer } = build();
  await call('put /api/admin/entities/:entityId/sending-domain', { params: { entityId: 'e1' }, body: { domain: 'mail.brand.com' } });
  await call('post /api/admin/entities/:entityId/sending-domain/verify', { params: { entityId: 'e1' } });
  assert.equal(mailer.resolver('e1'), 'events@mail.brand.com');
  const del = await call('delete /api/admin/entities/:entityId/sending-domain', { params: { entityId: 'e1' } });
  assert.equal(del.out.status, 'unset');
  assert.equal(mailer.resolver('e1'), '');
});

test('client self-service guard: only own entity passes', async () => {
  const { routes } = build();
  const guards = routes['get /api/my/sending-domain/:entityId'];
  const myGuard = guards[guards.length - 2]; // [AUTH, PERM, myGuard, handler]
  let denied = 0;
  const res = { status: () => ({ json: () => { denied += 1; } }) };
  let passed = 0;
  myGuard({ params: { entityId: 'e1' }, user: { role: 'member', entityIds: ['e2'] } }, res, () => { passed += 1; });
  assert.equal(denied, 1);
  myGuard({ params: { entityId: 'e1' }, user: { role: 'member', entityIds: ['e1'] } }, res, () => { passed += 1; });
  assert.equal(passed, 1);
});

test('adopts an already-registered Resend domain instead of dead-ending', async () => {
  // POST /domains → "registered already"; the module should list, match by name,
  // GET the existing domain and store its records so setup still completes.
  let phase = 'post';
  global.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    if (m === 'POST' && u.endsWith('/domains')) return { ok: false, status: 422, json: async () => ({ message: 'The kff.it domain has been registered already.' }) };
    if (m === 'GET' && u.endsWith('/domains')) return { ok: true, json: async () => ({ data: [{ id: 'dom_existing', name: 'kff.it', status: 'pending' }] }) };
    if (m === 'GET' && u.includes('/domains/dom_existing')) return { ok: true, json: async () => ({ id: 'dom_existing', name: 'kff.it', status: 'pending', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=xyz', status: 'not_started' }] }) };
    return { ok: true, json: async () => ({}) };
  };
  const { call } = build();
  const ent = { id: 'e-kff' };
  // seed entity lookup used by view()/guards isn't needed for admin setDomain route
  const r = await call('put /api/admin/entities/:entityId/sending-domain', { params: { entityId: ent.id }, body: { domain: 'kff.it', fromLocal: 'info' } });
  assert.equal(r.code, 200, 'setup succeeds by adopting the existing domain');
  assert.equal(r.out.domain, 'kff.it');
  assert.ok((r.out.records || []).some((x) => x.type === 'TXT'), 'the existing domain’s DNS records are surfaced for the client');
});
