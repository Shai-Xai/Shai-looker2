// ─── Meta (Facebook/Instagram) audience-sync connector — disposable module ────
// Pushes a Pulse SEGMENT to a Meta Custom Audience (hashed email/phone match) for
// ad targeting or exclusion. This is an AUDIENCE-SYNC action, not a per-recipient
// "send" (see docs/ENGAGEMENT_ENGINE.md §4). Mirrors mailer.js / messaging.js:
//   • write-only secret (per client, in entity integrations — never returned)
//   • graceful no-op when unconfigured
//   • one sync chokepoint, never throws
//
// Membership is MIRRORED by default (Meta `usersreplace` sessions): the audience
// reflects exactly who is in the segment now — people who leave the segment are
// removed on the next sync. `mode: 'append'` adds without removing.
//
// We remember the Meta audience id per (client, segment) in `meta_audiences`, so
// repeat syncs target the SAME audience even if the segment is renamed, and so we
// can show "last synced" without re-listing the ad account.
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
function init(deps) {
  db = deps.db;
  // One row per (client, segment): the mapped audience + last-sync record.
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS meta_audiences (
      entity_id     TEXT NOT NULL,
      segment_id    TEXT NOT NULL,
      audience_id   TEXT NOT NULL DEFAULT '',
      audience_name TEXT NOT NULL DEFAULT '',
      last_mode     TEXT NOT NULL DEFAULT '',
      last_received INTEGER NOT NULL DEFAULT 0,
      last_status   TEXT NOT NULL DEFAULT '',
      last_error    TEXT NOT NULL DEFAULT '',
      last_by       TEXT NOT NULL DEFAULT '',
      last_at       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, segment_id)
    );
  `);
}

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

// ── per-(client,segment) audience mapping + last-sync record ──
function mapRow(entityId, segmentId) {
  return db ? db.db.prepare('SELECT * FROM meta_audiences WHERE entity_id=? AND segment_id=?').get(entityId, segmentId) : null;
}
function rememberSync({ entityId, segmentId, audienceId, name, mode, received, status: st, error, by }) {
  db.db.prepare(`INSERT INTO meta_audiences (entity_id, segment_id, audience_id, audience_name, last_mode, last_received, last_status, last_error, last_by, last_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id, segment_id) DO UPDATE SET audience_id=excluded.audience_id, audience_name=excluded.audience_name, last_mode=excluded.last_mode, last_received=excluded.last_received, last_status=excluded.last_status, last_error=excluded.last_error, last_by=excluded.last_by, last_at=excluded.last_at`)
    .run(entityId, segmentId, audienceId || '', name || '', mode || '', received || 0, st || '', error || '', by || '', new Date().toISOString());
}
// Last sync for a segment (for the UI). null if never synced.
function lastSyncFor(entityId, segmentId) {
  const r = mapRow(entityId, segmentId);
  if (!r || !r.last_at) return null;
  return { audienceId: r.audience_id, name: r.audience_name, mode: r.last_mode, received: r.last_received, status: r.last_status, error: r.last_error, by: r.last_by, at: r.last_at };
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
  const res = await fetch(method === 'GET' ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(e.message || `Meta HTTP ${res.status}`);
    err.metaCode = e.code; err.metaSubcode = e.error_subcode; err.httpStatus = res.status;
    throw err;
  }
  return data;
}

// Find an existing Custom Audience by name on the ad account (paged), else create
// one. Used only when we don't already have a mapped audience id.
async function findOrCreateAudience({ adAccountId, token, name, description }) {
  let path = `${adAccountId}/customaudiences?fields=id,name&limit=200`;
  for (let page = 0; page < 10 && path; page++) {
    let list;
    try { list = await graph(path, { token }); } catch { break; }
    const hit = (list.data || []).find((a) => (a.name || '').toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    path = list.paging?.next ? list.paging.next.replace(`${GRAPH}/`, '') : null;
  }
  const created = await graph(`${adAccountId}/customaudiences`, {
    method: 'POST', token,
    body: { name, subtype: 'CUSTOM', description: description || 'Synced from Howler Pulse', customer_file_source: 'USER_PROVIDED_ONLY' },
  });
  return created.id;
}

// Upload hashed rows to an audience. replace=true MIRRORS membership (Meta
// `usersreplace` session across batches); replace=false appends (`users`).
async function uploadUsers({ audienceId, token, rows, replace }) {
  const edge = replace ? 'usersreplace' : 'users';
  const sessionId = replace ? Math.floor(Date.now() / 1000) : null;
  const batches = [];
  for (let i = 0; i < rows.length; i += 5000) batches.push(rows.slice(i, i + 5000));
  let received = 0;
  for (let i = 0; i < batches.length; i++) {
    const body = { payload: { schema: ['EMAIL', 'PHONE'], data: batches[i] } };
    if (replace) body.session = { session_id: sessionId, batch_seq: i + 1, last_batch_flag: i === batches.length - 1, estimated_num_total: rows.length };
    const r = await graph(`${audienceId}/${edge}`, { method: 'POST', token, body });
    received += Number(r.num_received != null ? r.num_received : batches[i].length);
  }
  return received;
}

// Push a segment's members to a Custom Audience. members: [{ email, phone }].
// mode 'replace' (default) mirrors membership; 'append' only adds.
// Best-effort: returns { ok, audienceId, pushed, received, mode, error }. Never throws.
async function syncAudience({ entityId, segmentId, name, members = [], description = '', mode = 'replace', by = '' }) {
  if (!isConfigured(entityId)) return { ok: false, reason: 'not_configured', error: 'Meta is not connected for this client.' };
  const { accessToken: token, adAccountId } = connection(entityId);
  const replace = mode !== 'append';
  // Hash each member → [emailHash, phoneHash]; drop rows with neither.
  const rows = [];
  for (const m of members) {
    const eh = hashEmail(m.email); const ph = hashPhone(m.phone);
    if (eh || ph) rows.push([eh, ph]);
  }
  if (!rows.length) return { ok: false, error: 'No matchable email or phone in this segment.' };
  const audienceName = `${name} (Pulse)`;
  try {
    // Prefer the audience we already mapped for this segment (survives renames,
    // avoids re-listing); fall back to find-or-create by name.
    let audienceId = mapRow(entityId, segmentId)?.audience_id || '';
    if (!audienceId) audienceId = await findOrCreateAudience({ adAccountId, token, name: audienceName, description });
    let received;
    try {
      received = await uploadUsers({ audienceId, token, rows, replace });
    } catch (e) {
      // Mapped audience may have been deleted in Meta — recreate once, then retry.
      if (mapRow(entityId, segmentId)?.audience_id) {
        audienceId = await findOrCreateAudience({ adAccountId, token, name: audienceName, description });
        received = await uploadUsers({ audienceId, token, rows, replace });
      } else throw e;
    }
    rememberSync({ entityId, segmentId, audienceId, name: audienceName, mode: replace ? 'replace' : 'append', received, status: 'ok', error: '', by });
    return { ok: true, audienceId, pushed: rows.length, received, mode: replace ? 'replace' : 'append' };
  } catch (e) {
    rememberSync({ entityId, segmentId, audienceId: mapRow(entityId, segmentId)?.audience_id || '', name: audienceName, mode: replace ? 'replace' : 'append', received: 0, status: 'error', error: e.message, by });
    return { ok: false, error: e.message };
  }
}

// Per-client health/audience summary for the admin monitoring view.
function summary(entityId) {
  const rows = db ? db.db.prepare('SELECT * FROM meta_audiences WHERE entity_id=?').all(entityId) : [];
  const audiences = rows.filter((r) => r.last_at).map((r) => ({ segmentId: r.segment_id, audienceId: r.audience_id, name: r.audience_name, status: r.last_status, error: r.last_error, received: r.last_received, at: r.last_at, by: r.last_by }));
  const errors = audiences.filter((a) => a.status === 'error').length;
  const lastAt = audiences.reduce((m, a) => (a.at > m ? a.at : m), '');
  const lastError = audiences.filter((a) => a.status === 'error').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  return { channel: 'meta', configured: isConfigured(entityId), audienceCount: audiences.length, ok: audiences.length - errors, errors, lastAt, lastError: lastError ? { at: lastError.at, error: lastError.error, segmentId: lastError.segmentId } : null, audiences };
}

module.exports = { init, isConfigured, status, connection, syncAudience, lastSyncFor, summary, hashEmail, hashPhone };
