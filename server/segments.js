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

function mount(app, { db, auth, resolveAudience, resolveRecipe, meta, tiktok }) {
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
  // Opt-in: keep this segment's Meta / TikTok Custom Audience mirrored automatically (~daily).
  try { sql.exec('ALTER TABLE segments ADD COLUMN meta_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { sql.exec('ALTER TABLE segments ADD COLUMN tiktok_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

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
    const mode = ['paste', 'gsheet'].includes(d.mode) ? d.mode : 'tile';
    const out = {
      mode,
      gsheetUrl: String(d.gsheetUrl || '').slice(0, 1000), // linked Google Sheet (shared/published)
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
    metaAuto: !!r.meta_auto,
    tiktokAuto: !!r.tiktok_auto,
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
    res.json({
      segments: rows.map((r) => ({
        ...rowToSeg(r),
        metaSync: meta?.lastSyncFor?.(req.params.entityId, r.id) || null,
        tiktokSync: tiktok?.lastSyncFor?.(req.params.entityId, r.id) || null,
      })),
      metaConnected: !!meta?.isConfigured?.(req.params.entityId),
      tiktokConnected: !!tiktok?.isConfigured?.(req.params.entityId),
      connectors: {
        meta: { connected: !!meta?.isConfigured?.(req.params.entityId), audiencesUrl: meta?.audiencesUrl?.(req.params.entityId) || '' },
        tiktok: { connected: !!tiktok?.isConfigured?.(req.params.entityId), audiencesUrl: tiktok?.audiencesUrl?.(req.params.entityId) || '' },
      },
    });
  });

  app.post('/api/segments/:entityId', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const name = String(req.body?.name || '').trim().slice(0, 120) || 'Untitled segment';
    const definition = cleanDef(req.body?.definition || {});
    const source = ['paste', 'gsheet'].includes(definition.mode) ? definition.mode : 'tile';
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
    const source = ['paste', 'gsheet'].includes(definition.mode) ? definition.mode : 'tile';
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

  // Audience-sync: push a segment to a Meta Custom Audience (hashed match). The
  // resolver enforces the client's org/event scope, so a sync can't leak another
  // client's people; identities are hashed inside the connector before they leave.
  app.post('/api/segments/:entityId/:id/sync/meta', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    if (!meta?.isConfigured?.(req.params.entityId)) return res.status(400).json({ error: 'Meta isn’t connected for this client — add a Meta access token + ad account in Integrations.' });
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    try {
      const r = await resolveDefinition(req.params.entityId, JSON.parse(seg.definition || '{}'), req.user);
      const members = (r.list || []).map((m) => ({ email: m.email, phone: m.phone }));
      if (!members.length) return res.status(400).json({ error: 'This segment resolved to nobody right now.' });
      const mode = req.body?.mode === 'append' ? 'append' : 'replace';
      const out = await meta.syncAudience({ entityId: req.params.entityId, segmentId: seg.id, name: seg.name, members, mode, by: req.user.email });
      if (!out.ok) return res.status(502).json({ error: out.error || 'Meta sync failed' });
      res.json({ ok: true, audienceId: out.audienceId, pushed: out.pushed, received: out.received, mode: out.mode });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Audience-sync: push a segment to a TikTok Custom Audience (hashed match,
  // append-only for v1). Same org-scope guarantee as the Meta route.
  app.post('/api/segments/:entityId/:id/sync/tiktok', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    if (!tiktok?.isConfigured?.(req.params.entityId)) return res.status(400).json({ error: 'TikTok isn’t connected for this client — add a TikTok access token + advertiser ID in Integrations.' });
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    try {
      const r = await resolveDefinition(req.params.entityId, JSON.parse(seg.definition || '{}'), req.user);
      const members = (r.list || []).map((m) => ({ email: m.email, phone: m.phone }));
      if (!members.length) return res.status(400).json({ error: 'This segment resolved to nobody right now.' });
      const out = await tiktok.syncAudience({ entityId: req.params.entityId, segmentId: seg.id, name: seg.name, members, by: req.user.email });
      if (!out.ok) return res.status(502).json({ error: out.error || 'TikTok sync failed' });
      res.json({ ok: true, audienceId: out.audienceId, pushed: out.pushed, received: out.received, added: out.added, removed: out.removed });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Toggle daily auto-mirror to a channel (meta | tiktok) for a segment.
  app.put('/api/segments/:entityId/:id/sync/:channel/auto', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const col = req.params.channel === 'tiktok' ? 'tiktok_auto' : (req.params.channel === 'meta' ? 'meta_auto' : null);
    if (!col) return res.status(400).json({ error: 'Unknown channel' });
    const seg = getSeg(req.params.id);
    if (!seg || seg.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const on = !!(req.body && req.body.on);
    sql.prepare(`UPDATE segments SET ${col}=? WHERE id=?`).run(on ? 1 : 0, req.params.id);
    res.json({ ok: true, channel: req.params.channel, auto: on });
  });

  // Background mirror: re-push auto-enabled segments to Meta/TikTok ~daily.
  // Best-effort, throttled per (segment, channel) — skip if mirrored in the last
  // 20h. Resolves the audience ONCE per segment and pushes to each auto channel.
  // Uses a synthetic system user so the SAME server-side org/event scope applies.
  const stale = (last) => !(last?.at && (Date.now() - new Date(last.at).getTime()) < 20 * 3600 * 1000);
  async function autoMirrorTick() {
    let rows = [];
    try { rows = sql.prepare('SELECT id, entity_id, name, definition, meta_auto, tiktok_auto FROM segments WHERE meta_auto=1 OR tiktok_auto=1').all(); } catch { return; }
    for (const s of rows) {
      const doMeta = s.meta_auto && meta?.isConfigured?.(s.entity_id) && stale(meta.lastSyncFor?.(s.entity_id, s.id));
      const doTiktok = s.tiktok_auto && tiktok?.isConfigured?.(s.entity_id) && stale(tiktok.lastSyncFor?.(s.entity_id, s.id));
      if (!doMeta && !doTiktok) continue;
      try {
        const user = { id: `autosync:${s.entity_id}`, email: 'autosync@pulse', role: 'client', entityIds: [s.entity_id], memberships: [{ entityId: s.entity_id, role: 'owner' }] };
        const r = await resolveDefinition(s.entity_id, JSON.parse(s.definition || '{}'), user);
        const members = (r.list || []).map((m) => ({ email: m.email, phone: m.phone }));
        if (!members.length) continue;
        if (doMeta) await meta.syncAudience({ entityId: s.entity_id, segmentId: s.id, name: s.name, members, mode: 'replace', by: 'auto' });
        if (doTiktok) await tiktok.syncAudience({ entityId: s.entity_id, segmentId: s.id, name: s.name, members, by: 'auto' });
      } catch (e) { console.error('[segments] auto-mirror failed', s.id, e.message); }
    }
  }
  if (meta || tiktok) {
    const tick = setInterval(() => autoMirrorTick().catch(() => {}), 3600 * 1000);
    if (tick.unref) tick.unref();
    setTimeout(() => autoMirrorTick().catch(() => {}), 30000); // shortly after boot
  }

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
