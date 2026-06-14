// ─── Segments — reusable, LIVE audiences ─────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `segments` table + its routes.
// A segment is a *definition* (which people), not a frozen list — it re-resolves
// every time so it's always up to date. Definitions are source-agnostic: today a
// dashboard tile (or a pasted list); tomorrow a direct query (BigQuery) or rules.
//
// Resolution is delegated to the campaign engine's `audienceFor` (injected as
// `resolveAudience`) so we reuse the exact tile-query + dedupe logic without
// coupling — and the same boundary (server-side org scope) applies. The Action
// layer (campaigns/journeys) and later ad-sync / app-push all read segments.
//
// Mount: `require('./segments').mount(app, { db, auth, resolveAudience })`.
const crypto = require('crypto');

function mount(app, { db, auth, resolveAudience, resolveRecipe }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id               TEXT PRIMARY KEY,
      entity_id        TEXT NOT NULL,
      name             TEXT NOT NULL,
      source           TEXT NOT NULL DEFAULT 'tile',  -- tile | paste | query | rules
      definition       TEXT NOT NULL DEFAULT '{}',     -- JSON audience config (source-agnostic)
      last_count       INTEGER NOT NULL DEFAULT -1,    -- cached live count (-1 = not yet resolved)
      last_resolved_at TEXT NOT NULL DEFAULT '',
      created_by       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_entity ON segments(entity_id);
  `);
  // Additive: cached per-channel contactable counts (visible at preview, not a
  // silent send-time drop). -1 = not yet resolved. Consent-opt-in layers on later.
  for (const col of ['last_email', 'last_sms']) {
    try { sql.exec(`ALTER TABLE segments ADD COLUMN ${col} INTEGER NOT NULL DEFAULT -1`); } catch { /* exists */ }
  }

  // Scope: admins see all; clients only their own entities (same boundary as
  // campaigns). Enforced server-side, so a segment can't reach another client.
  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => {
    if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; }
    return true;
  };

  // Light shaping of a segment definition (the audience config). We don't trust
  // the client shape blindly, but we keep it source-agnostic — only known keys.
  const cleanDef = (d = {}) => {
    const mode = ['paste'].includes(d.mode) ? d.mode : 'tile';
    const out = {
      mode,
      dashboardId: String(d.dashboardId || ''),
      tileId: String(d.tileId || ''),
      emailField: String(d.emailField || ''),
      nameField: String(d.nameField || ''),
      phoneField: String(d.phoneField || ''),
      // Per-channel marketing consent columns — drive the reach figures + are
      // enforced when a campaign sends from this segment.
      emailConsentField: String(d.emailConsentField || ''),
      smsConsentField: String(d.smsConsentField || ''),
      // NB: no consent field — a segment is "who matches"; per-channel consent +
      // unsubscribe are applied at SEND (email-opt-in ≠ SMS/WhatsApp). POPIA.
      ticketField: String(d.ticketField || ''),
      // Dashboard (Looker) filters captured at "create segment from tile" time,
      // keyed by query field. Applied at resolution so the segment tracks that
      // cohort live. Capped + stringified; never trusted to widen org scope.
      lookerFilters: (d.lookerFilters && typeof d.lookerFilters === 'object' && !Array.isArray(d.lookerFilters))
        ? Object.fromEntries(Object.entries(d.lookerFilters).slice(0, 50).map(([k, v]) => [String(k), String(v)]))
        : {},
      attrDashboardId: String(d.attrDashboardId || ''),
      attrTileId: String(d.attrTileId || ''),
      attrEmailField: String(d.attrEmailField || ''),
      pasted: String(d.pasted || '').slice(0, 200000),
      filters: Array.isArray(d.filters) ? d.filters.slice(0, 8).map((f) => ({
        field: String(f.field || ''), op: f.op === 'between' ? 'between' : 'in',
        values: Array.isArray(f.values) ? f.values.map(String).slice(0, 100) : [],
        min: f.min, max: f.max, dashboardId: String(f.dashboardId || ''), tileId: String(f.tileId || ''),
      })) : [],
    };
    return out;
  };

  const getSeg = (id) => sql.prepare('SELECT * FROM segments WHERE id=?').get(id);
  const rowToSeg = (r) => ({
    id: r.id, entityId: r.entity_id, name: r.name, source: r.source,
    definition: JSON.parse(r.definition || '{}'),
    count: r.last_count, lastResolvedAt: r.last_resolved_at,
    reach: { email: r.last_email, sms: r.last_sms }, // contactable-by-identifier per channel
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  // Resolve a definition live (delegates to the campaign audience resolver).
  async function resolveDefinition(entityId, definition, user) {
    return resolveAudience(entityId, { audience: definition, channel: 'email' }, user);
  }

  // ── routes (dual-surface: same handlers for admin + client self-service) ──
  app.get('/api/segments/:entityId', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const rows = sql.prepare('SELECT * FROM segments WHERE entity_id=? ORDER BY updated_at DESC LIMIT 200').all(req.params.entityId);
    res.json({ segments: rows.map(rowToSeg) });
  });

  app.post('/api/segments/:entityId', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const name = String(req.body?.name || '').trim().slice(0, 120) || 'Untitled segment';
    const definition = cleanDef(req.body?.definition || {});
    const source = definition.mode === 'paste' ? 'paste' : 'tile';
    const id = uuid(); const ts = now();
    sql.prepare('INSERT INTO segments (id, entity_id, name, source, definition, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, name, source, JSON.stringify(definition), req.user.email, ts, ts);
    res.status(201).json({ segment: rowToSeg(getSeg(id)) });
  });

  // Materialise a built-in recipe (e.g. 'abandoned_cart') as a real, live
  // segment — auto-resolves the audience source from this client's data.
  app.post('/api/segments/:entityId/recipe/:key', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    if (typeof resolveRecipe !== 'function') return res.status(400).json({ error: 'Recipes are not available.' });
    const r = resolveRecipe(req.params.entityId, req.params.key);
    if (!r) return res.status(400).json({ error: "Couldn't find this audience in your data yet — create it from a dashboard tile instead." });
    // Don't duplicate — if one already exists by that name, return it.
    const existing = sql.prepare('SELECT * FROM segments WHERE entity_id=? AND name=?').get(req.params.entityId, r.name);
    if (existing) return res.json({ segment: rowToSeg(existing), existed: true });
    const definition = cleanDef(r.definition);
    const id = uuid(); const ts = now();
    sql.prepare('INSERT INTO segments (id, entity_id, name, source, definition, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, r.name, 'tile', JSON.stringify(definition), req.user.email, ts, ts);
    res.status(201).json({ segment: rowToSeg(getSeg(id)) });
  });

  app.patch('/api/segments/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) || seg.name : seg.name;
    const definition = req.body?.definition !== undefined ? cleanDef(req.body.definition) : JSON.parse(seg.definition || '{}');
    const source = definition.mode === 'paste' ? 'paste' : 'tile';
    // A changed definition invalidates the cached count.
    const changed = JSON.stringify(definition) !== seg.definition;
    sql.prepare('UPDATE segments SET name=?, source=?, definition=?, updated_at=?' + (changed ? ', last_count=-1, last_resolved_at=\'\'' : '') + ' WHERE id=?')
      .run(name, source, JSON.stringify(definition), now(), req.params.id);
    res.json({ segment: rowToSeg(getSeg(req.params.id)) });
  });

  app.delete('/api/segments/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    sql.prepare('DELETE FROM segments WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // Resolve a SAVED segment live — refreshes the cached count + returns a sample.
  app.post('/api/segments/:entityId/:id/preview', auth.requireAuth, auth.requirePermission('campaigns.view'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    try {
      const r = await resolveDefinition(req.params.entityId, JSON.parse(seg.definition || '{}'), req.user);
      const list = r.list || [];
      const count = list.length;
      // Per-channel reach is consent-aware (identifier present AND opted in on
      // that channel) — comes straight from the resolver.
      const reach = r.reach || { email: list.filter((m) => m.email && m.emailOk !== false).length, sms: list.filter((m) => m.phone && m.smsOk !== false).length };
      sql.prepare('UPDATE segments SET last_count=?, last_email=?, last_sms=?, last_resolved_at=? WHERE id=?').run(count, reach.email, reach.sms, now(), req.params.id);
      res.json({ count, reach, sample: list.slice(0, 8).map((x) => ({ email: x.email, name: x.name || '' })), excluded: r.excluded || 0, noConsent: r.noConsent || 0, filteredOut: r.filteredOut || 0 });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // The people in a segment — resolved live, capped for display.
  app.get('/api/segments/:entityId/:id/members', auth.requireAuth, auth.requirePermission('campaigns.view'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    try {
      const r = await resolveDefinition(req.params.entityId, JSON.parse(seg.definition || '{}'), req.user);
      const list = r.list || [];
      res.json({ name: seg.name, count: list.length, capped: list.length > 2000, members: list.slice(0, 2000).map((m) => ({ email: m.email || '', name: m.name || '', phone: m.phone || '', ticket: m.ticket || '' })) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log('[segments] segments module mounted');

  // For the Action layer (campaigns/journeys) to resolve a segment by id.
  async function resolveSegment(entityId, segmentId, user) {
    const seg = getSeg(segmentId);
    if (!seg || seg.entity_id !== entityId) return null;
    return resolveDefinition(entityId, JSON.parse(seg.definition || '{}'), user);
  }
  function getSegmentDefinition(entityId, segmentId) {
    const seg = getSeg(segmentId);
    return seg && seg.entity_id === entityId ? JSON.parse(seg.definition || '{}') : null;
  }
  return { resolveSegment, getSegmentDefinition };
}

module.exports = { mount };
