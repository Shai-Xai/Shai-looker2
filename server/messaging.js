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
const fetch = require('node-fetch');

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

// Send one SMS. Best-effort: returns { ok, error }. Never throws.
async function sendSms({ to, text }) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  const msisdn = normaliseMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid number' };
  const body = { messages: [{ channel: 'sms', to: msisdn, content: String(text || '').slice(0, 1600) }] };
  if (sender()) body.messages[0].from = sender();
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { Authorization: apiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      timeout: 20000, // node-fetch: fail a stuck SMS send instead of hanging forever
    });
    const data = await res.json().catch(() => ({}));
    // Clickatell returns per-message accepted/error; treat HTTP 2xx + no error as ok.
    const msg = Array.isArray(data.messages) ? data.messages[0] : null;
    if (res.ok && (!msg || msg.accepted !== false)) return { ok: true, id: msg?.apiMessageId || msg?.messageId };
    return { ok: false, error: msg?.error?.description || data.error || `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Channel dispatcher (email stays in mailer; this owns sms now, whatsapp later).
async function send({ channel, to, text }) {
  if (channel === 'sms') return sendSms({ to, text });
  return { ok: false, error: `Unsupported channel: ${channel}` };
}

module.exports = { init, isConfigured, status, sendSms, send, normaliseMsisdn };
