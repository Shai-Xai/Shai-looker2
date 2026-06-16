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
    short: 'Email customers who started a ticket purchase but didn’t finish — nudge them to complete it.',
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
      body: 'Hi {{name}},\n\nYou were so close! Your {{ticketType}} is still waiting — complete your checkout before it’s gone.\n\nSee you there.',
      ctaText: 'Complete my purchase',
      utm: { source: 'pulse', medium: 'email', campaign: 'abandoned-cart' },
    },
  },
];

// ─── Journey recipes (Engage → Journeys, J1) ─────────────────────────────────
// Whole pre-wired multi-step journeys (not just one email). A promoter picks one
// and only fills in audience + finalises copy. Each is a LINEAR timed sequence
// today (runs on the drip engine); `reactsTo` records the behavioural intent for
// the review summary + the branching engine that lands later. These map 1:1 onto
// a campaign's `steps` (delayHours/channel/subject/body/ctaText).
const JOURNEY_RECIPES = [
  {
    key: 'abandoned_cart_journey',
    label: 'Recover abandoned checkouts',
    short: 'Email the people who started but didn’t finish, then follow up — escalating to SMS if they still haven’t bought.',
    goal: 'Recover customers who abandoned checkout and get them to complete the purchase.',
    summary: 'We email them straight away, nudge again by email after a day, then send a short SMS after two days if they still haven’t bought.',
    steps: [
      { channel: 'email', delayHours: 0, reactsTo: 'sent right away', subject: 'You left something behind 🎟️', body: 'Hi {{name}},\n\nYou were so close — your {{ticketType}} is still waiting. Pick up where you left off before it’s gone.', ctaText: 'Complete my order' },
      { channel: 'email', delayHours: 24, reactsTo: 'if they still haven’t bought after a day', subject: 'Still thinking it over?', body: 'Hi {{name}},\n\nYour spot isn’t booked yet. Tickets are moving — grab yours before they sell out.', ctaText: 'Get my tickets' },
      { channel: 'sms', delayHours: 48, reactsTo: 'if still no purchase after two days — escalate to SMS', subject: '', body: 'Last call {{name}} — your tickets are still waiting but selling fast. Tap to finish up:', ctaText: 'Finish order' },
    ],
  },
  {
    key: 'winback_lapsed',
    label: 'Win back lapsed buyers',
    short: 'Re-engage people who used to buy but have gone quiet, with a friendly email then an SMS offer.',
    goal: 'Bring lapsed customers back to buy again.',
    summary: 'We send a “we miss you” email, wait three days, then follow up with a short SMS offer for anyone who hasn’t come back.',
    steps: [
      { channel: 'email', delayHours: 0, reactsTo: 'sent right away', subject: 'We’ve missed you 👋', body: 'Hi {{name}},\n\nIt’s been a while! We’ve got new events lined up we think you’ll love. Come see what’s on.', ctaText: 'See what’s on' },
      { channel: 'sms', delayHours: 72, reactsTo: 'if they haven’t come back after three days', subject: '', body: 'Hi {{name}}, still keen? Here’s a little something to welcome you back — tap to browse what’s coming up:', ctaText: 'Browse events' },
    ],
  },
  {
    key: 'pre_event_reminder',
    label: 'Pre-event reminder',
    short: 'Build excitement before the event with a reminder email and a day-of SMS.',
    goal: 'Maximise attendance and reduce no-shows for an upcoming event.',
    summary: 'We send a reminder email a few days before, then a short SMS on the day with the key details.',
    steps: [
      { channel: 'email', delayHours: 0, reactsTo: 'sent a few days out', subject: 'Almost showtime 🎉', body: 'Hi {{name}},\n\nNot long now! Here’s everything you need to know before the doors open. Can’t wait to see you there.', ctaText: 'View event info' },
      { channel: 'sms', delayHours: 48, reactsTo: 'day-of nudge', subject: '', body: 'See you today, {{name}}! Doors open soon — tap for directions, timings and your ticket:', ctaText: 'Event details' },
    ],
  },
  {
    key: 'post_event_upsell',
    label: 'Thank-you → next event',
    short: 'Thank attendees, then point the engaged ones to your next event.',
    goal: 'Turn happy attendees into repeat buyers for the next event.',
    summary: 'We send a thank-you email after the event, then follow up a few days later with the next event for people to book again.',
    steps: [
      { channel: 'email', delayHours: 0, reactsTo: 'sent right after the event', subject: 'Thanks for coming! 🙌', body: 'Hi {{name}},\n\nWhat a night — thank you for being there. We’d love to see you again soon.', ctaText: 'Relive it' },
      { channel: 'email', delayHours: 72, reactsTo: 'a few days later, point them to the next event', subject: 'Your next one’s already here', body: 'Hi {{name}},\n\nLoved having you. Here’s what’s coming up next — get in early before it sells out.', ctaText: 'See what’s next' },
    ],
  },
];
const byJourneyKey = Object.fromEntries(JOURNEY_RECIPES.map((r) => [r.key, r]));
function listJourneys() {
  return JOURNEY_RECIPES.map((r) => ({ key: r.key, label: r.label, short: r.short, goal: r.goal, summary: r.summary, steps: r.steps }));
}
function getJourney(key) { return byJourneyKey[key] || null; }

const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
function get(key) { return byKey[key] || null; }
// Public list (no internals) for the gallery.
function list() {
  return TEMPLATES.map((t) => ({ key: t.key, category: t.category, label: t.label, short: t.short, type: t.type, capability: t.capability, recurringSuggested: !!t.recurringSuggested }));
}

// Resolve a template's audience source for one client, given a tile catalogue
// [{ dashboardId, title, tiles:[{tileId, title, fields:[fieldName] }] }].
// Returns the matched dashboard/tile + suggested field mappings, and `ready`
// (whether a usable source was found). The client can still adjust everything.
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

module.exports = { TEMPLATES, get, list, resolveAudience, JOURNEY_RECIPES, listJourneys, getJourney };
