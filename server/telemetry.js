// ─── Onboarding & feature telemetry — SELF-CONTAINED, DISPOSABLE MODULE ───────
// Captures lightweight usage signals so the onboarding flow can be REFINED from
// real behaviour instead of guesswork:
//   • the wizard funnel — where people open, advance, skip or complete a guide,
//   • feature engagement — which features clients actually use.
// The client posts events to /api/my/track (entity-scoped, ownership enforced).
// Admin reads the aggregates (funnel + feature usage) to decide what to change.
//
// Privacy: we store only an event's KIND, NAME (guide id / feature key), STEP
// index, the entity, the user and a timestamp — never any message content.
//
// Mount: require('./telemetry').mount(app, { db, auth, rateLimit });

function mount(app, { db, auth, rateLimit }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS usage_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id  TEXT NOT NULL,
    user_id    TEXT,
    kind       TEXT NOT NULL,   -- 'guide' | 'feature'
    name       TEXT NOT NULL,   -- guide id, or feature key
    step       TEXT,            -- guide step index (guide events only)
    event      TEXT NOT NULL,   -- open | step | cta | skip | complete | use
    ts         TEXT NOT NULL
  );`);
  try { sql.exec('CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_events(kind, name)'); } catch { /* older sqlite */ }

  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const KINDS = new Set(['guide', 'feature']);
  const EVENTS = new Set(['open', 'step', 'cta', 'skip', 'complete', 'use']);
  const clip = (v, n = 64) => (v == null ? null : String(v).slice(0, n));
  const insert = sql.prepare('INSERT INTO usage_events (entity_id,user_id,kind,name,step,event,ts) VALUES (?,?,?,?,?,?,?)');

  // Client self-service: log a small batch of events for an entity the user owns.
  // Telemetry must NEVER break the UI, so bad rows are skipped and errors swallowed.
  app.post('/api/my/track', auth.requireAuth, rateLimit({ windowMs: 60_000, max: 120, by: 'user', scope: 'track' }), (req, res) => {
    const entityId = (req.body && req.body.entityId) || '';
    if (!entityId || !canEntity(req, entityId)) return res.status(403).json({ error: 'Not allowed' });
    const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 50) : [];
    const uid = clip(req.user.id || req.user.sub || req.user.email);
    const now = new Date().toISOString();
    try {
      db.db.transaction((rows) => {
        for (const e of rows) {
          if (!e || !KINDS.has(e.kind) || !EVENTS.has(e.event) || !e.name) continue;
          insert.run(entityId, uid, clip(e.kind, 16), clip(e.name), clip(e.step, 16), clip(e.event, 16), now);
        }
      })(events);
    } catch { /* swallow — never fail on telemetry */ }
    res.json({ ok: true });
  });

  // Distinct people = user within an entity (admins previewing many clients count once each).
  const PERSON = "COUNT(DISTINCT user_id || ':' || entity_id)";

  // Aggregate everything the admin "Onboarding insights" view needs.
  function stats() {
    const guides = {};
    const G = (name) => (guides[name] ||= { opens: 0, completes: 0, steps: {} });
    for (const r of sql.prepare(`SELECT name, event, ${PERSON} AS people, COUNT(*) AS hits FROM usage_events WHERE kind='guide' AND event IN ('open','complete') GROUP BY name, event`).all()) {
      if (r.event === 'open') G(r.name).opens = r.people; else G(r.name).completes = r.people;
    }
    for (const r of sql.prepare(`SELECT name, step, event, ${PERSON} AS people FROM usage_events WHERE kind='guide' AND event IN ('step','cta','skip') AND step IS NOT NULL GROUP BY name, step, event`).all()) {
      const s = (G(r.name).steps[r.step] ||= { viewed: 0, cta: 0, skip: 0 });
      if (r.event === 'step') s.viewed = r.people; else if (r.event === 'cta') s.cta = r.people; else s.skip = r.people;
    }
    const features = sql.prepare(`SELECT name, ${PERSON} AS people, COUNT(*) AS hits FROM usage_events WHERE kind='feature' GROUP BY name ORDER BY people DESC, hits DESC`).all();
    const total = sql.prepare('SELECT COUNT(*) n FROM usage_events').get()?.n || 0;
    return { guides, features, total };
  }

  app.get('/api/admin/onboarding/stats', auth.requireAdmin, (req, res) => res.json(stats()));

  console.log('[telemetry] usage events module mounted');
  return { stats };
}

module.exports = { mount };
