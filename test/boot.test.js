// The server must BOOT. Module tests mount features in isolation, so a broken
// composition root (a TDZ reference in a mount line, a bad require, a crash in
// any module's table setup) can pass the whole suite and still take production
// down at deploy — exactly what happened with an `aiUsage`-before-initialization
// mount arg. This spawns the real entrypoint against a throwaway DATA_DIR and
// asserts it reaches "listening" and serves HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('server/index.js boots and serves HTTP', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-boot-'));
  const port = 3900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dir, DB_FILE: path.join(dir, 'boot.db'), PORT: String(port), LOOKER_BASE_URL: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    // Wait for the listen line, failing fast if the process dies first.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`server did not report listening in time.\n--- output ---\n${out}`)), 25_000);
      child.stdout.on('data', () => { if (/running on http/i.test(out)) { clearTimeout(t); resolve(); } });
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (code ${code}) before listening.\n--- output ---\n${out}`)); });
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, 'the booted server must answer /');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r) === undefined && setTimeout(r, 2000));
  }
});
