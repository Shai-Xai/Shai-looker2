// HTTP test harness — mount a server module into a real Express app with the
// SAME cookie-auth middleware the production server uses, listen on an ephemeral
// port, and drive it over real HTTP. This lets the route-level tests exercise the
// actual permission gates, tenant guards and request lifecycle (not just exported
// helpers), which is exactly what protects a future refactor of these routes.

const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const h = require('./helpers');

// A signed session cookie for `user`, produced by the REAL issueCookie path
// (so the token is signed/verified exactly as in production). issueCookie wants
// a `res` to set the cookie on — we hand it a stub that just captures it.
function cookieFor(user) {
  let name, value;
  h.auth.issueCookie({ cookie: (n, v) => { name = n; value = v; } }, user);
  return `${name}=${value}`;
}

// Build an app, attach cookie + user middleware, run mountFn to add routes, and
// start listening. Returns a request helper bound to the running server.
async function startApp(mountFn) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(h.auth.attachUser);
  mountFn(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, path, { as, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (as) headers.Cookie = cookieFor(as);
    const r = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* no/non-JSON body (e.g. 204) */ }
    return { status: r.status, body: json };
  }

  return { app, server, base, req, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startApp, cookieFor };
