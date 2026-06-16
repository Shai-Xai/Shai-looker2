// ─── TikTok audience-sync connector — disposable module ───────────────────────
// Pushes a Pulse SEGMENT to a TikTok Custom Audience (hashed email/phone match),
// mirroring server/meta.js: per-client write-only token, graceful no-op when
// unconfigured, one sync chokepoint, never throws. Remembers the audience id per
// (client, segment) in `tiktok_audiences` so repeat syncs hit the same audience.
//
// IMPORTANT — TikTok differs from Meta in two ways that shape this v1:
//   1. The customer-file flow is multipart: upload a file of hashed ids → get a
//      file_path → create/update the audience from that path. (We build the
//      multipart body by hand to avoid a form-data dependency.)
//   2. TikTok has no one-call "replace" like Meta's usersreplace, so this is
//      APPEND-only for now (stable audience id, adds without removing). True
//      mirroring needs membership diffing — a documented follow-up.
//
// The exact endpoint paths / field names of the TikTok Marketing API move between
// versions — VERIFY against current docs before going live. Untested here (no
// TikTok app/creds in this environment); the reusable scaffolding around it
// (connection, hashing, route, UI, history) is the deliverable.
//
// Per-client connection (Admin → client → Integrations, or client self-service):
//   tiktokAccessToken    — long-lived access token (write-only)
//   tiktokAdvertiserId   — the advertiser id the audience lives under
const crypto = require('crypto');
const fetch = require('node-fetch');

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

let db = null;
function init(deps) {
  db = deps.db;
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_audiences (
      entity_id     TEXT NOT NULL,
      segment_id    TEXT NOT NULL,
      audience_id   TEXT NOT NULL DEFAULT '',
      audience_name TEXT NOT NULL DEFAULT '',
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
  return { accessToken: (i.tiktokAccessToken || '').trim(), advertiserId: (i.tiktokAdvertiserId || '').trim() };
}
function isConfigured(entityId) { const c = connection(entityId); return !!(c.accessToken && c.advertiserId); }
function status(entityId) { const c = connection(entityId); return { configured: !!(c.accessToken && c.advertiserId), advertiserId: c.advertiserId }; }

// ── per-(client,segment) audience mapping + last-sync record ──
function mapRow(entityId, segmentId) {
  return db ? db.db.prepare('SELECT * FROM tiktok_audiences WHERE entity_id=? AND segment_id=?').get(entityId, segmentId) : null;
}
function rememberSync({ entityId, segmentId, audienceId, name, received, status: st, error, by }) {
  db.db.prepare(`INSERT INTO tiktok_audiences (entity_id, segment_id, audience_id, audience_name, last_received, last_status, last_error, last_by, last_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id, segment_id) DO UPDATE SET audience_id=excluded.audience_id, audience_name=excluded.audience_name, last_received=excluded.last_received, last_status=excluded.last_status, last_error=excluded.last_error, last_by=excluded.last_by, last_at=excluded.last_at`)
    .run(entityId, segmentId, audienceId || '', name || '', received || 0, st || '', error || '', by || '', new Date().toISOString());
}
function lastSyncFor(entityId, segmentId) {
  const r = mapRow(entityId, segmentId);
  if (!r || !r.last_at) return null;
  return { audienceId: r.audience_id, name: r.audience_name, received: r.last_received, status: r.last_status, error: r.last_error, by: r.last_by, at: r.last_at };
}

// ── hashing (SHA-256 of normalised id, same spec as Meta) ──
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hashEmail = (e) => { const v = String(e || '').trim().toLowerCase(); return v ? sha256(v) : ''; };
function hashPhone(raw, defaultCc = '27') {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = defaultCc + s.slice(1);
  return /^\d{8,15}$/.test(s) ? sha256(s) : '';
}

// TikTok responses are { code, message, data }; code 0 = OK.
async function api(path, { method = 'POST', token, body, headers } = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { 'Access-Token': token, 'Content-Type': 'application/json', ...(headers || {}) },
    body: body !== undefined ? body : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.code !== 0 && data.code !== undefined)) {
    const err = new Error((data && data.message) || `TikTok HTTP ${res.status}`);
    err.tiktokCode = data && data.code; err.httpStatus = res.status;
    throw err;
  }
  return data.data || {};
}

// Build a multipart/form-data body by hand (no form-data dependency). `file` is
// { field, filename, content }. Returns { body: Buffer, contentType }.
function multipart(fields, file) {
  const boundary = '----pulse' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: text/plain\r\n\r\n`));
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content)));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Upload a file of hashed ids of one type → returns a file_path TikTok references.
// calculateType: 'EMAIL_SHA256' | 'PHONE_SHA256'.
async function uploadFile({ advertiserId, token, calculateType, values }) {
  const { body, contentType } = multipart(
    { advertiser_id: advertiserId, calculate_type: calculateType, file_signature: sha256(values.join('\n')) },
    { field: 'file', filename: 'audience.csv', content: values.join('\n') },
  );
  const res = await fetch(`${BASE}/dmp/custom_audience/file/upload/`, { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': contentType }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.code)) throw new Error((data && data.message) || `TikTok upload HTTP ${res.status}`);
  return (data.data && (data.data.file_path || data.data.path)) || '';
}

async function createAudience({ advertiserId, token, name, filePaths }) {
  const d = await api('dmp/custom_audience/create/', { token, body: JSON.stringify({ advertiser_id: advertiserId, custom_audience_name: name, file_paths: filePaths }) });
  return d.custom_audience_id || d.audience_id || '';
}
async function appendAudience({ advertiserId, token, audienceId, filePaths }) {
  await api('dmp/custom_audience/update/', { token, body: JSON.stringify({ advertiser_id: advertiserId, custom_audience_id: audienceId, action: 'APPEND', file_paths: filePaths }) });
}

// Push a segment's members to a TikTok Custom Audience. members: [{email, phone}].
// APPEND-only for v1 (see header). Best-effort: { ok, audienceId, pushed, received, error }. Never throws.
async function syncAudience({ entityId, segmentId, name, members = [], by = '' }) {
  if (!isConfigured(entityId)) return { ok: false, reason: 'not_configured', error: 'TikTok is not connected for this client.' };
  const { accessToken: token, advertiserId } = connection(entityId);
  const emails = []; const phones = [];
  for (const m of members) { const e = hashEmail(m.email); const p = hashPhone(m.phone); if (e) emails.push(e); if (p) phones.push(p); }
  const count = emails.length + phones.length;
  if (!count) return { ok: false, error: 'No matchable email or phone in this segment.' };
  const audienceName = `${name} (Pulse)`;
  try {
    const filePaths = [];
    if (emails.length) filePaths.push(await uploadFile({ advertiserId, token, calculateType: 'EMAIL_SHA256', values: emails }));
    if (phones.length) filePaths.push(await uploadFile({ advertiserId, token, calculateType: 'PHONE_SHA256', values: phones }));
    const clean = filePaths.filter(Boolean);
    if (!clean.length) throw new Error('TikTok accepted no files for this segment.');
    let audienceId = mapRow(entityId, segmentId)?.audience_id || '';
    if (audienceId) {
      try { await appendAudience({ advertiserId, token, audienceId, filePaths: clean }); }
      catch { audienceId = await createAudience({ advertiserId, token, name: audienceName, filePaths: clean }); } // recreate if the mapped audience is gone
    } else {
      audienceId = await createAudience({ advertiserId, token, name: audienceName, filePaths: clean });
    }
    rememberSync({ entityId, segmentId, audienceId, name: audienceName, received: count, status: 'ok', error: '', by });
    return { ok: true, audienceId, pushed: count, received: count };
  } catch (e) {
    rememberSync({ entityId, segmentId, audienceId: mapRow(entityId, segmentId)?.audience_id || '', name: audienceName, received: 0, status: 'error', error: e.message, by });
    return { ok: false, error: e.message };
  }
}

module.exports = { init, isConfigured, status, connection, syncAudience, lastSyncFor, hashEmail, hashPhone };
