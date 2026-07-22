// ─── Data retention + background-job housekeeping — disposable module ─────────
// The platform lives on one small disk, and a handful of event tables grow one
// row per pixel hit / AI call / telemetry ping forever. This module is the one
// place time-based retention lives — a daily tick that prunes:
//
//   ai_usage        > 13 months  (13 keeps year-over-year cost dashboards whole)
//   usage_events    > 13 months  (product telemetry)
//   action_opens    > 12 months  (per-event open detail; campaign headline
//   action_clicks   > 12 months   counters live on the action row and survive)
//
// Deliberately NOT pruned here: os_attachments and settlement/document PDFs —
// that's client business data, deleting it is a product decision, not hygiene.
//
// It also sweeps for scheduled jobs stuck in `last_status 'started: …'` — the
// claim-before-send convention means a crash mid-send leaves that marker and
// MISSES the run (never double-sends); this makes the miss page a human
// instead of sitting invisible in a table.

const MONTH_MS = 30.44 * 24 * 3600e3;
const STUCK_AFTER_MS = 15 * 60 * 1000;

function mount({ db, notifyOps }) {
  const sql = db.db;
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  function prune() {
    const jobs = [
      ['ai_usage', 'created_at', 13],
      ['usage_events', 'ts', 13],
      ['action_opens', 'at', 12],
      ['action_clicks', 'at', 12],
    ];
    for (const [table, col, months] of jobs) {
      try {
        const { changes } = sql.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(iso(months * MONTH_MS));
        if (changes) console.log(`[retention] pruned ${changes} row(s) from ${table} (> ${months} months)`);
      } catch (e) { console.error(`[retention] prune ${table} failed:`, e.message); }
    }
  }

  function sweepStuckJobs() {
    try {
      // 'started: <iso>' — the timestamp rides in the status string itself.
      const rows = sql.prepare("SELECT id, name, last_status FROM scheduled_jobs WHERE last_status LIKE 'started:%'").all()
        .filter((r) => {
          const t = Date.parse(String(r.last_status).slice('started:'.length).trim());
          return Number.isFinite(t) && Date.now() - t > STUCK_AFTER_MS;
        });
      if (rows.length && notifyOps) {
        notifyOps(`${rows.length} scheduled job(s) stuck mid-send (claimed but never finished — likely killed by a deploy): ${rows.map((r) => r.name || r.id).join(', ')}. Their runs were MISSED, not duplicated; check Admin → Digests.`);
      }
    } catch { /* table may not exist yet on a fresh DB — nothing to sweep */ }
  }

  // Boot: sweep after the schedulers have had a moment to resume/settle, then
  // daily. All timers unref'd — never keep the process alive.
  const boot = setTimeout(() => { sweepStuckJobs(); prune(); }, 90 * 1000);
  if (boot.unref) boot.unref();
  const daily = setInterval(() => { prune(); sweepStuckJobs(); }, 24 * 3600e3);
  if (daily.unref) daily.unref();
  console.log('[retention] daily prune + stuck-job sweep armed');
  return { prune, sweepStuckJobs }; // exposed for tests
}

module.exports = { mount };
