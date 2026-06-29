// ─── Messaging (SMS via Clickatell One API) — disposable module ───────────────
// A second send channel alongside email. Mirrors the mailer's shape: a single
// send chokepoint, write-only secret, graceful no-op when unconfigured. SMS now;
// WhatsApp (also Clickatell, a WhatsApp BSP) slots in later behind the same
// interface.
//
// Config lives in settings (Admin → Integrations), with .env fallback:
//   clickatell_api_key   — the One API key (write-only; never returned)
//   sms_sender           — alphanumeric sender ID (e.g. "MTNBush") or number
//   clickatell_endpoint  — One API URL (kept configurable; verify vs current docs)

let db = null;
const DEFAULT_ENDPOINT = 'https://platform.clickatell.com/v1/message';

function init(deps) { db = deps.db; }
function apiKey() { return (db?.getSetting('clickatell_api_key') || process.env.CLICKATELL_API_KEY || '').trim(); }
function sender() { return (db?.getSetting('sms_sender') || process.env.SMS_SENDER || '').trim(); }
function endpoint() { return (db?.getSetting('clickatell_endpoint') || process.env.CLICKATELL_ENDPOINT || DEFAULT_ENDPOINT).trim(); }
function isConfigured() { return !!apiKey(); }
function status() { return { configured: isConfigured(), sender: sender(), endpoint: endpoint() }; }

// Normalise to international digits (no +). Defaults bare SA numbers (0XXXXXXXXX)
// to +27. Returns '' if it doesn't look like a phone number.
function normaliseMsisdn(raw, defaultCc = '27') {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = defaultCc + s.slice(1); // local → country code
  return /^\d{8,15}$/.test(s) ? s : '';
}

// The WhatsApp sender — the Business number registered with Clickatell. SMS uses an
// alphanumeric sender ID; WhatsApp must send FROM the WA number.
function waFrom() { return (db?.getSetting('whatsapp_from') || process.env.WHATSAPP_FROM || '').trim(); }
// WhatsApp can run through a SEPARATE Clickatell integration from SMS, so it has its own
// key/endpoint — falling back to the SMS ones when not separately configured.
function waApiKey() { return (db?.getSetting('whatsapp_api_key') || process.env.WHATSAPP_API_KEY || apiKey()).trim(); }
function waEndpoint() { return (db?.getSetting('whatsapp_endpoint') || process.env.WHATSAPP_ENDPOINT || endpoint()).trim(); }
function waConfigured() { return !!waApiKey(); }

// Send one message on a Clickatell One API channel ('sms' | 'whatsapp'). Best-effort:
// returns { ok, error }. Never throws. WhatsApp free-form replies are allowed inside the
// 24h customer-service window (i.e. when replying to a customer's inbound message).
async function sendOne(channel, { to, text }) {
  const isWa = channel === 'whatsapp';
  const key = isWa ? waApiKey() : apiKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  const msisdn = normaliseMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid number' };
  const from = isWa ? waFrom() : sender();
  const body = { messages: [{ channel, to: msisdn, content: String(text || '').slice(0, isWa ? 4096 : 1600) }] };
  if (from) body.messages[0].from = from;
  try {
    const res = await fetch(isWa ? waEndpoint() : endpoint(), {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000), // fail a stuck send instead of hanging forever
    });
    const data = await res.json().catch(() => ({}));
    // Clickatell returns per-message accepted/error; treat HTTP 2xx + no error as ok.
    const msg = Array.isArray(data.messages) ? data.messages[0] : null;
    if (res.ok && (!msg || msg.accepted !== false)) return { ok: true, id: msg?.apiMessageId || msg?.messageId };
    // Coerce whatever error shape Clickatell sent into a readable string (code + text).
    const e = msg?.error || data.error || data;
    const errStr = typeof e === 'string' ? e
      : [e?.code, e?.description || e?.message].filter(Boolean).join(' ') || JSON.stringify(e || {}).slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: errStr, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function sendSms({ to, text }) { return sendOne('sms', { to, text }); }
async function sendWhatsapp({ to, text }) { return sendOne('whatsapp', { to, text }); }

// Coerce Clickatell's varied error shapes into one readable string (shared by the
// media/button sends below, which don't go through sendOne).
function waErr(data, msg, status) {
  const e = (msg && msg.error) || data.error || data;
  return typeof e === 'string' ? e
    : [e?.code, e?.description || e?.message].filter(Boolean).join(' ') || JSON.stringify(e || {}).slice(0, 300) || `HTTP ${status}`;
}

// POST a single pre-built WhatsApp message object to the One API. Shared by the
// image + button sends (sendOne handles the plain-text channel path).
async function waSend(message, key) {
  try {
    const res = await fetch(waEndpoint(), {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messages: [message] }), signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    const msg = Array.isArray(data.messages) ? data.messages[0] : null;
    if (res.ok && (!msg || msg.accepted !== false)) return { ok: true, id: msg?.apiMessageId || msg?.messageId };
    return { ok: false, error: waErr(data, msg, res.status), status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The media-upload URL. Derive it from the message endpoint's ORIGIN + the documented
// /v1/media path, so a configured endpoint with an odd path/trailing slash/query can't
// produce a malformed URL (a likely cause of the 404 we saw).
function waMediaUrl() {
  const ep = waEndpoint();
  try { return `${new URL(ep).origin}/v1/media`; } catch { return ep.replace(/\/message\/?$/, '/media'); }
}

// Upload binary media (a chart PNG) to Clickatell and get back a fileId to reference
// in a WhatsApp image message. One API requires upload-first (no direct URL). On
// failure the error carries the exact URL + status + a snippet of the raw response,
// so the admin activity log pinpoints the cause without server access.
async function uploadWhatsappMedia(buffer, contentType = 'image/png') {
  const key = waApiKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  const mediaUrl = waMediaUrl();
  try {
    const res = await fetch(mediaUrl, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': contentType, Accept: 'application/json' },
      body: buffer, signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();
    let data = {}; try { data = JSON.parse(raw); } catch { /* non-JSON (e.g. an HTML 404 page) */ }
    const fileId = data.fileId || data.id || (Array.isArray(data.media) ? data.media[0]?.fileId : null);
    if (res.ok && fileId) return { ok: true, fileId };
    const parsed = waErr(data, null, res.status);
    const why = (parsed && parsed !== '{}' ? parsed : '') || raw.slice(0, 160) || `HTTP ${res.status}`;
    return { ok: false, error: `${why} [${res.status} @ ${mediaUrl}]`, status: res.status };
  } catch (e) { return { ok: false, error: `${e.message} [@ ${mediaUrl}]` }; }
}

// Send a WhatsApp image (by uploaded fileId) with an optional caption.
async function sendWhatsappImage({ to, fileId, caption = '', contentType = 'image/png' }) {
  const key = waApiKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  const msisdn = normaliseMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid number' };
  const m = { channel: 'whatsapp', to: msisdn, media: { contentType, fileId, caption: String(caption || '').slice(0, 1024) } };
  if (waFrom()) m.from = waFrom();
  return waSend(m, key);
}

// Send a WhatsApp image by public URL (no upload step) — works when the media
// endpoint isn't provisioned, as long as Clickatell accepts a media URL. We cover
// a couple of likely field names (url / mediaUrl) since it's lightly documented.
async function sendWhatsappImageByUrl({ to, url, caption = '', contentType = 'image/png' }) {
  const key = waApiKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  const msisdn = normaliseMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid number' };
  const cap = String(caption || '').slice(0, 1024);
  const m = { channel: 'whatsapp', to: msisdn, media: { contentType, url, mediaUrl: url, caption: cap } };
  if (waFrom()) m.from = waFrom();
  return waSend(m, key);
}

// Send an interactive reply-button message (max 3). buttons: [{title, postbackData}].
async function sendWhatsappButtons({ to, body, buttons }) {
  const key = waApiKey();
  if (!key) return { ok: false, reason: 'not_configured' };
  const msisdn = normaliseMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid number' };
  const items = (buttons || []).slice(0, 3).map((b) => ({ type: 'reply', title: String(b.title || '').slice(0, 20), postbackData: String(b.postbackData || b.title || '').slice(0, 256) }));
  if (!items.length) return { ok: false, error: 'no buttons' };
  const m = { channel: 'whatsapp', to: msisdn, button: { body: String(body || '').slice(0, 1024), items } };
  if (waFrom()) m.from = waFrom();
  return waSend(m, key);
}

// Channel dispatcher (email stays in mailer; this owns sms + whatsapp).
async function send({ channel, to, text }) {
  if (channel === 'sms') return sendSms({ to, text });
  if (channel === 'whatsapp') return sendWhatsapp({ to, text });
  return { ok: false, error: `Unsupported channel: ${channel}` };
}

module.exports = { init, isConfigured, status, sendSms, sendWhatsapp, send, normaliseMsisdn, waFrom, waConfigured, uploadWhatsappMedia, sendWhatsappImage, sendWhatsappImageByUrl, sendWhatsappButtons };
