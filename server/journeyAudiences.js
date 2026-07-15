// ─── Journey audience ledger — incremental add/remove into Meta / TikTok ──────
// FACTORY (not a routes module). A journey `sync` node adds or removes INDIVIDUAL
// people to a named ad audience as they cross a branch ("non-buyers → add to
// retargeting", "buyers → remove"). But the Meta/TikTok connectors mirror a WHOLE
// membership, not a delta — so we keep each journey audience's membership here
// (per client + platform + name) and, on every add/remove, recompute the full set
// and hand it to the connector's existing `syncAudience`, which appends/deletes
// the delta on a stable audience. That reuses the battle-tested, in-production
// connector path — NO new ad-account API code — and is a safe no-op when the
// platform isn't connected. Members are the same raw {email,phone} the drip
// enrolment table already stores; the connector hashes before anything leaves.
//
//   const journeySync = require('./journeyAudiences')({ db, meta, tiktok });
//   await journeySync({ entityId, platform:'both', audienceName:'FF27 retargeting', action:'add', members });
module.exports = function createJourneyAudiences({ db, meta, tiktok }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS journey_audiences (
    entity_id  TEXT NOT NULL,
    audkey     TEXT NOT NULL,                 -- "<platform>|<audienceName>"
    members    TEXT NOT NULL DEFAULT '[]',    -- JSON [{email,phone}] currently in the audience
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity_id, audkey)
  );`);
  const read = (entityId, audkey) => { try { return JSON.parse(sql.prepare('SELECT members FROM journey_audiences WHERE entity_id=? AND audkey=?').get(entityId, audkey)?.members || '[]'); } catch { return []; } };
  const write = (entityId, audkey, members) => sql.prepare('INSERT INTO journey_audiences (entity_id,audkey,members,updated_at) VALUES (?,?,?,?) ON CONFLICT(entity_id,audkey) DO UPDATE SET members=excluded.members, updated_at=excluded.updated_at').run(entityId, audkey, JSON.stringify(members), new Date().toISOString());
  const idOf = (m) => `${String(m.email || '').trim().toLowerCase()}|${String(m.phone || '').trim()}`;
  const conns = { meta, tiktok };

  // Recompute one journey audience's membership after add/remove, then mirror it
  // to the platform via the existing connector. Best-effort per platform; a
  // connector error never throws (it would stall the journey tick).
  return async function syncAudience({ entityId, platform, audienceName, action, members = [] }) {
    const results = [];
    for (const p of platform === 'both' ? ['meta', 'tiktok'] : [platform]) {
      const conn = conns[p];
      if (!conn || !conn.isConfigured || !conn.isConfigured(entityId)) { results.push({ platform: p, skipped: 'not_connected' }); continue; }
      const audkey = `${p}|${audienceName}`;
      const byId = new Map(read(entityId, audkey).map((m) => [idOf(m), m]));
      for (const m of members) {
        if (!m || (!m.email && !m.phone)) continue;
        if (action === 'remove') byId.delete(idOf(m));
        else byId.set(idOf(m), { email: m.email || '', phone: m.phone || '' });
      }
      const next = [...byId.values()];
      write(entityId, audkey, next); // ledger commits even if the platform call fails — the next sync reconciles
      try { const r = await conn.syncAudience({ entityId, segmentId: `journey:${audienceName}`, name: audienceName, members: next, mode: 'replace', by: 'journey' }); results.push({ platform: p, ok: !!(r && r.ok), members: next.length }); }
      catch (e) { results.push({ platform: p, error: e.message, members: next.length }); }
    }
    return { ok: true, results };
  };
};
