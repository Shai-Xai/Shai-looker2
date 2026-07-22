// Request ids + crash intake (server/reqlog.js): id issuance, inbound id
// hygiene, the 5xx `ref` correlation contract, and client-error rate limiting.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers'); // sets DATA_DIR before anything touches the DB
const { startApp } = require('./http');
const reqlog = require('../server/reqlog');
const { asyncHandler, errorMiddleware } = require('../server/http');

let srv;
test('setup', async () => {
  srv = await startApp((app) => {
    app.use(reqlog.requestId);
    app.use(reqlog.accessLog);
    reqlog.mount(app, { ops: { alert: () => {} } });
    app.get('/api/ok', (_req, res) => res.json({ ok: true }));
    app.get('/api/boom', asyncHandler(async () => { throw new Error('internal detail'); }));
    app.use(errorMiddleware);
  });
});
after(() => srv?.close());

test('every response carries an X-Request-Id; inbound ids are honoured but sanitised', async () => {
  const r = await fetch(`${srv.base}/api/ok`);
  const id = r.headers.get('x-request-id');
  assert.ok(id && id.length >= 8);

  const r2 = await fetch(`${srv.base}/api/ok`, { headers: { 'X-Request-Id': 'trace-123' } });
  assert.equal(r2.headers.get('x-request-id'), 'trace-123');

  // Hostile inbound id: header-unsafe chars stripped, length capped.
  const r3 = await fetch(`${srv.base}/api/ok`, { headers: { 'X-Request-Id': 'a'.repeat(200) + 'é<x>' } });
  const cleaned = r3.headers.get('x-request-id');
  assert.equal(cleaned, 'a'.repeat(64));
});

test('a 5xx response includes ref matching the request id, message stays generic', async () => {
  const r = await fetch(`${srv.base}/api/boom`);
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.error, 'Something went wrong on our end.'); // no internal detail leaked
  assert.equal(body.ref, r.headers.get('x-request-id'));
});

test('client-error intake: 204 on report, 429 after the per-IP window is spent', async () => {
  const post = () => fetch(`${srv.base}/api/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x is not a function', stack: 'at render', url: '/dash' }),
  });
  for (let i = 0; i < 10; i++) assert.equal((await post()).status, 204);
  assert.equal((await post()).status, 429); // 11th within the minute window
});
