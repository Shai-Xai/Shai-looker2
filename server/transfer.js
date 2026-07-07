// Full backup / restore: export the whole DB to JSON, import to replace it.
// A factory over the shared better-sqlite3 handle (see server/db.js) — kept out
// of db.js so that file stays a thin data-access layer.
//
// Export enumerates EVERY table (from sqlite_master) → complete by construction,
// never drifts as new feature tables are added. Excluded: 2FA/OAuth secrets
// (tied to this box's key/callbacks) + backup_runs (this disk's own history).
const EXPORT_EXCLUDE = new Set(['user_2fa', 'user_2fa_backup', 'oauth_codes', 'oauth_clients', 'backup_runs']);

module.exports = function makeTransfer(db, now) {
  function exportableTables() {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map((r) => r.name).filter((n) => !EXPORT_EXCLUDE.has(n)).sort();
  }
  function exportAll() {
    const out = { _version: 2, exportedAt: now() };
    for (const t of exportableTables()) out[t] = db.prepare(`SELECT * FROM ${t}`).all();
    return out;
  }
  function insertRow(name, row) {
    const valid = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    const cols = Object.keys(row).filter((c) => valid.has(c));
    if (!cols.length) return;
    const sql = `INSERT OR REPLACE INTO ${name} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    db.prepare(sql).run(...cols.map((c) => row[c]));
  }
  // Full-replace restore: FK checks off for the swap (pragma can't change inside a
  // txn, so it wraps it) → no dependency ordering needed. Only tables present in the
  // file are touched (old/partial snapshots never wipe newer tables).
  function importAll(data) {
    const tables = exportableTables().filter((t) => Array.isArray(data[t]));
    db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
        const counts = {};
        for (const t of tables) { for (const row of data[t]) insertRow(t, row); counts[t] = data[t].length; }
        return counts;
      });
      return run();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  return { exportAll, importAll };
};
