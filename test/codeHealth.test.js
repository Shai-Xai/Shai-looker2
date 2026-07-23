// Code health panel (server/codeHealth.js): mirrors the daily review's rolling
// GitHub issue into Pulse — unconfigured fail-soft, newest-first reports,
// short cache (one GitHub round-trip per 5 min), refresh bust, stale-on-error.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const codeHealth = require('../server/codeHealth');

const routes = {};
const fakeApp = { get: (p, ...fns) => { routes[`GET ${p}`] = fns; } };
const pass = (_req, _res, next) => next();

let ghCalls = 0;
let ghDown = false;
let configured = true;
const fakeGithub = {
  isConfigured: () => configured,
  findOpenIssueByTitle: async (frag) => {
    ghCalls += 1;
    if (ghDown) throw new Error('GitHub 503');
    assert.match(frag, /Code health/);
    return { number: 77, title: '🩺 Code health — daily review', url: 'https://github.test/issues/77', body: 'rolling issue', updatedAt: '2026-07-23T18:35:15Z' };
  },
  listIssueComments: async (n) => {
    assert.equal(n, 77);
    return [
      { id: 1, author: 'claude[bot]', body: '**Daily review — 2026-07-23**\n\nOne finding.', url: 'u1', createdAt: '2026-07-23T18:35:14Z' },
      { id: 2, author: 'claude', body: 'Finding 1 fixed in abc1234.', url: 'u2', createdAt: '2026-07-23T19:40:00Z' },
    ];
  },
};

const api = codeHealth.mount(fakeApp, { auth: { requireAdmin: pass }, github: fakeGithub });

function call(query = {}) {
  return new Promise((resolve, reject) => {
    const req = { query, params: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, json: p }); } };
    let i = 0;
    const fns = routes['GET /api/admin/code-health'];
    const next = (err) => { if (err) return reject(err); Promise.resolve(fns[i++](req, res, next)).catch(reject); };
    next();
  });
}

test('reports come back newest-first with the issue meta', async () => {
  api._clearCache();
  const r = await call();
  assert.equal(r.json.found, true);
  assert.equal(r.json.issue.number, 77);
  assert.equal(r.json.reports[0].id, 2, 'newest first');
  assert.equal(r.json.reports[1].author, 'claude[bot]');
});

test('a second read within the cache window costs no GitHub round-trip; refresh=1 busts it', async () => {
  api._clearCache();
  ghCalls = 0;
  await call();
  await call();
  assert.equal(ghCalls, 1, 'served from cache');
  await call({ refresh: '1' });
  assert.equal(ghCalls, 2, 'refresh forces a live read');
});

test('GitHub down → serve the stale copy, flagged', async () => {
  api._clearCache();
  await call(); // warm
  ghDown = true;
  const r = await call({ refresh: '1' });
  ghDown = false;
  assert.equal(r.json.stale, true);
  assert.equal(r.json.reports.length, 2, 'stale data still shown');
});

test('GitHub unconfigured → fail-soft flag for the panel copy', async () => {
  configured = false;
  const r = await call();
  configured = true;
  assert.deepEqual(r.json, { configured: false });
});
