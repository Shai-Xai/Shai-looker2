// ─── Mailer: outbound email via Resend ────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE — the only file that knows we use Resend.
// Swapping providers (Postmark, SES, …) means rewriting `deliver()` below and
// nothing else. Wired from index.js with `mailer.init({ db })` and passed into
// modules that send (currently os.js). To remove: delete this file + the two
// wiring lines in index.js; senders all guard with `mailer?.isConfigured()`.
//
// Config (DB setting first, .env fallback — same precedence as Looker/Anthropic):
//   resend_api_key / RESEND_API_KEY   — the Resend API key (write-only in Admin → Integrations)
//   mail_from      / MAIL_FROM        — From address; until a domain is verified in
//                                       Resend, `onboarding@resend.dev` works for
//                                       sends to the account owner's own address.
//   app_base_url   / APP_URL          — absolute base for links in emails
//   mail_enabled                      — kill switch ('0' disables all sending)
//
// `send()` never throws: notification email is best-effort and must never break
// the API call that triggered it. Failures are logged and reported in status().

let db = null;
let lastError = '';
let lastSentAt = '';

function init(deps) {
  db = deps.db;
  // Tiny send log so admins can see what the mailer did (sent / failed /
  // skipped) from Admin → Integrations — survives restarts, unlike module
  // state. Owned by this module; drop mail_log to uninstall.
  db.db.exec(`CREATE TABLE IF NOT EXISTS mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
  )`);
}

function log(recipient, subject, status, detail = '') {
  try {
    db.db.prepare('INSERT INTO mail_log (at, recipient, subject, status, detail) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), recipient, subject, status, detail);
    db.db.prepare('DELETE FROM mail_log WHERE id NOT IN (SELECT id FROM mail_log ORDER BY id DESC LIMIT 50)').run();
  } catch { /* logging must never break sending */ }
}

function recent(limit = 15) {
  try { return db.db.prepare('SELECT at, recipient, subject, status, detail FROM mail_log ORDER BY id DESC LIMIT ?').all(limit); }
  catch { return []; }
}

const setting = (key, env) => ((db && db.getSetting(key)) || process.env[env] || '').trim();
const apiKey = () => setting('resend_api_key', 'RESEND_API_KEY');
const from = () => setting('mail_from', 'MAIL_FROM') || 'Howler Pulse <onboarding@resend.dev>';
const baseUrl = () => (setting('app_base_url', 'APP_URL') || 'https://howler-pulse-v2.onrender.com').replace(/\/$/, '');
const enabled = () => !db || db.getSetting('mail_enabled', '1') !== '0';

function isConfigured() { return !!apiKey() && enabled(); }

function status() {
  return {
    configured: isConfigured(),
    keySet: !!(db && db.getSetting('resend_api_key')),
    keyHint: db && db.getSetting('resend_api_key') ? `••••••${db.getSetting('resend_api_key').slice(-4)}` : '',
    envFallback: !(db && db.getSetting('resend_api_key')) && !!process.env.RESEND_API_KEY,
    from: from(),
    enabled: enabled(),
    lastError,
    lastSentAt,
  };
}

// The provider call. ALL Resend specifics live here.
async function deliver({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from(), to: Array.isArray(to) ? to : [to], subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend responded ${res.status}`);
  return data; // { id }
}

// Best-effort send. Returns { ok } | { skipped, reason } | { ok:false, error }.
async function send({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  if (!enabled()) { log(recipients.join(', '), subject, 'skipped', 'mail disabled (mail_enabled=0)'); return { skipped: true, reason: 'mail disabled (mail_enabled=0)' }; }
  if (!apiKey()) { log(recipients.join(', '), subject, 'skipped', 'no Resend API key configured'); return { skipped: true, reason: 'no Resend API key configured' }; }
  try {
    const r = await deliver({ to: recipients, subject, html, text });
    lastSentAt = new Date().toISOString();
    lastError = '';
    log(recipients.join(', '), subject, 'sent', r.id || '');
    console.log(`[mailer] sent "${subject}" → ${recipients.join(', ')} (${r.id || 'ok'})`);
    return { ok: true, id: r.id };
  } catch (err) {
    lastError = err.message;
    log(recipients.join(', '), subject, 'failed', err.message);
    console.error(`[mailer] FAILED "${subject}" → ${recipients.join(', ')}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Branded notification template ────────────────────────────────────────────
// Minimal, table-free HTML that renders everywhere. Keep emails as a nudge with
// a CTA back into Pulse — the conversation itself lives in the inbox.
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function notificationEmail({ title, body, ctaText = 'Open in Pulse', ctaPath = '/inbox', preheader = '' }) {
  const url = `${baseUrl()}${ctaPath}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(preheader || body).slice(0, 140)}</div>
  <div style="max-width:560px;margin:0 auto;padding:28px 16px;">
    <div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;margin-bottom:14px;">🦉 Howler&nbsp;:&nbsp;Pulse</div>
    <div style="background:#ffffff;border:1px solid #e8e8ec;border-radius:14px;padding:24px;">
      <div style="font-size:17px;font-weight:700;color:#111;margin-bottom:10px;">${esc(title)}</div>
      <div style="font-size:14px;line-height:1.6;color:#3a3a3c;white-space:pre-wrap;">${esc(body)}</div>
      <a href="${url}" style="display:inline-block;margin-top:18px;background:#FF385C;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:980px;padding:11px 22px;">${esc(ctaText)} →</a>
    </div>
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;">
      You're receiving this because you have a Howler&nbsp;:&nbsp;Pulse login. Replies to this email aren't monitored yet — reply inside Pulse so it's tracked.
    </div>
  </div>
</body></html>`;
  const text = `${title}\n\n${body}\n\n${ctaText}: ${url}`;
  return { html, text };
}

module.exports = { init, isConfigured, send, status, recent, notificationEmail, baseUrl };
