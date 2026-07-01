// ─── Public read API (/api/v1) — Pulse as a platform ──────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. The REST read surface of the public API
// (docs/API_MCP_BRIEF.md): a thin adapter over the SAME service functions the
// app uses — no second implementation, no second security boundary. Auth is a
// per-entity API key (server/apiKeys.js) whose synthetic principal rides every
// existing gate (entity ownership, organiser scope, suite access) unchanged.
//
// The `core` functions returned from mount are shared with the MCP server
// (server/mcp.js) so both surfaces are one implementation with two transports.
// v1 is READ-ONLY by design — writes land in P3 with the approval/consent gates.
//
// Mount: `require('./api').mount(app, { db, auth, store, rateLimit, apiKeys,
//   clientCatalogue, resolveTileValue, segmentsApi, actionsApi, goalsApi })`.

const { HttpError, asyncHandler } = require('./http');

function mount(app, { db, auth, rateLimit, apiKeys, clientCatalogue, resolveTileValue, segmentsApi, actionsApi, goalsApi }) {
  const entityOf = (user) => (user.entityIds || [])[0];
  const asOf = () => new Date().toISOString();

  // ── core (shared by REST + MCP — one implementation, two transports) ──

  function me(user, key) {
    const entityId = entityOf(user);
    const e = db.getEntity(entityId);
    return {
      entity: { id: entityId, name: e?.name || '' },
      key: { name: key?.name || '', scopes: key?.scopes || [] },
      suites: db.listSuitesForEntity(entityId).map((s) => ({ id: s.id, name: s.name })),
    };
  }

  // The client's dashboard catalogue — one entry per (dashboard, event) pairing,
  // exactly as the app's navigation resolves it. suiteId is the event context a
  // metric read needs (which event's locks apply).
  function listDashboards(user) {
    return clientCatalogue(entityOf(user)).catalogue
      .map((c) => ({ id: c.dashboardId, title: c.title, setName: c.setName, suiteId: c.suiteId, suiteName: c.suiteName }));
  }

  function getDashboard(user, dashboardId) {
    const entries = clientCatalogue(entityOf(user)).catalogue.filter((c) => c.dashboardId === dashboardId);
    if (!entries.length) throw new HttpError(404, 'Dashboard not found for this client');
    const def = db.getDashboard(dashboardId);
    if (!def) throw new HttpError(404, 'Dashboard not found for this client');
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    return {
      id: def.id, title: def.title,
      suites: entries.map((c) => ({ id: c.suiteId, name: c.suiteName })),
      tiles: tiles.map((t) => ({ id: t.id, title: t.title || '', type: (t.vis && t.vis.type) || t.type || '' })),
      filters: (def.filters || []).map((f) => f.name || f.title).filter(Boolean),
    };
  }

  // The number a tile currently shows — through the shared scope-enforced reader
  // (tileValues.js), so an API read equals the dashboard and can't widen scope.
  async function metric(user, { dashboardId, tileId, suiteId }) {
    if (!dashboardId || !tileId) throw new HttpError(400, 'dashboardId and tileId are required');
    const entries = clientCatalogue(entityOf(user)).catalogue.filter((c) => c.dashboardId === dashboardId);
    if (!entries.length) throw new HttpError(404, 'Dashboard not found for this client');
    const entry = suiteId ? entries.find((c) => c.suiteId === suiteId) : entries[0];
    if (!entry) throw new HttpError(404, 'That dashboard is not in that event (suite) for this client');
    const value = await resolveTileValue({ dashboardId, tileId, user, suiteId: entry.suiteId });
    if (value == null) throw new HttpError(404, 'No value — unknown tile, non-KPI tile, or no data access');
    return { dashboardId, tileId, suiteId: entry.suiteId, value, asOf: asOf() };
  }

  const segmentShape = (s) => ({
    id: s.id, name: s.name, source: s.source, count: s.count,
    reach: s.reach, suiteId: s.suiteId, folder: s.folder,
    lastResolvedAt: s.lastResolvedAt, updatedAt: s.updatedAt,
  });
  const listSegments = (user) => segmentsApi.listSegmentsFull(entityOf(user)).map(segmentShape);
  function getSegment(user, id) {
    const s = segmentsApi.listSegmentsFull(entityOf(user)).find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'Segment not found');
    return segmentShape(s);
  }
  // Live re-resolve (consent-aware reach) — same resolver the app's preview uses.
  async function segmentReach(user, id) {
    const entityId = entityOf(user);
    getSegment(user, id); // 404 before the expensive resolve
    const r = await segmentsApi.resolveSegment(entityId, id, user);
    if (!r) throw new HttpError(404, 'Segment not found');
    const list = r.list || [];
    return { id, count: list.length, reach: r.reach || { email: 0, sms: 0 }, noConsent: r.noConsent || 0, asOf: asOf() };
  }

  // Campaign read shape: results counters without the audience list or the full
  // creative (config can carry whole email bodies — not a read-API payload).
  const campaignShape = (a) => ({
    id: a.id, title: a.title || a.config?.subject || '', type: a.type, status: a.status,
    channel: a.config?.channel || 'email', subject: a.config?.subject || '',
    audienceCount: a.audienceCount,
    results: {
      sent: a.results?.sent || 0, failed: a.results?.failed || 0,
      clicks: a.results?.clicks || 0, opens: a.results?.opens || 0,
      emailSent: a.results?.emailSent || 0, smsSent: a.results?.smsSent || 0,
      converted: a.results?.converted || 0,
    },
    ctr: (a.results?.sent || 0) > 0 ? Math.min(100, Math.round(((a.results?.clicks || 0) / a.results.sent) * 100)) : 0,
    approvedBy: a.approvedBy || '', approvedAt: a.approvedAt || '',
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  });
  function listCampaigns(user, { status } = {}) {
    let rows = actionsApi.listForEntity(entityOf(user));
    if (status) rows = rows.filter((a) => a.status === String(status));
    return rows.map(campaignShape);
  }
  function getCampaign(user, id) {
    const a = actionsApi.listForEntity(entityOf(user)).find((x) => x.id === id);
    if (!a) throw new HttpError(404, 'Campaign not found');
    return campaignShape(a);
  }

  const goalShape = (g) => ({
    id: g.id, suiteId: g.suiteId, name: g.name, unit: g.unit, direction: g.direction,
    targetValue: g.targetValue, targetMax: g.targetMax, byDate: g.byDate,
    isNorthStar: g.isNorthStar, status: g.status, tag: g.tag,
  });
  function suiteFor(user, suiteId) {
    if (!suiteId) throw new HttpError(400, 'suiteId is required (see /api/v1/me for this client’s suites)');
    if (!auth.canAccessSuite(user, suiteId)) throw new HttpError(403, 'No access to that suite');
    return suiteId;
  }
  // Goals for one event (suite); progress=true resolves live progress through the
  // same scoped tile readers the app uses (slower — one Looker read per goal).
  async function listGoals(user, { suiteId, progress } = {}) {
    const sid = suiteFor(user, suiteId);
    const goals = goalsApi.listGoals(sid) || [];
    if (!progress) return goals.map(goalShape);
    const out = [];
    for (const g of goals) {
      const withProgress = await goalsApi.attachProgress(g, user);
      out.push({ ...goalShape(g), progress: withProgress.progress || null });
    }
    return out;
  }

  const core = { me, listDashboards, getDashboard, metric, listSegments, getSegment, segmentReach, listCampaigns, getCampaign, listGoals };

  // ── REST routes — thin wrappers, key-authed, rate-limited, audited ──
  const perKey = (max, scope) => rateLimit({ windowMs: 60_000, max, by: (req) => `key:${req.apiKey?.id}`, scope });
  const read = apiKeys.requireScope('read');
  const guard = [apiKeys.bearerAuth, apiKeys.auditware('rest'), perKey(120, 'apiv1'), read];
  const heavy = perKey(20, 'apiv1-heavy'); // live resolves (Looker/audience reads)

  app.get('/api/v1/me', ...guard, (req, res) => res.json(me(req.user, req.apiKey)));
  app.get('/api/v1/dashboards', ...guard, (req, res) => res.json({ dashboards: listDashboards(req.user) }));
  app.get('/api/v1/dashboards/:id', ...guard, asyncHandler(async (req, res) => res.json(getDashboard(req.user, req.params.id))));
  app.get('/api/v1/metric', ...guard, heavy, asyncHandler(async (req, res) => {
    res.json(await metric(req.user, { dashboardId: req.query.dashboardId, tileId: req.query.tileId, suiteId: req.query.suiteId }));
  }));
  app.get('/api/v1/segments', ...guard, (req, res) => res.json({ segments: listSegments(req.user) }));
  app.get('/api/v1/segments/:id', ...guard, asyncHandler(async (req, res) => res.json(getSegment(req.user, req.params.id))));
  app.get('/api/v1/segments/:id/reach', ...guard, heavy, asyncHandler(async (req, res) => res.json(await segmentReach(req.user, req.params.id))));
  app.get('/api/v1/campaigns', ...guard, (req, res) => res.json({ campaigns: listCampaigns(req.user, { status: req.query.status }) }));
  app.get('/api/v1/campaigns/:id', ...guard, asyncHandler(async (req, res) => res.json(getCampaign(req.user, req.params.id))));
  app.get('/api/v1/goals', ...guard, heavy, asyncHandler(async (req, res) => {
    res.json({ goals: await listGoals(req.user, { suiteId: req.query.suiteId, progress: req.query.progress === '1' || req.query.progress === 'true' }) });
  }));

  console.log('[api] public /api/v1 read surface mounted');
  return { core };
}

module.exports = { mount };
