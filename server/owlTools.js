// ─── Owl tools — the agentic Owl's callable capabilities ──────────────────────
// FACTORY library (not a routes module): require('./owlTools')({ query, catalogue })
// → the tool registry. `query` is the shared query engine (server/query.js:
// applyScope + runLookerQuery); `catalogue` is the curated field set
// (server/owlCatalogueSeed.js by default).
//
// P1 ships ONE tool: askData (text-to-query, READ-ONLY, bounded to the curated
// catalogue). Every read passes through the SAME hard scope gate tiles use
// (applyScope → fail closed), so askData can never reach another client's or
// another event's data. P2 act-tools (draftCampaign…) register here as more
// entries of the same { schema, run } shape.
//
// See docs/specs/AGENTIC_OWL_SPEC.md (§4 tool registry, §5 askData) and
// docs/specs/AGENTIC_OWL_P1_PLAN.md (§4).

const defaultCatalogue = require('./owlCatalogueSeed');

module.exports = function createOwlTools({ query, auth, db, getGoalsApi, getAlertsApi, getCampaignsApi, resolveTileValue, getExploreFields, catalogue = defaultCatalogue }) {
  if (!query || !query.applyScope || !query.runLookerQuery) {
    throw new Error('owlTools requires the query engine (applyScope + runLookerQuery).');
  }
  const ORG = 'core_organisers.name'; // the canonical organiser lock field

  // Index the curated catalogue once: name → spec, plus filterable set.
  const measureByName = new Map(catalogue.measures.map((m) => [m.name, m]));
  const dimByName = new Map(catalogue.dimensions.map((d) => [d.name, d]));
  // Groupable = can be listed / grouped / returned. Filterable = can be a filter.
  // filterOnly dims (e.g. customer email) are filterable but NOT groupable — so you
  // can look a customer up by a known email, but can never enumerate/dump emails.
  const groupableDims = new Set(catalogue.dimensions.filter((d) => !d.filterOnly).map((d) => d.name));
  const filterableDims = new Set(catalogue.dimensions.filter((d) => d.filter || d.filterOnly).map((d) => d.name));

  // A structured, bounded refusal — never throws into the chat loop, so the Owl
  // can phrase "I can't answer that from your data" instead of erroring out.
  const refuse = (reason, message) => ({ ok: false, reason, message });

  // Apply the EVENT scope a suite pins (its locked filters). applyScope only forces
  // the ORGANISER (the security boundary); the suite's event lock is what makes a
  // selected event like "KFF 26" actually mean that event, not all the organiser's
  // events. We only apply locks valid in THIS explore (core_events.* or a curated
  // dimension) so we never inject a field Looker would reject, and never touch the
  // organiser field (left to applyScope). ANY_VALUE / blank locks are skipped.
  function applySuiteEventLocks(filters, suiteId) {
    if (!suiteId || !auth || !auth.lockedFiltersForSuite) return;
    let locks; try { locks = auth.lockedFiltersForSuite(suiteId) || {}; } catch { return; }
    for (const [key, val] of Object.entries(locks)) {
      if (val == null || val === '' || val === ' __ANY_VALUE__') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (!field || field === ORG) continue; // organiser handled by applyScope
      if ((/^core_events\./.test(field) || dimByName.has(field)) && filters[field] == null) {
        filters[field] = String(val);
      }
    }
  }

  // Contact / PII patterns kept OUT of group-by (mirrors the curated catalogue's
  // exclusions) — for dynamic dashboard explores we can't hand-curate each field, so
  // anything that looks like contact data is filter-only (lookup), never enumerable.
  const PII_PATTERNS = (catalogue.excluded && catalogue.excluded.patterns) || ['email', 'cellphone', 'phone', 'mobile', 'id_number', 'first_name', 'last_name', 'full_name', 'address'];
  const isPII = (name) => PII_PATTERNS.some((p) => String(name).toLowerCase().includes(String(p).toLowerCase()));

  // Load + access-check the dashboard in ctx (shared by getDashboard + queryDashboard).
  function loadDashboardForCtx(ctx) {
    const { user, suiteId, dashboardId } = ctx;
    if (!dashboardId) return { error: refuse('no_dashboard', 'Open a dashboard first, then ask me about it.') };
    if (!db || !db.getDashboard) return { error: refuse('unavailable', 'I can\'t read dashboards right now.') };
    const def = db.getDashboard(dashboardId);
    if (!def) return { error: refuse('not_found', 'I can\'t find that dashboard.') };
    if (user.role !== 'admin') {
      if (def.ownerEntityId && !(user.entityIds || []).includes(def.ownerEntityId)) return { error: refuse('no_access', 'No access to that dashboard.') };
      if (suiteId && auth && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) return { error: refuse('no_access', 'No access to that event.') };
    }
    return { def };
  }
  const flatTiles = (def) => [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  // The distinct (model, explore) a dashboard's data tiles use, most-used first.
  function dashboardExplores(def) {
    const counts = new Map();
    for (const t of flatTiles(def)) {
      const q = t && t.query;
      if (q && q.model && q.view && Array.isArray(q.fields) && q.fields.length) {
        const k = `${q.model}::${q.view}`;
        const e = counts.get(k) || { model: q.model, view: q.view, count: 0 };
        e.count += 1; counts.set(k, e);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }
  // Field names a dashboard's tiles actually reference (the "vetted, relevant" subset).
  function dashboardFieldNames(def) {
    const out = new Set();
    for (const t of flatTiles(def)) {
      const q = t && t.query; if (!q) continue;
      for (const f of (q.fields || [])) out.add(f);
      for (const k of Object.keys(q.filters || {})) out.add(k);
    }
    return out;
  }
  // Fetch an explore's measures/dimensions (cached upstream); PII dims are filterOnly.
  async function exploreSurface(model, view) {
    if (typeof getExploreFields !== 'function') return null;
    let f; try { f = await getExploreFields(model, view); } catch { return null; }
    if (!f) return null;
    return {
      model, view,
      measures: (f.measures || []).map((m) => ({ name: m.name, label: m.label || m.name, type: m.type, group: m.group_label || m.group || '' })),
      dimensions: (f.dimensions || []).map((d) => ({ name: d.name, label: d.label || d.name, type: d.type, group: d.group_label || d.group || '', filterOnly: isPII(d.name) })),
    };
  }
  // Apply the suite's event lock, but ONLY for fields that exist in the target explore
  // (so we never inject a filter Looker would reject on a non-ticketing explore).
  function applyExploreEventLocks(filters, suiteId, validField) {
    if (!suiteId || !auth || !auth.lockedFiltersForSuite) return;
    let locks; try { locks = auth.lockedFiltersForSuite(suiteId) || {}; } catch { return; }
    for (const [key, val] of Object.entries(locks)) {
      if (val == null || val === '' || val === ' __ANY_VALUE__') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (!field || field === ORG) continue;
      if (validField.has(field) && filters[field] == null) filters[field] = String(val);
    }
  }

  // ── askData ──────────────────────────────────────────────────────────────
  // args: { measure, dimensions?: string[], filters?: {field: value},
  //         dateRange?: <Looker date expr>, limit?: number }
  // ctx:  { user, suiteId? }  (resolved server-side — the browser never supplies scope)
  async function runAskData(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');

    // 1) Validate against the curated whitelist BEFORE touching Looker.
    // One or more measures (2+ → shown as separate coloured series on the chart).
    const measureList = [];
    if (args.measure) measureList.push(args.measure);
    for (const mm of (Array.isArray(args.measures) ? args.measures : [])) if (!measureList.includes(mm)) measureList.push(mm);
    if (!measureList.length) return refuse('unknown_measure', 'No measure specified.');
    for (const mm of measureList) if (!measureByName.has(mm)) return refuse('unknown_measure', `"${mm}" is not a measure I can read. Pick one of the curated measures.`);
    const measure = measureList[0];
    const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
    for (const d of dimensions) {
      if (!groupableDims.has(d)) {
        return refuse('unknown_dimension', dimByName.has(d)
          ? `"${d}" can only be used to look up a specific customer (a filter), never listed or grouped.`
          : `"${d}" is not a dimension I can group by.`);
      }
    }
    const filters = {};
    for (const [field, val] of Object.entries(args.filters || {})) {
      if (!filterableDims.has(field)) return refuse('unfilterable', `I can't filter on "${field}".`);
      if (val == null || String(val).trim() === '') continue;
      filters[field] = String(val);
    }
    // Date range rides the catalogue's canonical date dimension (the sell timeline).
    if (args.dateRange && String(args.dateRange).trim()) {
      filters[catalogue.dateDimension] = String(args.dateRange).trim();
    }

    // 2) Build the Looker query body (dimensions first, then the measure).
    const body = {
      model: catalogue.model,
      view: catalogue.explore,
      fields: [...dimensions, ...measureList],
      filters,
      sorts: [`${measure} desc`],
      limit: Math.min(Math.max(Number(args.limit) || 500, 1), 5000),
    };

    // 3) Apply the suite's EVENT lock (the event the user picked in the Owl) — the
    //    organiser scope below is forced separately.
    applySuiteEventLocks(body.filters, suiteId);

    // 4) THE SCOPE GATE — bind to the organiser(s) this user can ACCESS; never run
    //    platform-wide. Event context (suiteId) narrows to that event's organiser
    //    (same boundary as every tile, ceiling not override). If applyScope leaves
    //    it unscoped (an admin with no event context), bind to the user's accessible
    //    organisers (their entities / the previewed client). If neither yields a
    //    bound, refuse — fail closed, so the Owl can never aggregate across clients.
    const allowed = await query.applyScope(body, user, suiteId);
    if (allowed === false) {
      return refuse('no_scope', 'I can\'t tell which client\'s data to use here — open a client or an event first.');
    }
    if (!body.filters[ORG]) {
      const locks = auth && auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
      if (locks && locks[ORG]) {
        body.filters = { ...body.filters, ...locks };
      } else {
        return refuse('no_scope', 'I can\'t tell which client\'s data to answer for — open a client or an event first, and I\'ll scope to that organiser.');
      }
    }

    // 5) Run + return the grounding trail. /queries/run/json → array of row objects.
    const rows = await query.runLookerQuery('/queries/run/json', body);
    return {
      ok: true,
      rows: Array.isArray(rows) ? rows : [],
      count: Array.isArray(rows) ? rows.length : 0,
      measure,
      dimensions,
      queryBody: body, // stored in the audit ledger (tool_results)
    };
  }

  // Claude tool-use schema — enums lock the model to the curated catalogue, so it
  // physically cannot ask for an off-catalogue field. (Consumed by the chat loop, M3.)
  const askDataSchema = {
    name: 'askData',
    description:
      'Answer a question from the client\'s own ticketing data by running a bounded, scoped query over the curated "All Tickets" catalogue. Read-only. Returns rows; you then phrase the answer and cite the figures. Amounts are ZAR.',
    input_schema: {
      type: 'object',
      properties: {
        measure: { type: 'string', enum: catalogue.measures.map((m) => m.name), description: 'The number to compute.' },
        measures: { type: 'array', items: { type: 'string', enum: catalogue.measures.map((m) => m.name) }, description: 'Optional: list 2+ measures to compare side by side (e.g. revenue AND tickets sold) — they render as separate coloured series.' },
        dimensions: { type: 'array', items: { type: 'string', enum: catalogue.dimensions.filter((d) => !d.filterOnly).map((d) => d.name) }, description: 'Optional fields to break the measure down by (group-by). Customer email/phone are NOT here — they are filter-only.' },
        filters: { type: 'object', description: 'Optional {field: value} filters. Includes filter-only lookup fields like core_purchasers.email — set it to a specific known address to look up one customer\'s tickets. Never used to list/dump contacts.' },
        dateRange: { type: 'string', description: 'Optional Looker date expression on the purchase date, e.g. "last 7 days", "this month", "2026-01-01 to 2026-02-01".' },
        limit: { type: 'number', description: 'Max rows (default 500).' },
      },
      required: ['measure'],
    },
  };

  // ── getGoals ───────────────────────────────────────────────────────────────
  // Reads this EVENT's goals + how they're tracking (target, pace, forecast, vs
  // last time) from the goals module — no Looker query. Read-only, fail-safe. The
  // suiteId is access-checked by the chat route before we run.
  function slimGoal(g) { const out = { ...(g || {}) }; for (const k of ['series', 'curve', 'sparkline', 'history', 'checkpointsSeries']) delete out[k]; return out; }
  async function runGetGoals(_args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    if (!suiteId && !entityId) return refuse('no_event', 'Open or pick an event (or client) first.');
    if (suiteId && user.role !== 'admin' && auth && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) return refuse('no_access', 'No access to that event.');
    const goalsApi = typeof getGoalsApi === 'function' ? getGoalsApi() : null;
    if (!goalsApi || !goalsApi.listGoals) return refuse('unavailable', 'Goals aren\'t available right now.');
    const caches = goalsApi.makeGoalCaches ? goalsApi.makeGoalCaches() : null;
    const attach = async (g, eventName) => { try { const p = await goalsApi.attachProgress(g, user, caches); return eventName ? { ...p, eventName } : p; } catch { return g; } };
    try {
      // 1) An event is selected → that event's goals (event-scoped AND the user's personal).
      if (suiteId) {
        let goals = goalsApi.listGoals(suiteId) || [];
        if (goalsApi.listPersonalGoals) { try { goals = goals.concat(goalsApi.listPersonalGoals(suiteId, user) || []); } catch { /* ignore */ } }
        if (goals.length) {
          const out = []; for (const g of goals.slice(0, 12)) out.push(slimGoal(await attach(g)));
          return { ok: true, goals: out };
        }
      }
      // 2) No event selected (client scope), OR the selected event has none → gather the
      //    client's goals across its events, each tagged with its event name. (This is the
      //    common case: the user picks a client but no specific event, so suiteId is empty.)
      const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
      if (eid && db && db.listSuitesForEntity) {
        const gathered = [];
        for (const s of (db.listSuitesForEntity(eid) || [])) {
          if (s.id === suiteId) continue; // already tried above
          for (const g of (goalsApi.listGoals(s.id) || [])) gathered.push({ g, name: s.name });
          if (gathered.length >= 12) break;
        }
        if (gathered.length) {
          const out = []; for (const { g, name } of gathered.slice(0, 12)) out.push(slimGoal(await attach(g, name)));
          const note = suiteId
            ? 'No goals are set on the selected event; these are goals on the client\'s other events (each tagged with its event).'
            : 'No single event is selected, so these are the client\'s goals across all of its events (each tagged with its event). Pick an event above to focus on just that one.';
          return { ok: true, goals: out, note };
        }
      }
      return { ok: true, goals: [], note: suiteId ? 'No goals set for this event yet.' : 'No goals set for this client yet.' };
    } catch { return refuse('error', 'Couldn\'t read the goals for this event.'); }
  }
  const getGoalsSchema = {
    name: 'getGoals',
    description: 'Get THIS event\'s goals and how they are tracking — target, current value, pace (ahead/on-track/behind), forecast landing, and vs last time, leading with the North Star. Use for any question about goals, targets, the North Star, or "are we on track". Read-only; amounts are ZAR.',
    input_schema: { type: 'object', properties: {} },
  };

  // ── getDashboard ─────────────────────────────────────────────────────────────
  // Reads the dashboard the user is currently viewing — each data tile's current
  // headline value, scoped to the selected event (same scope path as the tile uses
  // on screen). Read-only, fail-safe. The dashboardId rides in ctx (set by the chat
  // route from the page the user is on); no Looker field is exposed to the model.
  async function runGetDashboard(_args = {}, ctx = {}) {
    const { user, suiteId, dashboardId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const loaded = loadDashboardForCtx(ctx);
    if (loaded.error) return loaded.error;
    const def = loaded.def;
    if (typeof resolveTileValue !== 'function') return refuse('unavailable', 'I can\'t read dashboards right now.');
    // 1) Tile overview — each data tile's current headline value, scoped to the event.
    const dataTiles = flatTiles(def).filter((t) => t && t.type !== 'text' && t.query && Array.isArray(t.query.fields) && t.query.fields.length);
    const CAP = 16;
    const tiles = [];
    for (const t of dataTiles.slice(0, CAP)) {
      let value = null;
      try { value = await resolveTileValue({ dashboardId, tileId: t.id, user, suiteId }); } catch { value = null; }
      const q = t.query || {};
      tiles.push({
        title: t.title || '(untitled)', value,
        visType: (t.vis && t.vis.type) || '', context: t.aiContext || '',
        // The tile's query surface — so the model can explain what each tile measures
        // and a fix-brief can show the explore/fields/filters behind a number.
        explore: [q.model, q.view].filter(Boolean).join('/'),
        fields: Array.isArray(q.fields) ? q.fields : [],
        filters: q.filters && typeof q.filters === 'object' ? q.filters : {},
      });
    }
    const text = flatTiles(def).filter((t) => t && t.type === 'text' && t.body_text)
      .slice(0, 4).map((t) => ({ title: t.title || '', body: String(t.body_text).slice(0, 400) }));
    // 2) The queryable surface — the dashboard's primary explore + the measures and
    //    dimensions ITS TILES use (so the model can ask deeper questions via
    //    queryDashboard). Compact: only the fields this dashboard actually exposes.
    const explores = dashboardExplores(def);
    let fields = null;
    if (explores[0]) {
      const surf = await exploreSurface(explores[0].model, explores[0].view);
      if (surf) {
        // Expose the FULL explore surface so the user can ask anything the dataset
        // supports (not just what's already on a tile) — PII dims are lookup-only, and
        // we mark which fields the dashboard's own tiles use so the model can lead with
        // those. Capped to keep the model's context manageable.
        const used = dashboardFieldNames(def);
        const MCAP = 40; const DCAP = 60;
        fields = {
          explore: surf.view, model: surf.model,
          measures: surf.measures.slice(0, MCAP).map((m) => ({ name: m.name, label: m.label, onDashboard: used.has(m.name) || undefined })),
          dimensions: surf.dimensions.filter((d) => !d.filterOnly).slice(0, DCAP).map((d) => ({ name: d.name, label: d.label, group: d.group, onDashboard: used.has(d.name) || undefined })),
          lookupOnly: surf.dimensions.filter((d) => d.filterOnly).map((d) => d.name).slice(0, 20),
          truncated: (surf.measures.length > MCAP || surf.dimensions.length > DCAP) || undefined,
        };
      }
    }
    return {
      ok: true,
      dashboard: { id: dashboardId, title: def.title || 'Dashboard', explores: explores.map((e) => e.view) },
      tiles, text, fields,
      note: dataTiles.length > CAP ? `Showing the first ${CAP} of ${dataTiles.length} data tiles.` : undefined,
    };
  }
  const getDashboardSchema = {
    name: 'getDashboard',
    description: 'Read the dashboard the user is currently viewing: its tiles + each tile\'s current headline value, AND its queryable data surface (the measures/dimensions its data exposes, in "fields"). Use for "this dashboard / what is this telling me / which number is highest", and ALWAYS call it first when the user wants to dig into the dashboard\'s data so you can then call queryDashboard with valid field names. Read-only; ZAR. ok:false if no dashboard is open.',
    input_schema: { type: 'object', properties: {} },
  };

  // ── queryDashboard ───────────────────────────────────────────────────────────
  // Run a fresh, bounded, scoped query against the CURRENT dashboard's own explore —
  // so the user can ask deeper questions than the tiles show (re-group, break down,
  // trend, filter), over whatever dataset the dashboard is built on. Field names come
  // from getDashboard's "fields". Scope is enforced the same way tiles are (applyScope,
  // fail-closed) plus the suite's event lock (only for fields the explore has).
  async function runQueryDashboard(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const loaded = loadDashboardForCtx(ctx);
    if (loaded.error) return loaded.error;
    const def = loaded.def;
    const explores = dashboardExplores(def);
    if (!explores.length) return refuse('no_data', 'This dashboard has no queryable data tiles.');
    // Pick the explore (default = the dashboard's primary; the model may name another).
    let target = explores[0];
    if (args.explore) {
      const t = explores.find((e) => e.view === args.explore || `${e.model}::${e.view}` === args.explore);
      if (!t) return refuse('unknown_explore', `This dashboard doesn't use "${args.explore}". It uses: ${explores.map((e) => e.view).join(', ')}.`);
      target = t;
    }
    const surf = await exploreSurface(target.model, target.view);
    if (!surf) return refuse('unavailable', 'I couldn\'t read that dashboard\'s fields.');
    const measureByName = new Map(surf.measures.map((m) => [m.name, m]));
    const dimByName = new Map(surf.dimensions.map((d) => [d.name, d]));
    const validField = new Set([...measureByName.keys(), ...dimByName.keys()]);
    const someMeasures = () => surf.measures.slice(0, 30).map((m) => m.name).join(', ');
    // Validate measures, dimensions and filters against the explore's real fields.
    const measureList = [];
    if (args.measure) measureList.push(args.measure);
    for (const mm of (Array.isArray(args.measures) ? args.measures : [])) if (!measureList.includes(mm)) measureList.push(mm);
    if (!measureList.length) return refuse('unknown_measure', `Pick a measure from this dashboard's data. Available: ${someMeasures()}.`);
    for (const mm of measureList) if (!measureByName.has(mm)) return refuse('unknown_measure', `"${mm}" isn't a measure on this dashboard's data. Available: ${someMeasures()}.`);
    const measure = measureList[0];
    const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
    for (const d of dimensions) {
      if (!dimByName.has(d)) return refuse('unknown_dimension', `"${d}" isn't a dimension on this dashboard's data.`);
      if (dimByName.get(d).filterOnly) return refuse('unknown_dimension', `"${d}" is contact/PII — it can only filter a lookup, never be grouped or listed.`);
    }
    const filters = {};
    for (const [field, val] of Object.entries(args.filters || {})) {
      if (!validField.has(field)) return refuse('unfilterable', `I can't filter on "${field}" on this dashboard's data.`);
      if (val == null || String(val).trim() === '') continue;
      filters[field] = String(val);
    }
    if (args.dateRange && String(args.dateRange).trim()) {
      const dateDim = (args.dateField && validField.has(args.dateField)) ? args.dateField
        : (surf.dimensions.find((d) => /date|time/i.test(String(d.type || ''))) || {}).name;
      if (dateDim) filters[dateDim] = String(args.dateRange).trim();
    }
    const body = {
      model: target.model, view: target.view,
      fields: [...dimensions, ...measureList], filters,
      sorts: [`${measure} desc`], limit: Math.min(Math.max(Number(args.limit) || 500, 1), 5000),
    };
    // Event lock (only fields this explore has), then the hard organiser scope.
    applyExploreEventLocks(body.filters, suiteId, validField);
    const before = new Set(Object.keys(body.filters));
    const allowed = await query.applyScope(body, user, suiteId);
    if (allowed === false) return refuse('no_scope', 'I can\'t tell which client\'s data to use here — open the dashboard under a client or event first.');
    const addedScope = Object.keys(body.filters).some((k) => !before.has(k));
    if (!addedScope && !body.filters[ORG]) {
      // applyScope imposed no restriction (a broad admin with no event) — bind to the
      // user's accessible organisers if this explore exposes the organiser field, else refuse.
      const locks = auth && auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
      if (locks && locks[ORG] && validField.has(ORG)) body.filters = { ...body.filters, ...locks };
      else return refuse('no_scope', 'Open this dashboard under a specific client or event so I can scope its data safely.');
    }
    const rows = await query.runLookerQuery('/queries/run/json', body);
    return { ok: true, rows: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0, measure, dimensions, explore: target.view, queryBody: body };
  }
  const queryDashboardSchema = {
    name: 'queryDashboard',
    description: 'Run a fresh, bounded query against the CURRENT dashboard\'s own data to answer a deeper question than the tiles show — re-group, break down, trend or filter it. Call getDashboard FIRST to get the valid field names ("fields"), then pass measure/dimensions/filters using those exact names. Scoped to the selected event; read-only; amounts ZAR. Returns rows you then phrase + cite (a breakdown auto-charts, like askData).',
    input_schema: {
      type: 'object',
      properties: {
        measure: { type: 'string', description: 'Measure field name from getDashboard.fields.measures (e.g. core_tickets.count).' },
        measures: { type: 'array', items: { type: 'string' }, description: 'Optional 2+ measures to compare side by side (separate coloured series).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Optional dimension field names to break the measure down by (group-by). Contact/PII fields can\'t be grouped.' },
        filters: { type: 'object', description: 'Optional {field: value} filters using this dashboard\'s field names.' },
        dateRange: { type: 'string', description: 'Optional Looker date expression (e.g. "last 7 days"), applied to the data\'s date dimension.' },
        dateField: { type: 'string', description: 'Optional explicit date dimension for dateRange.' },
        explore: { type: 'string', description: 'Optional: which of the dashboard\'s explores to query (default = its primary).' },
        limit: { type: 'number', description: 'Max rows (default 500).' },
      },
      required: ['measure'],
    },
  };

  // ── getAlerts ────────────────────────────────────────────────────────────────
  // This event's metric alerts (threshold watchers) + their current state. Read-only.
  // Per-suite; if only a client is in scope, gather across the client's events. Strips
  // delivery internals (no SMS recipient numbers / channels).
  function slimAlert(a, eventName) {
    if (!a) return null;
    const metric = a.source === 'tile' ? (a.tileName || a.dashboardName || a.name) : (a.metricLabel || a.measureLabel || a.measure || a.name);
    const OP = { gte: '≥', lte: '≤', gt: '>', lt: '<' };
    return {
      name: a.name, watching: metric, condition: `${OP[a.operator] || a.operator} ${a.threshold}${a.unit ? ' ' + a.unit : ''}`,
      status: a.status, state: a.state, // active|paused, armed|triggered
      lastValue: a.lastValue, lastFiredAt: a.lastFiredAt || '', fireCount: a.fireCount || 0,
      priority: a.priority, frequency: a.frequency,
      ...(eventName ? { eventName } : {}),
    };
  }
  async function runGetAlerts(_args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    if (!suiteId && !entityId) return refuse('no_event', 'Open or pick an event (or client) first.');
    if (suiteId && user.role !== 'admin' && auth && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) return refuse('no_access', 'No access to that event.');
    const alertsApi = typeof getAlertsApi === 'function' ? getAlertsApi() : null;
    if (!alertsApi || !alertsApi.listForSuite) return refuse('unavailable', 'Alerts aren\'t available right now.');
    try {
      if (suiteId) {
        const list = (alertsApi.listForSuite(suiteId) || []).slice(0, 40).map((a) => slimAlert(a));
        return { ok: true, alerts: list, note: list.length ? undefined : 'No alerts set on this event yet.' };
      }
      const eid = entityId || (db && db.getSuite && suiteId ? (db.getSuite(suiteId) || {}).entityId : null);
      const gathered = [];
      if (eid && db && db.listSuitesForEntity) {
        for (const s of (db.listSuitesForEntity(eid) || [])) {
          for (const a of (alertsApi.listForSuite(s.id) || [])) gathered.push(slimAlert(a, s.name));
          if (gathered.length >= 40) break;
        }
      }
      return { ok: true, alerts: gathered.slice(0, 40), note: gathered.length ? 'Alerts across the client\'s events (each tagged with its event).' : 'No alerts set for this client yet.' };
    } catch { return refuse('error', 'Couldn\'t read the alerts.'); }
  }
  const getAlertsSchema = {
    name: 'getAlerts',
    description: 'Get this event\'s metric ALERTS (threshold watchers) and their current state — what each is watching, its condition, whether it is active/paused and armed/triggered, its last value and when it last fired. Use for questions about alerts, alarms, thresholds, "what am I being notified about", or "has anything triggered". Read-only.',
    input_schema: { type: 'object', properties: {} },
  };

  // ── getCampaigns ─────────────────────────────────────────────────────────────
  // The client's email/SMS campaigns + their results. Read-only, per-CLIENT (campaigns
  // can span events). Never returns the audience list (PII) — only a recipient count.
  function slimCampaign(a) {
    const c = a.config || {}; const r = a.results || {};
    return {
      title: a.title || '(untitled)', status: a.status, // draft|scheduled|running|done|failed|pending
      channel: c.channel || 'email', mode: c.campaignMode || 'once',
      recipients: a.audienceCount != null ? a.audienceCount : undefined,
      sent: r.sent || 0, opens: r.opens || 0, clicks: r.clicks || 0, converted: r.converted || 0, failed: r.failed || 0,
      startedAt: r.startedAt || '', finishedAt: r.finishedAt || '', createdAt: a.createdAt || '',
    };
  }
  async function runGetCampaigns(_args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!eid) return refuse('no_client', 'Open or pick a client first.');
    if (user.role !== 'admin' && !(user.entityIds || []).includes(eid)) return refuse('no_access', 'No access to that client.');
    const campaignsApi = typeof getCampaignsApi === 'function' ? getCampaignsApi() : null;
    if (!campaignsApi || !campaignsApi.listForEntity) return refuse('unavailable', 'Campaigns aren\'t available right now.');
    try {
      const list = (campaignsApi.listForEntity(eid) || []).slice(0, 25).map(slimCampaign);
      return { ok: true, campaigns: list, note: list.length ? undefined : 'No campaigns for this client yet.' };
    } catch { return refuse('error', 'Couldn\'t read the campaigns.'); }
  }
  const getCampaignsSchema = {
    name: 'getCampaigns',
    description: 'Get the client\'s email/SMS CAMPAIGNS and how they performed — title, status (draft/scheduled/running/done), channel, recipient count, and results (sent, opens, clicks, conversions). Use for questions about campaigns, sends, marketing, "what have we sent", open/click rates. Read-only; never lists individual contacts.',
    input_schema: { type: 'object', properties: {} },
  };

  return {
    catalogue,
    askData: { schema: askDataSchema, run: runAskData },
    getGoals: { schema: getGoalsSchema, run: runGetGoals },
    getDashboard: { schema: getDashboardSchema, run: runGetDashboard },
    queryDashboard: { schema: queryDashboardSchema, run: runQueryDashboard },
    getAlerts: { schema: getAlertsSchema, run: runGetAlerts },
    getCampaigns: { schema: getCampaignsSchema, run: runGetCampaigns },
  };
};
