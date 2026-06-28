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

module.exports = function createOwlTools({ query, auth, catalogue = defaultCatalogue }) {
  if (!query || !query.applyScope || !query.runLookerQuery) {
    throw new Error('owlTools requires the query engine (applyScope + runLookerQuery).');
  }
  const ORG = 'core_organisers.name'; // the canonical organiser lock field

  // Index the curated catalogue once: name → spec, plus filterable set.
  const measureByName = new Map(catalogue.measures.map((m) => [m.name, m]));
  const dimByName = new Map(catalogue.dimensions.map((d) => [d.name, d]));
  const filterableDims = new Set(catalogue.dimensions.filter((d) => d.filter).map((d) => d.name));

  // A structured, bounded refusal — never throws into the chat loop, so the Owl
  // can phrase "I can't answer that from your data" instead of erroring out.
  const refuse = (reason, message) => ({ ok: false, reason, message });

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
      if (!dimByName.has(d)) return refuse('unknown_dimension', `"${d}" is not a dimension I can group by.`);
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

    // 3) THE SCOPE GATE — bind to the organiser(s) this user can ACCESS; never run
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

    // 4) Run + return the grounding trail. /queries/run/json → array of row objects.
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
        dimensions: { type: 'array', items: { type: 'string', enum: catalogue.dimensions.map((d) => d.name) }, description: 'Optional fields to break the measure down by.' },
        filters: { type: 'object', description: 'Optional {field: value} filters; field must be a filterable catalogue dimension.' },
        dateRange: { type: 'string', description: 'Optional Looker date expression on the purchase date, e.g. "last 7 days", "this month", "2026-01-01 to 2026-02-01".' },
        limit: { type: 'number', description: 'Max rows (default 500).' },
      },
      required: ['measure'],
    },
  };

  return {
    catalogue,
    askData: { schema: askDataSchema, run: runAskData },
  };
};
