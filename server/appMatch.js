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
const APP_WINDOW_DAYS = 90;
const TICKET_EMAILS = 200;     // per-request cap for tickets-by-email enrichment
const ORG = 'core_organisers.name';
const ID_EMAIL = 'core_purchasers.email';

function mount(app, { db, auth, posthog, queryEngine, catalogue }) {
  const cat = catalogue || require('./owlCatalogueSeed');
  const query = queryEngine || require('./query')({ looker: require('./looker'), auth });

  const cache = new Map(); // entityId → { at, data }

  // Distinct emails for one identity field (purchaser or ticket user), scoped
  // to the SAME Howler event ids the app side uses — so both sides of the match
  // describe the same events, and the base equals the per-event "unique
  // customers" number the client sees on their dashboards (not all-time
  // organiser history). Org-locked and fail-closed like every people query.
  // Returns null (degrade) if the field isn't in the explore.
  async function identityEmails(entityId, user, field, eventIds) {
    const body = {
      model: cat.model, view: cat.explore, fields: [field],
      filters: { 'core_events.id': eventIds.join(',') }, limit: 500000,
    };
    const allowed = await query.applyScope(body, user, null);
    if (allowed === false) return null;
    const locks = auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
    if (locks && locks[ORG]) body.filters = { ...body.filters, ...locks };
    else if (!body.filters[ORG]) return null; // fail closed — never resolve cross-client
    try {
      const rows = await query.runLookerQuery('/queries/run/json', body);
      const set = new Set();
      for (const r of (rows || [])) {
        const e = String(r[field] || '').trim().toLowerCase();
        if (e.includes('@')) set.add(e);
      }
      return set;
    } catch { return null; }
  }

  async function overlap(entityId, user, { event = '' } = {}) {
    const cacheKey = `${entityId}:${event}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (!posthog.isConfigured()) return { configured: false };
    // ONE event scope drives everything: the client's suite-locked events —
    // optionally narrowed to a single one of them (never widened beyond them).
    let eventIds = await posthog.eventIdsForEntity(entityId);
    if (!eventIds.length) return { configured: true, scoped: false };
    if (event && eventIds.includes(String(event))) eventIds = [String(event)];
    const [appSide, appTotal, buyerEmails, attendees] = await Promise.all([
      posthog.appEmails(eventIds, { days: APP_WINDOW_DAYS }),
      posthog.windowUniques(eventIds, { days: APP_WINDOW_DAYS }),
      identityEmails(entityId, user, ID_EMAIL, eventIds),
      identityEmails(entityId, user, 'core_users.email', eventIds),
    ]);
    if (!buyerEmails) throw new HttpError(400, 'Couldn\'t resolve the buyer list for these events.');
    const matched = appSide.emails.filter((e) => buyerEmails.has(e)).length;
    const matchedAttendees = attendees ? appSide.emails.filter((e) => attendees.has(e)).length : null;
    const data = {
      configured: true, scoped: true, asOf: new Date().toISOString(), windowDays: APP_WINDOW_DAYS,
      event: eventIds.length === 1 && event ? String(event) : '',
      appUsers: appTotal || appSide.persons, appUsersWithEmail: appSide.emails.length, appCapped: !!appSide.capped,
      // Who PAID for THESE events (purchaser contact on the order) …
      buyers: buyerEmails.size, matched,
      appNotBuyers: appSide.emails.length - matched,
      buyersNotOnApp: Math.max(0, buyerEmails.size - matched),
      // … vs who HELD a ticket for them (the user on each ticket) — the wider segment.
      attendees: attendees ? attendees.size : null,
      matchedAttendees,
      appNotAttendees: attendees ? appSide.emails.length - matchedAttendees : null,
      attendeesNotOnApp: attendees ? Math.max(0, attendees.size - matchedAttendees) : null,
    };
    if (cache.size > 100) cache.clear();
    cache.set(cacheKey, { at: Date.now(), data });
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
    res.json(await overlap(req.params.entityId, req.user, { event: String(req.query.event || '') }));
  }));
  app.get('/api/admin/entities/:id/app-audience', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!db.getEntity(req.params.id)) throw new HttpError(404, 'Not found');
    res.json(await overlap(req.params.id, req.user, { event: String(req.query.event || '') }));
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
