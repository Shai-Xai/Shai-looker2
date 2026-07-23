// ─── Google Drive connector — the Owl reads the client's own files ─────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns drive_sources + drive_files and the
// /api/admin/entities/:id/drive + /api/my/drive/:id routes. Remove the mount line
// in index.js + this file (and the two Owl tools that consume driveApi) to uninstall.
//
// How it connects (no OAuth app needed): each client gets a Google SERVICE ACCOUNT
// key (write-only, sealed at rest — or the platform-wide GOOGLE_SERVICE_ACCOUNT_KEY
// env fallback). The client shares specific files/folders with the service-account
// EMAIL (like sharing with a colleague), pastes the link here, and the Owl can read
// exactly those — nothing else. Explicit allow, never whole-Drive.
//
// What each file becomes:
//   Google Sheet / CSV        → a TABLE in owl_uploads (source 'drive') — the Owl's
//                               existing askUpload tool queries it like any upload.
//   Google Doc / Slides / txt → extracted TEXT in drive_files — searchDriveDocs /
//                               readDriveDoc ground answers on it, cited by file.
//   PDF                       → text via AI extraction (injected extractDocText,
//                               metered per client) → drive_files like a doc.
//   Folder                    → all supported children, kept in step; `watch` makes
//                               the hourly tick re-sync it automatically.
//
// Dependency-free Google auth: service-account JWT (RS256 via node crypto) →
// oauth2.googleapis.com token, cached until expiry. All calls hit fixed Google
// hosts with hard timeouts — user input only ever selects WHICH file id.

const crypto = require('crypto');

// PDF → text prompt. Registered in insights.promptRegistry() (key 'driveDocText')
// so the Admin → AI audit shows it — the CLAUDE.md auditability rule.
const DOC_TEXT_SYSTEM = `You transcribe a PDF document to clean plain text so an analyst AI can search and quote it.
Rules:
- Output ONLY the document's text content — no commentary, no summary, no markdown fences.
- Keep the reading order; render headings as their own lines; render tables as lines of "label: value" or aligned columns.
- Transcribe numbers, dates and names EXACTLY as written. Never infer or fill in values you cannot read.
- If a page is an image with no readable text, write [unreadable page].`;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TEXT_CAP = 2 * 1024 * 1024;        // exported text/CSV per file
const DOC_STORE_CAP = 400_000;           // chars of extracted text kept per file
const PDF_CAP = 10 * 1024 * 1024;        // binary PDF size for AI extraction
const FOLDER_FILE_CAP = 120;             // children synced per folder
const READ_CHUNK = 6000;                 // chars per readDriveDoc call

// ── link parsing (exported for tests) ──────────────────────────────────────────
// Accepts Sheets/Docs/Slides links, drive file links, folder links, ?id= links,
// or a bare file id. Returns { fileId, folder } or null.
function parseLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/docs\.google\.com\/(?:spreadsheets|document|presentation)\/d\/([\w-]+)/);
  if (m) return { fileId: m[1], folder: false };
  m = s.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (m) return { fileId: m[1], folder: false };
  m = s.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)/);
  if (m) return { fileId: m[1], folder: true };
  m = s.match(/[?&]id=([\w-]+)/);
  if (m) return { fileId: m[1], folder: false };
  if (/^[\w-]{20,}$/.test(s) && !s.includes('.')) return { fileId: s, folder: false };
  return null;
}

// ── service-account key + token ────────────────────────────────────────────────
function parseServiceAccount(jsonText) {
  let o;
  try { o = JSON.parse(String(jsonText || '')); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const email = String(o.client_email || '').trim();
  const key = String(o.private_key || '');
  if (!email.includes('@') || !key.includes('PRIVATE KEY')) return null;
  return { email, key };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// Build the signed JWT assertion for the token exchange (exported for tests).
function buildAssertion(sa, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.key))}`;
}

// What each mime becomes. `export` = Drive files.export target for Google-native
// types; download-as-is otherwise. XLSX and other binaries are unsupported (same
// stance as owl uploads — export them to Sheets/CSV first).
function kindOf(mime) {
  const m = String(mime || '');
  if (m === 'application/vnd.google-apps.spreadsheet') return { kind: 'table', export: 'text/csv' };
  if (m === 'text/csv') return { kind: 'table' };
  if (m === 'application/vnd.google-apps.document') return { kind: 'doc', export: 'text/plain' };
  if (m === 'application/vnd.google-apps.presentation') return { kind: 'doc', export: 'text/plain' };
  if (m === 'text/plain' || m === 'text/markdown') return { kind: 'doc' };
  if (m === 'application/pdf') return { kind: 'pdf' };
  if (m === 'application/vnd.google-apps.folder') return { kind: 'folder' };
  return null;
}

function mount(app, { db, auth, insights, anthropicKeyForEntity, extractDocText, fetchImpl, startTimer = true }) {
  const sql = db.db;
  const doFetch = fetchImpl || fetch;

  // PDF → text via the metered Anthropic client (per-client key, usage attributed
  // to the entity as kind 'drive_ingest'). Tests inject extractDocText instead.
  async function aiExtractPdf({ pdfBase64, entityId }) {
    const apiKey = anthropicKeyForEntity ? anthropicKeyForEntity(entityId) : '';
    if (!insights || !insights.isConfigured(apiKey)) throw new Error('PDF reading needs the AI key configured.');
    return require('./aiUsage').run({ entityId, kind: 'drive_ingest' }, async () => {
      const c = insights.requireClient(apiKey);
      const msg = await c.messages.create({
        model: insights.MODEL, max_tokens: 16000, system: DOC_TEXT_SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Transcribe this document to plain text.' },
        ] }],
      });
      return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    });
  }
  const pdfToText = extractDocText || aiExtractPdf;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS drive_sources (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, added_by TEXT NOT NULL DEFAULT '',
      file_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
      name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
      watch INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
      last_synced TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE(entity_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS drive_files (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, source_id TEXT NOT NULL,
      file_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'doc', text TEXT NOT NULL DEFAULT '', chars INTEGER NOT NULL DEFAULT 0,
      upload_id TEXT NOT NULL DEFAULT '',
      modified_time TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok', error TEXT NOT NULL DEFAULT '',
      UNIQUE(entity_id, file_id)
    );
    CREATE INDEX IF NOT EXISTS idx_drive_files_entity ON drive_files(entity_id, kind);
  `);
  const now = () => new Date().toISOString();

  // ── connection: one-click OAuth (preferred) → client SA key → platform env ──
  // OAuth stores a per-entity refresh token (sealed) from the "Connect with
  // Google" flow (drive.file scope — the app only sees files picked/granted).
  // The service-account share-with-email path stays as the robust fallback.
  const oauthApp = () => ({
    clientId: (db.getSetting ? db.getSetting('google_oauth_client_id', '') : '') || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: (db.getSetting ? db.getSetting('google_oauth_client_secret', '') : '') || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    apiKey: (db.getSetting ? db.getSetting('google_api_key', '') : '') || process.env.GOOGLE_API_KEY || '', // the Picker's developerKey
  });
  function connection(entityId) {
    const i = entityId ? db.getEntityIntegrations(entityId) : {};
    const app = oauthApp();
    if (i.googleOauthRefreshToken && app.clientId && app.clientSecret) {
      return { mode: 'oauth', email: i.googleOauthEmail || '', refreshToken: i.googleOauthRefreshToken, entityId };
    }
    const stored = i.googleServiceAccountSecret || '';
    const sa = parseServiceAccount(stored) || parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '');
    return sa ? { mode: 'sa', ...sa, envFallback: !stored } : null;
  }

  // Access-token cache: SA tokens key on the SA email (clients may share the env
  // key); OAuth tokens key on the entity.
  const tokens = new Map(); // key → { token, exp }
  async function tokenGrant(params) {
    const res = await doFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) { const e = new Error(data.error_description || data.error || `Google auth failed (${res.status})`); e.googleError = data.error; throw e; }
    return data;
  }
  async function accessToken(conn) {
    const key = conn.mode === 'oauth' ? `oauth:${conn.entityId}` : `sa:${conn.email}`;
    const hit = tokens.get(key);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    let data;
    if (conn.mode === 'oauth') {
      const app = oauthApp();
      try {
        data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: conn.refreshToken, client_id: app.clientId, client_secret: app.clientSecret });
      } catch (e) {
        if (e.googleError === 'invalid_grant') { // revoked / expired → surface a reconnect, don't retry forever
          db.setEntityIntegrations(conn.entityId, { googleOauthError: 'Access was revoked or expired — reconnect Google Drive.' });
          throw new Error('Google access needs a reconnect (it was revoked or expired).');
        }
        throw e;
      }
    } else {
      data = await tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildAssertion(conn, Math.floor(Date.now() / 1000)) });
    }
    tokens.set(key, { token: data.access_token, exp: Date.now() + Math.min(Number(data.expires_in) || 3600, 3600) * 1000 });
    return data.access_token;
  }

  // ── Drive API (fixed host, hard timeouts; token in the header, never the URL) ──
  async function gapi(path, token, { asText = false, asBuffer = false } = {}) {
    const res = await doFetch(`${DRIVE}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const msg = detail?.error?.message || `Drive HTTP ${res.status}`;
      const e = new Error(res.status === 404 ? 'File not found — is it shared with the service-account email?' : msg);
      e.httpStatus = res.status;
      throw e;
    }
    if (asBuffer) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > PDF_CAP) throw new Error('File is too large (10MB max).');
      return buf;
    }
    if (asText) {
      const text = await res.text();
      if (text.length > TEXT_CAP) throw new Error('File is too large (2MB text max).');
      return text;
    }
    return res.json();
  }
  const FIELDS = 'id,name,mimeType,modifiedTime';
  const getMeta = (token, id) => gapi(`files/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`, token);
  const exportText = (token, id, mime) => gapi(`files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`, token, { asText: true });
  const downloadText = (token, id) => gapi(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, token, { asText: true });
  const downloadBuffer = (token, id) => gapi(`files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, token, { asBuffer: true });
  async function listFolder(token, id) {
    const files = []; let pageToken = '';
    do {
      const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
      const page = await gapi(`files?q=${q}&fields=nextPageToken,files(${FIELDS})&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, token);
      files.push(...(page.files || []));
      pageToken = page.nextPageToken || '';
    } while (pageToken && files.length < FOLDER_FILE_CAP);
    return files.slice(0, FOLDER_FILE_CAP);
  }

  // ── statements ──
  const srcIns = sql.prepare('INSERT INTO drive_sources (id,entity_id,added_by,file_id,kind,name,mime,watch,status,error,last_synced,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const srcGet = sql.prepare('SELECT * FROM drive_sources WHERE id=?');
  const srcByFile = sql.prepare('SELECT * FROM drive_sources WHERE entity_id=? AND file_id=?');
  const srcList = sql.prepare('SELECT * FROM drive_sources WHERE entity_id=? ORDER BY created_at DESC');
  const srcUpd = sql.prepare('UPDATE drive_sources SET name=?, mime=?, status=?, error=?, last_synced=? WHERE id=?');
  const srcDel = sql.prepare('DELETE FROM drive_sources WHERE id=?');
  const fGet = sql.prepare('SELECT * FROM drive_files WHERE entity_id=? AND file_id=?');
  const fBySource = sql.prepare('SELECT * FROM drive_files WHERE source_id=?');
  const fIns = sql.prepare('INSERT INTO drive_files (id,entity_id,source_id,file_id,name,mime,kind,text,chars,upload_id,modified_time,synced_at,status,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const fUpd = sql.prepare('UPDATE drive_files SET name=?, mime=?, kind=?, text=?, chars=?, upload_id=?, modified_time=?, synced_at=?, status=?, error=? WHERE id=?');
  const fDel = sql.prepare('DELETE FROM drive_files WHERE id=?');
  const fDocs = sql.prepare("SELECT * FROM drive_files WHERE entity_id=? AND kind='doc' AND status='ok' ORDER BY synced_at DESC");

  // owl_uploads is owned by owlUploads.js (mounted before this module) — we only
  // write 'drive'-sourced rows into it so askUpload sees Drive Sheets like any upload.
  const upFind = () => sql.prepare("SELECT id FROM owl_uploads WHERE entity_id=? AND source='drive' AND sheet_url=?");
  const upIns = () => sql.prepare('INSERT INTO owl_uploads (id,entity_id,user_id,name,source,sheet_url,columns,rows,row_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const upUpd = () => sql.prepare('UPDATE owl_uploads SET name=?, columns=?, rows=?, row_count=?, updated_at=? WHERE id=?');
  const upDel = () => sql.prepare('DELETE FROM owl_uploads WHERE id=?');

  // ── sync one file (table/doc/pdf) under a source ──
  async function syncFile(token, entityId, sourceId, meta) {
    const t = kindOf(meta.mimeType);
    if (!t || t.kind === 'folder') return { skipped: 'unsupported' };
    const existing = fGet.get(entityId, meta.id);
    if (existing && existing.status === 'ok' && existing.modified_time === (meta.modifiedTime || '') && existing.kind !== 'error') return { skipped: 'unchanged' };
    const ts = now();
    const save = (patch) => {
      const cur = fGet.get(entityId, meta.id);
      const v = { name: meta.name || '', mime: meta.mimeType || '', kind: t.kind === 'pdf' ? 'doc' : t.kind, text: '', chars: 0, uploadId: cur?.upload_id || '', modified: meta.modifiedTime || '', status: 'ok', error: '', ...patch };
      if (cur) fUpd.run(v.name, v.mime, v.kind, v.text, v.chars, v.uploadId, v.modified, ts, v.status, v.error, cur.id);
      else fIns.run(crypto.randomUUID(), entityId, sourceId, meta.id, v.name, v.mime, v.kind, v.text, v.chars, v.uploadId, v.modified, ts, v.status, v.error);
    };
    try {
      if (t.kind === 'table') {
        const csv = t.export ? await exportText(token, meta.id, t.export) : await downloadText(token, meta.id);
        const { columns, rows } = require('./owlUploads').tableFromCsv(csv);
        if (!columns.length) throw new Error("Couldn't read any columns.");
        const ref = `drive:${meta.id}`;
        const hit = upFind().get(entityId, ref);
        let uploadId = hit?.id;
        if (uploadId) upUpd().run(String(meta.name || 'Drive sheet').slice(0, 120), JSON.stringify(columns), JSON.stringify(rows), rows.length, ts, uploadId);
        else { uploadId = crypto.randomUUID(); upIns().run(uploadId, entityId, 'drive', String(meta.name || 'Drive sheet').slice(0, 120), 'drive', ref, JSON.stringify(columns), JSON.stringify(rows), rows.length, ts, ts); }
        save({ uploadId, text: '', chars: rows.length });
      } else if (t.kind === 'doc') {
        const text = (t.export ? await exportText(token, meta.id, t.export) : await downloadText(token, meta.id)).slice(0, DOC_STORE_CAP);
        save({ text, chars: text.length });
      } else if (t.kind === 'pdf') {
        const buf = await downloadBuffer(token, meta.id);
        const text = String(await pdfToText({ pdfBase64: buf.toString('base64'), entityId }) || '').slice(0, DOC_STORE_CAP);
        if (!text.trim()) throw new Error('No text could be extracted from the PDF.');
        save({ text, chars: text.length });
      }
      return { ok: true };
    } catch (e) {
      save({ status: 'error', error: String(e.message || e).slice(0, 300) });
      return { error: e.message };
    }
  }

  // Remove a stored file row + its linked upload table.
  function dropFileRow(row) {
    if (row.upload_id) { try { upDel().run(row.upload_id); } catch { /* table may be gone */ } }
    fDel.run(row.id);
  }

  // ── sync a source (file or folder). Never throws — records status on the row. ──
  async function syncSource(src) {
    try {
      const sa = connection(src.entity_id);
      if (!sa) throw new Error('Google Drive is not connected for this client.');
      const token = await accessToken(sa);
      if (src.kind === 'folder') {
        const children = await listFolder(token, src.file_id);
        const seen = new Set();
        let errors = 0;
        for (const child of children) {
          const t = kindOf(child.mimeType);
          if (!t || t.kind === 'folder') continue; // no recursion — keep the surface explicit
          seen.add(child.id);
          const r = await syncFile(token, src.entity_id, src.id, child);
          if (r.error) errors++;
        }
        for (const row of fBySource.all(src.id)) if (!seen.has(row.file_id)) dropFileRow(row); // unshared/removed → forget it
        srcUpd.run(src.name, src.mime, errors ? 'partial' : 'ok', errors ? `${errors} file(s) failed — see the file list` : '', now(), src.id);
      } else {
        const meta = await getMeta(token, src.file_id);
        const r = await syncFile(token, src.entity_id, src.id, meta);
        const fileRow = fGet.get(src.entity_id, src.file_id);
        srcUpd.run(meta.name || src.name, meta.mimeType || src.mime, r.error ? 'error' : (r.skipped === 'unsupported' ? 'unsupported' : 'ok'), r.error || (r.skipped === 'unsupported' ? 'This file type isn\'t supported — Sheets, Docs, Slides, CSV, text and PDF are.' : (fileRow?.error || '')), now(), src.id);
      }
    } catch (e) {
      srcUpd.run(src.name, src.mime, 'error', String(e.message || e).slice(0, 300), now(), src.id);
    }
    return srcGet.get(src.id);
  }

  // ── views ──
  const srcView = (r) => ({ id: r.id, fileId: r.file_id, kind: r.kind, name: r.name, mime: r.mime, watch: !!r.watch, status: r.status, error: r.error, lastSynced: r.last_synced, files: r.kind === 'folder' ? fBySource.all(r.id).map(fileView) : undefined });
  const fileView = (r) => ({ id: r.id, fileId: r.file_id, name: r.name, mime: r.mime, kind: r.kind, chars: r.chars, rowCount: r.kind === 'table' ? r.chars : undefined, status: r.status, error: r.error, syncedAt: r.synced_at });
  function view(entityId) {
    const conn = connection(entityId);
    const i = db.getEntityIntegrations(entityId);
    const app = oauthApp();
    return {
      configured: !!conn,
      mode: conn ? conn.mode : '',
      saEmail: conn && conn.mode === 'sa' ? conn.email : '',
      envFallback: conn && conn.mode === 'sa' ? !!conn.envFallback : false,
      keySet: !!(i.googleServiceAccountSecret || '').trim(),
      oauth: {
        available: !!(app.clientId && app.clientSecret),
        connected: !!(i.googleOauthRefreshToken || '').trim(),
        email: i.googleOauthEmail || '',
        error: i.googleOauthError || '',
        pickerKey: app.apiKey, // browser key for the Google Picker (public by design)
        clientId: app.clientId,
      },
      sources: srcList.all(entityId).map(srcView),
    };
  }

  // ── route handlers (shared by both surfaces) ──
  async function addSource(entityId, userId, body, res) {
    const parsed = body.fileId ? { fileId: String(body.fileId) } : parseLink(body.link); // Picker passes the id directly
    if (!parsed) return res.status(400).json({ error: 'Paste a Google Drive / Docs / Sheets link (or a folder link).' });
    const conn = connection(entityId);
    if (!conn) return res.status(400).json({ error: 'Connect Google Drive first.' });
    if (srcByFile.get(entityId, parsed.fileId)) return res.status(400).json({ error: 'That file is already added.' });
    let meta;
    try { meta = await getMeta(await accessToken(conn), parsed.fileId); }
    catch (e) {
      const hint = conn.mode === 'oauth' ? 'Use "Pick files" to grant access to it (pasted links only work for files already picked).' : `Share it with ${conn.email} and try again.`;
      return res.status(400).json({ error: `${e.message} ${hint}` });
    }
    const isFolder = meta.mimeType === 'application/vnd.google-apps.folder';
    const id = crypto.randomUUID();
    srcIns.run(id, entityId, userId || '', meta.id, isFolder ? 'folder' : 'file', meta.name || '', meta.mimeType || '', isFolder && body.watch !== false ? 1 : 0, 'pending', '', '', now());
    await syncSource(srcGet.get(id));
    res.json({ ok: true, ...view(entityId) });
  }
  async function saveKey(entityId, body, res) {
    if (body.clear) { db.setEntityIntegrations(entityId, { googleServiceAccountSecret: '' }); return res.json({ ok: true, ...view(entityId) }); }
    const sa = parseServiceAccount(body.serviceAccountJson);
    if (!sa) return res.status(400).json({ error: 'That doesn\'t look like a Google service-account JSON key (needs client_email + private_key).' });
    db.setEntityIntegrations(entityId, { googleServiceAccountSecret: String(body.serviceAccountJson) });
    tokens.delete(sa.email);
    res.json({ ok: true, ...view(entityId) });
  }
  async function syncOne(entityId, sid, res) {
    const src = srcGet.get(sid);
    if (!src || src.entity_id !== entityId) return res.status(404).json({ error: 'Not found.' });
    await syncSource(src);
    res.json({ ok: true, ...view(entityId) });
  }
  function updateSource(entityId, sid, body, res) {
    const src = srcGet.get(sid);
    if (!src || src.entity_id !== entityId) return res.status(404).json({ error: 'Not found.' });
    if (body.watch != null) sql.prepare('UPDATE drive_sources SET watch=? WHERE id=?').run(body.watch ? 1 : 0, sid);
    res.json({ ok: true, ...view(entityId) });
  }
  function removeSource(entityId, sid, res) {
    const src = srcGet.get(sid);
    if (!src || src.entity_id !== entityId) return res.status(404).json({ error: 'Not found.' });
    for (const row of fBySource.all(sid)) dropFileRow(row);
    srcDel.run(sid);
    res.json({ ok: true, ...view(entityId) });
  }

  // ── routes: admin + client self-service (dual-surface rule) ──
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'Something went wrong.' }) && console.error('[drive]', e.message));
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  const manage = (req, res, next) => auth.requirePermission('integrations.manage')(req, res, next);

  app.get('/api/admin/entities/:entityId/drive', auth.requireAdmin, (req, res) => res.json(view(req.params.entityId)));
  app.put('/api/admin/entities/:entityId/drive/key', auth.requireAdmin, wrap((req, res) => saveKey(req.params.entityId, req.body || {}, res)));
  app.post('/api/admin/entities/:entityId/drive/sources', auth.requireAdmin, wrap((req, res) => addSource(req.params.entityId, req.user?.id, req.body || {}, res)));
  app.post('/api/admin/entities/:entityId/drive/sources/:sid/sync', auth.requireAdmin, wrap((req, res) => syncOne(req.params.entityId, req.params.sid, res)));
  app.put('/api/admin/entities/:entityId/drive/sources/:sid', auth.requireAdmin, (req, res) => updateSource(req.params.entityId, req.params.sid, req.body || {}, res));
  app.delete('/api/admin/entities/:entityId/drive/sources/:sid', auth.requireAdmin, (req, res) => removeSource(req.params.entityId, req.params.sid, res));

  app.get('/api/my/drive/:entityId', auth.requireAuth, myEntity, (req, res) => res.json(view(req.params.entityId)));
  app.put('/api/my/drive/:entityId/key', auth.requireAuth, myEntity, manage, wrap((req, res) => saveKey(req.params.entityId, req.body || {}, res)));
  app.post('/api/my/drive/:entityId/sources', auth.requireAuth, myEntity, manage, wrap((req, res) => addSource(req.params.entityId, req.user?.id, req.body || {}, res)));
  app.post('/api/my/drive/:entityId/sources/:sid/sync', auth.requireAuth, myEntity, manage, wrap((req, res) => syncOne(req.params.entityId, req.params.sid, res)));
  app.put('/api/my/drive/:entityId/sources/:sid', auth.requireAuth, myEntity, manage, (req, res) => updateSource(req.params.entityId, req.params.sid, req.body || {}, res));
  app.delete('/api/my/drive/:entityId/sources/:sid', auth.requireAuth, myEntity, manage, (req, res) => removeSource(req.params.entityId, req.params.sid, res));

  // ── One-click OAuth ("Connect with Google", drive.file scope) ─────────────────
  // The Picker-first flow: the app only ever sees files the user explicitly picks
  // (non-sensitive scope — no Google verification ordeal). Platform app config:
  // settings google_oauth_client_id / google_oauth_client_secret / google_api_key
  // (or env GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_API_KEY).
  // Register the redirect URI <base>/api/drive/oauth/callback on the OAuth client.
  const oauthState = require('./oauthState');
  oauthState.init({ db });
  const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const redirectUri = (req) => `${baseUrl(req)}/api/drive/oauth/callback`;
  const safeReturn = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/settings?section=integrations');

  function oauthStart(entityId, req, res) {
    const app2 = oauthApp();
    if (!app2.clientId || !app2.clientSecret) return res.status(400).json({ error: 'Google connect isn\'t configured on the platform yet (OAuth client id/secret).' });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', app2.clientId);
    u.searchParams.set('redirect_uri', redirectUri(req));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file openid email');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent'); // guarantees a refresh_token on re-connects
    u.searchParams.set('state', oauthState.sign({ t: 'gdrive', entityId, userId: req.user.id, ret: safeReturn(req.query.ret) }));
    res.json({ url: u.toString() });
  }
  app.get('/api/my/drive/:entityId/oauth/start', auth.requireAuth, myEntity, manage, (req, res) => oauthStart(req.params.entityId, req, res));
  app.get('/api/admin/entities/:entityId/drive/oauth/start', auth.requireAdmin, (req, res) => oauthStart(req.params.entityId, req, res));

  app.get('/api/drive/oauth/callback', auth.requireAuth, wrap(async (req, res) => {
    const st = oauthState.verify(req.query.state);
    if (!st || st.t !== 'gdrive' || st.userId !== req.user.id) return res.status(400).send('This connect link expired — go back to Settings and try again.');
    if (!(req.user.role === 'admin' || (req.user.entityIds || []).includes(st.entityId))) return res.status(403).send('Not your client.');
    if (req.query.error) return res.redirect(302, `${safeReturn(st.ret)}${st.ret.includes('?') ? '&' : '?'}drive=denied`);
    const app2 = oauthApp();
    const data = await tokenGrant({ grant_type: 'authorization_code', code: String(req.query.code || ''), client_id: app2.clientId, client_secret: app2.clientSecret, redirect_uri: redirectUri(req) });
    let email = '';
    try { email = JSON.parse(Buffer.from(String(data.id_token || '').split('.')[1] || '', 'base64url').toString()).email || ''; } catch { /* display-only */ }
    if (!data.refresh_token) return res.status(400).send('Google didn\'t return a durable grant — remove the app at https://myaccount.google.com/permissions and connect again.');
    db.setEntityIntegrations(st.entityId, { googleOauthRefreshToken: data.refresh_token, googleOauthEmail: email, googleOauthError: '' });
    tokens.delete(`oauth:${st.entityId}`);
    res.redirect(302, `${safeReturn(st.ret)}${st.ret.includes('?') ? '&' : '?'}drive=connected`);
  }));

  // Short-lived access token for the Google Picker (drive.file scope; the Picker
  // browses as the CONNECTED account and only picked files reach the server).
  async function pickerToken(entityId, res) {
    const conn = connection(entityId);
    if (!conn || conn.mode !== 'oauth') return res.status(400).json({ error: 'Connect with Google first.' });
    res.json({ accessToken: await accessToken(conn), apiKey: oauthApp().apiKey, email: conn.email });
  }
  app.get('/api/my/drive/:entityId/oauth/picker-token', auth.requireAuth, myEntity, manage, wrap((req, res) => pickerToken(req.params.entityId, res)));
  app.get('/api/admin/entities/:entityId/drive/oauth/picker-token', auth.requireAdmin, wrap((req, res) => pickerToken(req.params.entityId, res)));

  function oauthDisconnect(entityId, res) {
    db.setEntityIntegrations(entityId, { googleOauthRefreshToken: '', googleOauthEmail: '', googleOauthError: '' });
    tokens.delete(`oauth:${entityId}`);
    res.json({ ok: true, ...view(entityId) });
  }
  app.post('/api/my/drive/:entityId/oauth/disconnect', auth.requireAuth, myEntity, manage, (req, res) => oauthDisconnect(req.params.entityId, res));
  app.post('/api/admin/entities/:entityId/drive/oauth/disconnect', auth.requireAdmin, (req, res) => oauthDisconnect(req.params.entityId, res));

  // ── P3: the background tick. Watched folders re-sync hourly; everything else
  // refreshes every 6h (cheap: unchanged files short-circuit on modifiedTime).
  // Kill switch: setting drive_sync_enabled = '0'.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    if (db.getSetting && db.getSetting('drive_sync_enabled', '1') === '0') return;
    ticking = true;
    try {
      const cutHour = new Date(Date.now() - 55 * 60_000).toISOString();
      const cut6h = new Date(Date.now() - 6 * 3600_000).toISOString();
      const due = sql.prepare(`SELECT * FROM drive_sources WHERE (kind='folder' AND watch=1 AND (last_synced='' OR last_synced < ?)) OR (last_synced='' OR last_synced < ?) ORDER BY last_synced ASC LIMIT 10`).all(cutHour, cut6h);
      for (const src of due) await syncSource(src);
    } catch (e) { console.error('[drive] tick failed:', e.message); }
    ticking = false;
  }
  if (startTimer) { const timer = setInterval(() => tick().catch(() => {}), 10 * 60_000); timer.unref?.(); }

  // ── the Owl's read API (consumed by owlTools searchDriveDocs / readDriveDoc) ──
  function listDocs(entityId) { return fDocs.all(entityId).map((r) => ({ id: r.id, name: r.name, mime: r.mime, chars: r.chars, syncedAt: r.synced_at })); }
  function searchDocs(entityId, q) {
    const needle = String(q || '').toLowerCase().trim();
    const out = [];
    for (const r of fDocs.all(entityId)) {
      const nameHit = r.name.toLowerCase().includes(needle);
      const idx = needle ? r.text.toLowerCase().indexOf(needle) : -1;
      if (!needle || nameHit || idx >= 0) {
        out.push({ id: r.id, name: r.name, mime: r.mime, chars: r.chars, syncedAt: r.synced_at, snippet: idx >= 0 ? r.text.slice(Math.max(0, idx - 120), idx + 180).replace(/\s+/g, ' ').trim() : r.text.slice(0, 180).replace(/\s+/g, ' ').trim() });
      }
      if (out.length >= 12) break;
    }
    return out;
  }
  function readDoc(entityId, { docId, name, offset = 0 } = {}) {
    let row = null;
    if (docId) { const r = sql.prepare('SELECT * FROM drive_files WHERE id=?').get(docId); if (r && r.entity_id === entityId) row = r; }
    if (!row && name) row = fDocs.all(entityId).find((r) => r.name.toLowerCase().includes(String(name).toLowerCase())) || null;
    if (!row) return null;
    const start = Math.max(0, Number(offset) || 0);
    const chunk = row.text.slice(start, start + READ_CHUNK);
    return { id: row.id, name: row.name, mime: row.mime, chars: row.chars, offset: start, text: chunk, more: start + READ_CHUNK < row.text.length, nextOffset: start + READ_CHUNK < row.text.length ? start + READ_CHUNK : null };
  }

  console.log('[googleDrive] Drive connector mounted');
  return { listDocs, searchDocs, readDoc, syncSource, tick, view, connection, _internals: { accessToken, syncFile, addSource } };
}

module.exports = { mount, parseLink, parseServiceAccount, buildAssertion, kindOf, DOC_TEXT_SYSTEM };
