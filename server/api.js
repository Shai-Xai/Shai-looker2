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

function mount(app, { db, auth, rateLimit, apiKeys, clientCatalogue, resolveTileValue, resolveTileRows, segmentsApi, actionsApi, goalsApi, getOwlTools, owlCatalogue }) {
  const entityOf = (user) => (user.entityIds || [])[0];
  const asOf = () => new Date().toISOString();

  // Building the client catalogue walks suites→sets→dashboards in SQLite; the
  // read tools call it on nearly every request. Memoise it per entity for a few
  // seconds so a burst of tool calls (list → metric → fetch) doesn't rebuild it
  // each time. Short TTL so a newly-added dashboard still appears promptly.
  const CAT_TTL = 15_000;
  const catCache = new Map(); // entityId -> { at, val }
  const catalogueFor = (entityId) => {
    const hit = catCache.get(entityId);
    if (hit && Date.now() - hit.at < CAT_TTL) return hit.val;
    const val = clientCatalogue(entityId);
    catCache.set(entityId, { at: Date.now(), val });
    if (catCache.size > 200) catCache.delete(catCache.keys().next().value);
    return val;
  };

  // Run async tasks with a concurrency cap — fast without hammering Looker.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    });
    await Promise.all(workers);
    return out;
  }

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
    return catalogueFor(entityOf(user)).catalogue
      .map((c) => ({ id: c.dashboardId, title: c.title, setName: c.setName, suiteId: c.suiteId, suiteName: c.suiteName }));
  }

  function getDashboard(user, dashboardId) {
    const entries = catalogueFor(entityOf(user)).catalogue.filter((c) => c.dashboardId === dashboardId);
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
    const entries = catalogueFor(entityOf(user)).catalogue.filter((c) => c.dashboardId === dashboardId);
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

  // Row-level: the table behind a tile (customer/ticketing rows — may include
  // personal data). Gated behind the explicit `read_rows` key scope at the
  // surface; same catalogue + scope enforcement as the KPI reader.
  async function tileRows(user, { dashboardId, tileId, suiteId, limit }) {
    if (!dashboardId || !tileId) throw new HttpError(400, 'dashboardId and tileId are required');
    const entries = catalogueFor(entityOf(user)).catalogue.filter((c) => c.dashboardId === dashboardId);
    if (!entries.length) throw new HttpError(404, 'Dashboard not found for this client');
    const entry = suiteId ? entries.find((c) => c.suiteId === suiteId) : entries[0];
    if (!entry) throw new HttpError(404, 'That dashboard is not in that event (suite) for this client');
    const r = await resolveTileRows({ dashboardId, tileId, user, suiteId: entry.suiteId, limit });
    if (!r) throw new HttpError(404, 'No rows — unknown tile, non-queryable tile, or no data access');
    return { dashboardId, tileId, suiteId: entry.suiteId, fields: r.fields, rowCount: r.rows.length, rows: r.rows, asOf: asOf() };
  }

  // ── direct data queries (no dashboard/tile needed) ──
  // Rides the Owl's curated-catalogue engine (server/owlTools.js askData + the
  // per-explore tools): admin-ticked fields only, PII never groupable, the
  // organiser scope forced fail-closed. A dashboard stops being the only door —
  // but the catalogue and the tenancy boundary still are.
  const dataToolFor = (user, exploreKey) => {
    const tools = getOwlTools();
    if (!exploreKey || exploreKey === 'primary') return { runner: tools.askData, cat: { model: tools.catalogue.model, view: tools.catalogue.explore, label: tools.catalogue.label || 'All Tickets', key: 'primary', measures: tools.catalogue.measures, dimensions: tools.catalogue.dimensions, dateDimension: tools.catalogue.dateDimension } };
    for (const t of Object.values(tools)) {
      if (t && t.exploreKey === exploreKey) {
        if (!owlCatalogue.exploreEnabledFor(db, exploreKey, entityOf(user))) return null; // per-client off → invisible
        const cat = (tools.catalogue.extras || []).find((e) => `${e.model}::${e.explore}` === exploreKey);
        return { runner: t, cat: cat ? { model: cat.model, view: cat.explore, label: cat.label, key: exploreKey, measures: cat.measures, dimensions: cat.dimensions, dateDimension: cat.dateDimension } : null };
      }
    }
    return null;
  };
  // The data sources this client may query, with their curated fields — the
  // discovery step an agent (or developer) uses to learn what it can ask for.
  function listDataSources(user) {
    const tools = getOwlTools();
    const shape = (c, key) => ({
      key, label: c.label || 'All Tickets', dateDimension: c.dateDimension || '',
      measures: (c.measures || []).map((m) => ({ name: m.name, label: m.label })),
      dimensions: (c.dimensions || []).filter((d) => !d.filterOnly).map((d) => ({ name: d.name, label: d.label })),
      filterOnly: (c.dimensions || []).filter((d) => d.filterOnly).map((d) => ({ name: d.name, label: d.label })),
    });
    const out = [shape(tools.catalogue, 'primary')];
    for (const e of tools.catalogue.extras || []) {
      const key = `${e.model}::${e.explore}`;
      if (owlCatalogue.exploreEnabledFor(db, key, entityOf(user))) out.push(shape(e, key));
    }
    return out;
  }
  // Run one bounded, scoped aggregate query: measure(s) × group-by dimensions ×
  // filters × optional date range, against a curated source. suiteId (optional)
  // narrows to one event, exactly like the Owl with an event open.
  async function queryData(user, { source, suiteId, ...args } = {}) {
    const t = dataToolFor(user, source);
    if (!t) throw new HttpError(404, 'Unknown data source — see the data-sources list for what this client can query');
    if (suiteId && !auth.canAccessSuite(user, suiteId)) throw new HttpError(403, 'No access to that suite');
    const out = await t.runner.run(args, { user, suiteId: suiteId || '', entityId: entityOf(user) });
    if (!out || out.ok !== true) throw new HttpError(400, (out && out.message) || 'That query couldn’t be run.');
    return { source: t.cat?.key || 'primary', measure: out.measure, dimensions: out.dimensions, count: out.count, rows: out.rows, asOf: asOf() };
  }

  // ── Event Ops (per event: devices, stations, staff, issues, checkpoints) ──
  // Delegates to the Owl's eventOps runner, which enforces suite access + the
  // per-client "Event Ops enabled" switch and refuses cleanly. Gated behind the
  // read_rows scope at the surface (staff names + device movements are
  // operational row-level data, not aggregates).
  async function eventOps(user, { suiteId, ...args } = {}) {
    if (!suiteId) throw new HttpError(400, 'suiteId is required — Event Ops answers are per event (see /api/v1/me)');
    if (!auth.canAccessSuite(user, suiteId)) throw new HttpError(403, 'No access to that suite');
    const t = getOwlTools().eventOps;
    if (!t) throw new HttpError(404, 'Event Ops isn’t available');
    const out = await t.run(args, { user, suiteId, entityId: entityOf(user) });
    if (!out || out.ok !== true) throw new HttpError(400, (out && out.message) || 'Event Ops couldn’t answer that.');
    const { ok, ...data } = out;
    return { suiteId, ...data, asOf: asOf() };
  }

  // ── OpenAI/ChatGPT-compatible search + fetch (over the same read core) ──
  // ChatGPT connectors require an MCP server to expose `search` and `fetch`.
  // A "document" here is any addressable read item — a dashboard, segment,
  // campaign or goal; its id encodes the type so fetch() can resolve it.
  // Aggregate only — never row-level (that stays behind read_rows). URLs are
  // added by the transport layer (it knows the host).
  function search(user, query) {
    const q = String(query || '').trim().toLowerCase();
    const match = (s) => !q || String(s || '').toLowerCase().includes(q);
    const results = [];
    for (const d of listDashboards(user)) {
      if (match(d.title) || match(d.suiteName) || match(d.setName)) {
        results.push({ id: `dashboard:${d.id}:${d.suiteId}`, title: `Dashboard — ${d.title} (${d.suiteName})` });
      }
    }
    for (const s of listSegments(user)) {
      if (match(s.name)) results.push({ id: `segment:${s.id}`, title: `Segment — ${s.name}` });
    }
    for (const c of listCampaigns(user, {})) {
      if (match(c.title) || match(c.subject)) results.push({ id: `campaign:${c.id}`, title: `Campaign — ${c.title || c.subject}` });
    }
    for (const su of db.listSuitesForEntity(entityOf(user))) {
      let goals = [];
      try { goals = goalsApi.listGoals(su.id) || []; } catch { goals = []; }
      for (const g of goals) if (match(g.name)) results.push({ id: `goal:${su.id}:${g.id}`, title: `Goal — ${g.name} (${su.name})` });
    }
    return { results: results.slice(0, 50) };
  }

  async function fetchDoc(user, id) {
    const parts = String(id || '').split(':');
    const type = parts[0];
    if (type === 'dashboard') {
      const [, dashId, suiteId] = parts;
      const d = getDashboard(user, dashId); // 404s if not visible to this client
      const CAP = 12;
      const shown = d.tiles.slice(0, CAP);
      // Resolve the tile values concurrently (capped) rather than one-at-a-time —
      // a dashboard fetch was the slowest path when done serially.
      const values = await mapLimit(shown, 6, async (t) => {
        try { return (await metric(user, { dashboardId: dashId, tileId: t.id, suiteId })).value; } catch { return null; }
      });
      const lines = [`Dashboard: ${d.title}`, 'Live tile values:'];
      shown.forEach((t, idx) => lines.push(values[idx] == null ? `- ${t.title || t.id}` : `- ${t.title || t.id}: ${values[idx]}`));
      if (d.tiles.length > CAP) lines.push(`… and ${d.tiles.length - CAP} more tiles`);
      return { id, title: `Dashboard — ${d.title}`, text: lines.join('\n'), metadata: { type: 'dashboard', suiteId: suiteId || '' } };
    }
    if (type === 'segment') {
      const s = getSegment(user, parts[1]);
      const text = `Segment "${s.name}"\nSize: ${s.count}\nContactable — email: ${s.reach?.email ?? 'n/a'}, SMS: ${s.reach?.sms ?? 'n/a'}\nSource: ${s.source}`;
      return { id, title: `Segment — ${s.name}`, text, metadata: { type: 'segment' } };
    }
    if (type === 'campaign') {
      const c = getCampaign(user, parts[1]);
      const r = c.results || {};
      const text = `Campaign "${c.title}" (${c.channel}, status: ${c.status})\nSent: ${r.sent}, Clicks: ${r.clicks}, Opens: ${r.opens}, CTR: ${c.ctr}%, Converted: ${r.converted}`;
      return { id, title: `Campaign — ${c.title}`, text, metadata: { type: 'campaign' } };
    }
    if (type === 'goal') {
      const [, suiteId, goalId] = parts;
      const goals = await listGoals(user, { suiteId, progress: true });
      const g = goals.find((x) => x.id === goalId);
      if (!g) throw new HttpError(404, 'Goal not found');
      const p = g.progress || {};
      const text = `Goal "${g.name}"\nTarget: ${g.targetValue}${g.unit ? ' ' + g.unit : ''}${g.byDate ? ' by ' + g.byDate : ''}\nCurrent: ${p.value ?? 'n/a'}`;
      return { id, title: `Goal — ${g.name}`, text, metadata: { type: 'goal', suiteId } };
    }
    throw new HttpError(404, 'Unknown document id');
  }

  const core = { me, listDashboards, getDashboard, metric, listSegments, getSegment, segmentReach, listCampaigns, getCampaign, listGoals, tileRows, search, fetchDoc, listDataSources, queryData, eventOps };

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
  // Direct data queries over the curated catalogue (no dashboard/tile needed).
  app.get('/api/v1/data-sources', ...guard, (req, res) => res.json({ sources: listDataSources(req.user) }));
  app.post('/api/v1/query', ...guard, heavy, asyncHandler(async (req, res) => {
    res.json(await queryData(req.user, req.body || {}));
  }));
  // Event Ops — read_rows scope (operational row-level data: staff, devices).
  app.get('/api/v1/event-ops', apiKeys.bearerAuth, apiKeys.auditware('rest'), perKey(120, 'apiv1'), apiKeys.requireScope('read_rows'), heavy, asyncHandler(async (req, res) => {
    const { suiteId, query, code, state, station, status } = req.query;
    res.json(await eventOps(req.user, { suiteId, query, code, state, station, status }));
  }));
  // Row-level tile data — requires the `read_rows` scope (explicit opt-in per
  // key; rows can carry customer/ticketing personal data).
  app.get('/api/v1/tiles/rows', apiKeys.bearerAuth, apiKeys.auditware('rest'), perKey(120, 'apiv1'), apiKeys.requireScope('read_rows'), heavy, asyncHandler(async (req, res) => {
    res.json(await tileRows(req.user, { dashboardId: req.query.dashboardId, tileId: req.query.tileId, suiteId: req.query.suiteId, limit: req.query.limit }));
  }));

  console.log('[api] public /api/v1 read surface mounted');
  return { core };
}

module.exports = { mount };
