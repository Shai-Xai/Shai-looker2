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
  // System-wide send log: every email the mailer attempts (sent / failed /
  // skipped) with its kind + client, so admins get one place to audit all
  // outbound mail. Survives restarts. Owned by this module; drop mail_log to
  // uninstall.
  db.db.exec(`CREATE TABLE IF NOT EXISTS mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
  )`);
  // ALTER for DBs created before kind/entity_id existed.
  try {
    const cols = db.db.prepare('PRAGMA table_info(mail_log)').all().map((c) => c.name);
    if (!cols.includes('kind')) db.db.exec("ALTER TABLE mail_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
    if (!cols.includes('entity_id')) db.db.exec("ALTER TABLE mail_log ADD COLUMN entity_id TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('[mailer] mail_log migration skipped:', e.message); }
}

function log(recipient, subject, status, detail = '', kind = 'other', entityId = '') {
  try {
    db.db.prepare('INSERT INTO mail_log (at, recipient, subject, status, detail, kind, entity_id) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), recipient, subject, status, detail, kind, entityId);
    // Keep a generous rolling window now that it's the system audit log.
    db.db.prepare('DELETE FROM mail_log WHERE id NOT IN (SELECT id FROM mail_log ORDER BY id DESC LIMIT 5000)').run();
  } catch { /* logging must never break sending */ }
}

// Recent sends, newest first, with optional kind/status/entity filters.
function recent({ limit = 15, kind = '', status = '', entityId = '' } = {}) {
  try {
    const where = [];
    const args = [];
    if (kind) { where.push('kind=?'); args.push(kind); }
    if (status) { where.push("status LIKE ?"); args.push(`${status}%`); }
    if (entityId) { where.push('entity_id=?'); args.push(entityId); }
    const sql = `SELECT at, recipient, subject, status, detail, kind, entity_id FROM mail_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(Math.min(limit, 1000));
    return db.db.prepare(sql).all(...args);
  } catch { return []; }
}

// Emails addressed to ONE recipient, newest first. `recipient` may be a
// comma-joined list (one send to several people), so we LIKE-match in SQL then
// confirm an exact token match in JS — avoids `joe@x.com` matching `joe@x.com.au`.
function recipientLog(email, limit = 50) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  try {
    const rows = db.db.prepare(
      'SELECT at, recipient, subject, status, kind, entity_id AS entityId FROM mail_log WHERE LOWER(recipient) LIKE ? ORDER BY id DESC LIMIT ?'
    ).all(`%${e}%`, Math.min(limit, 500));
    return rows
      .filter((r) => String(r.recipient || '').toLowerCase().split(/[,;]\s*/).includes(e))
      .map((r) => ({ at: r.at, subject: r.subject, status: r.status, kind: r.kind || 'other', entityId: r.entityId || '' }));
  } catch { return []; }
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
async function deliver({ to, subject, html, text, from: fromOverride, replyTo }) {
  const body = { from: fromOverride || from(), to: Array.isArray(to) ? to : [to], subject, html, text };
  if (replyTo) body.reply_to = replyTo; // e.g. the client's CC-the-Owl inbound address
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Resend responded ${res.status}`);
  return data; // { id }
}

// Best-effort send. Returns { ok } | { skipped, reason } | { ok:false, error }.
// `fromName` sets the display name in front of the verified address (per-client
// branding); the address itself never changes (single verified domain).
async function send({ to, subject, html, text, fromName, kind = 'other', entity = '', replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true, reason: 'no recipients' };
  if (!enabled()) { log(recipients.join(', '), subject, 'skipped', 'mail disabled (mail_enabled=0)', kind, entity); return { skipped: true, reason: 'mail disabled (mail_enabled=0)' }; }
  if (!apiKey()) { log(recipients.join(', '), subject, 'skipped', 'no Resend API key configured', kind, entity); return { skipped: true, reason: 'no Resend API key configured' }; }
  try {
    const r = await deliver({ to: recipients, subject, html, text, from: fromName ? fromWithName(fromName) : undefined, replyTo });
    lastSentAt = new Date().toISOString();
    lastError = '';
    log(recipients.join(', '), subject, 'sent', r.id || '', kind, entity);
    console.log(`[mailer] sent "${subject}" → ${recipients.join(', ')} (${r.id || 'ok'})`);
    return { ok: true, id: r.id };
  } catch (err) {
    lastError = err.message;
    log(recipients.join(', '), subject, 'failed', err.message, kind, entity);
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
  secondaryColor: '#FF6B35',                 // gradient partner + 2nd chart series
  chart3: '#FFB020',                         // chart series 3-5 (charts often use 4-5 colours)
  chart4: '#06B6D4',
  chart5: '#7C3AED',
  logo: '',                                  // image URL/data-URL; blank → text wordmark
  wordmark: 'Howler : Pulse',
  header: '',                                // optional tagline under the logo/wordmark
  intro: '',                                 // optional line above the message
  footer: "You're receiving this because you have a Howler : Pulse login. Reply inside Pulse so it's tracked.",
  metricScale: '',                           // presentation-only: KPI number size multiplier (blank = 1.0). Rides to the browser via /api/theme.
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
// Resolve the branding to use for a client (or platform default if none), with
// an optional EVENT (suite) override layered on top. Tiers, each blank field
// inheriting the one below: defaults ← platform ← client identity ← client
// branding ← event branding.
function resolveBranding(entityId, suiteId) {
  const platform = overlay(DEFAULTS, platformTemplate());
  const client = entityId && db ? db.getEntityMailBranding(entityId) : {};
  // Default a client's logo/sender to its own identity when not explicitly set.
  const ent = entityId && db ? db.getEntity(entityId) : null;
  const clientDefaults = ent ? { senderName: ent.name, wordmark: ent.name, logo: ent.logo || '' } : {};
  const suite = suiteId && db && db.getSuiteMailBranding ? db.getSuiteMailBranding(suiteId) : {};
  return overlay(overlay(overlay(platform, clientDefaults), client), suite);
}

// ── Branded notification template ────────────────────────────────────────────
// Minimal, table-free HTML that renders everywhere. Keep emails as a nudge with
// a CTA back into Pulse — the conversation itself lives in the inbox.
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Default footer brand row on EVERY email: the Howler mark + the Pulse owl +
// wordmark. Small pre-resized PNGs served from the app's static root.
function brandRow() {
  const base = baseUrl();
  return `<div style="margin-top:10px;">
      <img src="${base}/email-howler.png" width="20" height="20" alt="Howler" style="border-radius:5px;vertical-align:middle;" />
      <img src="${base}/email-pulse.png" width="20" height="20" alt="Pulse" style="border-radius:50%;vertical-align:middle;margin-left:4px;" />
      <span style="font-size:11px;color:#a1a1a6;vertical-align:middle;margin-left:7px;font-weight:600;">Howler&nbsp;:&nbsp;Pulse</span>
    </div>`;
}

// `branding` may be a resolved object, or {entityId} to resolve, or omitted.
// Uploaded logos are stored as data-URLs, which Gmail/Outlook STRIP from emails
// — so for real sends pass `assetScope` (an entityId or 'platform') and the img
// src becomes a Pulse-hosted URL instead. Previews omit it (browsers render
// data-URLs fine, and it lets unsaved uploads show live).
function notificationEmail({ title, body, ctaText = 'Open in Pulse', ctaPath = '/inbox', preheader = '', branding, entityId, assetScope }) {
  const b = branding || resolveBranding(entityId);
  const url = `${baseUrl()}${ctaPath}`;
  const scope = assetScope || entityId;
  const logoSrc = b.logo && b.logo.startsWith('data:') && scope ? `${baseUrl()}/mail-assets/logo/${scope}` : b.logo;
  const brandMark = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(b.wordmark)}" style="max-height:40px;max-width:200px;display:block;" />`
    : `<div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;">${esc(b.wordmark)}</div>`;
  const headerLine = b.header ? `<div style="font-size:12.5px;color:#6e6e73;margin-top:5px;white-space:pre-wrap;">${esc(b.header)}</div>` : '';
  const header = `<div style="margin-bottom:14px;">${brandMark}${headerLine}</div>`;
  const introHtml = b.intro ? `<div style="font-size:14px;line-height:1.6;color:#3a3a3c;margin-bottom:12px;white-space:pre-wrap;">${esc(b.intro)}</div>` : '';
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
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;white-space:pre-wrap;">${esc(b.footer)}</div>
    ${brandRow()}
  </div>
</body></html>`;
  const text = `${b.header ? b.header + '\n\n' : ''}${b.intro ? b.intro + '\n\n' : ''}${title}\n\n${body}\n\n${ctaText}: ${url}\n\n${b.footer}`;
  return { html, text };
}

// Light **bold** → <strong> for narrative/headline text (everything escaped first).
function mdBold(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }

// Render a scheduled digest into the branded shell: headline, KPI stat cards,
// analytical narrative, and role-appropriate suggested actions (each may deep
// link into Pulse). `content` is the structured output of insights.digestBrief
// with links already resolved ({label/value/delta/href} kpis, {text/href} actions).
function digestEmail({ branding, entityId, assetScope, content, roleLabel, customMessage, ctaPath = '/', feedbackUrl = '' }) {
  const b = branding || resolveBranding(entityId);
  const scope = assetScope || entityId;
  const logoSrc = b.logo && b.logo.startsWith('data:') && scope ? `${baseUrl()}/mail-assets/logo/${scope}` : b.logo;
  const brandMark = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(b.wordmark)}" style="max-height:40px;max-width:200px;display:block;" />`
    : `<div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;">${esc(b.wordmark)}</div>`;
  const headerLine = b.header ? `<div style="font-size:12.5px;color:#6e6e73;margin-top:5px;white-space:pre-wrap;">${esc(b.header)}</div>` : '';

  // Build the inner pieces (KPI cards, chart images, narrative, suggested
  // actions) for one "part" — the whole digest in single-event mode, or each
  // section (overall + per event) in a multi-event digest.
  const partsHtml = (part) => {
    const kpis = part.kpis || [];
    let kpiHtml = '';
    for (let i = 0; i < kpis.length; i += 3) {
      const row = kpis.slice(i, i + 3).map((k) => `
        <td style="padding:6px;" width="33%" valign="top">
          <div style="background:#fafafa;border:1px solid #ececf0;border-radius:12px;padding:13px 14px;">
            <div style="font-size:11px;color:#86868b;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">${esc(k.label)}</div>
            <div style="font-size:21px;font-weight:800;color:#111;margin-top:4px;letter-spacing:-0.02em;">${esc(k.value)}</div>
            ${k.delta ? `<div style="font-size:11.5px;font-weight:700;margin-top:2px;color:${/^-|↓|▼|down|behind/i.test(k.delta) ? '#d11' : '#1a8a4a'};">${esc(k.delta)}</div>` : ''}
          </div>
        </td>`).join('');
      kpiHtml += `<tr>${row}</tr>`;
    }
    const kpiTable = kpis.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border-collapse:collapse;">${kpiHtml}</table>` : '';
    // Chart images (e.g. followed tiles rendered server-side to PNG). Full-width,
    // titled, linking to the dashboard. Each image already includes its own title.
    const charts = (part.charts || []).filter((c) => c.imageUrl);
    const chartsBlock = charts.length ? charts.map((c) => {
      const img = `<img src="${esc(c.imageUrl)}" alt="${esc(c.title || '')}" width="100%" style="width:100%;max-width:520px;border:1px solid #ececf0;border-radius:12px;display:block;margin:0 auto;" />`;
      return `<div style="margin:14px 0;">${c.href ? `<a href="${esc(c.href)}" style="text-decoration:none;">${img}</a>` : img}</div>`;
    }).join('') : '';
    const narrative = (part.narrative || []).map((p) => `<p style="font-size:14px;line-height:1.6;color:#3a3a3c;margin:0 0 12px;">${mdBold(p)}</p>`).join('');
    const actionsLis = (part.actions || []).filter((a) => a.text).map((a) => {
      const txt = `<span style="color:#111;font-weight:600;">${esc(a.text)}</span>`;
      // "Make it happen" only when the action maps to an executable capability.
      const makeIt = a.action ? `<a href="${baseUrl()}/actions?goal=${encodeURIComponent(a.text)}&type=${encodeURIComponent(a.action)}" style="color:#7c3aed;text-decoration:none;font-size:12px;font-weight:700;margin-left:8px;">⚡ Make it happen</a>` : '';
      return `<li style="margin:0 0 8px;line-height:1.5;">${a.href ? `<a href="${esc(a.href)}" style="color:${esc(b.brandColor)};text-decoration:none;">${esc(a.text)} →</a>` : txt}${makeIt}</li>`;
    }).join('');
    const actionsBlock = actionsLis ? `
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid #ececf0;">
        <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:8px;">Suggested actions</div>
        <ul style="margin:0;padding-left:18px;font-size:13.5px;color:#3a3a3c;">${actionsLis}</ul>
      </div>` : '';
    return { kpiTable, chartsBlock, narrative, actionsBlock };
  };

  const { kpiTable, chartsBlock, narrative, actionsBlock } = partsHtml(content);
  // Multi-event digests carry per-event sections — render each one clearly
  // separated and labelled with the event name, under the portfolio overview.
  const events = content.events || [];
  const eventsBlock = events.map((ev) => {
    const p = partsHtml(ev);
    return `
      <div style="margin-top:24px;padding-top:18px;border-top:2px solid #ececf0;">
        <div style="font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:${esc(b.brandColor)};margin-bottom:8px;">${esc(ev.suiteName || 'Event')}</div>
        ${ev.headline ? `<div style="font-size:16px;font-weight:800;color:#111;margin-bottom:10px;line-height:1.35;letter-spacing:-0.01em;">${mdBold(ev.headline)}</div>` : ''}
        ${p.kpiTable}${p.chartsBlock}
        <div style="margin-top:10px;">${p.narrative}</div>
        ${p.actionsBlock}
      </div>`;
  }).join('');

  // Optional personal note (from the AM / client), rendered as a callout above
  // the AI content. Verbatim, with **bold** + line breaks honoured.
  const note = (customMessage || '').trim()
    ? `<div style="background:${esc(b.brandColor)}12;border-left:3px solid ${esc(b.brandColor)};border-radius:8px;padding:13px 15px;margin-bottom:16px;font-size:14px;line-height:1.55;color:#2a2a2c;white-space:pre-wrap;">${mdBold(customMessage)}</div>`
    : '';

  // Open Pulse on the RIGHT client: carry the entity so the app switches to that
  // profile after login (a multi-profile login otherwise lands on its default).
  const url = (ctaPath === '/' && entityId)
    ? `${baseUrl()}/?entity=${encodeURIComponent(entityId)}`
    : `${baseUrl()}${ctaPath}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc((customMessage || content.headline || '')).slice(0, 140)}</div>
  <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
    <div style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;">
      <div>${brandMark}${headerLine}</div>
      <div style="font-size:11px;color:#a1a1a6;text-align:right;">${esc(roleLabel || '')} digest<br>${new Date().toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
    </div>
    <div style="background:#ffffff;border:1px solid #e8e8ec;border-radius:14px;padding:24px;">
      ${note}
      ${events.length ? `<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#86868b;margin-bottom:6px;">Portfolio · ${events.length} event${events.length === 1 ? '' : 's'}</div>` : ''}
      ${content.headline ? `<div style="font-size:18px;font-weight:800;color:#111;margin-bottom:14px;line-height:1.35;letter-spacing:-0.01em;">${mdBold(content.headline)}</div>` : ''}
      ${kpiTable}
      ${chartsBlock}
      <div style="margin-top:14px;">${narrative}</div>
      ${actionsBlock}
      ${eventsBlock}
      <a href="${url}" style="display:inline-block;margin-top:22px;background:${esc(b.brandColor)};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:980px;padding:11px 22px;">Open Pulse →</a>
      ${feedbackUrl ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #ececf0;text-align:center;font-size:13px;color:#6e6e73;">
        Was this digest useful?
        <a href="${esc(feedbackUrl)}&amp;v=up" style="text-decoration:none;font-size:17px;margin:0 5px;">👍</a>
        <a href="${esc(feedbackUrl)}&amp;v=down" style="text-decoration:none;font-size:17px;margin:0 5px;">👎</a>
        <a href="${esc(feedbackUrl)}" style="color:${esc(b.brandColor)};text-decoration:none;font-weight:600;margin-left:6px;">💬 Add a comment</a>
        <div style="font-size:11.5px;color:#a1a1a6;margin-top:6px;">…or just reply to this email — it reaches the team and tunes future digests.</div>
      </div>` : ''}
    </div>
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;white-space:pre-wrap;">${esc(b.footer)}</div>
    ${brandRow()}
  </div>
</body></html>`;

  const textParts = [];
  if ((customMessage || '').trim()) textParts.push(customMessage.trim(), '');
  if (events.length) textParts.push(`Portfolio · ${events.length} events`);
  textParts.push(content.headline || '');
  for (const k of (content.kpis || [])) textParts.push(`• ${k.label}: ${k.value}${k.delta ? ` (${k.delta})` : ''}`);
  for (const c of (content.charts || [])) if (c.imageUrl) textParts.push(`• ${c.title || 'Chart'}${c.href ? `: ${c.href}` : ''}`);
  textParts.push('', ...(content.narrative || []));
  if (content.actions?.length) { textParts.push('', 'Suggested actions:'); for (const a of content.actions) textParts.push(`- ${a.text}`); }
  // Per-event sections (multi-event digest).
  for (const ev of events) {
    textParts.push('', `── ${ev.suiteName || 'Event'} ──`);
    if (ev.headline) textParts.push(ev.headline);
    for (const k of (ev.kpis || [])) textParts.push(`• ${k.label}: ${k.value}${k.delta ? ` (${k.delta})` : ''}`);
    if ((ev.narrative || []).length) textParts.push('', ...ev.narrative);
    if (ev.actions?.length) { textParts.push('Suggested actions:'); for (const a of ev.actions) textParts.push(`- ${a.text}`); }
  }
  textParts.push('', `Open Pulse: ${url}`, '', b.footer);
  const text = textParts.join('\n').replace(/\*\*/g, '');
  return { html, text, subject: content.subject };
}

// Marketing campaign email (Action Engine): client-branded shell with the
// campaign copy, a tracked CTA button, and the REQUIRED unsubscribe link.
// Body is plain text (pre-wrap) with **bold**; personalisation happens before
// this is called.
function campaignEmail({ branding, entityId, assetScope, subject, bodyText, ctaText, ctaUrl, unsubUrl, heroImage, promo }) {
  const b = branding || resolveBranding(entityId);
  const scope = assetScope || entityId;
  const logoSrc = b.logo && b.logo.startsWith('data:') && scope ? `${baseUrl()}/mail-assets/logo/${scope}` : b.logo;
  const brandMark = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(b.wordmark)}" style="max-height:40px;max-width:200px;display:block;" />`
    : `<div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;">${esc(b.wordmark)}</div>`;
  const hero = heroImage ? `<img src="${esc(heroImage)}" alt="" style="width:100%;border-radius:10px;margin-bottom:18px;display:block;" />` : '';
  const cta = ctaUrl ? `<a href="${esc(ctaUrl)}" style="display:inline-block;margin-top:20px;background:${esc(b.brandColor)};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:980px;padding:12px 26px;">${esc(ctaText || 'View event')} →</a>` : '';
  // Promo/discount code block. 'discount' = enter at checkout; 'promo' = applied
  // via the button (it rides the link).
  const promoBox = (promo && promo.code) ? `
      <div style="margin-top:20px;border:1.5px dashed ${esc(b.brandColor)};border-radius:12px;padding:16px;text-align:center;background:#fafafa;">
        ${promo.benefit ? `<div style="font-size:13px;font-weight:700;color:#111;margin-bottom:6px;">${esc(promo.benefit)}</div>` : ''}
        <div style="font-size:22px;font-weight:800;letter-spacing:1px;color:${esc(b.brandColor)};font-family:ui-monospace,Menlo,monospace;">${esc(promo.code)}</div>
        <div style="font-size:12px;color:#86868b;margin-top:6px;">${promo.type === 'discount' ? 'Enter this code at checkout.' : 'Applied automatically when you tap the button.'}</div>
      </div>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(bodyText || '').slice(0, 140)}</div>
  <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
    <div style="margin-bottom:14px;">${brandMark}</div>
    <div style="background:#ffffff;border:1px solid #e8e8ec;border-radius:14px;padding:26px;">
      ${hero}
      ${subject ? `<div style="font-size:19px;font-weight:800;color:#111;margin-bottom:12px;line-height:1.35;letter-spacing:-0.01em;">${mdBold(subject)}</div>` : ''}
      <div style="font-size:14.5px;line-height:1.65;color:#3a3a3c;white-space:pre-wrap;">${mdBold(bodyText || '')}</div>
      ${cta}
      ${promoBox}
    </div>
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;">
      Sent by ${esc(b.senderName)} via Howler : Pulse · <a href="${esc(unsubUrl)}" style="color:#86868b;">Unsubscribe</a>
    </div>
    ${brandRow()}
  </div>
</body></html>`;
  const promoText = (promo && promo.code) ? `${promo.benefit ? `${promo.benefit}\n` : ''}Code: ${promo.code}${promo.type === 'discount' ? ' (enter at checkout)' : ''}\n\n` : '';
  const text = `${subject || ''}\n\n${bodyText || ''}\n\n${promoText}${ctaUrl ? `${ctaText || 'View event'}: ${ctaUrl}\n\n` : ''}Unsubscribe: ${unsubUrl}`;
  return { html, text };
}

// Branding to render for a live preview: unsaved `edits` layered over the right
// base (a client's resolved branding, or the platform template for the platform
// editor). Used by the preview endpoint so editors see exactly what will send.
function previewBranding({ edits, entityId, suiteId } = {}) {
  const base = entityId ? resolveBranding(entityId, suiteId) : overlay(DEFAULTS, platformTemplate());
  return overlay(base, edits || {});
}

module.exports = {
  init, isConfigured, send, status, recent, recipientLog, notificationEmail, baseUrl,
  DEFAULTS, getPlatformTemplate, setPlatformTemplate, resolveBranding, previewBranding, digestEmail, campaignEmail,
};
