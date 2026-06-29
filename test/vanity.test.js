// Vanity login slugs: the admin set/validate path + the PUBLIC branding lookup
// that paints the white-labelled /<slug> login. Routes are exercised directly via
// captured handlers (no HTTP) — the deliverable is the validation + resolution.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity } = require('./helpers');
const vanity = require('../server/vanity');

// Capture registered route handlers so we can invoke them with fake req/res.
function mount() {
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; }, post() {}, delete() {} };
  const mailer = { resolveBranding: (id) => ({ wordmark: 'Acme', brandColor: '#123456', secondaryColor: '#abcdef', logo: 'data:logo', logoDark: '', loginBackground: 'data:bg' }) };
  vanity.mount(app, { db, auth, mailer });
  return routes;
}
// Invoke a handler and capture the response (status defaults to 200).
function call(handler, { params = {}, body = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; } };
  handler({ params, body }, res);
  return { code, body: payload };
}

test('normalizeSlug: lowercases, strips junk, collapses/trim hyphens, caps length', () => {
  assert.equal(vanity.normalizeSlug('  Kunye  '), 'kunye');
  assert.equal(vanity.normalizeSlug('My Cool Event!!'), 'my-cool-event');
  assert.equal(vanity.normalizeSlug('--a__b--'), 'a-b');
  assert.equal(vanity.normalizeSlug('x'.repeat(60)).length, 40);
});

test('set + resolve a slug; public branding returns NON-secret brand only', () => {
  const routes = mount();
  const e = makeEntity('Acme', 'org1');
  const put = call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: e.id }, body: { slug: 'Kunye' } });
  assert.equal(put.code, 200);
  assert.equal(put.body.slug, 'kunye');           // normalized

  const got = call(routes['GET /api/admin/entities/:id/slug'], { params: { id: e.id } });
  assert.equal(got.body.slug, 'kunye');

  const pub = call(routes['GET /api/branding/:slug'], { params: { slug: 'kunye' } });
  assert.equal(pub.code, 200);
  assert.equal(pub.body.name, 'Acme');
  assert.equal(pub.body.primary, '#123456');
  assert.equal(pub.body.loginBackground, 'data:bg');
  assert.ok(!('integrations' in pub.body) && !('senderName' in pub.body), 'no secret/sender fields leak');
});

test('reserved words and duplicates are rejected; unknown slug 404s', () => {
  const routes = mount();
  const a = makeEntity('A', 'orgA');
  const b = makeEntity('B', 'orgB');

  const reserved = call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: a.id }, body: { slug: 'admin' } });
  assert.equal(reserved.code, 400);

  call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: a.id }, body: { slug: 'shared' } });
  const dup = call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: b.id }, body: { slug: 'shared' } });
  assert.equal(dup.code, 409);

  const miss = call(routes['GET /api/branding/:slug'], { params: { slug: 'nobody' } });
  assert.equal(miss.code, 404);
});

test('blank slug clears the mapping', () => {
  const routes = mount();
  const e = makeEntity('C', 'orgC');
  call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: e.id }, body: { slug: 'temp' } });
  const cleared = call(routes['PUT /api/admin/entities/:id/slug'], { params: { id: e.id }, body: { slug: '' } });
  assert.equal(cleared.body.slug, '');
  const miss = call(routes['GET /api/branding/:slug'], { params: { slug: 'temp' } });
  assert.equal(miss.code, 404);
});
