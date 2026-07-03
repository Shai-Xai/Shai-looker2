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
// The alert option lists live in server/alerts.js — import them so createAlert's tool
// schema + validation track that module automatically (add an operator/channel/priority
// there and the Owl can immediately set + ask for it; no second list to keep in sync).
const { OPERATORS: ALERT_OPERATORS, CHANNELS: ALERT_CHANNELS, PRIORITIES: ALERT_PRIORITIES } = require('./alerts');
const reportingTz = require('./timezone');

module.exports = function createOwlTools({ query, auth, db, getGoalsApi, getAlertsApi, getCampaignsApi, getUploadsApi, getDriveApi, getMetaAdsApi, resolveTileValue, getExploreFields, getFieldOverrides, draftCampaignCopy, designEmailFn, getSegmentsApi, getEventOpsApi, catalogue = defaultCatalogue }) {
  if (!query || !query.applyScope || !query.runLookerQuery) {
    throw new Error('owlTools requires the query engine (applyScope + runLookerQuery).');
  }
  const ORG = 'core_organisers.name'; // the canonical organiser lock field
  // Stamp the client's reporting timezone onto a FRESH Owl query body so Looker
  // resolves relative date filters ("today"/"this week") on the client's local
  // calendar day — the cashless `dateRange="today"` = zero-rows fix. Only set it
  // when the body doesn't already carry one; harmless on date-free queries.
  function stampReportingTz(body, ctx) {
    if (body && !body.query_timezone) body.query_timezone = reportingTz.reportingTimezoneFor(db, ctx || {});
    return body;
  }
  // Zero rows + caller-supplied filters is USUALLY a case/spelling miss — Looker
  // string filters are exact and case-sensitive ("Bar" ≠ "bar"). Say so in the
  // result, so the Owl checks the field's real values instead of concluding
  // "no data" (or blaming the date filter — how issue #28's retest went wrong).
  const emptyFilterNote = (userFilters) => ((userFilters && Object.keys(userFilters).length)
    ? 'No rows matched. Filter values are exact and CASE-SENSITIVE ("Bar" ≠ "bar") — group by the filtered field WITHOUT the filter to see its real values, then retry with the exact value.'
    : undefined);
  // A grouped result where EVERY row repeats the IDENTICAL measure value is almost
  // always a Looker fan-out: the group-by dimension doesn't actually relate to the
  // measured view in this explore, so the ungrouped total is repeated once per
  // dimension value (e.g. check-ins by sales station → 185 rows of "4"). Those
  // numbers look like a real breakdown but are meaningless — say so in the result
  // so the Owl re-queries instead of confidently presenting garbage.
  const FANOUT_MIN_ROWS = 8;
  function fanOutNote(rows, measureList, dimensions) {
    if (!Array.isArray(rows) || rows.length < FANOUT_MIN_ROWS) return undefined;
    if (!Array.isArray(dimensions) || !dimensions.length) return undefined;
    if (!Array.isArray(measureList) || !measureList.length) return undefined;
    const uniform = measureList.every((m) => {
      const v0 = rows[0] ? rows[0][m] : undefined;
      return v0 !== undefined && rows.every((r) => r && r[m] === v0);
    });
    if (!uniform) return undefined;
    const family = String(measureList[0]).split('.')[0];
    return `SUSPECT RESULT — every row repeats the identical measure value, which means the group-by dimension(s) don't relate to this measure in this explore (Looker repeated the ungrouped total per row). Do NOT present this as a breakdown. Re-query grouping "${measureList[0]}" by a dimension from its own data family (a ${family}.* field or a dimension whose label shares its family), or drop the group-by for the true total.`;
  }
  // The first applicable note wins (they're mutually exclusive: empty vs many rows).
  const resultNote = (rows, measureList, dimensions, userFilters) => ((!Array.isArray(rows) || !rows.length)
    ? emptyFilterNote(userFilters)
    : fanOutNote(rows, measureList, dimensions));
  // Resolver for the createSegment act-tool's preview (count + per-channel reach).
  // Server-side only; never returns the people list to the chat. Same scope gate.
  const { resolveQueryAudience } = require('./audienceQuery')({ auth, db, catalogue });
  // Per-client SMS sub-cap (shared with the campaign engine) — so a drafted SMS/both
  // campaign shows the honest capped SMS reach, not the full consenting count.
  const { clampSmsCap } = require('./audienceMap');
  const smsCapFor = (entityId) => clampSmsCap(db && db.getSetting ? db.getSetting(`sms_cap:${entityId}`, '') : '');

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
  function applySuiteEventLocks(filters, suiteId, dims = dimByName) {
    if (!suiteId || !auth || !auth.lockedFiltersForSuite) return;
    let locks; try { locks = auth.lockedFiltersForSuite(suiteId) || {}; } catch { return; }
    for (const [key, val] of Object.entries(locks)) {
      if (val == null || val === '' || val === ' __ANY_VALUE__') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (!field || field === ORG) continue; // organiser handled by applyScope
      if ((/^core_events\./.test(field) || dims.has(field)) && filters[field] == null) {
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
  // The single field overlay (server/owlFields.js), keyed by field name. Looker labels
  // are the base; this overlays an admin's label rename + synonyms + typical questions,
  // applied EVERYWHERE a field appears (askData via owlChat, and dashboard explores here)
  // so the same field reads the same way across the Owl.
  const fieldOverlay = () => { try { return (typeof getFieldOverrides === 'function' && getFieldOverrides()) || {}; } catch { return {}; } };
  const withOverlay = (f, ov) => { const o = ov[f.name]; return o ? { ...f, label: (o.label && o.label.trim()) || f.label, aka: o.aka || [], questions: o.questions || [] } : f; };
  async function exploreSurface(model, view) {
    if (typeof getExploreFields !== 'function') return null;
    let f; try { f = await getExploreFields(model, view); } catch { return null; }
    if (!f) return null;
    const ov = fieldOverlay();
    return {
      model, view,
      measures: (f.measures || []).map((m) => withOverlay({ name: m.name, label: m.label || m.name, type: m.type, group: m.group_label || m.group || '' }, ov)),
      dimensions: (f.dimensions || []).map((d) => withOverlay({ name: d.name, label: d.label || d.name, type: d.type, group: d.group_label || d.group || '', filterOnly: isPII(d.name) }, ov)),
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
    //    (same boundary as every tile, ceiling not override). If neither yields a
    //    bound, refuse — fail closed, so the Owl can never aggregate across clients.
    const allowed = await query.applyScope(body, user, suiteId);
    if (allowed === false) {
      return refuse('no_scope', 'I can\'t tell which client\'s data to use here — open a client or an event first.');
    }
    // 4b) Bind to the SINGLE client in context (entityId). Critical: with no event,
    //     applyScope scopes a MULTI-ENTITY user to the UNION of their organisers — so
    //     without this, a chat with only a client in scope (e.g. the WhatsApp door,
    //     which passes entityId and no suiteId) would aggregate across that user's
    //     other clients. Narrowing to entityId is a tightening within the user's own
    //     organisers (never a widening); fail closed if it can't be bound.
    if (entityId && auth && auth.accessibleOrgFilters) {
      const locks = auth.accessibleOrgFilters(user, entityId);
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else if (!body.filters[ORG]) return refuse('no_scope', 'I can\'t tell which client\'s data to answer for — open a client or an event first.');
    } else if (!body.filters[ORG]) {
      const locks = auth && auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else return refuse('no_scope', 'I can\'t tell which client\'s data to answer for — open a client or an event first, and I\'ll scope to that organiser.');
    }

    // 5) Run + return the grounding trail. /queries/run/json → array of row objects.
    //    A Looker error (e.g. a field that isn't in this explore) becomes a structured
    //    refusal so the Owl can say "I couldn't run that" instead of crashing the turn.
    stampReportingTz(body, { user, suiteId, entityId });
    let rows;
    try {
      rows = await query.runLookerQuery('/queries/run/json', body);
    } catch (e) {
      return refuse('query_failed', `I couldn't run that query over your data${e && e.message ? ` (${String(e.message).slice(0, 140)})` : ''}. Try rephrasing or a different breakdown.`);
    }
    const note = resultNote(rows, measureList, dimensions, args.filters);
    return {
      ok: true,
      rows: Array.isArray(rows) ? rows : [],
      count: Array.isArray(rows) ? rows.length : 0,
      measure,
      dimensions,
      queryBody: body, // stored in the audit ledger (tool_results)
      ...(note ? { note } : {}),
    };
  }

  // Claude tool-use schema — enums lock the model to the curated catalogue, so it
  // physically cannot ask for an off-catalogue field. (Consumed by the chat loop, M3.)
  const askDataSchema = {
    name: 'askData',
    description:
      'Answer a question from the client\'s own ticketing data by running a bounded, scoped query over the curated "All Tickets" catalogue. Read-only. Returns rows; you then phrase the answer and cite the figures. Money is in the client\'s reporting currency (see the Currency note; default ZAR).',
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
          measures: surf.measures.slice(0, MCAP).map((m) => ({ name: m.name, label: m.label, aka: (m.aka || []).length ? m.aka : undefined, questions: (m.questions || []).length ? m.questions : undefined, onDashboard: used.has(m.name) || undefined })),
          dimensions: surf.dimensions.filter((d) => !d.filterOnly).slice(0, DCAP).map((d) => ({ name: d.name, label: d.label, group: d.group, aka: (d.aka || []).length ? d.aka : undefined, onDashboard: used.has(d.name) || undefined })),
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
    stampReportingTz(body, { user, suiteId, entityId });
    const rows = await query.runLookerQuery('/queries/run/json', body);
    const note = resultNote(rows, measureList, dimensions, args.filters);
    return { ok: true, rows: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0, measure, dimensions, explore: target.view, queryBody: body, ...(note ? { note } : {}) };
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

  // ── askUpload ────────────────────────────────────────────────────────────────
  // Query an ATTACHED external table (a CSV file or live Google Sheet the user added),
  // computed in-memory (no Looker). Filter / group-by / aggregate, returning rows the
  // model phrases — and can set side-by-side with askData to answer across sources.
  async function runAskUpload(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!eid) return refuse('no_client', 'Open or pick a client first.');
    const api = typeof getUploadsApi === 'function' ? getUploadsApi() : null;
    if (!api || !api.listUploads) return refuse('unavailable', 'Attachments aren\'t available right now.');
    const list = api.listUploads(eid);
    if (!list.length) return { ok: true, rows: [], note: 'No files or sheets are attached for this client yet — use the 📎 attach button to add a CSV or a Google Sheet.' };
    // Resolve which attached source: explicit id, fuzzy name match, or the only one.
    let pick = null;
    if (args.uploadId) pick = list.find((u) => u.id === args.uploadId);
    else if (args.name) pick = list.find((u) => u.name.toLowerCase().includes(String(args.name).toLowerCase()));
    else if (list.length === 1) pick = list[0];
    if (!pick) return { ok: false, reason: 'which_source', message: `Which attached source? ${list.map((u) => `"${u.name}"`).join(', ')}`, sources: list.map((u) => ({ name: u.name, columns: u.columns.map((c) => c.name) })) };
    const up = api.getUpload(pick.id);
    if (!up) return refuse('not_found', 'That attachment is gone.');
    const colByName = new Map(up.columns.map((c) => [c.name, c]));
    const dims = (Array.isArray(args.dimensions) ? args.dimensions : []).filter((d) => colByName.has(d));
    const measure = args.measure && colByName.has(args.measure) ? args.measure : null;
    const agg = ['sum', 'avg', 'count', 'min', 'max'].includes(args.agg) ? args.agg : 'sum';
    const num = api.toNum || ((v) => Number(v));
    let rows = up.rows;
    for (const [f, v] of Object.entries(args.filters || {})) { if (colByName.has(f) && v != null && String(v).trim() !== '') rows = rows.filter((r) => String(r[f]).toLowerCase() === String(v).toLowerCase()); }
    let columns; let outRows;
    if (!dims.length && !measure) { // no aggregation → raw rows for the columns
      columns = up.columns.map((c) => ({ field: c.name, label: c.label, kind: c.type === 'number' ? 'measure' : 'dimension' }));
      outRows = rows.slice(0, 200);
    } else {
      const groups = new Map();
      for (const r of rows) { const key = dims.map((d) => r[d]).join(''); if (!groups.has(key)) groups.set(key, { vals: dims.map((d) => r[d]), items: [] }); groups.get(key).items.push(r); }
      const mLabel = measure ? `${agg} of ${colByName.get(measure).label}` : 'Count';
      columns = [...dims.map((d) => ({ field: d, label: colByName.get(d).label, kind: 'dimension' })), { field: '__m', label: mLabel, kind: 'measure' }];
      outRows = [...groups.values()].map((g) => {
        const o = {}; dims.forEach((d, i) => { o[d] = g.vals[i]; });
        if (!measure) o.__m = g.items.length;
        else { const ns = g.items.map((r) => num(r[measure])).filter(Number.isFinite); o.__m = agg === 'count' ? ns.length : agg === 'avg' ? (ns.reduce((a, b) => a + b, 0) / (ns.length || 1)) : agg === 'min' ? Math.min(...ns) : agg === 'max' ? Math.max(...ns) : ns.reduce((a, b) => a + b, 0); }
        return o;
      }).sort((a, b) => (Number(b.__m) || 0) - (Number(a.__m) || 0)).slice(0, Math.min(Math.max(Number(args.limit) || 500, 1), 2000));
    }
    return { ok: true, source: up.name, columns, rows: outRows, count: outRows.length, measure: measure || '__m', dimensions: dims };
  }
  const askUploadSchema = {
    name: 'askUpload',
    description: 'Query data the user ATTACHED (a CSV file or a live Google Sheet) — not the ticketing data. Filter, group-by and aggregate it. To answer across BOTH sources (e.g. uploaded budget vs actual revenue), call askData AND askUpload, then combine in your answer. Call with no measure/dimensions to see the raw rows + column names first. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Which attached source to query (fuzzy name match). Omit if there is only one.' },
        measure: { type: 'string', description: 'A numeric column to aggregate.' },
        agg: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'], description: 'How to aggregate the measure (default sum).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Column(s) to group by.' },
        filters: { type: 'object', description: 'Optional {column: value} exact-match filters.' },
        limit: { type: 'number' },
      },
    },
  };

  // ── Drive documents (Google Drive connector) ───────────────────────────────────
  // Read-only grounding over the client's OWN shared Drive files — the Docs/Slides/
  // PDF text that server/googleDrive.js synced. (Drive Sheets/CSVs become attached
  // TABLES and are queried via askUpload instead.) Entity-scoped: the drive API only
  // ever returns this client's rows, and docId reads re-check ownership server-side.
  function driveCtx(ctx) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return { err: refuse('no_user', 'No authenticated user.') };
    const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!eid) return { err: refuse('no_client', 'Open or pick a client first.') };
    const api = typeof getDriveApi === 'function' ? getDriveApi() : null;
    if (!api || !api.searchDocs) return { err: refuse('unavailable', 'Drive documents aren\'t available right now.') };
    return { eid, api };
  }
  function runSearchDriveDocs(args = {}, ctx = {}) {
    const { err, eid, api } = driveCtx(ctx); if (err) return err;
    const results = api.searchDocs(eid, String(args.query || ''));
    if (!results.length) return { ok: true, results: [], note: 'No Drive documents matched. Files are shared with the Owl under Settings → Integrations → Google Drive.' };
    return { ok: true, results, note: 'Quote figures exactly as written and cite the document name.' };
  }
  const searchDriveDocsSchema = {
    name: 'searchDriveDocs',
    description: 'Search the client\'s connected Google Drive DOCUMENTS (Docs, Slides, PDFs synced as text) by name or content. Returns matching files with a snippet. Use readDriveDoc to read one. Drive SHEETS are attached tables — query those with askUpload. Read-only.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Word or phrase to find (matches file names and text). Empty lists all documents.' } } },
  };
  function runReadDriveDoc(args = {}, ctx = {}) {
    const { err, eid, api } = driveCtx(ctx); if (err) return err;
    const doc = api.readDoc(eid, { docId: args.docId, name: args.name, offset: Number(args.offset) || 0 });
    if (!doc) return refuse('not_found', 'No Drive document matched — call searchDriveDocs to see what\'s connected.');
    return { ok: true, ...doc, note: doc.more ? `Document continues — call readDriveDoc again with offset ${doc.nextOffset} for the next part.` : 'End of document.' };
  }
  const readDriveDocSchema = {
    name: 'readDriveDoc',
    description: 'Read the TEXT of one connected Drive document (Doc/Slides/PDF), in chunks. Ground your answer on this text and cite the document name; never invent content. Long documents: page through with offset.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Document name (fuzzy match). Or pass docId from searchDriveDocs.' },
      docId: { type: 'string', description: 'Exact document id from searchDriveDocs.' },
      offset: { type: 'number', description: 'Character offset to continue from (default 0).' },
    } },
  };

  // ── getPaidPerformance — Meta ads results (deep Meta P1) ───────────────────────
  // Read-only report over meta_ad_insights (synced by server/metaAds.js): spend,
  // clicks, purchases + purchase value, CPC, cost-per-purchase, ROAS — totals and
  // per-campaign. Entity-scoped; numbers come straight from the table, never invented.
  function runGetPaidPerformance(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!eid) return refuse('no_client', 'Open or pick a client first.');
    const api = typeof getMetaAdsApi === 'function' ? getMetaAdsApi() : null;
    if (!api || !api.report) return refuse('unavailable', 'Paid performance isn\'t available right now.');
    const rep = api.report(eid, Number(args.days) || 28);
    if (!rep.configured) return { ok: false, reason: 'not_configured', message: 'Meta ads aren\'t connected for this client — the token + ad account go in Settings → Integrations → Meta.' };
    if (!rep.campaigns.length) return { ok: true, days: rep.days, totals: rep.totals, campaigns: [], note: 'No paid activity recorded in this window — try Sync on the Social page, or a longer period.' };
    return {
      ok: true, days: rep.days, currency: rep.currency || 'account currency', lastSync: rep.lastSync,
      totals: rep.totals, campaigns: rep.campaigns.slice(0, 15),
      note: 'roas = purchase value ÷ spend (Meta-attributed). Quote spend/ROAS with the currency. purchases/purchaseValue are Meta pixel conversions, not Howler ticket sales — say so if asked about revenue.',
    };
  }
  const getPaidPerformanceSchema = {
    name: 'getPaidPerformance',
    description: 'Meta (Facebook/Instagram) PAID ads performance for this client: spend, impressions, clicks, purchases, purchase value, CPC, cost-per-purchase and ROAS — totals, per-campaign and last-sync time. Use for "how are my ads doing", "what did we spend", "which campaign converts best". Read-only.',
    input_schema: { type: 'object', properties: { days: { type: 'number', description: 'Window in days (default 28, max 90).' } } },
  };

  // ── createAlert (ACT) ─────────────────────────────────────────────────────────
  // The FIRST act-tool. It DRAFTS a metric alert for the user to confirm — it does
  // NOT create anything (no DB write here). Self-affecting only: an alert notifies the
  // client's OWN team when a number crosses a threshold; it never messages ticket
  // buyers, never spends, never touches PII. That low blast radius makes it the safe
  // place to prove the draft→confirm pattern the riskier act-tools (campaigns) reuse.
  // The draft is committed only when the user taps "Create alert"
  // (POST /api/owl/act/create-alert), which runs the real alerts permission + create
  // path. Bounded to the curated catalogue exactly like askData (enum'd measures).
  const OP_LABEL = { gte: '≥', lte: '≤', gt: '>', lt: '<' };
  const DEFAULT_CHANNEL = ALERT_CHANNELS.includes('push') ? 'push' : ALERT_CHANNELS[0];
  const DEFAULT_PRIORITY = ALERT_PRIORITIES.includes('normal') ? 'normal' : ALERT_PRIORITIES[0];
  function runCreateAlert(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const m = measureByName.get(args.measure);
    if (!m) return refuse('unknown_measure', `"${args.measure}" isn't a measure I can watch. Pick a curated measure.`);
    const operator = ALERT_OPERATORS.includes(args.operator) ? args.operator : 'gte';
    const threshold = Number(args.threshold);
    if (!Number.isFinite(threshold)) return refuse('bad_threshold', 'Give a numeric threshold to watch for.');
    // Optional filters — curated FILTERABLE dims only (e.g. ticket type = VIP). PII
    // filter-only fields are rejected: an alert watches an aggregate, never a person.
    const metricFilters = {};
    const filterDesc = [];
    for (const [field, val] of Object.entries(args.filters || {})) {
      const d = dimByName.get(field);
      if (!d || d.filterOnly || !filterableDims.has(field)) return refuse('unfilterable', `I can't use "${field}" as an alert filter.`);
      if (val == null || String(val).trim() === '') continue;
      metricFilters[field] = String(val);
      filterDesc.push(`${d.label} = ${val}`);
    }
    // Delivery — channel(s) + priority, validated against the alerts module's own lists.
    // Both default sensibly (inbox is always-on regardless); alerts.clean re-validates.
    const channels = (Array.isArray(args.channels) ? args.channels : [])
      .filter((c) => ALERT_CHANNELS.includes(c));
    const priority = ALERT_PRIORITIES.includes(args.priority) ? args.priority : DEFAULT_PRIORITY;
    const metricLabel = [m.label, ...filterDesc].join(' · ');
    const name = String(args.name || '').trim().slice(0, 120) || `${metricLabel} ${OP_LABEL[operator]} ${threshold}`;
    // The metric-source alert draft (the Owl's catalogue IS a single curated explore).
    // The draft is FULLY resolved (incl. channels + priority) so the confirm card shows
    // exactly what will be created and the commit is explicit, not default-filled.
    const draft = {
      name, ruleType: 'threshold', source: 'metric',
      model: catalogue.model, view: catalogue.explore,
      measure: m.name, measureLabel: m.label,
      metricFilters, metricLabel,
      operator, threshold, unit: m.unit || '',
      channels: channels.length ? channels : [DEFAULT_CHANNEL], priority,
    };
    // Resolve which EVENT the alert watches. If one is already selected, use it. If not,
    // don't dead-end the chat asking the user to go pick one — draft it anyway and let
    // the confirm card offer an event picker (auto-pick when the client has only one).
    let resolvedSuite = suiteId || '';
    let events;
    if (!resolvedSuite) {
      const entityId = ctx.entityId
        || ((user.entityIds || []).length === 1 ? user.entityIds[0] : null);
      if (!entityId) return refuse('no_client', 'Open a client (or an event) first, then I can set up the alert.');
      const list = (db && db.listSuitesForEntity ? db.listSuitesForEntity(entityId) : []).map((s) => ({ id: s.id, name: s.name }));
      if (list.length === 1) resolvedSuite = list[0].id; // only one event → no need to ask
      else if (!list.length) return refuse('no_events', 'This client has no events yet to attach an alert to.');
      else events = list; // several → the card lets them choose
    }
    return {
      ok: true,
      confirm: true, // tells the loop to surface an action card; nothing is created yet
      action: {
        kind: 'createAlert', suiteId: resolvedSuite, needsEvent: !resolvedSuite, events, draft,
        summary: `Notify when ${metricLabel} ${OP_LABEL[operator]} ${threshold}`,
      },
    };
  }
  const createAlertSchema = {
    name: 'createAlert',
    description:
      'DRAFT a metric alert for the user to confirm — you do NOT create it; they tap "Create alert" to switch it on. An alert watches ONE event\'s ticketing number and notifies the client\'s own team when it crosses a threshold (e.g. tickets sold ≥ 1000, revenue ≥ 500000, remaining ≤ 50). Use when the user asks to be told / notified / alerted / reminded when a number reaches a level. Self-affecting only: it never messages ticket buyers and never spends. Delivery defaults to an in-app/push notification at normal priority — only set channels/priority if the user asks (e.g. "email me", "make it important"); inbox is always on. You do NOT need an event to be selected: if none is, the confirm card lets the user pick which event (or auto-uses the only one) — so never ask them to go and select an event. After calling it, tell the user what it will watch + the exact condition + how they\'ll be notified, and that they can tap the button to switch it on (choosing the event there if asked).',
    input_schema: {
      type: 'object',
      properties: {
        measure: { type: 'string', enum: catalogue.measures.map((mm) => mm.name), description: 'Which curated number to watch.' },
        operator: { type: 'string', enum: ALERT_OPERATORS, description: 'gte = at or above, lte = at or below, gt = above, lt = below.' },
        threshold: { type: 'number', description: 'The level to watch for.' },
        filters: { type: 'object', description: 'Optional catalogue dimension filters to narrow what is watched, e.g. {"core_ticket_types.name":"VIP"}. Contact/PII fields are not allowed.' },
        channels: { type: 'array', items: { type: 'string', enum: ALERT_CHANNELS }, description: `Optional notify channels (default ${DEFAULT_CHANNEL}; inbox is always on). Only set if the user asks how to be notified.` },
        priority: { type: 'string', enum: ALERT_PRIORITIES, description: `Optional priority (default ${DEFAULT_PRIORITY}); "important" breaks through quiet hours. Only set if the user asks.` },
        name: { type: 'string', description: 'Optional short name; one is generated from the condition if omitted.' },
      },
      required: ['measure', 'operator', 'threshold'],
    },
  };

  // `menu` = the slash-command palette entry for a tool (client /api/owl/capabilities).
  // Defining it HERE keeps the palette sourced from the registry, so adding a tool with
  // a menu automatically adds its slash command — one source of truth, no drift.
  // ── createSegment (ACT) ───────────────────────────────────────────────────────
  // DRAFT a reusable audience from a cohort (catalogue dimensions: age/gender/city/
  // country/ticket type/category/guest-list…). Self-confirm pattern like createAlert.
  // PII-safe: it resolves a count + per-channel reach server-side, but NEVER returns
  // people to the chat; the actual list only materialises inside a governed send.
  // Contact fields can't define a segment. Committed via POST /api/owl/act/create-segment.
  async function runCreateSegment(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const entityId = ctx.entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!entityId) return refuse('no_client', 'Open or pick a client first — a segment belongs to a client.');
    const filters = {};
    const desc = [];
    for (const [field, val] of Object.entries(args.filters || {})) {
      const d = dimByName.get(field);
      if (!d) return refuse('unknown_filter', `"${field}" isn't a field I can segment by.`);
      if (d.filterOnly || !filterableDims.has(field)) return refuse('pii_filter', `"${field}" is contact data — it can't define a segment (you never segment by email/phone/name).`);
      if (val == null || String(val).trim() === '') continue;
      filters[field] = String(val);
      desc.push(`${d.label} = ${val}`);
    }
    if (!Object.keys(filters).length) return refuse('no_cohort', 'Tell me the cohort to capture — e.g. ticket type VIP, city Cape Town, age 18 to 25.');
    const name = String(args.name || '').trim().slice(0, 120) || desc.join(' · ') || 'Segment';
    // Bake the current event (suite) scope into the draft so the SAVED segment is
    // scoped to it on every later resolution — the count previewed here matches what
    // reach checks + campaigns resolve later, not just at creation.
    const draft = { mode: 'query', model: catalogue.model, view: catalogue.explore, queryFilters: filters, suiteId: suiteId || '' };
    // Preview the size + reach (server-side; the list itself never enters the chat).
    let count = null; let reach = null;
    try { const r = await resolveQueryAudience({ entityId, definition: draft, user, suiteId }); if (r && !r.error) { count = r.count; reach = r.reach; } } catch { /* preview is best-effort */ }
    return {
      ok: true,
      confirm: true,
      action: { kind: 'createSegment', entityId, name, draft, summary: desc.join(' · '), count, reach },
    };
  }
  const createSegmentSchema = {
    name: 'createSegment',
    description:
      'DRAFT a reusable audience SEGMENT from a cohort, for the user to confirm — you do NOT create it; they tap "Create segment" to save it. The cohort is defined by curated dimensions (age, gender, buyer city/country, ticket type, ticket category, complimentary = guest list, etc.). A segment is a saved, live audience used later to run a campaign or sync to ad platforms; consent + unsubscribes are applied when it is actually messaged. Use when the user wants to build or save an audience ("make a segment of VIP buyers in Cape Town", "save these people as an audience", "guest list segment"). NEVER lists or names individual people — only a total count + per-channel reach. Contact fields (email/phone/name) CANNOT define a segment. Requires a client in scope. After calling it, state the cohort + the count/reach and tell the user to tap "Create segment".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the segment (one is generated from the cohort if omitted).' },
        filters: {
          type: 'object',
          description: 'The cohort as {dimension: value} over curated dimensions, e.g. {"core_ticket_types.name":"VIP","core_purchasers.city":"Cape Town"}. Guest list = {"core_tickets.is_complimentary":"Yes"}. Age can be a range like "18 to 25". Contact/PII fields are NOT allowed.',
        },
      },
      required: ['filters'],
    },
  };

  // ── draftCampaign (ACT) ───────────────────────────────────────────────────────
  // The flagship insight→action: DRAFT an email/SMS campaign to a cohort. It creates a
  // DRAFT in Engage that a human reviews, approves and sends — the Owl NEVER sends.
  // PII-safe: only a count + reach reach the chat. The audience is the same query-cohort
  // segments use; the copy is written by the existing campaign copywriter (draftCopy).
  async function runDraftCampaign(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const entityId = ctx.entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!entityId) return refuse('no_client', 'Open or pick a client first — a campaign belongs to a client.');
    const goal = String(args.goal || '').trim();
    if (!goal) return refuse('no_goal', 'Tell me the goal — who to reach and what to get them to do (e.g. "win back last year\'s VIP buyers who haven\'t rebooked").');
    const channel = ['email', 'sms', 'both'].includes(args.channel) ? args.channel : 'email';
    // Optional per-campaign language override for the drafted copy (blank → client default).
    const lang = String(args.language || '').slice(0, 5).toLowerCase();
    // Audience: EITHER a saved segment (by name) OR a custom cohort built from the chat.
    let audience; let summary = ''; let reach = null;
    const segName = String(args.segmentName || '').trim();
    if (segName) {
      const segApi = typeof getSegmentsApi === 'function' ? getSegmentsApi() : null;
      const list = segApi && segApi.listSegments ? segApi.listSegments(entityId) : [];
      const lc = segName.toLowerCase();
      const seg = list.find((s) => s.name.toLowerCase() === lc)
        || list.find((s) => s.name.toLowerCase().includes(lc) || lc.includes(s.name.toLowerCase()));
      if (!seg) {
        return refuse('no_segment', list.length
          ? `I couldn't find a saved segment called "${segName}". You have: ${list.map((s) => `"${s.name}"`).join(', ')}. Pick one, or describe a cohort and I'll build it.`
          : 'There are no saved segments for this client yet — describe the cohort (e.g. ticket type VIP, city Cape Town) and I\'ll build it.');
      }
      audience = { mode: 'segment', segmentId: seg.id };
      summary = seg.name;
      try { if (segApi.resolveSegment) { const r = await segApi.resolveSegment(entityId, seg.id, user); if (r && r.reach) reach = r.reach; } } catch { /* best-effort preview */ }
    } else {
      // Custom cohort from the chat — same validation + shape as createSegment; PII rejected.
      const filters = {};
      const desc = [];
      for (const [field, val] of Object.entries(args.filters || {})) {
        const d = dimByName.get(field);
        if (!d) return refuse('unknown_filter', `"${field}" isn't a field I can target by.`);
        if (d.filterOnly || !filterableDims.has(field)) return refuse('pii_filter', `"${field}" is contact data — it can't define an audience.`);
        if (val == null || String(val).trim() === '') continue;
        filters[field] = String(val);
        desc.push(`${d.label} = ${val}`);
      }
      if (!Object.keys(filters).length) return refuse('no_cohort', 'Who should this go to? Name a saved segment, or give a cohort — e.g. ticket type VIP, city Cape Town, age 18 to 25.');
      audience = { mode: 'query', model: catalogue.model, view: catalogue.explore, queryFilters: filters, suiteId: suiteId || '' };
      summary = desc.join(' · ');
      try { const r = await resolveQueryAudience({ entityId, definition: audience, user, suiteId }); if (r && !r.error) reach = r.reach; } catch { /* best-effort preview */ }
    }
    // Honest SMS reach for the chat: the send loop stops sending SMS once the sub-cap
    // is hit, so reflect that here when this campaign would use SMS.
    if (reach && (channel === 'sms' || channel === 'both')) {
      const cap = smsCapFor(entityId);
      if ((reach.sms || 0) > cap) reach = { ...reach, sms: cap, smsCapped: true, smsCap: cap };
    }
    // DESIGN the email like the builder does: a theme + content blocks. Falls back to
    // plain subject/body copy if the designer is unavailable or returns nothing usable.
    const audienceCount = (reach && reach.total) || 0;
    const su = suiteId && db && db.getSuite ? db.getSuite(suiteId) : null;
    let designed = null;
    try { if (typeof designEmailFn === 'function') designed = await designEmailFn({ entityId, goal, audienceCount, eventSuiteId: suiteId || '', eventName: su?.name || '' }); } catch { designed = null; }
    let copy = {};
    if (!(designed && Array.isArray(designed.blocks) && designed.blocks.length)) {
      try { if (typeof draftCampaignCopy === 'function') copy = (await draftCampaignCopy({ entityId, goal, audienceCount, eventSuiteId: suiteId || '', language: lang })) || {}; } catch { copy = {}; }
    }
    const subject = (designed && designed.subject) || copy.subject || '';
    if (!designed && !subject && !copy.body) return refuse('draft_failed', 'I couldn\'t draft the email just now — try again in a moment, or build it in Engage.');
    const name = String(args.name || '').trim().slice(0, 120) || (subject ? String(subject).slice(0, 80) : (summary || 'Campaign'));
    return {
      ok: true,
      confirm: true,
      action: {
        kind: 'draftCampaign', entityId, name, channel, goal, language: lang,
        audience, summary, reach,
        // Designed → block builder (theme + blocks); else classic subject/body template.
        contentMode: designed ? 'blocks' : 'template',
        blocks: designed ? designed.blocks : [],
        theme: designed ? designed.theme : null,
        subject, body: copy.body || '', ctaText: copy.ctaText || '',
        ctaUrl: String(args.ctaUrl || '').slice(0, 500),
      },
    };
  }
  const draftCampaignSchema = {
    name: 'draftCampaign',
    description:
      'DRAFT an email/SMS marketing CAMPAIGN, for the user to confirm — you do NOT send it. It creates a DRAFT in Engage that a human reviews, approves and sends; nothing reaches customers from here. Use when the user wants to market to / message a group ("draft a win-back email to lapsed VIP buyers", "email my Cape Town segment an offer"). The audience is EITHER a saved segment (pass segmentName — use this when the user names an existing audience/segment) OR a new cohort built from curated dimensions (pass filters — age, gender, buyer city/country, ticket type, category, complimentary = guest list). Provide exactly ONE of segmentName or filters. You provide the goal; the copy (subject + body) is drafted for you and shown for review. NEVER lists or names individual people — only a count + reach. Contact fields (email/phone) cannot define the audience. Requires a client in scope. After calling it, give the audience + the subject line and tell the user to tap "Create draft campaign", then review & send it in Engage.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the campaign should achieve — who to reach and what action to drive (e.g. "win back last year\'s VIP buyers who haven\'t rebooked; drive early-bird sales").' },
        segmentName: { type: 'string', description: 'Target an EXISTING saved segment by name (the user named an audience/segment, or you just created one). The name is matched against the client\'s saved segments.' },
        filters: { type: 'object', description: 'OR build a new cohort as {dimension: value}, e.g. {"core_ticket_types.name":"VIP","core_purchasers.city":"Cape Town"}. Use this when no saved segment is named. Contact/PII fields are NOT allowed.' },
        channel: { type: 'string', enum: ['email', 'sms', 'both'], description: 'Delivery channel (default email).' },
        language: { type: 'string', description: 'OPTIONAL ISO language code (e.g. "fr", "af", "pt") to write THIS campaign\'s copy in, overriding the client\'s default language. Use only when the user asks for a specific language for this send (e.g. "draft it in French for the Cape Town crowd"). Omit to use the client default.' },
        ctaUrl: { type: 'string', description: 'Optional destination link for the call-to-action button (e.g. the event buy page) if the user gave one.' },
        name: { type: 'string', description: 'Optional campaign name (defaults to the subject line).' },
      },
      required: ['goal'],
    },
  };

  // ── eventOps: read-only Event Ops state (devices / stations / staff / issues / checkpoints) ──
  async function runEventOps(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    if (!suiteId) return refuse('no_event', 'Open or pick an event first — Event Ops answers are per event.');
    if (user.role !== 'admin' && auth && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) return refuse('no_access', 'No access to that event.');
    const api = typeof getEventOpsApi === 'function' ? getEventOpsApi() : null;
    if (!api || !api.suiteSummary) return refuse('unavailable', 'Event Ops isn\'t available right now.');
    const su = db && db.getSuite ? db.getSuite(suiteId) : null;
    if (su && api.entityEnabled && !api.entityEnabled(su.entityId)) return refuse('unavailable', 'Event Ops isn\'t switched on for this client.');
    try {
      const q = args.query || 'overview';
      if (q === 'locate') {
        if (!args.code) return refuse('error', 'Tell me the device code to locate (e.g. SL005).');
        const device = api.locateDevice(suiteId, args.code);
        return device ? { ok: true, device } : { ok: true, found: false, message: `No device matches "${args.code}" at this event.` };
      }
      if (q === 'devices') return { ok: true, devices: api.listDevices(suiteId, { state: args.state, stationName: args.station }) };
      if (q === 'issues') return { ok: true, issues: api.listIssues(suiteId, args.status || 'open') };
      if (q === 'staff') return { ok: true, staff: api.listStaff(suiteId, { stationName: args.station }) };
      if (q === 'stations') return { ok: true, stations: api.listStations(suiteId) };
      if (q === 'checkpoints') return { ok: true, checkpoints: api.listCheckpoints(suiteId, { stationName: args.station }) };
      return { ok: true, summary: api.suiteSummary(suiteId) };
    } catch (e) {
      return refuse('error', `Couldn't read Event Ops: ${e.message}`);
    }
  }
  const eventOpsSchema = {
    name: 'eventOps',
    description: 'Live EVENT OPS state for THIS event — physical devices (handhelds/scanners/radios), the STATIONS they\'re deployed to (bars/gates/booths/top-ups), the STAFF working it, device ISSUES, and station CHECKPOINTS. Use for: "where is device SL005", "how many devices are deployed vs at the Hive", "which devices are at <station>", "what open issues are there / how long open", "who is posted to <station> / how many staff", "were the checkpoints done at <station>". Read-only; returns structured data you then phrase + cite. The Hive = the store/warehouse (in stock).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', enum: ['overview', 'locate', 'devices', 'issues', 'staff', 'stations', 'checkpoints'], description: 'overview = totals + per-station device counts + open issues + recent checkpoints. locate = find ONE device by code. devices/issues/staff/stations/checkpoints = those lists (optionally filtered).' },
        code: { type: 'string', description: 'For query="locate": the device QR code, serial or label (e.g. SL005).' },
        state: { type: 'string', enum: ['in_stock', 'deployed', 'returned', 'lost', 'damaged'], description: 'For query="devices": filter by state (in_stock/returned = at the Hive).' },
        station: { type: 'string', description: 'Filter by station name (for devices/staff/checkpoints), e.g. "Main Bar" or "Hive".' },
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'For query="issues": which issues (default open).' },
      },
    },
  };

  // ── draftReport (ACT) ─────────────────────────────────────────────────────────
  // DRAFT a product report (bug / improvement / idea) the user describes in chat.
  // Nothing is filed until they tap "File it" — confirm pattern like the others.
  // Committed via POST /api/owl/act/submit-report → tickets.createTicket.
  async function runDraftReport(args = {}, ctx = {}) {
    if (!ctx.user) return refuse('no_user', 'No authenticated user in context.');
    const type = ['bug', 'improvement', 'idea'].includes(args.type) ? args.type : 'bug';
    const title = String(args.title || '').trim().slice(0, 160);
    const description = String(args.description || '').trim().slice(0, 6000);
    const urgency = ['low', 'normal', 'high', 'urgent'].includes(args.urgency) ? args.urgency : 'normal';
    if (!description && !title) return refuse('empty', "Tell me what to report first — what went wrong, or what you'd like.");
    return {
      ok: true,
      confirm: true,
      action: { kind: 'draftReport', draft: { type, title, description, urgency, screen: String(args.screen || '').trim().slice(0, 200) }, summary: title || description.slice(0, 80) },
    };
  }
  const draftReportSchema = {
    name: 'draftReport',
    description: 'DRAFT a product report — a BUG (something broken/wrong), an IMPROVEMENT (make something better), or an IDEA (a new feature/capability) — for the user to confirm. You do NOT file it; they tap "File it" on the card. Use whenever the user reports a problem, a frustration, or a wish about the app itself ("there\'s a bug…", "X is broken", "it would be great if…", "can you add…", "I wish it could…"). Capture it conversationally: infer the type, write a short clear title, and a description (for a bug: what happened + what they expected; for an idea: the objective/outcome they want). Ask at most one or two SHORT follow-ups only if the description is too thin to act on — don\'t interrogate. If they named the screen/area, pass it. After calling it, tell them you\'ve drafted the report and they can tap "File it" to send it to the product team (and that they can add a screenshot in the report form if it\'s a visual bug). Do NOT say it\'s been filed until they confirm.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'improvement', 'idea'], description: 'bug = broken/wrong; improvement = make something better; idea = a new capability/feature.' },
        title: { type: 'string', description: 'A short, specific title (under ~12 words).' },
        description: { type: 'string', description: 'The details. For a bug: what happened + what they expected. For an idea/improvement: the objective/outcome they want.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Only meaningful for bugs — how impactful/urgent. Default normal.' },
        screen: { type: 'string', description: 'The screen/area it relates to, if the user said (e.g. "Alerts", "the sales dashboard").' },
      },
      required: ['type', 'description'],
    },
  };

  // ── Extra explores (admin-registered) — one scoped read tool each ────────────
  // Mirrors askData for any additional explore the admin enabled. Same scope gate
  // (applyScope is explore-aware + fails closed), so an explore that can't be bound
  // to the client is refused, never leaked. Read-only; no PII (locked at selection).
  function makeExploreTool(cat) {
    const mByName = new Map((cat.measures || []).map((m) => [m.name, m]));
    const groupable = new Set((cat.dimensions || []).map((d) => d.name));
    const dByName = new Map((cat.dimensions || []).map((d) => [d.name, d]));
    const toolName = `ask_${String(cat.explore).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48)}`;
    async function run(args = {}, ctx = {}) {
      const { user, suiteId, entityId } = ctx;
      if (!user) return refuse('no_user', 'No authenticated user in context.');
      const measureList = [];
      if (args.measure) measureList.push(args.measure);
      for (const mm of (Array.isArray(args.measures) ? args.measures : [])) if (!measureList.includes(mm)) measureList.push(mm);
      if (!measureList.length) return refuse('unknown_measure', 'No measure specified.');
      for (const mm of measureList) if (!mByName.has(mm)) return refuse('unknown_measure', `"${mm}" is not a measure in ${cat.label}.`);
      const measure = measureList[0];
      const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
      for (const d of dimensions) if (!groupable.has(d)) return refuse('unknown_dimension', `"${d}" is not a groupable dimension in ${cat.label}.`);
      const filters = {};
      for (const [field, val] of Object.entries(args.filters || {})) {
        if (!groupable.has(field)) return refuse('unfilterable', `I can't filter on "${field}" in ${cat.label}.`);
        if (val == null || String(val).trim() === '') continue;
        filters[field] = String(val);
      }
      // Date-filter the MEASURED view's OWN date field when it has one. In a
      // combined explore the catalogue-level dateDimension (e.g. the cashless
      // access-control/check-in date) does not constrain other views' rows —
      // issue #28's residual: "today" on bar sales matched every date. Prefer
      // `<measureView>.date_date`, then `<measureView>.created_at_date`, then
      // the catalogue default.
      let crossDateNote;
      if (args.dateRange && String(args.dateRange).trim()) {
        const mv = String(measure).split('.')[0];
        const dateDim = [`${mv}.date_date`, `${mv}.created_at_date`].find((n) => dByName.has(n)) || cat.dateDimension;
        if (dateDim) {
          filters[dateDim] = String(args.dateRange).trim();
          // The measured view has NO date field of its own in the catalogue, so the
          // range rides another view's date. In a combined explore that may not
          // constrain the measure at all (Inventive-vs-Owl check-ins mismatch) —
          // the Owl must caveat day/hour figures instead of stating them as fact.
          if (String(dateDim).split('.')[0] !== mv) {
            crossDateNote = `CAUTION: the date range was applied on ${dateDim} — ${mv} has no date field in the curated catalogue, and a cross-view date may not constrain ${measure} at all. Treat day/hour figures from this query as unverified and tell the user a ${mv} date field is needed for reliable time filtering.`;
          }
        }
      }
      const body = { model: cat.model, view: cat.explore, fields: [...dimensions, ...measureList], filters, sorts: [`${measure} desc`], limit: Math.min(Math.max(Number(args.limit) || 500, 1), 5000) };
      applySuiteEventLocks(body.filters, suiteId, dByName);
      const allowed = await query.applyScope(body, user, suiteId);
      if (allowed === false) return refuse('no_scope', `I can't scope ${cat.label} to a client here — this data source may not be linkable to your client, or open a client/event first.`);
      if (entityId && auth && auth.accessibleOrgFilters) {
        const locks = auth.accessibleOrgFilters(user, entityId);
        if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
        else if (!body.filters[ORG]) return refuse('no_scope', `I can't tell which client's data to use for ${cat.label}.`);
      } else if (!body.filters[ORG]) {
        const locks = auth && auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
        if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
        else return refuse('no_scope', `I can't tell which client's data to use for ${cat.label}.`);
      }
      stampReportingTz(body, { user, suiteId, entityId });
      let rows;
      try { rows = await query.runLookerQuery('/queries/run/json', body); }
      catch (e) { return refuse('query_failed', `I couldn't run that ${cat.label} query${e && e.message ? ` (${String(e.message).slice(0, 140)})` : ''}.`); }
      const note = [crossDateNote, resultNote(rows, measureList, dimensions, args.filters)].filter(Boolean).join(' ') || undefined;
      return { ok: true, rows: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0, measure, dimensions, explore: cat.explore, queryBody: body, ...(note ? { note } : {}) };
    }
    const props = {
      measure: { type: 'string', enum: cat.measures.map((m) => m.name), description: `The number to compute from ${cat.label}. For money totals ("sales", "revenue", "spend") prefer a *sum_credit_amount / *sale_item_total_price measure — a *sum_sale_item_unit_price measure adds up UNIT prices ignoring quantities and understates real takings.` },
      measures: { type: 'array', items: { type: 'string', enum: cat.measures.map((m) => m.name) }, description: 'Optional: 2+ measures side by side.' },
      filters: { type: 'object', description: 'Optional {field: value} filters on this data.' },
      limit: { type: 'number', description: 'Max rows (default 500).' },
    };
    if (cat.dimensions.length) props.dimensions = { type: 'array', items: { type: 'string', enum: cat.dimensions.map((d) => d.name) }, description: `Optional group-by fields in ${cat.label}.` };
    // Name the bound field so the model KNOWS which date this rides — and routes a
    // different family's time question (e.g. check-in created-at) via filters instead.
    if (cat.dateDimension) props.dateRange = { type: 'string', description: `Optional Looker date expression applied to ${cat.dateDimension} (e.g. "last 7 days"). To time-filter a DIFFERENT date field, put the date expression in filters under that field's name instead.` };
    // A combined explore stitches several views (families) together; not every
    // view joins to every other. Warn the model up front so it pairs a measure
    // with its own family's dimensions instead of producing a fan-out.
    const families = new Set([...(cat.measures || []), ...(cat.dimensions || [])].map((f) => String(f.name).split('.')[0]));
    const combinedHint = families.size > 2
      ? ' This explore COMBINES several views — group a measure by dimensions of its OWN family (matching field-name prefix, or shared core_events/date fields). A cross-family group-by returns the same total repeated on every row, not a real breakdown.'
      : '';
    // Category-style dimensions (station_category, catalog_item_type, …) are how a
    // subset question is answered. Without this hint the model answered "bar sales"
    // across ALL stations (food, merch, coffee included) — issue caught live at KFF.
    const categoryDims = (cat.dimensions || []).map((d) => d.name).filter((n) => /(^|[._])(category|category_\d+|type)([._]|$)/i.test(n));
    const subsetHint = categoryDims.length
      ? ` SUBSET QUESTIONS ("bars only", "food vendors", "merch"): do NOT answer across everything — FILTER a category field (${categoryDims.slice(0, 4).join(', ')}). Group by it once without a filter to learn its exact case-sensitive values, then filter and answer the subset.`
      : '';
    // Per-explore usage notes (e.g. the reliable check-in recipe from the catalogue)
    // ride the tool's own description — the guidance only exists for clients who
    // actually have this tool, so a switched-off explore never leaks a mention.
    const usage = (cat.notes || []).length ? ` USAGE: ${cat.notes.join(' ')}` : '';
    return {
      schema: {
        name: toolName,
        description: `Answer a question from the client's own ${cat.label} data (Looker explore ${cat.model}::${cat.explore}) — a bounded, scoped, read-only query. Use this for ${cat.label} questions. To compare ${cat.label} with ticketing, also call askData and combine on a shared dimension (event or date). Returns rows; cite the figures.${combinedHint}${subsetHint}${usage}`,
        input_schema: { type: 'object', properties: props, required: ['measure'] },
      },
      run,
    };
  }
  const extraTools = {};
  // exploreKey tags the tool with its source explore so the chat/WhatsApp doors can
  // include or drop it PER CLIENT (Admin can switch an explore off for one client).
  for (const ex of (catalogue.extras || [])) { try { const t = makeExploreTool(ex); extraTools[t.schema.name] = { ...t, exploreKey: `${ex.model}::${ex.explore}` }; } catch { /* skip a malformed explore */ } }

  // ── Raw-data export (the chat's ⬇ CSV "full data" path) ─────────────────────
  // Re-runs a citation's queryBody LIVE with the full row budget (the chat stream
  // caps citation rows at 50). The body is UNTRUSTED — it round-trips through the
  // browser — so: whitelisted keys only, PII fields rejected, and the SAME scope
  // gate + entity binding as askData re-applied fresh (ceiling, fail closed). It can
  // never return data the user couldn't already query — just more rows of it.
  async function exportRows(raw, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const qb = raw && typeof raw === 'object' ? raw : {};
    if (!qb.model || !qb.view || !Array.isArray(qb.fields) || !qb.fields.length) return refuse('bad_query', 'No query to export.');
    const fields = qb.fields.map(String).slice(0, 24);
    if (fields.some((f) => isPII(f))) return refuse('pii', 'Contact fields can\'t be exported.');
    const filters = {};
    for (const [k, v] of Object.entries(qb.filters || {})) if (v != null && (typeof v === 'string' || typeof v === 'number')) filters[String(k).slice(0, 200)] = String(v).slice(0, 2000);
    const body = { model: String(qb.model), view: String(qb.view), fields, filters, sorts: Array.isArray(qb.sorts) ? qb.sorts.slice(0, 4).map(String) : [], limit: 5000 };
    const allowed = await query.applyScope(body, user, suiteId);
    if (allowed === false) return refuse('no_scope', 'No data scope for this export.');
    if (entityId && auth && auth.accessibleOrgFilters) {
      const locks = auth.accessibleOrgFilters(user, entityId);
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else if (!body.filters[ORG]) return refuse('no_scope', 'No data scope for this export.');
    } else if (!body.filters[ORG]) return refuse('no_scope', 'No data scope for this export.');
    let rows;
    try { rows = await query.runLookerQuery('/queries/run/json', body); }
    catch (e) { return refuse('query_failed', `Export failed${e && e.message ? ` (${String(e.message).slice(0, 140)})` : ''}.`); }
    return { ok: true, rows: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0 };
  }

  return {
    catalogue,
    exportRows, // NOT a chat tool (no schema) — the export route calls it directly
    ...extraTools,
    draftReport: { schema: draftReportSchema, run: runDraftReport, menu: { cmd: 'report', label: 'Report a bug or idea', icon: '🐞', example: 'I found a bug on the alerts page' } },
    eventOps: { schema: eventOpsSchema, run: runEventOps, menu: { cmd: 'eventops', label: 'Event Ops', icon: '📟', example: 'Where is SL005, and any open issues?' } },
    askData: { schema: askDataSchema, run: runAskData, menu: { cmd: 'data', label: 'Ticket data', icon: '📊', example: 'How many tickets have I sold?' } },
    getGoals: { schema: getGoalsSchema, run: runGetGoals, menu: { cmd: 'goals', label: 'Goals', icon: '🎯', example: 'How are my goals tracking?' } },
    getDashboard: { schema: getDashboardSchema, run: runGetDashboard, menu: { cmd: 'dashboard', label: 'This dashboard', icon: '📋', example: 'Summarise what this dashboard is telling me.' } },
    queryDashboard: { schema: queryDashboardSchema, run: runQueryDashboard },
    // One palette entry per domain. Alerts & campaigns each cover BOTH reading and the
    // act-tool (set up / draft), so we don't add duplicate singular rows — the example
    // hints at both and the Owl routes by intent. Segments has no read tool, so its only
    // entry is the act-tool's.
    getAlerts: { schema: getAlertsSchema, run: runGetAlerts, menu: { cmd: 'alerts', label: 'Alerts', icon: '🔔', example: 'What alerts are set — or set up a new one?' } },
    getCampaigns: { schema: getCampaignsSchema, run: runGetCampaigns, menu: { cmd: 'campaigns', label: 'Campaigns', icon: '📣', example: 'How did recent campaigns do — or draft a new one?' } },
    askUpload: { schema: askUploadSchema, run: runAskUpload, menu: { cmd: 'uploads', label: 'Attached files', icon: '📎', example: "What's in my attached data?" } },
    searchDriveDocs: { schema: searchDriveDocsSchema, run: runSearchDriveDocs, menu: { cmd: 'drive', label: 'Drive documents', icon: '📁', example: 'What does the marketing plan say about launch week?' } },
    readDriveDoc: { schema: readDriveDocSchema, run: runReadDriveDoc },
    getPaidPerformance: { schema: getPaidPerformanceSchema, run: runGetPaidPerformance, menu: { cmd: 'ads', label: 'Paid ads (Meta)', icon: '💸', example: 'How are my Meta ads performing — spend and ROAS?' } },
    createAlert: { schema: createAlertSchema, run: runCreateAlert },
    createSegment: { schema: createSegmentSchema, run: runCreateSegment, menu: { cmd: 'segment', label: 'Build an audience', icon: '👥', example: 'Build a segment of my top customers' } },
    draftCampaign: { schema: draftCampaignSchema, run: runDraftCampaign },
  };
};
