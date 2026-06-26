// ─── Persisted briefing cache + background warmer ─────────────────────────────
// The home briefing is expensive (Looker facts + an LLM call) and was cached only
// in memory, so every redeploy wiped it and the first home load after a deploy
// paid the full 1-3s cost. This disposable module:
//   • Persists the finished briefing in SQLite (survives restarts) — index.js
//     serves it instantly and refreshes a stale copy in the background (SWR).
//   • Runs a warmer that, every interval, force-regenerates (fresh Looker facts +
//     AI summary, persisted) the briefings recently-active users actually load —
//     so what's served is fresh, and it never generates for inactive users.
// `last_used` tracks real serves (not warmer writes) so the warmer targets only
// active users. Factory: require('./briefingCache')({ sql, getUser, regenerate }).
// Remove that line in index.js + this file to uninstall.

module.exports = function createBriefingCache({ sql, getUser, regenerate, log = console }) {
  sql.exec(`CREATE TABLE IF NOT EXISTS briefing_cache (
    key       TEXT PRIMARY KEY,
    payload   TEXT NOT NULL,
    at        INTEGER NOT NULL,   -- when generated (ms)
    last_used INTEGER NOT NULL    -- when last served to a user (ms)
  );`);

  function get(key) {
    const r = sql.prepare('SELECT payload, at FROM briefing_cache WHERE key=?').get(key);
    if (!r) return null;
    try { return { payload: JSON.parse(r.payload), at: r.at }; } catch { return null; }
  }
  function save(key, payload) {
    const now = Date.now();
    // UPSERT: refresh payload + generated-at, but DON'T reset last_used — a warmer
    // regenerating must not look like fresh user activity.
    sql.prepare(`INSERT INTO briefing_cache (key, payload, at, last_used) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, at=excluded.at`)
      .run(key, JSON.stringify(payload), now, now);
  }
  function touch(key) { try { sql.prepare('UPDATE briefing_cache SET last_used=? WHERE key=?').run(Date.now(), key); } catch { /* best-effort */ } }

  // ── In-memory layer + stale-while-revalidate ──
  const TTL = 6 * 60 * 60 * 1000;
  const mem = new Map(); // key -> { at, val }
  // Serve a cached briefing instantly: fresh memory, else the persisted copy
  // (warming memory + refreshing in the background if it's stale). Returns the
  // payload, or null when nothing is cached anywhere (caller then generates
  // inline). `regen` is a force-regenerate thunk — coalesced by the generator.
  function serve(key, regen) {
    const m = mem.get(key);
    if (m && Date.now() - m.at < TTL) { touch(key); return m.val; }
    const saved = get(key);
    if (saved) {
      mem.set(key, { at: Date.now(), val: saved.payload });
      touch(key);
      if (Date.now() - saved.at >= TTL) regen().catch(() => {});
      return saved.payload;
    }
    return null;
  }
  function put(key, val) { mem.set(key, { at: Date.now(), val }); if (mem.size > 500) mem.delete(mem.keys().next().value); save(key, val); }
  // Invalidate a client's briefings (memory AND disk) so the next load regenerates.
  function bust(userId, entityId) {
    const prefix = `${userId}:${entityId}:`;
    for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
    try { sql.prepare("DELETE FROM briefing_cache WHERE key LIKE ?").run(`${prefix}%`); } catch { /* best-effort */ }
  }
  function clearMem() { mem.clear(); }

  // ── Warmer ──
  const INTERVAL = Number(process.env.BRIEFING_WARM_INTERVAL_MS) || 15 * 60 * 1000;
  const ACTIVE_WINDOW = Number(process.env.BRIEFING_WARM_ACTIVE_MS) || 24 * 60 * 60 * 1000;
  const PRUNE_AFTER = 30 * 24 * 60 * 60 * 1000; // drop briefings unused for 30 days
  let running = false;
  async function warm() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const keys = sql.prepare('SELECT key FROM briefing_cache WHERE last_used >= ? AND at <= ?')
        .all(now - ACTIVE_WINDOW, now - INTERVAL).map((r) => r.key);
      // Keys are `${userId}:${entityId}:${segment}[:overall:…|:events:…]` — the
      // first three colon-parts are always userId, entityId, segment (UUIDs use
      // hyphens, segment is a word). Dedupe to one regen per (user, entity,
      // segment); regenerate() handles single-vs-multi-event internally.
      const seen = new Set();
      let warmed = 0;
      for (const key of keys) {
        const [userId, entityId, segment] = key.split(':');
        if (!userId || !entityId || !segment) continue;
        const dk = `${userId}:${entityId}:${segment}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        const user = getUser(userId);
        if (!user) continue;
        try { await regenerate(user, entityId, segment); warmed += 1; } catch (e) { log.error('[brief-warm] regen failed', dk, e.message); }
      }
      if (warmed) log.log(`[brief-warm] refreshed ${warmed} briefing(s)`);
      try { sql.prepare('DELETE FROM briefing_cache WHERE last_used < ?').run(now - PRUNE_AFTER); } catch { /* best-effort */ }
    } catch (e) { log.error('[brief-warm] sweep failed', e.message); }
    finally { running = false; }
  }
  const timer = setInterval(() => warm().catch(() => {}), INTERVAL);
  if (timer.unref) timer.unref();
  setTimeout(() => warm().catch(() => {}), 60 * 1000); // once, shortly after boot

  return { get, save, touch, serve, put, bust, clearMem, warm, stop: () => clearInterval(timer) };
};
