// Disk watchdog (server/diskGuard.js): the poll actually measures the DATA_DIR
// filesystem and exposes a sane status shape — /health consults `critical` so a
// full disk fails health instead of failing silently at SQLITE_FULL time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const diskGuard = require('../server/diskGuard');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('start() measures the filesystem and status() exposes usedPct/critical', async () => {
  diskGuard.start({ dir: os.tmpdir() });
  // statfs is async — wait for the first sample to land.
  for (let i = 0; i < 40 && !diskGuard.status().checkedAt; i++) await sleep(25);
  const s = diskGuard.status();
  assert.ok(s.checkedAt, 'first sample recorded');
  assert.ok(s.usedPct >= 0 && s.usedPct <= 1, `usedPct in [0,1], got ${s.usedPct}`);
  assert.ok(s.totalBytes > 0, 'total bytes measured');
  assert.equal(typeof s.critical, 'boolean');
  // The CI/test disk is not full — critical must be false, so /health stays green.
  assert.equal(s.critical, false);
});
