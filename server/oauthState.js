// ─── Signed OAuth state — tiny shared helper ───────────────────────────────────
// Both outbound OAuth flows (Google Drive connect, Meta connect) need a `state`
// parameter that survives the round-trip to the provider and can't be forged or
// replayed across users/clients. This signs a small JSON payload with an HMAC
// keyed by a persisted secret (created once, stored sealed in settings), with a
// TTL. Verify returns the payload or null — never throws.

const crypto = require('crypto');

let db = null;
function init(deps) { db = deps.db; }

function secret() {
  let s = db.getSetting('oauth_state_secret', '');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); db.setSetting('oauth_state_secret', s); }
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, ttlMs = 10 * 60_000) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, n: crypto.randomBytes(8).toString('hex') }));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

module.exports = { init, sign, verify };
