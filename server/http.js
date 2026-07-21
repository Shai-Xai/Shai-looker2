// Shared HTTP helpers so route handlers stop hand-rolling try/catch and a
// forgotten catch can't leak an unhandled rejection.
//
// Express 4 routes a SYNC throw to error middleware automatically, but an ASYNC
// (promise) rejection is NOT caught — it becomes an unhandled rejection and the
// request hangs. Wrap async handlers with asyncHandler() so their rejections are
// forwarded to errorMiddleware, which is mounted once after all routes.
//
// Error policy (and info-disclosure fix): a raw 5xx error's message is logged
// server-side but NEVER sent to the client (it can expose internals); the client
// gets a generic message. For an INTENTIONAL, client-safe error throw
// `new HttpError(status, message)` — its status + message reach the client.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true; // message is safe to show the client
  }
}

// Wrap an async route handler so a rejected promise goes to errorMiddleware
// instead of hanging the request. Sync handlers don't need it (Express 4 catches
// those), but wrapping them is harmless.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The single error-handling middleware. Mount LAST: `app.use(errorMiddleware)`.
function errorMiddleware(err, req, res, _next) {
  if (res.headersSent) return _next(err); // mid-stream: let Express abort the response
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  // Only expose the message for explicit HttpErrors / 4xx; 5xx stays generic.
  const safe = (err && err.expose === true) || (status >= 400 && status < 500);
  const error = safe && err && err.message ? err.message : 'Something went wrong on our end.';
  if (status >= 500) {
    console.error(`[error]${req.id ? ` [${req.id}]` : ''} ${req.method} ${req.originalUrl} →`, (err && err.stack) || err);
    // A client just SAW a failure — page a human (throttled per kind in ops.js)
    // instead of relying on someone reading the Render log stream.
    try { require('./ops').alert('http5xx', `${req.method} ${req.originalUrl}: ${(err && err.message) || err}${req.id ? ` (ref ${req.id})` : ''}`); } catch { /* alerting must never break the response */ }
  }
  // `ref` = the request id (reqlog.js): a user's screenshot of the error dialog
  // is enough to find the exact server log line + stack.
  res.status(status).json(req.id && status >= 500 ? { error, ref: req.id } : { error });
}

// For handlers with their own try/catch (e.g. mixed cleanup + response logic)
// that would otherwise hand-roll `res.status(500).json({ error: e.message })`
// and leak internals: same policy as errorMiddleware — full detail logged +
// ops-paged, GENERIC message to the client. Prefer asyncHandler + throw where
// the handler shape allows it.
function serverError(res, err, context = '') {
  console.error(`[error]${context ? ` ${context}` : ''} →`, (err && err.stack) || err);
  try { require('./ops').alert('http5xx', `${context || 'handler'}: ${(err && err.message) || err}`); } catch { /* never break the response */ }
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our end.' });
}

// Per-response CSP opt-out for the handful of SERVER-RENDERED pages that carry
// their own inline <script> (digest feedback page, sales/docs pages). The
// app-wide header (index.js) pins script-src 'self'; these static, no-user-data
// pages relax it for themselves only — the SPA and API keep the strict policy.
function allowInlineScripts(res) {
  res.set('Content-Security-Policy', "script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
}

// App-wide security headers (dependency-free, helmet essentials), mounted once
// near the top of index.js: frame-ancestors 'self' — cross-origin framing
// (clickjacking) stays blocked, SELF-framing allowed for the admin /split
// view's two same-origin panes. Plus nosniff, Referrer-Policy, HSTS in prod.
// CSP: script-src is the XSS backstop — a stored-XSS slip (message body,
// ticket, inbound email HTML) can no longer execute injected inline <script>
// or pull one from an attacker host; React escaping stops being the ONLY line
// of defence. apis.google.com + gstatic are the Google Drive picker
// (DriveSourcesCard). No default-src on purpose: images/styles/fonts/connect
// stay open (data-URL logos, inline styles, the ECharts canvas). The few
// server-rendered pages with their own inline <script> (digest feedback, docs)
// override this header per-response via allowInlineScripts above.
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', "script-src 'self' https://apis.google.com https://www.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

module.exports = { HttpError, asyncHandler, errorMiddleware, serverError, allowInlineScripts, securityHeaders };
