// ─── Action templates (recipes) ──────────────────────────────────────────────
// Pre-configured action blueprints. A client picks one ("Abandoned carts →
// Recover checkouts"), Pulse resolves the right dashboard/tile + field mappings
// from THEIR data, and the editor opens pre-filled so they just finalize. The
// abandoned-cart template is the first; more drop in here. Each carries a
// category (for grouping/labelling) and matching hints so the audience source
// is found automatically per client.
//
// Code-defined for now (like roles); can become data-driven later. The catalog
// also feeds automation: a template marked recurringSuggested powers the daily
// auto-check.

const TEMPLATES = [
  {
    key: 'abandoned_cart',
    category: 'Abandoned carts',
    label: 'Recover abandoned checkouts',
    short: 'Email customers who started a ticket purchase but didn’t finish, and nudge them to complete it.',
    type: 'email_campaign',
    capability: 'email_campaign',
    recurringSuggested: true,
    // Find the audience source by TILE title — the "abandoned" people-list tile
    // usually lives on a broader dashboard (e.g. "Ticketing Overview"), so we
    // don't require the dashboard title to match too (an email column is still
    // required, so only the right tile resolves).
    match: { tile: /abandon|incomplete|unfinished|drop.?off|didn.?t.*(finish|complet)|started.*(checkout|purchase)|pending.*(order|checkout|payment)/i },
    // Pick the email / name / ticket / consent columns by field-name hints
    // (first match wins). Resolved against the matched tile's query fields.
    fieldHints: {
      emailField: [/e-?mail/i],
      nameField: [/(^|[._])name/i, /customer/i],
      ticketField: [/ticket.?type/i, /ticket.?name/i, /product/i],
      consentField: [/allow.*e-?mail/i, /e-?mail.*(consent|opt|allow|subscrib)/i, /consent/i, /opt.?in/i, /marketing/i, /subscrib/i],
    },
    preset: {
      goal: 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.',
      subject: 'You left something behind 🎟️',
      body: 'Hi {{name}},\n\nYou were so close! Your {{ticketType}} is still waiting, so complete your checkout before it’s gone.\n\nSee you there.',
      ctaText: 'Complete my purchase',
      utm: { source: 'pulse', medium: 'email', campaign: 'abandoned-cart' },
    },
  },
];

// ─── Journey recipes (Engage → Journeys) ──────────────────────────────────────
// Whole pre-wired BRANCHING journeys (decision trees). A promoter picks one and
// only fills in audience + finalises copy. Each is a tree of `nodes`: `message`
// nodes (channel/delayHours/subject/body/ctaText) interleaved with `decision`
// nodes that branch on behaviour (bought / clicked / opened / no response).
// Same node shape the Owl's draftJourney tool emits + JourneyTree renders.
// Served by GET /api/journeys/:entityId/recipes (server/journeys.js).
const msg = (channel, delayHours, subject, body, ctaText) => ({ type: 'message', channel, delayHours, subject, body, ctaText });
const decide = (question, waitHours, branches) => ({ type: 'decision', question, waitHours, branches });

const JOURNEY_RECIPES = [
  {
    key: 'abandoned_cart_journey',
    label: 'Recover abandoned checkouts',
    short: 'Email people who didn’t finish, then branch: thank the buyers, nudge the clickers, and escalate the quiet ones to SMS.',
    goal: 'Recover customers who abandoned checkout and get them to complete the purchase.',
    summary: 'We email them right away. After two days we check what happened: buyers get a thank-you and stop; people who clicked but didn’t buy get a fresh email; everyone else gets a last-call SMS.',
    nodes: [
      msg('email', 0, 'You left something behind 🎟️', 'Hi {{name}},\n\nYou were so close - your {{ticketType}} is still waiting. Pick up where you left off before it’s gone.', 'Complete my order'),
      decide('After 2 days, what did they do?', 48, [
        { label: 'Bought', nodes: [
          msg('email', 0, 'You’re in! 🎉', 'Hi {{name}},\n\nYour tickets are confirmed - thanks for grabbing them. See you there!', 'View my tickets'),
        ] },
        { label: 'Clicked but didn’t buy', nodes: [
          msg('email', 0, 'Still thinking it over?', 'Hi {{name}},\n\nYou took a look - nice! Your spot isn’t booked yet though, and tickets are moving fast.', 'Get my tickets'),
        ] },
        { label: 'No response', nodes: [
          msg('sms', 0, '', 'Last call {{name}} - your tickets are still waiting but selling fast. Tap to finish up:', 'Finish order'),
        ] },
      ]),
    ],
  },
  {
    key: 'winback_lapsed',
    label: 'Win back lapsed buyers',
    short: 'Re-engage people who’ve gone quiet, then branch on whether they re-engage or stay silent.',
    goal: 'Bring lapsed customers back to buy again.',
    summary: 'We send a “we miss you” email. After three days, people who opened it get a friendly follow-up; people who ignored it get a short SMS offer.',
    nodes: [
      msg('email', 0, 'We’ve missed you 👋', 'Hi {{name}},\n\nIt’s been a while! We’ve got new events lined up we think you’ll love. Come see what’s on.', 'See what’s on'),
      decide('After 3 days, did they open it?', 72, [
        { label: 'Opened', nodes: [
          msg('email', 0, 'Picking up where we left off', 'Hi {{name}},\n\nGreat to see you back. Here are a few coming up we think are right up your street.', 'Browse events'),
        ] },
        { label: 'No open', nodes: [
          msg('sms', 0, '', 'Hi {{name}}, still keen? Here’s a little something to welcome you back - tap to see what’s coming up:', 'Browse events'),
        ] },
      ]),
    ],
  },
  {
    key: 'pre_event_reminder',
    label: 'Pre-event reminder',
    short: 'Build excitement before the event with a reminder email and a day-of SMS.',
    goal: 'Maximise attendance and reduce no-shows for an upcoming event.',
    summary: 'We send a reminder email a few days before, then a short SMS on the day with the key details.',
    nodes: [
      msg('email', 0, 'Almost showtime 🎉', 'Hi {{name}},\n\nNot long now! Here’s everything you need to know before the doors open. Can’t wait to see you there.', 'View event info'),
      msg('sms', 48, '', 'See you today, {{name}}! Doors open soon - tap for directions, timings and your ticket:', 'Event details'),
    ],
  },
  {
    key: 'post_event_upsell',
    label: 'Thank-you → next event',
    short: 'Thank attendees, then point the ones who engaged to your next event.',
    goal: 'Turn happy attendees into repeat buyers for the next event.',
    summary: 'We send a thank-you email after the event. A few days later we check who engaged: people who clicked get the next event; the rest get a gentler nudge.',
    nodes: [
      msg('email', 0, 'Thanks for coming! 🙌', 'Hi {{name}},\n\nWhat a night - thank you for being there. We’d love to see you again soon.', 'Relive it'),
      decide('After 3 days, did they click?', 72, [
        { label: 'Clicked', nodes: [
          msg('email', 0, 'Your next one’s already here', 'Hi {{name}},\n\nLoved having you. Here’s what’s coming up next - get in early before it sells out.', 'See what’s next'),
        ] },
        { label: 'Didn’t click', nodes: [
          msg('email', 0, 'One more from us', 'Hi {{name}},\n\nIn case you missed it - here’s a peek at what’s coming up. No rush, just so you’re first to know.', 'See what’s on'),
        ] },
      ]),
    ],
  },
];
const byJourneyKey = Object.fromEntries(JOURNEY_RECIPES.map((r) => [r.key, r]));
function listJourneys() {
  return JOURNEY_RECIPES.map((r) => ({ key: r.key, label: r.label, short: r.short, goal: r.goal, summary: r.summary, nodes: r.nodes }));
}
function getJourney(key) { return byJourneyKey[key] || null; }

const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
function get(key) { return byKey[key] || null; }
// Public list (no internals) for the gallery.
function list() {
  return TEMPLATES.map((t) => ({ key: t.key, category: t.category, label: t.label, short: t.short, type: t.type, capability: t.capability, recurringSuggested: !!t.recurringSuggested }));
}

// Resolve a template's audience source for one client, given a tile catalogue
// [{ dashboardId, suiteId, title, tiles:[{tileId, title, fields:[fieldName] }] }].
// Dashboards are tried in order, so pass the event the suggestion pointed at
// first to scope a multi-event client to the right one. Returns the matched
// dashboard/tile/event + suggested field mappings, and `ready` (whether a usable
// source was found). The client can still adjust everything.
function resolveAudience(t, dashboards) {
  const pickField = (fields, hints) => {
    for (const h of hints) { const f = (fields || []).find((name) => h.test(name)); if (f) return f; }
    return '';
  };
  for (const d of dashboards || []) {
    if (t.match?.dashboard && !t.match.dashboard.test(d.title || '')) continue;
    for (const tile of d.tiles || []) {
      if (t.match?.tile && !t.match.tile.test(tile.title || '')) continue;
      const fields = tile.fields || [];
      const emailField = pickField(fields, t.fieldHints?.emailField || []);
      if (!emailField) continue; // an email column is the minimum for an email campaign
      return {
        ready: true,
        dashboardId: d.dashboardId,
        // The event (suite) the matched tile belongs to — so a multi-event
        // campaign scopes its audience to the right event automatically.
        suiteId: d.suiteId || '',
        tileId: tile.tileId,
        emailField,
        nameField: pickField(fields, t.fieldHints?.nameField || []),
        ticketField: pickField(fields, t.fieldHints?.ticketField || []),
        consentField: pickField(fields, t.fieldHints?.consentField || []),
      };
    }
  }
  return { ready: false };
}

// Scope + order a dashboard catalogue for a deep-linked suggestion before
// resolving its audience. `prefer` ({ dashboardId, suiteId }) targets ONE event:
// we HARD-restrict to that event's dashboards (explicit suite, else the suite
// that owns the pointed dashboard) so resolveAudience's first-match-wins can never
// fall through to a DIFFERENT event's abandoned-cart tile (which would target the
// wrong crowd). The pointed dashboard is ordered first within its event so its own
// tile wins when it has one. With no prefer, returns the full catalogue unchanged.
function scopeDashboards(dashboards, prefer = {}) {
  let out = dashboards || [];
  const { dashboardId } = prefer;
  let suiteId = prefer.suiteId || '';
  if (!suiteId && dashboardId) suiteId = out.find((d) => d.dashboardId === dashboardId)?.suiteId || '';
  if (suiteId) out = out.filter((d) => d.suiteId === suiteId);
  if (dashboardId) {
    const isPref = (d) => d.dashboardId === dashboardId;
    out = [...out.filter(isPref), ...out.filter((d) => !isPref(d))];
  }
  return out;
}

module.exports = { TEMPLATES, get, list, resolveAudience, scopeDashboards, JOURNEY_RECIPES, listJourneys, getJourney };
