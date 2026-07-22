// Backups: snapshot integrity, rotation, nightly-due logic, SigV4 shape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const { db, makeEntity } = require('./helpers');
const backup = require('../server/backup');

backup.init({ db, notifyOps: () => {} });
const backupDir = path.join(process.env.DATA_DIR, 'backups');

test('runBackup produces a valid, gzipped, openable snapshot of the live DB', async () => {
  makeEntity('Snapshot Co', 'Snapshot Co'); // real data the snapshot must carry
  const r = await backup.runBackup('manual');
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, false); // no S3 env in tests — local only
  const gz = path.join(backupDir, r.file);
  assert.ok(fs.existsSync(gz));

  // Restore drill: gunzip + open + read — proves the snapshot is a usable DB.
  const restored = path.join(process.env.DATA_DIR, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(gz)));
  const copy = new Database(restored, { readonly: true });
  const names = copy.prepare('SELECT name FROM entities').all().map((e) => e.name);
  copy.close();
  assert.ok(names.includes('Snapshot Co'));
});

test('backup run is recorded and reported by status()', () => {
  const s = backup.status();
  assert.equal(s.offBoxConfigured, false);
  assert.equal(s.atRisk, true); // no S3 env → the status itself must flag the risk
  assert.match(s.warning, /SAME disk/);
  assert.ok(s.lastSuccessAt);
  assert.ok(s.local.length >= 1);
  assert.equal(s.runs[0].status, 'ok');
  assert.match(s.runs[0].detail, /local snapshot only/);
});

test('an automatic local-only run raises an ops alert; a manual one stays quiet', async () => {
  const alerts = [];
  backup.init({ db, notifyOps: (m) => alerts.push(m) });
  const r = await backup.runBackup('nightly');
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /LOCAL-ONLY/);
  await backup.runBackup('manual');
  assert.equal(alerts.length, 1); // manual test runs don't spam ops
  backup.init({ db, notifyOps: () => {} });
});

test('rotation keeps only BACKUP_KEEP snapshots (oldest deleted first)', async () => {
  for (const stamp of ['2020-01-01T00-00', '2020-01-02T00-00', '2020-01-03T00-00']) {
    fs.writeFileSync(path.join(backupDir, `pulse-${stamp}.db.gz`), 'x');
  }
  process.env.BACKUP_KEEP = '2';
  try {
    const r = await backup.runBackup('manual');
    assert.equal(r.ok, true);
    const left = backup.listLocal().map((b) => b.file);
    assert.equal(left.length, 2);
    assert.ok(left.includes(r.file)); // newest survives
    assert.ok(!left.some((f) => f.includes('2020-01-01'))); // oldest gone
  } finally {
    delete process.env.BACKUP_KEEP;
  }
});

test('due(): once per UTC day, respects the kill switch', () => {
  process.env.BACKUP_HOUR_UTC = '0'; // always past the hour
  try {
    assert.equal(backup.due(), false); // a success already recorded today
    db.db.prepare("UPDATE backup_runs SET at='2020-01-01T00:00:00.000Z' WHERE status='ok'").run();
    assert.equal(backup.due(), true); // stale success → due again
    process.env.BACKUP_ENABLED = '0';
    assert.equal(backup.due(), false); // kill switch wins
  } finally {
    delete process.env.BACKUP_HOUR_UTC;
    delete process.env.BACKUP_ENABLED;
  }
});

test('SigV4 signer: correct scope/shape and deterministic', () => {
  const args = {
    method: 'PUT', host: 'acc.r2.cloudflarestorage.com', pathName: '/bucket/pulse/x.db.gz',
    region: 'auto', accessKey: 'AKIDEXAMPLE', secretKey: 'SECRET', amzDate: '20260701T010000Z',
  };
  const a = backup._sigv4(args);
  const b = backup._sigv4(args);
  assert.equal(a.authorization, b.authorization);
  assert.match(a.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260701\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  // Any input change must change the signature.
  const c = backup._sigv4({ ...args, pathName: '/bucket/pulse/y.db.gz' });
  assert.notEqual(a.authorization, c.authorization);
});
