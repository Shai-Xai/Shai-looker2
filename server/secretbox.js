// ─── Secrets at rest — AES-256-GCM envelope ───────────────────────────────────
// Integration credentials (Looker/Resend/Anthropic/Meta/TikTok/Clickatell/GitHub
// tokens, webhook secrets, per-client keys) used to sit PLAINTEXT in the SQLite
// `settings` table and `entities.integrations` blob — so the admin JSON export
// and the off-box DB backup were a complete credential dump. This seals those
// values so a leaked export/backup/disk is useless without the key.
//
// seal(str)  → "gcm1:<iv>:<tag>:<ct>" (all base64url). Deterministic prefix so
//              open() can tell sealed from legacy-plaintext.
// open(str)  → decrypts a sealed value; returns anything else UNCHANGED, so it's
//              safe to call on every read and on data written before this shipped
//              (backward-compatible — plaintext is migrated lazily on next write,
//              and eagerly by the boot migration in db.js).
//
// Key resolution (in order):
//   1. process.env.MASTER_KEY  — set this in Render for real at-rest protection
//      (the key then lives only in the environment, never in the DB/backup).
//   2. DATA_DIR/.master-key    — a persisted random key (auto-created). Protects
//      the export/backup (the key file is NOT in the DB, so a leaked snapshot
//      still can't be read) but not full-disk theft. Setting MASTER_KEY is better.
//
// NOTE: restoring a backup requires the SAME key (env var or .master-key file).
// This is inherent to encryption-at-rest — documented in DEPLOY.md.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'gcm1:';

let _key = null;
function key() {
  if (_key) return _key;
  const envKey = (process.env.MASTER_KEY || '').trim();
  if (envKey) {
    _key = crypto.createHash('sha256').update(envKey).digest(); // 32 bytes from any-length secret
    return _key;
  }
  const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const file = path.join(dir, '.master-key');
  try {
    _key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (_key.length === 32) return _key;
  } catch { /* not created yet */ }
  fs.mkdirSync(dir, { recursive: true });
  const raw = crypto.randomBytes(32);
  try { fs.writeFileSync(file, raw.toString('hex'), { mode: 0o600 }); } catch { /* fall through to in-memory */ }
  _key = raw;
  return _key;
}

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function seal(value) {
  const str = value == null ? '' : String(value);
  if (str === '' || isSealed(str)) return str; // don't seal blanks or double-seal
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

function open(value) {
  if (!isSealed(value)) return value; // legacy plaintext / non-secret → unchanged
  try {
    const [, iv, tag, ct] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch (e) {
    // Wrong key (e.g. restored to a new env without MASTER_KEY) or corruption.
    // Return empty rather than crash — the integration reads as "not set".
    console.error('[secretbox] failed to open a sealed value:', e.message);
    return '';
  }
}

// Field-name heuristic: which entity-integration / setting keys hold a credential.
// Generous on purpose — sealing a non-secret is harmless (open() reverses it on
// read), missing a real secret is not.
const SECRET_NAME = /secret|token|password|webhook|api_?key|access_?key|client_secret|private/i;
const isSecretName = (name) => SECRET_NAME.test(String(name || ''));

module.exports = { seal, open, isSealed, isSecretName };
