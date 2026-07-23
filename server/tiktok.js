// ─── TikTok audience-sync connector — disposable module ───────────────────────
// Pushes a Pulse SEGMENT to a TikTok Custom Audience (hashed email/phone match),
// mirroring server/meta.js: per-client write-only token, graceful no-op when
// unconfigured, one sync chokepoint, never throws. Remembers the audience id per
// (client, segment) in `tiktok_audiences` so repeat syncs hit the same audience.
//
// TRUE MIRROR via diffing. TikTok has no one-call "replace" like Meta's
// usersreplace — only APPEND and DELETE on a customer-file audience — and it won't
// read an audience's contents back. So we remember the exact hashed membership we
// last pushed (in `tiktok_audience_members`), and on each sync compute:
//   to-add    = in the segment now, not last time   → APPEND
//   to-remove = synced last time, gone from segment → DELETE
// The audience id stays stable (ads keep pointing at it) while membership tracks
// the segment. People who leave the segment are removed — not stranded.
//
// The customer-file flow is multipart: upload a file of hashed ids of ONE type →
// get a file_path → create / update the audience from it. (We build the multipart
// body by hand to avoid a form-data dependency.)
//
// The exact endpoint paths / field names of the TikTok Marketing API move between
// versions — VERIFY against current docs before going live. Untested here (no
// TikTok app/creds in this environment); the reusable scaffolding around it
// (connection, hashing, diffing, route, UI, history) is the deliverable.
//
// Per-client connection (Admin → client → Integrations, or client self-service):
//   tiktokAccessToken    — long-lived access token (write-only)
//   tiktokAdvertiserId   — the advertiser id the audience lives under
const crypto = require('crypto');

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
    CREATE TABLE IF NOT EXISTS tiktok_audience_members (
      entity_id  TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      kind       TEXT NOT NULL,         -- 'email' | 'phone'
      id_hash    TEXT NOT NULL,         -- SHA-256 hex of the normalised id
      PRIMARY KEY (entity_id, segment_id, kind, id_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_tiktok_members ON tiktok_audience_members(entity_id, segment_id, kind);
    CREATE TABLE IF NOT EXISTS audience_sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id   TEXT NOT NULL,
      segment_id  TEXT NOT NULL,
      channel     TEXT NOT NULL,
      audience_id TEXT NOT NULL DEFAULT '',
      received    INTEGER,
      added       INTEGER,
      removed     INTEGER,
      status      TEXT NOT NULL DEFAULT '',
      error       TEXT NOT NULL DEFAULT '',
      by          TEXT NOT NULL DEFAULT '',
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audience_log_entity ON audience_sync_log(entity_id, at);
  `);
}

// Append a row to the shared change-log. Best-effort; never throws.
function logSync({ entityId, segmentId, audienceId, received, added, removed, status, error, by }) {
  try {
    db.db.prepare('INSERT INTO audience_sync_log (entity_id, segment_id, channel, audience_id, received, added, removed, status, error, by, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(entityId, segmentId, 'tiktok', audienceId || '', received ?? null, added ?? null, removed ?? null, status, error || '', by || '', new Date().toISOString());
  } catch { /* logging must never break a sync */ }
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

// ── last-synced membership baseline (for diffing) ──
function memberSet(entityId, segmentId, kind) {
  const rows = db.db.prepare('SELECT id_hash FROM tiktok_audience_members WHERE entity_id=? AND segment_id=? AND kind=?').all(entityId, segmentId, kind);
  return new Set(rows.map((r) => r.id_hash));
}
// Replace the stored baseline for a kind with the given set (transactional).
function replaceMemberSet(entityId, segmentId, kind, set) {
  const del = db.db.prepare('DELETE FROM tiktok_audience_members WHERE entity_id=? AND segment_id=? AND kind=?');
  const ins = db.db.prepare('INSERT OR IGNORE INTO tiktok_audience_members (entity_id, segment_id, kind, id_hash) VALUES (?,?,?,?)');
  const tx = db.db.transaction((hashes) => {
    del.run(entityId, segmentId, kind);
    for (const h of hashes) ins.run(entityId, segmentId, kind, h);
  });
  tx([...set]);
}
function clearMembers(entityId, segmentId) {
  db.db.prepare('DELETE FROM tiktok_audience_members WHERE entity_id=? AND segment_id=?').run(entityId, segmentId);
}

// ── hashing (SHA-256 of normalised id, same spec as Meta) ──
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// MD5 of the raw upload body — TikTok's file/upload `file_signature` is an
// integrity checksum of the FILE (not the member-hash algorithm), and must be MD5.
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
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
async function api(path, { token, body } = {}) {
  const res = await fetch(`${BASE}/${path}`, { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.code)) {
    const err = new Error((data && data.message) || `TikTok HTTP ${res.status}`);
    err.tiktokCode = data && data.code; err.httpStatus = res.status;
    throw err;
  }
  return data.data || {};
}

// Build a multipart/form-data body by hand (no form-data dependency).
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
  const content = values.join('\n');
  const { body, contentType } = multipart(
    { advertiser_id: advertiserId, calculate_type: calculateType, file_signature: md5(content) },
    { field: 'file', filename: 'audience.csv', content },
  );
  const res = await fetch(`${BASE}/dmp/custom_audience/file/upload/`, { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': contentType }, body, signal: AbortSignal.timeout(60000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.code)) throw new Error((data && data.message) || `TikTok upload HTTP ${res.status}`);
  return (data.data && (data.data.file_path || data.data.path)) || '';
}

// `create` requires a single calculate_type, so an audience is seeded from ONE
// id kind; the other kind is added afterwards via update/APPEND (which doesn't
// take a calculate_type). calculateType: 'EMAIL_SHA256' | 'PHONE_SHA256'.
async function createAudience({ advertiserId, token, name, calculateType, filePaths }) {
  const d = await api('dmp/custom_audience/create/', { token, body: JSON.stringify({ advertiser_id: advertiserId, custom_audience_name: name, calculate_type: calculateType, file_paths: filePaths }) });
  return d.custom_audience_id || d.audience_id || '';
}
// action: 'APPEND' | 'DELETE'.
async function updateAudience({ advertiserId, token, audienceId, action, filePaths }) {
  await api('dmp/custom_audience/update/', { token, body: JSON.stringify({ advertiser_id: advertiserId, custom_audience_id: audienceId, action, file_paths: filePaths }) });
}

// Upload the given hashes of a kind and apply them to the audience with `action`.
async function applyDelta({ advertiserId, token, audienceId, kind, hashes, action }) {
  if (!hashes.length) return;
  const calculateType = kind === 'phone' ? 'PHONE_SHA256' : 'EMAIL_SHA256';
  const path = await uploadFile({ advertiserId, token, calculateType, values: hashes });
  if (path) await updateAudience({ advertiserId, token, audienceId, action, filePaths: [path] });
}

// Mirror a segment's members into a TikTok Custom Audience. members: [{email,phone}].
// Best-effort: { ok, audienceId, pushed, received, added, removed, error }. Never throws.
async function syncAudience({ entityId, segmentId, name, members = [], by = '' }) {
  if (!isConfigured(entityId)) return { ok: false, reason: 'not_configured', error: 'TikTok is not connected for this client.' };
  const { accessToken: token, advertiserId } = connection(entityId);
  const newEmails = new Set(); const newPhones = new Set();
  for (const m of members) { const e = hashEmail(m.email); const p = hashPhone(m.phone); if (e) newEmails.add(e); if (p) newPhones.add(p); }
  const count = newEmails.size + newPhones.size;
  if (!count) return { ok: false, error: 'No matchable email or phone in this segment.' };
  const audienceName = `${name} (Pulse)`;
  // Diff against the last-synced baseline.
  const oldEmails = memberSet(entityId, segmentId, 'email');
  const oldPhones = memberSet(entityId, segmentId, 'phone');
  const diff = (next, prev) => ({ add: [...next].filter((h) => !prev.has(h)), remove: [...prev].filter((h) => !next.has(h)) });
  const eD = diff(newEmails, oldEmails); const pD = diff(newPhones, oldPhones);
  try {
    let audienceId = mapRow(entityId, segmentId)?.audience_id || '';
    const createFresh = async () => {
      // Seed the audience from whichever id kind we have first, then APPEND the
      // other — `create` takes a single calculate_type, but APPEND mixes types.
      let id = '';
      const seed = async (kind, values) => {
        if (!values.length) return;
        const calculateType = kind === 'phone' ? 'PHONE_SHA256' : 'EMAIL_SHA256';
        const path = await uploadFile({ advertiserId, token, calculateType, values });
        if (!path) return;
        if (!id) id = await createAudience({ advertiserId, token, name: audienceName, calculateType, filePaths: [path] });
        else await updateAudience({ advertiserId, token, audienceId: id, action: 'APPEND', filePaths: [path] });
      };
      await seed('email', [...newEmails]);
      await seed('phone', [...newPhones]);
      if (!id) throw new Error('TikTok accepted no files for this segment.');
      return id;
    };
    let added = count; let removed = 0;
    if (audienceId) {
      try {
        // APPEND new, DELETE departed — true mirror on a stable audience.
        await applyDelta({ advertiserId, token, audienceId, kind: 'email', hashes: eD.add, action: 'APPEND' });
        await applyDelta({ advertiserId, token, audienceId, kind: 'phone', hashes: pD.add, action: 'APPEND' });
        await applyDelta({ advertiserId, token, audienceId, kind: 'email', hashes: eD.remove, action: 'DELETE' });
        await applyDelta({ advertiserId, token, audienceId, kind: 'phone', hashes: pD.remove, action: 'DELETE' });
        added = eD.add.length + pD.add.length; removed = eD.remove.length + pD.remove.length;
      } catch {
        // Mapped audience likely gone — recreate from the full current set.
        audienceId = await createFresh(); added = count; removed = 0;
      }
    } else {
      audienceId = await createFresh();
    }
    // Commit the new baseline only after the platform calls succeeded.
    replaceMemberSet(entityId, segmentId, 'email', newEmails);
    replaceMemberSet(entityId, segmentId, 'phone', newPhones);
    rememberSync({ entityId, segmentId, audienceId, name: audienceName, received: count, status: 'ok', error: '', by });
    logSync({ entityId, segmentId, audienceId, received: count, added, removed, status: 'ok', by });
    return { ok: true, audienceId, pushed: count, received: count, added, removed };
  } catch (e) {
    rememberSync({ entityId, segmentId, audienceId: mapRow(entityId, segmentId)?.audience_id || '', name: audienceName, received: 0, status: 'error', error: e.message, by });
    logSync({ entityId, segmentId, audienceId: mapRow(entityId, segmentId)?.audience_id || '', received: 0, status: 'error', error: e.message, by });
    return { ok: false, error: e.message };
  }
}

// Live audience size/status from TikTok. Best-effort; never throws.
async function audienceStatus(entityId, audienceId) {
  if (!isConfigured(entityId) || !audienceId) return { ok: false, error: 'not connected / no audience' };
  const { accessToken: token, advertiserId } = connection(entityId);
  try {
    const url = `${BASE}/dmp/custom_audience/get/?advertiser_id=${encodeURIComponent(advertiserId)}&custom_audience_ids=${encodeURIComponent(JSON.stringify([audienceId]))}`;
    const res = await fetch(url, { headers: { 'Access-Token': token }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.code)) return { ok: false, error: (data && data.message) || `TikTok HTTP ${res.status}` };
    const a = (data.data && (data.data.list || [])[0]) || {};
    return { ok: true, name: a.name, size: a.cover_num ?? a.audience_size ?? null, operation: a.is_valid === false ? 'invalid' : 'valid', checkedAt: new Date().toISOString() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Live connection check — is the token valid right now? Hits advertiser info.
// Best-effort; never throws. status: ok | not_configured | token_invalid | error.
async function verify(entityId) {
  const checkedAt = new Date().toISOString();
  if (!isConfigured(entityId)) return { ok: false, status: 'not_configured', detail: 'No access token / advertiser ID set.', checkedAt };
  const { accessToken: token, advertiserId } = connection(entityId);
  try {
    const url = `${BASE}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([advertiserId]))}&fields=${encodeURIComponent(JSON.stringify(['name', 'status']))}`;
    const res = await fetch(url, { headers: { 'Access-Token': token }, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.code)) {
      const status = data && (data.code === 40105 || data.code === 40100) ? 'token_invalid' : 'error';
      return { ok: false, status, detail: (data && data.message) || `TikTok HTTP ${res.status}`, checkedAt };
    }
    const adv = (data.data && (data.data.list || [])[0]) || {};
    return { ok: true, status: 'ok', account: adv.name || advertiserId, accountStatus: adv.status, checkedAt };
  } catch (e) { return { ok: false, status: 'error', detail: e.message, checkedAt }; }
}

// Live list of ALL custom audiences on the advertiser — Pulse-made or created
// directly in TikTok Ads. Paginates; best-effort; never throws.
// Returns { ok, audiences:[{audienceId,name,size,valid,type,calculateType,createdAt}] }.
async function listAudiences(entityId) {
  if (!isConfigured(entityId)) return { ok: false, error: 'not connected' };
  const { accessToken: token, advertiserId } = connection(entityId);
  try {
    const audiences = []; let page = 1; let totalPage = 1;
    do {
      const url = `${BASE}/dmp/custom_audience/list/?advertiser_id=${encodeURIComponent(advertiserId)}&page=${page}&page_size=100`;
      const res = await fetch(url, { headers: { 'Access-Token': token }, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data && data.code)) return { ok: false, error: (data && data.message) || `TikTok HTTP ${res.status}` };
      const d = data.data || {};
      for (const a of d.list || []) audiences.push({
        audienceId: String(a.audience_id || ''),
        name: a.name || '',
        size: a.cover_num ?? null,
        valid: a.is_valid !== false,
        type: a.audience_type || '',
        calculateType: a.calculate_type || '',
        createdAt: a.create_time || '',
      });
      totalPage = (d.page_info && d.page_info.total_page) || 1;
      page += 1;
    } while (page <= totalPage && page <= 20); // hard cap so a huge account can't spin forever
    return { ok: true, audiences };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Best-effort deep link to this advertiser's audiences in TikTok Ads.
function audiencesUrl(entityId) {
  const adv = connection(entityId).advertiserId; if (!adv) return '';
  return `https://ads.tiktok.com/i18n/dmp/audience/list?aadvid=${adv}`;
}

// Per-client health/audience summary for the admin monitoring view.
function summary(entityId) {
  const rows = db ? db.db.prepare('SELECT * FROM tiktok_audiences WHERE entity_id=?').all(entityId) : [];
  const audiences = rows.filter((r) => r.last_at).map((r) => ({ segmentId: r.segment_id, audienceId: r.audience_id, name: r.audience_name, status: r.last_status, error: r.last_error, received: r.last_received, at: r.last_at, by: r.last_by }));
  const errors = audiences.filter((a) => a.status === 'error').length;
  const lastAt = audiences.reduce((m, a) => (a.at > m ? a.at : m), '');
  const lastError = audiences.filter((a) => a.status === 'error').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  return { channel: 'tiktok', configured: isConfigured(entityId), advertiserId: connection(entityId).advertiserId, audiencesUrl: audiencesUrl(entityId), audienceCount: audiences.length, ok: audiences.length - errors, errors, lastAt, lastError: lastError ? { at: lastError.at, error: lastError.error, segmentId: lastError.segmentId } : null, audiences };
}

module.exports = { init, isConfigured, status, connection, syncAudience, lastSyncFor, clearMembers, verify, audienceStatus, listAudiences, audiencesUrl, summary, hashEmail, hashPhone };
