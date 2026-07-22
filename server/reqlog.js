// ─── Request IDs + structured logs + browser-crash intake — disposable module ──
// Before this existed the Render log stream was bare console.log prose: no way
// to correlate "what happened for THIS failing request", and a crash in a
// user's browser was invisible to the team. This module owns diagnosability:
//
//   • requestId middleware — every request gets a short id (honours an inbound
//     X-Request-Id from a proxy), echoed back as an X-Request-Id response
//     header and stamped into error responses as `ref` so a user's screenshot
//     of "Something went wrong (ref: …)" jumps straight to the server log line.
//   • accessLog middleware — one JSON line per /api request (and any non-2xx),
//     with method, path (query stripped — tokens/PII ride in query strings),
//     status, duration and who it was. JSON lines stay grep-able AND parseable.
//   • log.info/warn/error — structured logging for modules to adopt gradually.
//   • POST /api/client-error — the React error boundaries report genuine render
//     crashes here (rate-limited, hard-capped sizes, nothing reflected back),
//     so browser failures reach the server log + a throttled ops Slack alert
//     instead of dying silently on the user's machine.
//
// Self-owned: remove this file + its mounts in index.js/http.js to uninstall.

const crypto = require('crypto');

function jline(lvl, fields) {
  // One JSON object per line. Logging must never throw or block a request.
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, ...fields });
    (lvl === 'error' ? console.error : console.log)(line);
  } catch { /* never break the caller */ }
}

const log = {
  info: (msg, fields = {}) => jline('info', { msg, ...fields }),
  warn: (msg, fields = {}) => jline('warn', { msg, ...fields }),
  error: (msg, fields = {}) => jline('error', { msg, ...fields }),
};

// Short, log-friendly id (8 chars base64url ≈ 48 bits — collision-safe at our
// volumes). An inbound X-Request-Id (from a proxy/CDN) wins so ids correlate
// across hops; sanitised + capped because it's attacker-controllable input.
function requestId(req, res, next) {
  const inbound = String(req.get('x-request-id') || '').replace(/[^\w.-]/g, '').slice(0, 64);
  req.id = inbound || crypto.randomBytes(6).toString('base64url');
  res.set('X-Request-Id', req.id);
  next();
}

// Query strings carry signed tokens (/u/:token, ?e=…) and search text — log the
// path only. Static asset chatter is skipped unless something went wrong.
function accessLog(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const p = req.originalUrl.split('?')[0];
    if (!p.startsWith('/api/') && res.statusCode < 400) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    jline(res.statusCode >= 500 ? 'error' : 'info', {
      msg: 'req',
      reqId: req.id,
      method: req.method,
      path: p.slice(0, 200),
      status: res.statusCode,
      ms: Math.round(ms),
      ...(req.user ? { userId: req.user.id } : {}),
    });
  });
  next();
}

function mount(app, { ops } = {}) {
  const rateLimit = require('./ratelimit');
  // Browser crash reports. Unauthenticated ON PURPOSE (crashes happen on the
  // login page too) — hence: tight rate limit, hard caps, log-only (nothing is
  // stored or reflected), and the ops alert is throttled per kind in ops.js.
  app.post('/api/client-error', rateLimit({ windowMs: 60_000, max: 10, by: 'ip', scope: 'client-error' }), (req, res) => {
    const b = req.body || {};
    const report = {
      msg: 'client-crash',
      reqId: req.id,
      message: String(b.message || '').slice(0, 500),
      stack: String(b.stack || '').slice(0, 4000),
      componentStack: String(b.componentStack || '').slice(0, 2000),
      url: String(b.url || '').slice(0, 300),
      ua: String(req.get('user-agent') || '').slice(0, 200),
      ...(req.user ? { userId: req.user.id } : {}),
    };
    jline('error', report);
    try { (ops || require('./ops')).alert('client-crash', `${report.message || 'browser crash'} @ ${report.url} (ref ${req.id})`); } catch { /* alerting is best-effort */ }
    res.status(204).end();
  });
  return module.exports;
}

module.exports = { requestId, accessLog, log, mount };
