// ─── Owl segment resolver: a scoped people-query over the curated catalogue ─────
// Resolves a `query`-source segment (a cohort the Owl built in chat — age / gender /
// city / country / ticket type / category / guest-list, etc.) into recipients. The
// SAME hard scope gate askData uses runs here (organiser forced, fails closed), and
// the SAME audienceMap shaping (per-channel consent + reach) the campaign engine uses.
//
// PII boundary: this returns the people list ONLY to server-side callers (the campaign
// send path + the count/reach preview). It is NEVER returned to the browser/chat —
// callers surface a COUNT + per-channel reach, never names/emails.
//
// Why not arbitrary SQL: a query segment is bound to the ONE curated explore + curated
// filterable dimensions; identity columns are fixed. So it can't reach off-catalogue
// data, and the organiser ceiling is injected inside applyScope (never trusted to the
// definition). Mirrors owlTools.runAskData's gate exactly.

const ORG = 'core_organisers.name';

module.exports = function createAudienceQuery({ auth, db, catalogue = require('./owlCatalogueSeed') }) {
  const query = require('./query')({ looker: require('./looker'), auth });
  const { buildRows, finalizeAudience } = require('./audienceMap');

  const dimByName = new Map(catalogue.dimensions.map((d) => [d.name, d]));
  const filterableDims = new Set(catalogue.dimensions.filter((d) => d.filter || d.filterOnly).map((d) => d.name));
  // Identity columns pulled for the audience (server-side only). Present in the explore
  // as filter-only PII in the catalogue — the resolver may SELECT them, the Owl may not.
  const ID = { email: 'core_purchasers.email', name: 'core_purchasers.first_name', phone: 'core_purchasers.cellphone_number' };

  // Apply the suite's EVENT lock for fields valid in this explore (mirrors owlTools).
  function applySuiteEventLocks(filters, suiteId) {
    if (!suiteId || !auth.lockedFiltersForSuite) return;
    let locks; try { locks = auth.lockedFiltersForSuite(suiteId) || {}; } catch { return; }
    for (const [key, val] of Object.entries(locks)) {
      if (val == null || val === '' || val === ' __ANY_VALUE__') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (!field || field === ORG) continue; // organiser handled by applyScope
      if ((/^core_events\./.test(field) || dimByName.has(field)) && filters[field] == null) filters[field] = String(val);
    }
  }

  // The curated dimensions a cohort can be built from (non-PII, filterable) — the
  // segment "drivers". PII filter-only fields are NOT drivers (you don't segment by email).
  const cohortDrivers = catalogue.dimensions
    .filter((d) => d.filter && !d.filterOnly)
    .map((d) => ({ name: d.name, label: d.label, group: d.group, type: d.type, aka: d.aka || [] }));

  // Validate + normalise a cohort filter map against the curated drivers.
  function cleanCohortFilters(queryFilters = {}) {
    const out = {};
    for (const [field, val] of Object.entries(queryFilters || {})) {
      const d = dimByName.get(field);
      if (!d || d.filterOnly || !filterableDims.has(field)) continue; // drop unknown / PII
      if (val == null || String(val).trim() === '') continue;
      out[field] = String(val);
    }
    return out;
  }

  const empty = (error) => ({ raw: [], reach: { total: 0, email: 0, sms: 0 }, count: 0, error });

  // Resolve a query-segment definition to recipients. Returns { raw, reach, count }.
  // `raw` is the shaped (pre-suppression) people list for the caller to finalize with
  // its own suppression list; reach/count are a no-suppression preview estimate.
  async function resolveQueryAudience({ entityId, definition, user, suiteId, limit }) {
    const def = definition || {};
    if (!user) return empty('no_user');
    // Bound to the ONE curated explore — never an arbitrary model/view.
    if (def.model !== catalogue.model || def.view !== catalogue.explore) return empty('unsupported_explore');

    const filters = cleanCohortFilters(def.queryFilters);
    const body = { model: catalogue.model, view: catalogue.explore, fields: [ID.email, ID.name, ID.phone], filters, limit: Math.min(Math.max(Number(limit) || 50000, 1000), 500000) };

    // Event lock (the suite the segment is scoped to), then the HARD organiser gate.
    applySuiteEventLocks(body.filters, suiteId);
    const allowed = await query.applyScope(body, user, suiteId);
    if (allowed === false) return empty('no_scope');
    // Bind to the SINGLE client (entityId). applyScope with no event scopes a
    // multi-entity user to the UNION of their organisers — narrow so a segment never
    // resolves people across the user's OTHER clients. Tightening, never widening.
    if (entityId && auth.accessibleOrgFilters) {
      const locks = auth.accessibleOrgFilters(user, entityId);
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else if (!body.filters[ORG]) return empty('no_scope');
    } else if (!body.filters[ORG]) {
      const locks = auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else return empty('no_scope'); // fail closed — never resolve people across clients
    }

    const rows = await query.runLookerQuery('/queries/run/json', body);
    const { raw } = buildRows(Array.isArray(rows) ? rows : [], { emailField: ID.email, nameField: ID.name, phoneField: ID.phone });
    // No-suppression preview estimate (the send path re-finalizes with suppression).
    const { reach } = finalizeAudience(raw);
    return { raw, reach, count: reach.total };
  }

  return { resolveQueryAudience, cohortDrivers, cleanCohortFilters, ID };
};
