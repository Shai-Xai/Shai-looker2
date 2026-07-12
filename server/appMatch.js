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
// Mount: require('./appMatch').mount(app, { db, auth, posthog, segments })
// Uninstall: remove this file + its mount line + the AudienceMatchCard /
// tickets column in client/src/components/AppAnalytics.jsx + its GATES rows.

const { HttpError, asyncHandler } = require('./http');

const CACHE_MS = 10 * 60_000;  // overlap is expensive (Looker + PostHog) — reuse
const APP_WINDOW_DAYS = 90;
const TICKET_EMAILS = 200;     // per-request cap for tickets-by-email enrichment
const ORG = 'core_organisers.name';
const ID_EMAIL = 'core_purchasers.email';

function mount(app, { db, auth, posthog, queryEngine, catalogue, segments }) {
  const cat = catalogue || require('./owlCatalogueSeed');
  const query = queryEngine || require('./query')({ looker: require('./looker'), auth });
  const segApi = () => (typeof segments === 'function' ? segments() : segments); // lazy — segments mounts later in index.js

  const cache = new Map(); // `${entityId}:${event}` → { at, sets }

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

  // Resolve the three identity sets ONCE (app emails, buyers, holders) for the
  // scope — both the counts card and segment creation compute from these.
  async function resolveSets(entityId, user, event = '') {
    const cacheKey = `${entityId}:${event}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.sets;
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
    const sets = {
      configured: true, scoped: true, event: eventIds.length === 1 && event ? String(event) : '', eventIds,
      appEmails: appSide.emails, appTotal: appTotal || appSide.persons, appCapped: !!appSide.capped,
      buyers: buyerEmails, attendees,
    };
    if (cache.size > 100) cache.clear();
    cache.set(cacheKey, { at: Date.now(), sets });
    return sets;
  }

  async function overlap(entityId, user, { event = '' } = {}) {
    const s = await resolveSets(entityId, user, event);
    if (!s.configured || !s.scoped) return s;
    const matched = s.appEmails.filter((e) => s.buyers.has(e)).length;
    const matchedAttendees = s.attendees ? s.appEmails.filter((e) => s.attendees.has(e)).length : null;
    return {
      configured: true, scoped: true, asOf: new Date().toISOString(), windowDays: APP_WINDOW_DAYS,
      event: s.event, eventCount: s.eventIds.length,
      appUsers: s.appTotal, appUsersWithEmail: s.appEmails.length, appCapped: s.appCapped,
      // Who PAID for THESE events (purchaser contact on the order) …
      buyers: s.buyers.size, matched,
      appNotBuyers: s.appEmails.length - matched,
      buyersNotOnApp: Math.max(0, s.buyers.size - matched),
      // … vs who HELD a ticket for them (the user on each ticket) — the wider segment.
      attendees: s.attendees ? s.attendees.size : null,
      matchedAttendees,
      appNotAttendees: s.attendees ? s.appEmails.length - matchedAttendees : null,
      attendeesNotOnApp: s.attendees ? Math.max(0, s.attendees.size - matchedAttendees) : null,
    };
  }

  // ── the payoff: turn a group into a real LIVE Engage segment ──
  // The groups mix PostHog + Looker identity, which no single Looker query can
  // express — so the segment stores { mode: 'appmatch', group, appEvent } and
  // the campaign engine calls back into groupEmails() at EVERY resolve (reach
  // check, preview, send). Members are always computed server-side; the browser
  // only ever names a group.
  const GROUPS = {
    app_users: { label: '📲 App users', make: (s) => s.appEmails },
    app_holders: { label: '🎟 App users with a ticket', make: (s) => (s.attendees ? s.appEmails.filter((e) => s.attendees.has(e)) : null) },
    app_buyers: { label: '💳 App users who bought', make: (s) => s.appEmails.filter((e) => s.buyers.has(e)) },
    never_ticket: { label: '📲 App fans — never held a ticket', make: (s) => (s.attendees ? s.appEmails.filter((e) => !s.attendees.has(e)) : s.appEmails.filter((e) => !s.buyers.has(e))) },
    holders_not_app: { label: '🎟 Ticket holders not on the app', make: (s) => (s.attendees ? [...s.attendees].filter((e) => !s.appSet.has(e)) : null) },
    buyers_not_app: { label: '💳 Buyers not on the app', make: (s) => [...s.buyers].filter((e) => !s.appSet.has(e)) },
    group_buy: { label: '🎟 Held a ticket, never paid', make: (s) => (s.attendees ? [...s.attendees].filter((e) => !s.buyers.has(e)) : null) },
  };
  const SEGMENT_MAX = 20000; // sanity ceiling per resolve — the campaign cap still applies after
  const SUPER_MIN = 10, SUPER_MAX = 500; // 🏆 super-fans segment size bounds
  async function groupEmails(entityId, user, { group, event = '', size = 0 } = {}) {
    // 🏆 super_fans is PostHog-only: the top-N most active app users in the
    // window (staff excluded) — ranked live, so the segment tracks the leaderboard.
    if (String(group) === 'super_fans') {
      if (!posthog.isConfigured()) throw new HttpError(400, 'App analytics isn\'t configured.');
      let eventIds = await posthog.eventIdsForEntity(entityId);
      if (!eventIds.length) throw new HttpError(400, 'App analytics isn\'t scoped for this client yet.');
      if (event && eventIds.includes(String(event))) eventIds = [String(event)];
      const n = Math.min(Math.max(Number(size) || 50, SUPER_MIN), SUPER_MAX);
      const { people: fans } = await posthog.people({ ids: eventIds, days: APP_WINDOW_DAYS, orderBy: 'active', limit: n, excludeStaff: true });
      const emails = [...new Set(fans.map((p) => String(p.email || '').trim().toLowerCase()).filter((e) => e.includes('@')))];
      return { emails, total: emails.length, size: n, sets: { event: event && eventIds.length === 1 ? String(event) : '' }, label: `🏆 Top ${n} super fans` };
    }
    const g = GROUPS[String(group || '')];
    if (!g) throw new HttpError(400, 'Unknown group.');
    const s = await resolveSets(entityId, user, event);
    if (!s.configured || !s.scoped) throw new HttpError(400, 'App analytics isn\'t scoped for this client yet.');
    // The not-on-app groups dedupe against a Set of app emails — build once.
    const raw = g.make({ ...s, appSet: new Set(s.appEmails) });
    if (raw === null) throw new HttpError(400, 'Ticket-holder data isn\'t available for this client.');
    return { emails: raw.slice(0, SEGMENT_MAX), total: raw.length, size: 0, sets: s, label: g.label };
  }
  async function createGroupSegment(entityId, user, { group, event = '', size = 0 } = {}) {
    const segmentsApi = segApi();
    if (!segmentsApi || typeof segmentsApi.createSegment !== 'function') throw new HttpError(400, 'Segments are not available.');
    const { emails, sets: s, label, size: n } = await groupEmails(entityId, user, { group, event, size });
    if (!emails.length) throw new HttpError(400, 'No one is in this group right now.');
    let eventName = '';
    if (s.event) {
      try { eventName = String(db.db.prepare('SELECT event_name FROM posthog_daily_event WHERE event_ref=? AND event_name<>\'\' LIMIT 1').get(s.event)?.event_name || ''); } catch { /* name is a nicety */ }
    }
    const name = `${label} · ${eventName || (s.event ? `event ${s.event}` : 'all events')}`.slice(0, 120);
    const out = segmentsApi.createSegment({
      entityId, user, via: 'app-match',
      name,
      folder: 'App audience',
      definition: { mode: 'appmatch', group: String(group), appEvent: s.event, appSize: n || 0 },
    });
    if (!out.ok) throw new HttpError(400, out.error || 'Could not create the segment.');
    return { ok: true, segment: { id: out.segment.id, name: out.segment.name }, count: emails.length, live: true };
  }

  // ── 🎫 what the matched app users actually HOLD, ticket-type by ticket-type —
  // plus the share of ALL tickets sold that sit in app users' hands. Aggregates
  // only (type name + counts) cross the wire; the email lists stay server-side.
  const TYPE_EMAILS = 3000;  // matched-holder ceiling for the type breakdown (chunked queries)
  async function ticketSummary(entityId, user, { event = '' } = {}) {
    const cacheKey = `types:${entityId}:${event}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.sets;
    const s = await resolveSets(entityId, user, event);
    if (!s.configured || !s.scoped) return { configured: !!s.configured, scoped: false };
    const scopeFilters = { 'core_events.id': s.eventIds.join(',') };
    const locks = auth.accessibleOrgFilters ? auth.accessibleOrgFilters(user, entityId) : null;
    if (!locks || !locks[ORG]) return { configured: true, scoped: false }; // fail closed
    const run = async (fields, extraFilters) => {
      const body = { model: cat.model, view: cat.explore, fields, filters: { ...scopeFilters, ...locks, ...extraFilters }, limit: 5000 };
      const allowed = await query.applyScope(body, user, null);
      if (allowed === false) return null;
      return query.runLookerQuery('/queries/run/json', body);
    };
    // Total tickets sold for the scope — the denominator.
    const totalRows = await run(['core_tickets.count'], {});
    if (!totalRows) return { configured: true, scoped: false };
    const totalTickets = Number(totalRows[0]?.['core_tickets.count']) || 0;
    // The matched app users (holders when we have them, buyers otherwise), then
    // their tickets grouped by type — chunked email-IN queries, summed. Chunks
    // are disjoint emails, so per-type counts add cleanly.
    const matched = s.attendees ? s.appEmails.filter((e) => s.attendees.has(e)) : s.appEmails.filter((e) => s.buyers.has(e));
    const idField = s.attendees ? 'core_users.email' : ID_EMAIL;
    const use = matched.slice(0, TYPE_EMAILS);
    const types = new Map();
    let appTickets = 0;
    for (let i = 0; i < use.length; i += 250) {
      const rows = await run(['core_ticket_types.name', 'core_tickets.count'], { [idField]: use.slice(i, i + 250).join(',') });
      for (const r of (rows || [])) {
        const t = String(r['core_ticket_types.name'] || '').trim() || 'Other';
        const n = Number(r['core_tickets.count']) || 0;
        if (!n) continue;
        types.set(t, (types.get(t) || 0) + n);
        appTickets += n;
      }
    }
    const out = {
      configured: true, scoped: true, event: s.event,
      totalTickets, appTickets, appHolders: matched.length, holdersCapped: matched.length > use.length,
      types: [...types.entries()].map(([type, tickets]) => ({ type, tickets })).sort((a, b) => b.tickets - a.tickets).slice(0, 12),
    };
    if (cache.size > 100) cache.clear();
    cache.set(cacheKey, { at: Date.now(), sets: out });
    return out;
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
  // One click on the card → a real Engage segment. createSegmentFor re-checks
  // entity ownership + campaigns.approve, so the route only gates "your client".
  const segBody = (req) => ({ group: String((req.body || {}).group || ''), event: String((req.body || {}).event || ''), size: Number((req.body || {}).size) || 0 });
  app.post('/api/my/app-audience/:entityId/segment', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    res.json(await createGroupSegment(req.params.entityId, req.user, segBody(req)));
  }));
  app.post('/api/admin/entities/:id/app-audience/segment', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!db.getEntity(req.params.id)) throw new HttpError(404, 'Not found');
    res.json(await createGroupSegment(req.params.id, req.user, segBody(req)));
  }));
  app.get('/api/my/app-audience/:entityId/tickets-summary', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    res.json(await ticketSummary(req.params.entityId, req.user, { event: String(req.query.event || '') }));
  }));
  app.get('/api/admin/entities/:id/app-audience/tickets-summary', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!db.getEntity(req.params.id)) throw new HttpError(404, 'Not found');
    res.json(await ticketSummary(req.params.id, req.user, { event: String(req.query.event || '') }));
  }));

  return { overlap, ticketsByEmail, createGroupSegment, groupEmails, ticketSummary };
}

module.exports = { mount };
