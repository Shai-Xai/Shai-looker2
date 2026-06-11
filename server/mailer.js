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

// The verified sending address (the bit inside <...>), kept stable; only the
// display name in front of it varies per client.
function fromAddress() { const m = from().match(/<([^>]+)>/); return m ? m[1] : from(); }
function fromWithName(name) { const a = fromAddress(); return name && name.trim() ? `${name.trim()} <${a}>` : from(); }

// The provider call. ALL Resend specifics live here.
async function deliver({ to, subject, html, text, from: fromOverride }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromOverride || from(), to: Array.isArray(to) ? to : [to], subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend responded ${res.status}`);
  return data; // { id }
}

// Best-effort send. Returns { ok } | { skipped, reason } | { ok:false, error }.
// `fromName` sets the display name in front of the verified address (per-client
// branding); the address itself never changes (single verified domain).
async function send({ to, subject, html, text, fromName }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  if (!enabled()) { log(recipients.join(', '), subject, 'skipped', 'mail disabled (mail_enabled=0)'); return { skipped: true, reason: 'mail disabled (mail_enabled=0)' }; }
  if (!apiKey()) { log(recipients.join(', '), subject, 'skipped', 'no Resend API key configured'); return { skipped: true, reason: 'no Resend API key configured' }; }
  try {
    const r = await deliver({ to: recipients, subject, html, text, from: fromName ? fromWithName(fromName) : undefined });
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

// ── Branding & templates ─────────────────────────────────────────────────────
// A template is a small set of presentation fields layered in three tiers:
//   hardcoded DEFAULTS  ←  platform template (settings)  ←  client branding (entity)
// Only non-empty fields override the tier below, so a client setting just a logo
// keeps Howler's wording/colour. The HTML SHELL is fixed (renders everywhere and
// can't be broken); these fields fill it in. "Powered by Howler Pulse" is always
// in the footer regardless of overrides.
const DEFAULTS = {
  senderName: 'Howler : Pulse',
  brandColor: '#FF385C',
  logo: '',                                  // image URL/data-URL; blank → text wordmark
  wordmark: 'Howler : Pulse',
  intro: '',                                 // optional line above the message
  footer: "You're receiving this because you have a Howler : Pulse login. Reply inside Pulse so it's tracked.",
};

// Merge only the keys a tier actually sets (ignore '' / null / undefined).
function overlay(base, over) {
  const out = { ...base };
  for (const k of Object.keys(DEFAULTS)) { const v = (over || {})[k]; if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = v; }
  return out;
}
function platformTemplate() { try { return JSON.parse((db && db.getSetting('mail_template')) || '{}') || {}; } catch { return {}; } }
function getPlatformTemplate() { return overlay(DEFAULTS, platformTemplate()); }
function setPlatformTemplate(patch) {
  const next = { ...platformTemplate() };
  for (const k of Object.keys(DEFAULTS)) if (patch && k in patch) next[k] = String(patch[k] ?? '');
  if (db) db.setSetting('mail_template', JSON.stringify(next));
  return getPlatformTemplate();
}
// Resolve the branding to use for a given client (or platform default if none).
function resolveBranding(entityId) {
  const platform = overlay(DEFAULTS, platformTemplate());
  const client = entityId && db ? db.getEntityMailBranding(entityId) : {};
  // Default a client's logo/sender to its own identity when not explicitly set.
  const ent = entityId && db ? db.getEntity(entityId) : null;
  const clientDefaults = ent ? { senderName: ent.name, wordmark: ent.name, logo: ent.logo || '' } : {};
  return overlay(overlay(platform, clientDefaults), client);
}

// ── Branded notification template ────────────────────────────────────────────
// Minimal, table-free HTML that renders everywhere. Keep emails as a nudge with
// a CTA back into Pulse — the conversation itself lives in the inbox.
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// `branding` may be a resolved object, or {entityId} to resolve, or omitted.
function notificationEmail({ title, body, ctaText = 'Open in Pulse', ctaPath = '/inbox', preheader = '', branding, entityId }) {
  const b = branding || resolveBranding(entityId);
  const url = `${baseUrl()}${ctaPath}`;
  const header = b.logo
    ? `<img src="${esc(b.logo)}" alt="${esc(b.wordmark)}" style="max-height:40px;max-width:200px;display:block;margin-bottom:14px;" />`
    : `<div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;margin-bottom:14px;">${esc(b.wordmark)}</div>`;
  const introHtml = b.intro ? `<div style="font-size:14px;line-height:1.6;color:#3a3a3c;margin-bottom:12px;">${esc(b.intro)}</div>` : '';
  const poweredBy = b.wordmark && b.wordmark.toLowerCase().includes('howler')
    ? '' // already Howler-branded; avoid saying it twice
    : '<div style="font-size:11px;color:#a1a1a6;margin-top:8px;">⚡ Powered by Howler : Pulse</div>';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(preheader || body).slice(0, 140)}</div>
  <div style="max-width:560px;margin:0 auto;padding:28px 16px;">
    ${header}
    <div style="background:#ffffff;border:1px solid #e8e8ec;border-radius:14px;padding:24px;">
      ${introHtml}
      <div style="font-size:17px;font-weight:700;color:#111;margin-bottom:10px;">${esc(title)}</div>
      <div style="font-size:14px;line-height:1.6;color:#3a3a3c;white-space:pre-wrap;">${esc(body)}</div>
      <a href="${url}" style="display:inline-block;margin-top:18px;background:${esc(b.brandColor)};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:980px;padding:11px 22px;">${esc(ctaText)} →</a>
    </div>
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;">
      ${esc(b.footer)}
      ${poweredBy}
    </div>
  </div>
</body></html>`;
  const text = `${b.intro ? b.intro + '\n\n' : ''}${title}\n\n${body}\n\n${ctaText}: ${url}`;
  return { html, text };
}

// Branding to render for a live preview: unsaved `edits` layered over the right
// base (a client's resolved branding, or the platform template for the platform
// editor). Used by the preview endpoint so editors see exactly what will send.
function previewBranding({ edits, entityId } = {}) {
  const base = entityId ? resolveBranding(entityId) : overlay(DEFAULTS, platformTemplate());
  return overlay(base, edits || {});
}

module.exports = {
  init, isConfigured, send, status, recent, notificationEmail, baseUrl,
  DEFAULTS, getPlatformTemplate, setPlatformTemplate, resolveBranding, previewBranding,
};
