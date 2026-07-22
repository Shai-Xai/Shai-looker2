// ─── Database backups — disposable module ─────────────────────────────────────
// The single SQLite file on the Render disk is the whole business; before this
// module existed, disk loss meant losing every entity, user, dashboard and
// settlement permanently. This module owns that risk:
//
//   • Nightly snapshot via better-sqlite3's online backup API (page-chunked, so
//     it doesn't block the event loop the way `VACUUM INTO` would), gzipped to
//     DATA_DIR/backups/pulse-<stamp>.db.gz and rotated (BACKUP_KEEP, default 3 —
//     the disk is small; the gzip typically shrinks the DB 4-10×).
//   • OFF-BOX copy when S3-compatible credentials are configured (Cloudflare R2 /
//     AWS S3 / Backblaze B2 — hand-rolled SigV4, zero new dependencies). Local
//     rotation alone survives redeploys but NOT disk loss — set the env vars.
//   • Admin surface: GET /api/admin/backups (status + history), POST .../run
//     (take one now), GET .../download (stream the latest snapshot — a manual
//     off-box copy for admins even before S3 is set up).
//   • Every run recorded in backup_runs (bounded); failures raised through the
//     injected notifyOps hook so a broken backup never fails silently.
//
// Env (set in Render → Environment; all optional except where noted):
//   BACKUP_ENABLED     default '1' — set '0' to kill-switch the nightly run
//   BACKUP_HOUR_UTC    default 1   (03:00 SAST — quiet hour)
//   BACKUP_KEEP        default 3   local snapshots kept on the disk
//   BACKUP_S3_ENDPOINT e.g. https://<accountid>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET   bucket name (path-style: <endpoint>/<bucket>/<key>)
//   BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY
//   BACKUP_S3_REGION   default 'auto' (R2); use the real region for AWS S3
//   BACKUP_S3_PREFIX   optional key prefix, e.g. 'pulse/'
//
// Self-owned: drop this file + the backup_runs table to fully uninstall.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

let db = null;
let notifyOps = (msg) => console.error('[backup]', msg);

const cfg = () => ({
  enabled: process.env.BACKUP_ENABLED !== '0',
  hourUtc: Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR_UTC ?? 1) || 0)),
  keep: Math.min(30, Math.max(1, Number(process.env.BACKUP_KEEP ?? 3) || 3)),
  s3: {
    endpoint: (process.env.BACKUP_S3_ENDPOINT || '').trim().replace(/\/+$/, ''),
    bucket: (process.env.BACKUP_S3_BUCKET || '').trim(),
    accessKey: (process.env.BACKUP_S3_ACCESS_KEY || '').trim(),
    secretKey: (process.env.BACKUP_S3_SECRET_KEY || '').trim(),
    region: (process.env.BACKUP_S3_REGION || 'auto').trim(),
    prefix: (process.env.BACKUP_S3_PREFIX || '').trim().replace(/^\/+/, ''),
  },
});
const s3Configured = (c = cfg()) => !!(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey);

const backupDir = () => {
  const dir = path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function init(deps) {
  db = deps.db;
  if (deps.notifyOps) notifyOps = deps.notifyOps;
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      at       TEXT NOT NULL,
      status   TEXT NOT NULL,             -- ok | error
      trigger  TEXT NOT NULL DEFAULT '',  -- nightly | boot | manual
      file     TEXT NOT NULL DEFAULT '',
      bytes    INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0, -- 1 = off-box copy succeeded
      detail   TEXT NOT NULL DEFAULT ''
    );
  `);
}

function recordRun(row) {
  try {
    db.db.prepare('INSERT INTO backup_runs (at, status, trigger, file, bytes, uploaded, detail) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), row.status, row.trigger || '', row.file || '', row.bytes || 0, row.uploaded ? 1 : 0, String(row.detail || '').slice(0, 500));
    db.db.prepare('DELETE FROM backup_runs WHERE id NOT IN (SELECT id FROM backup_runs ORDER BY id DESC LIMIT 50)').run();
  } catch { /* history must never break a backup */ }
}

const listLocal = () => fs.readdirSync(backupDir())
  .filter((f) => /^pulse-.*\.db\.gz$/.test(f))
  .sort()
  .reverse()
  .map((f) => { const st = fs.statSync(path.join(backupDir(), f)); return { file: f, bytes: st.size, at: st.mtime.toISOString() }; });

function rotate(keep) {
  for (const b of listLocal().slice(keep)) {
    try { fs.unlinkSync(path.join(backupDir(), b.file)); } catch { /* best effort */ }
  }
}

// ── SigV4 (S3 PUT, UNSIGNED-PAYLOAD over HTTPS) ──
// Minimal, dependency-free signer — enough for a single PutObject. Exported for
// tests as _sigv4.
function sigv4({ method, host, pathName, region, accessKey, secretKey, amzDate, contentSha = 'UNSIGNED-PAYLOAD' }) {
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [
    method, pathName, '',
    `host:${host}\nx-amz-content-sha256:${contentSha}\nx-amz-date:${amzDate}\n`,
    signedHeaders, contentSha,
  ].join('\n');
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
  };
}

// PUT one local file to the configured bucket. Streams from disk (no buffering —
// we run on 512 MB). Resolves { key } or throws with a client-safe message.
function uploadToS3(localPath, key, c = cfg()) {
  const url = new URL(`${c.s3.endpoint}/${encodeURIComponent(c.s3.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const { authorization } = sigv4({
    method: 'PUT', host: url.host, pathName: url.pathname, region: c.s3.region,
    accessKey: c.s3.accessKey, secretKey: c.s3.secretKey, amzDate,
  });
  const size = fs.statSync(localPath).size;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'PUT', host: url.hostname, port: url.port || 443, path: url.pathname,
      headers: {
        Authorization: authorization,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'Content-Type': 'application/gzip',
        'Content-Length': size,
      },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 2000) body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ key });
        else reject(new Error(`S3 upload failed: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('S3 upload timed out')));
    req.on('error', reject);
    fs.createReadStream(localPath).on('error', reject).pipe(req);
  });
}

// ── the backup itself ──
let running = false;
async function runBackup(trigger = 'manual') {
  if (running) return { ok: false, error: 'A backup is already running' };
  running = true;
  const c = cfg();
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
  const raw = path.join(backupDir(), `pulse-${stamp}.db`);
  const gz = `${raw}.gz`;
  try {
    // Refuse to fill the disk: need roughly the DB's size free for the raw copy.
    const dbSize = fs.statSync(db.db.name).size;
    try {
      const st = await fs.promises.statfs(backupDir());
      if (st.bavail * st.bsize < dbSize * 1.2) throw new Error(`not enough free disk for a snapshot (need ~${Math.ceil(dbSize / 1e6)} MB)`);
    } catch (e) { if (/free disk/.test(e.message)) throw e; /* statfs unsupported — proceed */ }

    await db.db.backup(raw); // online, page-chunked — safe under WAL, no long block
    await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz));
    fs.unlinkSync(raw);
    const bytes = fs.statSync(gz).size;
    rotate(c.keep);

    let uploaded = false, detail = '';
    if (s3Configured(c)) {
      const key = `${c.s3.prefix ? `${c.s3.prefix.replace(/\/+$/, '')}/` : ''}${path.basename(gz)}`;
      await uploadToS3(gz, key, c);
      uploaded = true;
      detail = `uploaded s3://${c.s3.bucket}/${key}`;
    } else {
      detail = 'no off-box storage configured — local snapshot only';
      // The snapshot lives on the SAME disk as the database, so it does not
      // survive disk loss. Say so loudly on every automatic run — this state
      // must never sit quietly reporting "ok" (production-readiness F1).
      if (trigger !== 'manual') {
        notifyOps('Nightly backup ran LOCAL-ONLY — off-box storage (BACKUP_S3_*) is not configured, so disk loss is still total data loss. See docs/BACKUP_SETUP_RUNBOOK.md.');
      }
    }
    recordRun({ status: 'ok', trigger, file: path.basename(gz), bytes, uploaded, detail });
    return { ok: true, file: path.basename(gz), bytes, uploaded };
  } catch (e) {
    try { fs.existsSync(raw) && fs.unlinkSync(raw); } catch { /* cleanup */ }
    recordRun({ status: 'error', trigger, detail: e.message });
    notifyOps(`Database backup FAILED (${trigger}): ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
}

const lastSuccess = () => {
  try { return db.db.prepare("SELECT at FROM backup_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").get()?.at || null; } catch { return null; }
};

// ── nightly tick ──
// Checks every 10 min; runs once per UTC day at/after BACKUP_HOUR_UTC. A boot
// check also runs when the last success is >26h old (catches missed nights —
// deploys, downtime). Single instance, so an in-process flag is sufficient.
function due() {
  const c = cfg();
  if (!c.enabled) return false;
  const now = new Date();
  if (now.getUTCHours() < c.hourUtc) return false;
  const last = lastSuccess();
  return !last || last.slice(0, 10) !== now.toISOString().slice(0, 10);
}

function status() {
  const c = cfg();
  return {
    enabled: c.enabled,
    hourUtc: c.hourUtc,
    keep: c.keep,
    offBoxConfigured: s3Configured(c),
    atRisk: !s3Configured(c),
    warning: s3Configured(c) ? '' : 'Snapshots are stored on the SAME disk as the database — disk loss is total data loss. Set the BACKUP_S3_* env vars in Render (docs/BACKUP_SETUP_RUNBOOK.md).',
    lastSuccessAt: lastSuccess(),
    local: listLocal(),
    runs: db.db.prepare('SELECT at, status, trigger, file, bytes, uploaded, detail FROM backup_runs ORDER BY id DESC LIMIT 20').all(),
  };
}

function mount(app, deps) {
  const { auth } = deps;
  const { asyncHandler } = require('./http');
  init(deps);

  // Backup status is viewable by any Howler admin; taking one and downloading a
  // snapshot (a full copy of the DB — same trust level as /api/admin/export) is
  // Super-Admin-only.
  app.get('/api/admin/backups', auth.requireAdmin, (_req, res) => res.json(status()));
  app.post('/api/admin/backups/run', auth.requireSuperAdmin, asyncHandler(async (_req, res) => {
    res.json(await runBackup('manual'));
  }));
  // Manual off-box copy: stream the newest snapshot to the admin's machine.
  // (Contains everything the DB contains — same trust level as /api/admin/export.)
  app.get('/api/admin/backups/download', auth.requireSuperAdmin, (_req, res) => {
    const [latest] = listLocal();
    if (!latest) return res.status(404).json({ error: 'No backup taken yet — run one first' });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${latest.file}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(path.join(backupDir(), latest.file)).pipe(res);
  });

  const timer = setInterval(() => { if (due()) runBackup('nightly').catch(() => {}); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(() => {
    const last = lastSuccess();
    const stale = !last || (Date.now() - Date.parse(last)) > 26 * 3600 * 1000;
    if (cfg().enabled && stale) runBackup('boot').catch(() => {});
  }, 30000).unref?.();

  return module.exports;
}

module.exports = { mount, init, runBackup, status, due, listLocal, _sigv4: sigv4, _uploadToS3: uploadToS3 };
