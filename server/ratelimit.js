// ─── Rate limiting (zero-dependency, in-memory) ───────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. No npm dependency — a small fixed-window
// counter kept in a Map, swept periodically. Suits the single-instance Render
// deployment (one process, one memory space). If Pulse ever scales to multiple
// instances, swap the Map for a shared store (Redis) behind the same interface.
//
// Usage:
//   const rateLimit = require('./ratelimit');
//   app.post('/api/auth/login', rateLimit({ windowMs: 15*60_000, max: 10, by: 'ip' }), handler);
//   app.post('/api/insight',    rateLimit({ windowMs: 60_000, max: 20, by: 'user' }), handler);
//
// `by`:
//   'ip'   — keyed on the client IP (honours `trust proxy`, set in index.js).
//   'user' — keyed on the authenticated user id (falls back to IP if anonymous),
//            so one logged-in user can't drive runaway cost regardless of IP.
//   function(req) — custom key (e.g. per-entity); return a string.
//
// On limit: 429 with a `Retry-After` header and a JSON error. Fails OPEN on any
// internal error (never blocks a legitimate request because the limiter broke).

const WINDOWS = new Map(); // key -> { count, resetAt }

// Periodic sweep so the Map doesn't grow unbounded. Unref'd so it never holds
// the process open on shutdown.
const sweep = setInterval(() => {
  const t = Date.now();
  for (const [k, v] of WINDOWS) if (v.resetAt <= t) WINDOWS.delete(k);
}, 5 * 60_000);
if (sweep.unref) sweep.unref();

function clientIp(req) {
  // Express populates req.ip from X-Forwarded-For when `trust proxy` is set.
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function keyFor(by, req) {
  if (typeof by === 'function') { try { return String(by(req) || clientIp(req)); } catch { return clientIp(req); } }
  if (by === 'user') return `u:${req.user?.id || clientIp(req)}`;
  return `ip:${clientIp(req)}`;
}

/**
 * @param {object} opts
 * @param {number} opts.windowMs  Window length in ms.
 * @param {number} opts.max       Max requests allowed per window per key.
 * @param {'ip'|'user'|function} [opts.by='ip']  How to key requests.
 * @param {string} [opts.scope]   Optional label so different routes don't share a bucket.
 * @param {string} [opts.message] Custom 429 message.
 */
function rateLimit({ windowMs, max, by = 'ip', scope = '', message } = {}) {
  return (req, res, next) => {
    try {
      const key = `${scope}|${keyFor(by, req)}`;
      const t = Date.now();
      let rec = WINDOWS.get(key);
      if (!rec || rec.resetAt <= t) { rec = { count: 0, resetAt: t + windowMs }; WINDOWS.set(key, rec); }
      rec.count += 1;
      const remaining = Math.max(0, max - rec.count);
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));
      if (rec.count > max) {
        const retrySec = Math.ceil((rec.resetAt - t) / 1000);
        res.set('Retry-After', String(retrySec));
        return res.status(429).json({ error: message || 'Too many requests — please slow down and try again shortly.', retryAfter: retrySec });
      }
      return next();
    } catch {
      // Fail open: a broken limiter must never block real traffic.
      return next();
    }
  };
}

module.exports = rateLimit;
