const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError, asyncHandler, errorMiddleware } = require('../server/http');

function mockRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const mockReq = { method: 'GET', originalUrl: '/x' };
const silence = () => { const o = console.error; console.error = () => {}; return () => { console.error = o; }; };

test('asyncHandler forwards a rejected promise to next()', async () => {
  let caught = null;
  const handler = asyncHandler(async () => { throw new Error('boom'); });
  await handler(mockReq, mockRes(), (e) => { caught = e; });
  assert.equal(caught?.message, 'boom');
});

test('asyncHandler does not call next on success', async () => {
  let called = false;
  const handler = asyncHandler(async (req, res) => { res.json({ ok: true }); });
  const res = mockRes();
  await handler(mockReq, res, () => { called = true; });
  assert.equal(called, false);
  assert.deepEqual(res.body, { ok: true });
});

test('errorMiddleware sanitizes a raw 500 (never leaks the error message)', () => {
  const restore = silence();
  const res = mockRes();
  errorMiddleware(new Error('SQLITE_ERROR: no such table: secrets'), mockReq, res, () => {});
  restore();
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Something went wrong on our end.');
  assert.ok(!/SQLITE|secrets/.test(res.body.error), 'internal detail must not leak');
});

test('errorMiddleware exposes an intentional HttpError (status + message)', () => {
  const res = mockRes();
  errorMiddleware(new HttpError(400, 'Email is required'), mockReq, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Email is required');
});

test('errorMiddleware exposes 4xx messages but keeps 5xx generic', () => {
  const r4 = mockRes();
  errorMiddleware({ status: 404, message: 'Not found' }, mockReq, r4, () => {});
  assert.equal(r4.body.error, 'Not found');

  const restore = silence();
  const r5 = mockRes();
  errorMiddleware({ status: 503, message: 'upstream pool exhausted at db.js:42' }, mockReq, r5, () => {});
  restore();
  assert.equal(r5.statusCode, 503);
  assert.equal(r5.body.error, 'Something went wrong on our end.');
});

test('errorMiddleware defers to next when headers already sent', () => {
  let deferred = false;
  const res = mockRes();
  res.headersSent = true;
  errorMiddleware(new Error('mid-stream'), mockReq, res, () => { deferred = true; });
  assert.equal(deferred, true);
  assert.equal(res.statusCode, null); // didn't try to write a second response
});

test('jsonWithEtag: stable payload → 304; changed payload → fresh 200', () => {
  const { jsonWithEtag } = require('../server/http');
  const mkRes = () => {
    const r = { headers: {}, code: 200, body: undefined, ended: false };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.status = (c) => { r.code = c; return r; };
    r.type = () => r;
    r.send = (b) => { r.body = b; return r; };
    r.end = () => { r.ended = true; return r; };
    return r;
  };

  const first = mkRes();
  jsonWithEtag({ headers: {} }, first, { posts: [1, 2, 3] });
  const etag = first.headers.ETag;
  assert.ok(etag && etag.startsWith('"'));
  assert.deepEqual(JSON.parse(first.body).posts, [1, 2, 3]);

  // Same payload + If-None-Match → empty 304.
  const unchanged = mkRes();
  jsonWithEtag({ headers: { 'if-none-match': etag } }, unchanged, { posts: [1, 2, 3] });
  assert.equal(unchanged.code, 304);
  assert.equal(unchanged.ended, true);
  assert.equal(unchanged.body, undefined);

  // Payload changed → normal 200 with a NEW tag.
  const changed = mkRes();
  jsonWithEtag({ headers: { 'if-none-match': etag } }, changed, { posts: [1, 2, 3, 4] });
  assert.equal(changed.code, 200);
  assert.notEqual(changed.headers.ETag, etag);
  assert.deepEqual(JSON.parse(changed.body).posts, [1, 2, 3, 4]);
});
