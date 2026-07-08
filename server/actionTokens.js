// ─── Campaign contact tokens & suppression — extracted from actions.js ────────
// The signed per-recipient unsubscribe token (rides every /u, /o, /c link), the
// SMS short-link registry (/k/<code>), and the entity suppression set. Factory
// so the shared secret + tables stay owned by the action engine:
//   require('./actionTokens')({ db, sql, mailer })
// Owns no tables — writes to actions.js's action_short_links and reads its
// action_suppressions.

const crypto = require('crypto');
const { normaliseMsisdn } = require('./messaging'); // pure helper — needs no init()

module.exports = function actionTokens({ db, sql, mailer }) {
  const now = () => new Date().toISOString();
  const unsubSecret = () => {
    let s = db.getSetting('unsub_secret', '');
    if (!s) { s = crypto.randomBytes(18).toString('base64url'); db.setSetting('unsub_secret', s); }
    return s;
  };
  const unsubToken = (entityId, email) => {
    const payload = Buffer.from(JSON.stringify({ e: email, n: entityId })).toString('base64url');
    const sig = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 16);
    return `${payload}.${sig}`;
  };
  const parseUnsubToken = (token) => {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 16);
    if (sig !== want) return null;
    try { const j = JSON.parse(Buffer.from(payload, 'base64url').toString()); return j.e && j.n ? j : null; } catch { return null; }
  };

  // Store a URL → a tiny deterministic HMAC code (identical URLs collapse to one
  // row). Powers the SMS /k/<code> short links and per-link /c/?k=<code> tracking
  // of custom HTML. Returns '' if the store is unavailable (callers keep raw URL).
  const registerTarget = (url) => {
    if (!url) return '';
    try {
      const code = crypto.createHmac('sha256', unsubSecret()).update(url).digest('base64url').slice(0, 8);
      sql.prepare('INSERT OR IGNORE INTO action_short_links (code, target, at) VALUES (?,?,?)').run(code, url, now());
      return code;
    } catch { return ''; }
  };
  // Shorten a long absolute URL to a /k/<code> redirect so SMS stays in one segment.
  const shortLink = (targetUrl) => {
    if (!targetUrl) return targetUrl;
    const code = registerTarget(targetUrl);
    return code ? `${mailer.baseUrl()}/k/${code}` : targetUrl;
  };

  // Suppression set for an entity. Rows are keyed by whatever contact the unsub
  // token carried — an email OR a phone (phone-only SMS recipients have no email).
  // Phone-like values are ALSO added in normalised msisdn form so a suppression
  // recorded as '082…' still matches an audience row carrying '+27 82…'.
  const suppressed = (entityId) => {
    const set = new Set();
    for (const { email: v } of sql.prepare('SELECT email FROM action_suppressions WHERE entity_id=?').all(entityId)) {
      if (!v) continue;
      set.add(v);
      if (!v.includes('@')) { const m = normaliseMsisdn(v); if (m) set.add(m); }
    }
    return set;
  };
  // Canonical form of an unsubscribed contact before it is stored: emails
  // lowercase, phones normalised to msisdn digits (raw kept if unparseable).
  const canonicalContact = (v) => { const s = String(v || '').trim().toLowerCase(); return s.includes('@') ? s : (normaliseMsisdn(s) || s); };

  return { unsubToken, parseUnsubToken, registerTarget, shortLink, suppressed, canonicalContact };
};
