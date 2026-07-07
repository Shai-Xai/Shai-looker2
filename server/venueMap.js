// ─── Venue map: the Signal board's 🗺️ live site-plan view — config store ─────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `venue_map` table and the
// /api/*/venue-map routes. Mounted from index.js with one line.
//
// WHAT IT DOES: per event (suite), stores the uploaded site-plan image (a data URL,
// downscaled client-side) and the station pins the user dragged onto it
// ({ stationName: { x, y } }, both 0..1 fractions of the image box). The live map
// view joins these pins with the Signal board's live rows — this module never reads
// Looker or the monitors; it is a dumb, scoped config store.
// Dual-surface: /api/admin/venue-map/:suiteId (staff, any event) and
// /api/my/venue-map/:suiteId (client, own events only) — same shapes.
//
// TO REMOVE: delete this file + its one-line mount; drop the venue_map table;
// remove VenueMapView from client/src/components/EventSignal.jsx.

const MAX_IMAGE = 4.5 * 1024 * 1024; // data-URL length cap — client downscales before upload
const MAX_PINS = 400;

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  sql.exec(`
    CREATE TABLE IF NOT EXISTS venue_map (
      suite_id   TEXT PRIMARY KEY,
      image      TEXT NOT NULL DEFAULT '',   -- data URL of the site plan ('' = stylised placeholder)
      pins       TEXT NOT NULL DEFAULT '{}', -- { stationName: { x, y } } fractions 0..1
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  const parse = (s, f) => { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } };
  const view = (suiteId) => {
    const r = sql.prepare('SELECT * FROM venue_map WHERE suite_id=?').get(suiteId);
    return { image: (r && r.image) || '', pins: parse(r && r.pins, {}), updatedAt: (r && r.updated_at) || '' };
  };

  function save(suiteId, body) {
    const cur = view(suiteId);
    let image = cur.image;
    if (typeof body.image === 'string') {
      if (body.image && !/^data:image\/(png|jpeg|webp);base64,/.test(body.image)) throw Object.assign(new Error('Image must be a PNG/JPEG/WebP data URL'), { status: 400 });
      if (body.image.length > MAX_IMAGE) throw Object.assign(new Error('Image too large — try a smaller export of the site plan'), { status: 400 });
      image = body.image; // '' clears the map back to the stylised placeholder
    }
    let pins = cur.pins;
    if (body.pins && typeof body.pins === 'object' && !Array.isArray(body.pins)) {
      pins = {};
      for (const [k, v] of Object.entries(body.pins).slice(0, MAX_PINS)) {
        const x = Number(v && v.x), y = Number(v && v.y);
        if (!k.trim() || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        pins[String(k).slice(0, 120)] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      }
    }
    sql.prepare(`INSERT INTO venue_map (suite_id, image, pins, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(suite_id) DO UPDATE SET image=excluded.image, pins=excluded.pins, updated_at=excluded.updated_at`)
      .run(suiteId, image, JSON.stringify(pins), now());
    return view(suiteId);
  }

  const handleSave = (req, res) => {
    try { res.json(save(req.params.suiteId, req.body || {})); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the venue map' }); }
  };

  app.get('/api/admin/venue-map/:suiteId', auth.requireAdmin, (req, res) => res.json(view(req.params.suiteId)));
  app.put('/api/admin/venue-map/:suiteId', auth.requireAdmin, handleSave);

  const requireAuth = auth.requireAuth || auth.requireAdmin;
  const ownsSuite = (req) => { const su = db.getSuite(req.params.suiteId); if (!su) return false; return (req.user && req.user.role === 'admin') || ((req.user && req.user.entityIds) || []).includes(su.entityId); };
  app.get('/api/my/venue-map/:suiteId', requireAuth, (req, res) => { if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); res.json(view(req.params.suiteId)); });
  app.put('/api/my/venue-map/:suiteId', requireAuth, (req, res) => { if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); handleSave(req, res); });

  return { view, save };
}

module.exports = { mount };
