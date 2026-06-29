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

// Channel dispatcher (email stays in mailer; this owns sms + whatsapp).
async function send({ channel, to, text }) {
  if (channel === 'sms') return sendSms({ to, text });
  if (channel === 'whatsapp') return sendWhatsapp({ to, text });
  return { ok: false, error: `Unsupported channel: ${channel}` };
}

module.exports = { init, isConfigured, status, sendSms, sendWhatsapp, send, normaliseMsisdn, waFrom, waConfigured };
