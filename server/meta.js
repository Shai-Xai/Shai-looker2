// ─── Meta (Facebook/Instagram) audience-sync connector — disposable module ────
// Pushes a Pulse SEGMENT to a Meta Custom Audience (hashed email/phone match) for
// ad targeting or exclusion. This is an AUDIENCE-SYNC action, not a per-recipient
// "send" (see docs/ENGAGEMENT_ENGINE.md §4). Mirrors mailer.js / messaging.js:
//   • write-only secret (per client, in entity integrations — never returned)
//   • graceful no-op when unconfigured
//   • one sync chokepoint, never throws
//
// Per-client connection (Admin → client → Integrations, or client self-service):
//   metaAccessToken   — long-lived/system-user token (write-only)
//   metaAdAccountId   — e.g. "act_1234567890"
//   metaBusinessId    — optional, for reference
//
// Identity is hashed (SHA-256 of normalised email/phone) BEFORE it leaves Pulse,
// per Meta's Customer File requirements — raw PII is never sent.
const crypto = require('crypto');
const fetch = require('node-fetch');

const GRAPH = 'https://graph.facebook.com/v19.0';

let db = null;
function init(deps) { db = deps.db; }

function connection(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  return {
    accessToken: (i.metaAccessToken || '').trim(),
    adAccountId: normaliseAdAccount(i.metaAdAccountId || ''),
    businessId: (i.metaBusinessId || '').trim(),
  };
}
function isConfigured(entityId) { const c = connection(entityId); return !!(c.accessToken && c.adAccountId); }
function status(entityId) { const c = connection(entityId); return { configured: !!(c.accessToken && c.adAccountId), adAccountId: c.adAccountId, businessId: c.businessId }; }

// Meta wants the ad account as "act_<digits>". Accept a bare id too.
function normaliseAdAccount(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^act_/.test(s) ? s : (/^\d+$/.test(s) ? `act_${s}` : s);
}

// ── hashing (Meta Customer File spec) ──
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hashEmail = (e) => { const v = String(e || '').trim().toLowerCase(); return v ? sha256(v) : ''; };
// Phone → digits with country code, no '+' (default SA), then hash.
function hashPhone(raw, defaultCc = '27') {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = defaultCc + s.slice(1);
  return /^\d{8,15}$/.test(s) ? sha256(s) : '';
}

async function graph(path, { method = 'GET', token, body } = {}) {
  const url = `${GRAPH}/${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify({ ...body, access_token: token });
  else if (token) { /* GET: token via query */ }
  const res = await fetch(method === 'GET' ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(e.message || `Meta HTTP ${res.status}`);
    err.metaCode = e.code; err.metaSubcode = e.error_subcode;
    throw err;
  }
  return data;
}

// Find an existing Custom Audience by name on the ad account, else create one.
// Reusing by name keeps repeat syncs updating the SAME audience (no duplicates).
async function findOrCreateAudience({ adAccountId, token, name, description }) {
  try {
    const list = await graph(`${adAccountId}/customaudiences?fields=id,name&limit=200`, { token });
    const hit = (list.data || []).find((a) => (a.name || '').toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
  } catch { /* listing may be denied; fall through to create */ }
  const created = await graph(`${adAccountId}/customaudiences`, {
    method: 'POST', token,
    body: { name, subtype: 'CUSTOM', description: description || 'Synced from Howler Pulse', customer_file_source: 'USER_PROVIDED_ONLY' },
  });
  return created.id;
}

// Push a segment's members to a Custom Audience. members: [{ email, phone }].
// Best-effort: returns { ok, audienceId, pushed, matched, error }. Never throws.
async function syncAudience({ entityId, name, members = [], description = '' }) {
  if (!isConfigured(entityId)) return { ok: false, reason: 'not_configured', error: 'Meta is not connected for this client.' };
  const { accessToken: token, adAccountId } = connection(entityId);
  // Hash each member → [emailHash, phoneHash]; drop rows with neither.
  const rows = [];
  for (const m of members) {
    const eh = hashEmail(m.email); const ph = hashPhone(m.phone);
    if (eh || ph) rows.push([eh, ph]);
  }
  if (!rows.length) return { ok: false, error: 'No matchable email or phone in this segment.' };
  try {
    const audienceId = await findOrCreateAudience({ adAccountId, token, name: `${name} (Pulse)`, description });
    let pushed = 0; let matched = 0;
    // Meta accepts up to 10k users per call; batch to be safe.
    for (let i = 0; i < rows.length; i += 5000) {
      const batch = rows.slice(i, i + 5000);
      const r = await graph(`${audienceId}/users`, {
        method: 'POST', token,
        body: { payload: { schema: ['EMAIL', 'PHONE'], data: batch } },
      });
      pushed += batch.length;
      matched += Number(r.num_received || batch.length);
    }
    return { ok: true, audienceId, pushed, matched };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { init, isConfigured, status, connection, syncAudience, hashEmail, hashPhone };
