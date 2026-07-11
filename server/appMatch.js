// ─── App ↔ ticketing audience match — DISPOSABLE MODULE ─────────────────────────
// Joins the client's APP AUDIENCE (PostHog people, scoped to their events) with
// their BUYERS (Looker, resolved through the same hard-scoped resolver the
// segment engine uses) by email. Answers the questions neither system can
// alone: how many app users are actual buyers, who browses but never bought,
// how many buyers skip the app — plus which tickets each app user holds.
//
// PII boundary: buyer emails never leave the server; the ONLY emails that reach
// the browser are the ones the App-users table already shows, and the tickets
// enrichment is keyed by those same emails. Everything else is counts. Scope:
// the buyer side rides audienceQuery (organiser forced, fails closed); the app
// side rides posthog.eventIdsForEntity (fails closed on no event locks).
//
// Mount: require('./appMatch').mount(app, { db, auth, posthog })
// Uninstall: remove this file + its mount line + the AudienceMatchCard /
// tickets column in client/src/components/AppAnalytics.jsx + its GATES rows.

const { HttpError, asyncHandler } = require('./http');

const CACHE_MS = 10 * 60_000;  // overlap is expensive (Looker + PostHog) — reuse
const APP_PAGES = 4;           // × 500 = the client's top-2000 app users considered
const APP_WINDOW_DAYS = 90;
const TICKET_EMAILS = 200;     // per-request cap for tickets-by-email enrichment
const ORG = 'core_organisers.name';
const ID_EMAIL = 'core_purchasers.email';

function mount(app, { db, auth, posthog, resolveAudience, queryEngine, catalogue }) {
  const cat = catalogue || require('./owlCatalogueSeed');
  const resolve = resolveAudience || require('./audienceQuery')({ auth, db }).resolveQueryAudience;
  const query = queryEngine || require('./query')({ looker: require('./looker'), auth });

  const cache = new Map(); // entityId → { at, data }

  // The client's app people (top by interactions, 90d), scoped to their events.
  async function appUsers(entityId) {
    const ids = await posthog.eventIdsForEntity(entityId);
    if (!ids.length) return { scoped: false, people: [] };
    const people = [];
    for (let page = 0; page < APP_PAGES; page++) {
      const r = await posthog.people({ ids, days: APP_WINDOW_DAYS, limit: 500, offset: page * 500, orderBy: 'active' });
      people.push(...(r.people || []));
      // hasMore can't see past posthog's own 2000-row fetch ceiling, so a full
      // final page still means "capped" — never present the cap as the total.
      if (!r.hasMore && people.length < APP_PAGES * 500) return { scoped: true, people, capped: false };
    }
    return { scoped: true, people, capped: true };
  }

  async function overlap(entityId, user) {
    const hit = cache.get(entityId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (!posthog.isConfigured()) return { configured: false };
    const [appSide, buyers] = await Promise.all([
      appUsers(entityId),
      resolve({ entityId, definition: { model: cat.model, view: cat.explore, queryFilters: {} }, user, limit: 500000 }),
    ]);
    if (!appSide.scoped) return { configured: true, scoped: false };
    if (buyers.error) throw new HttpError(400, `Couldn't resolve the buyer list (${buyers.error}).`);
    // buildRows already lowercases emails on the buyer side; mirror on the app side.
    const buyerEmails = new Set((buyers.raw || []).map((p) => String(p.email || '').toLowerCase()).filter(Boolean));
    const appEmails = [...new Set(appSide.people.map((p) => String(p.email || '').toLowerCase()).filter(Boolean))];
    const matched = appEmails.filter((e) => buyerEmails.has(e)).length;
    const data = {
      configured: true, scoped: true, asOf: new Date().toISOString(), windowDays: APP_WINDOW_DAYS,
      appUsers: appSide.people.length, appUsersWithEmail: appEmails.length, appCapped: !!appSide.capped,
      buyers: buyerEmails.size, matched,
      appNotBuyers: appEmails.length - matched,
      buyersNotOnApp: Math.max(0, buyerEmails.size - matched),
    };
    if (cache.size > 100) cache.clear();
    cache.set(entityId, { at: Date.now(), data });
    return data;
  }

  // Which of the client's events do these emails hold tickets for? Keyed by the
  // emails the App-users table already displays — no new PII crosses the wire.
  async function ticketsByEmail(entityId, user, emails) {
    const list = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')))].slice(0, TICKET_EMAILS);
    const out = {};
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const body = {
        model: cat.model, view: cat.explore,
        fields: [ID_EMAIL, 'core_events.name', 'core_tickets.count'],
        filters: { [ID_EMAIL]: chunk.join(',') }, limit: 5000,
      };
      const allowed = await query.applyScope(body, user, null);
      if (allowed === false) return {};
      // Bind to THIS client (mirrors audienceQuery): fail closed without an org lock.
      const locks = auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
      if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
      else if (!body.filters[ORG]) continue;
      const rows = await query.runLookerQuery('/queries/run/json', body);
      for (const r of (rows || [])) {
        const em = String(r[ID_EMAIL] || '').toLowerCase();
        const ev = String(r['core_events.name'] || '');
        const n = Number(r['core_tickets.count']) || 0;
        if (!em || !ev || !n) continue;
        (out[em] = out[em] || []).push({ event: ev, tickets: n });
      }
    }
    for (const em of Object.keys(out)) out[em].sort((a, b) => b.tickets - a.tickets);
    return out;
  }

  // ── the same surface twice (dual-surface rule) ──
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  app.get('/api/my/app-audience/:entityId', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    res.json(await overlap(req.params.entityId, req.user));
  }));
  app.get('/api/admin/entities/:id/app-audience', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!db.getEntity(req.params.id)) throw new HttpError(404, 'Not found');
    res.json(await overlap(req.params.id, req.user));
  }));
  app.post('/api/my/app-tickets/:entityId', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    res.json({ byEmail: await ticketsByEmail(req.params.entityId, req.user, (req.body || {}).emails) });
  }));
  app.post('/api/admin/entities/:id/app-tickets', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!db.getEntity(req.params.id)) throw new HttpError(404, 'Not found');
    res.json({ byEmail: await ticketsByEmail(req.params.id, req.user, (req.body || {}).emails) });
  }));

  return { overlap, ticketsByEmail };
}

module.exports = { mount };
