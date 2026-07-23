// Product site (server/productSite.js): the curated feature matrix with admin
// include/exclude, and the overview-markdown section filter that keeps hidden
// sections off the public page.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth } = require('./helpers');

const productSite = require('../server/productSite');

// Mount capturing the final route handlers (no real express; middleware skipped —
// requireAdmin is exercised by the auth suite). `use` is a no-op: the module
// also mounts a static gallery (/sales/experience) via app.use, which this
// harness doesn't exercise — without the stub the whole mount throws.
function mountRoutes() {
  const routes = {};
  const reg = (m) => (p, ...hs) => { for (const key of [].concat(p)) routes[m + ' ' + key] = hs[hs.length - 1]; };
  productSite.mount({ get: reg('GET'), put: reg('PUT'), use: () => {} }, { db, auth });
  return routes;
}
const res = () => {
  const o = { headers: {} };
  o.setHeader = (k, v) => { o.headers[k] = v; return o; };
  o.type = () => o;
  o.status = (c) => { o.code = c; return o; };
  o.json = (b) => { o.body = b; o.code = o.code || 200; return o; };
  o.send = (b) => { o.sent = b; o.code = o.code || 200; return o; };
  o.sendFile = (f) => { o.file = f; return o; };
  return o;
};

test('matrix: hiding a feature removes it from the public site; the admin still sees it flagged', () => {
  const routes = mountRoutes();
  const put = (body) => { const r = res(); routes['PUT /api/admin/product/visibility']({ body }, r); return r; };
  const pub = () => { const r = res(); routes['GET /api/product/site']({}, r); return r.body; };
  const adm = () => { const r = res(); routes['GET /api/admin/product/matrix']({}, r); return r.body; };

  const before = pub();
  const dash = before.sections.find((s) => s.id === 'dashboards');
  assert.ok(dash.features.some((f) => f.id === 'dash.pwa'), 'feature visible before hiding');

  assert.equal(put({ kind: 'feature', id: 'dash.pwa', hidden: true }).code, 200);
  const afterPub = pub().sections.find((s) => s.id === 'dashboards');
  assert.ok(!afterPub.features.some((f) => f.id === 'dash.pwa'), 'hidden feature is gone from the public matrix');

  const afterAdm = adm().sections.find((s) => s.id === 'dashboards');
  assert.equal(afterAdm.features.find((f) => f.id === 'dash.pwa').hidden, true, 'admin sees it, flagged hidden');

  assert.equal(put({ kind: 'feature', id: 'dash.pwa', hidden: false }).code, 200);
  assert.ok(pub().sections.find((s) => s.id === 'dashboards').features.some((f) => f.id === 'dash.pwa'), 'un-hiding restores it');
});

test('matrix: hiding a whole section removes it (and all its features) from the public site', () => {
  const routes = mountRoutes();
  const put = (body) => { const r = res(); routes['PUT /api/admin/product/visibility']({ body }, r); return r; };
  const pub = () => { const r = res(); routes['GET /api/product/site']({}, r); return r.body; };

  put({ kind: 'section', id: 'eventops', hidden: true });
  assert.ok(!pub().sections.some((s) => s.id === 'eventops'), 'hidden section is gone entirely');
  put({ kind: 'section', id: 'eventops', hidden: false });
  assert.ok(pub().sections.some((s) => s.id === 'eventops'), 'restored');
});

test('visibility route: rejects a bad kind and an unknown id', () => {
  const routes = mountRoutes();
  const put = (body) => { const r = res(); routes['PUT /api/admin/product/visibility']({ body }, r); return r; };
  assert.equal(put({ kind: 'nope', id: 'x', hidden: true }).code, 400);
  assert.equal(put({ kind: 'feature', id: 'not.a.feature', hidden: true }).code, 404);
  assert.equal(put({ kind: 'section', id: 'not-a-section', hidden: true }).code, 404);
});

test('overview filter: a hidden ## section vanishes, its ### subsections with it, and the rest survives', () => {
  const md = [
    '# Title', '',
    '## Keep me', 'kept body', '',
    '---', '',
    '## Hide me  🧪', 'secret body', '### A subsection', 'more secret', '',
    '## Also keep', 'tail body',
  ].join('\n');
  const sections = productSite.overviewSections(md);
  assert.deepEqual(sections.map((s) => s.slug), ['keep-me', 'hide-me', 'also-keep']);

  const out = productSite.filterOverviewMd(md, new Set(['hide-me']));
  assert.ok(out.includes('kept body') && out.includes('tail body'), 'other sections intact');
  assert.ok(!out.includes('secret body') && !out.includes('A subsection'), 'hidden section + subsections stripped');
  assert.ok(out.includes('## Keep me') && out.includes('## Also keep') && !out.includes('## Hide me'));
});

test('overview filter: duplicate headings stay individually addressable', () => {
  const md = ['## Twin', 'first', '## Twin', 'second'].join('\n');
  const sections = productSite.overviewSections(md);
  assert.deepEqual(sections.map((s) => s.slug), ['twin', 'twin-2']);
  const out = productSite.filterOverviewMd(md, new Set(['twin-2']));
  assert.ok(out.includes('first') && !out.includes('second'), 'only the second twin is stripped');
});

test('the real overview doc parses into sections and each catalogue id is unique', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.join(__dirname, '../docs/PRODUCT_OVERVIEW_SALES.md'), 'utf8');
  const sections = productSite.overviewSections(md);
  assert.ok(sections.length >= 10, 'the doc has its ## sections');
  assert.equal(new Set(sections.map((s) => s.slug)).size, sections.length, 'overview slugs unique');

  const ids = [];
  for (const s of productSite.CATALOGUE) { ids.push(s.id); for (const [fid] of s.features) ids.push(fid); }
  assert.equal(new Set(ids).size, ids.length, 'catalogue section/feature ids unique');
});

// Every feature must carry the plain-language "what it does for you" description —
// it powers the tap-to-explain rows on the in-app What's in Pulse grid and the
// public /sales/features page. A blank one renders as a dead-end row.
test('every catalogue feature has a client-facing desc, and the public API serves it', () => {
  for (const s of productSite.CATALOGUE) {
    for (const [fid, , , desc] of s.features) {
      assert.ok(typeof desc === 'string' && desc.trim().length >= 20, `feature ${fid} needs a real desc`);
    }
  }
  const routes = mountRoutes();
  const r = res();
  routes['GET /api/product/site']({}, r);
  const dash = r.body.sections.find((s) => s.id === 'dashboards');
  assert.ok(dash.features.every((f) => f.desc && f.desc.length >= 20), 'public matrix carries desc per feature');
});
