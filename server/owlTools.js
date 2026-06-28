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

module.exports = function createOwlTools({ query, auth, getGoalsApi, catalogue = defaultCatalogue }) {
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

  // ── askData ──────────────────────────────────────────────────────────────
  // args: { measure, dimensions?: string[], filters?: {field: value},
  //         dateRange?: <Looker date expr>, limit?: number }
  // ctx:  { user, suiteId? }  (resolved server-side — the browser never supplies scope)
  async function runAskData(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');

    // 1) Validate against the curated whitelist BEFORE touching Looker.
    const measure = args.measure;
    if (!measure || !measureByName.has(measure)) {
      return refuse('unknown_measure', `"${measure}" is not a measure I can read. Pick one of the curated measures.`);
    }
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
      fields: [...dimensions, measure],
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
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    if (!suiteId) return refuse('no_event', 'Goals are per event — open or pick a specific event first.');
    if (user.role !== 'admin' && auth && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) return refuse('no_access', 'No access to that event.');
    const goalsApi = typeof getGoalsApi === 'function' ? getGoalsApi() : null;
    if (!goalsApi || !goalsApi.listGoals) return refuse('unavailable', 'Goals aren\'t available right now.');
    try {
      const goals = goalsApi.listGoals(suiteId);
      if (!goals.length) return { ok: true, goals: [], note: 'No goals set for this event yet.' };
      const caches = goalsApi.makeGoalCaches ? goalsApi.makeGoalCaches() : null;
      const out = [];
      for (const g of goals) { try { out.push(await goalsApi.attachProgress(g, user, caches)); } catch { out.push(g); } }
      return { ok: true, goals: out.map(slimGoal) };
    } catch { return refuse('error', 'Couldn\'t read the goals for this event.'); }
  }
  const getGoalsSchema = {
    name: 'getGoals',
    description: 'Get THIS event\'s goals and how they are tracking — target, current value, pace (ahead/on-track/behind), forecast landing, and vs last time, leading with the North Star. Use for any question about goals, targets, the North Star, or "are we on track". Read-only; amounts are ZAR.',
    input_schema: { type: 'object', properties: {} },
  };

  return {
    catalogue,
    askData: { schema: askDataSchema, run: runAskData },
    getGoals: { schema: getGoalsSchema, run: runGetGoals },
  };
};
