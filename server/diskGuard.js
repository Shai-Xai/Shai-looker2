// ─── Disk watchdog — disposable module ─────────────────────────────────────────
// The whole platform lives on one small persistent disk (SQLite + attachments +
// backups). A FULL disk used to fail silently: /health only does a read (reads
// still succeed at 100%), so writes would start throwing SQLITE_FULL while the
// service stayed "healthy". This module polls statfs(DATA_DIR) every 10 minutes:
//   ≥ 80%  → ops alert (max once per 6h while it persists — fix it this week)
//   ≥ 95%  → critical: /health goes 500 so Render flags/recycles the service
//            and the failure is LOUD (fix it today)
// status() is consumed by /health and the admin backups panel.

const fs = require('fs');

const WARN_PCT = 0.80;
const CRIT_PCT = 0.95;
const CHECK_MS = 10 * 60 * 1000;
const REALERT_MS = 6 * 60 * 60 * 1000;

let state = { usedPct: 0, freeBytes: 0, totalBytes: 0, critical: false, checkedAt: '' };
let lastWarnAt = 0;

function start({ dir, notifyOps }) {
  const check = () => {
    fs.statfs(dir, (err, s) => {
      if (err) { console.error('[diskGuard] statfs failed:', err.message); return; }
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const usedPct = total > 0 ? 1 - free / total : 0;
      state = { usedPct, freeBytes: free, totalBytes: total, critical: usedPct >= CRIT_PCT, checkedAt: new Date().toISOString() };
      if (usedPct >= WARN_PCT && Date.now() - lastWarnAt > REALERT_MS) {
        lastWarnAt = Date.now();
        const msg = `Data disk at ${(usedPct * 100).toFixed(1)}% (${(free / 1e9).toFixed(2)}GB free of ${(total / 1e9).toFixed(2)}GB)${state.critical ? ' — CRITICAL, /health now failing' : ''} — grow the disk or prune attachments/backups`;
        if (notifyOps) try { notifyOps(msg); } catch { /* alerting must never break the check */ }
        else console.error('[diskGuard]', msg);
      }
    });
  };
  check();
  const t = setInterval(check, CHECK_MS);
  if (t.unref) t.unref();
  console.log(`[diskGuard] watching ${dir} (warn ${WARN_PCT * 100}% / critical ${CRIT_PCT * 100}%)`);
}

function status() { return state; }

module.exports = { start, status };
