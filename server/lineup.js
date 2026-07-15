// ─── Lineup: the event's artist/set schedule — config store ──────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `event_lineup` table and the
// /api/*/lineup routes. Mounted from index.js with one line.
//
// WHAT IT DOES: per event (suite), stores the set schedule the user uploaded —
// a list of { day, stage, artist, start, end } (start/end are 'HH:MM' local event
// time; end < start means the set runs past midnight). The Rhythm/Heat views join
// these bands with the live transaction line to show each artist's sales footprint.
// This module never reads Looker or the monitors; it is a dumb, scoped config store.
// Dual-surface: /api/admin/lineup/:suiteId (staff, any event) and
// /api/my/lineup/:suiteId (client, own events only) — same shapes.
//
// TO REMOVE: delete this file + its one-line mount; drop the event_lineup table;
// remove the Lineup editor + overlay from the client.

const MAX_SETS = 600;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/; // 24h HH:MM

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  sql.exec(`
    CREATE TABLE IF NOT EXISTS event_lineup (
      suite_id   TEXT PRIMARY KEY,
      sets       TEXT NOT NULL DEFAULT '[]', -- [{ day, stage, artist, start, end }]
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  const parse = (s, f) => { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } };
  const view = (suiteId) => {
    const r = sql.prepare('SELECT * FROM event_lineup WHERE suite_id=?').get(suiteId);
    return { sets: parse(r && r.sets, []), updatedAt: (r && r.updated_at) || '' };
  };

  // Clean + clamp a submitted set list. Rows missing an artist or a valid start are
  // dropped rather than half-stored (a band with no start can't be drawn on the line).
  const clean = (raw) => {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const s of raw.slice(0, MAX_SETS)) {
      if (!s || typeof s !== 'object') continue;
      const artist = String(s.artist ?? '').trim().slice(0, 120);
      const start = String(s.start ?? '').trim();
      if (!artist || !HHMM.test(start)) continue;
      const end = String(s.end ?? '').trim();
      out.push({
        day: String(s.day ?? '').trim().slice(0, 40),
        stage: String(s.stage ?? '').trim().slice(0, 80),
        artist, start, end: HHMM.test(end) ? end : '',
      });
    }
    return out;
  };

  function save(suiteId, body) {
    const sets = clean(body && body.sets);
    if (!sets) throw Object.assign(new Error('Expected a { sets: [...] } list'), { status: 400 });
    sql.prepare(`INSERT INTO event_lineup (suite_id, sets, updated_at) VALUES (?,?,?)
      ON CONFLICT(suite_id) DO UPDATE SET sets=excluded.sets, updated_at=excluded.updated_at`)
      .run(suiteId, JSON.stringify(sets), now());
    return view(suiteId);
  }

  const handleSave = (req, res) => {
    try { res.json(save(req.params.suiteId, req.body || {})); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the lineup' }); }
  };

  app.get('/api/admin/lineup/:suiteId', auth.requireAdmin, (req, res) => res.json(view(req.params.suiteId)));
  app.put('/api/admin/lineup/:suiteId', auth.requireAdmin, handleSave);

  const requireAuth = auth.requireAuth || auth.requireAdmin;
  const ownsSuite = (req) => { const su = db.getSuite(req.params.suiteId); if (!su) return false; return (req.user && req.user.role === 'admin') || ((req.user && req.user.entityIds) || []).includes(su.entityId); };
  app.get('/api/my/lineup/:suiteId', requireAuth, (req, res) => { if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); res.json(view(req.params.suiteId)); });
  app.put('/api/my/lineup/:suiteId', requireAuth, (req, res) => { if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); handleSave(req, res); });

  return { view, save };
}

module.exports = { mount };
