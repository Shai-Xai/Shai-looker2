// ─── Owl data catalogue — curated DEFAULT seed for the "All Tickets" explore ───
// The agentic Owl's `askData` tool must NOT see the raw explore: combined/all_tickets
// exposes ~692 visible dimensions + 63 measures (plus 371 hidden) — far too many to
// ground an accurate answer. This seed is the hand-curated, high-value slice the Owl
// is allowed to query, derived from the live Looker metadata (platform45,
// model `combined`, explore `all_tickets`) on 2026-06-28.
//
// Shape is consumed by server/dataCatalogue.js (M1) and stored in owl_catalogue as
// the `global` default; a Howler admin can widen/narrow per client. Curation quality
// IS the accuracy ceiling (see docs/specs/AGENTIC_OWL_P1_PLAN.md §6, §11.2).
//
// DELIBERATELY EXCLUDED: per-person PII/contact fields (email, cellphone, id_number,
// passport, street, date_of_birth, sign-in timestamps). askData answers AGGREGATE
// questions; it never needs to read a buyer's contact row. Audience-building from
// contact data stays in the governed segment resolver, not here.

module.exports = {
  model: 'combined',
  explore: 'all_tickets',
  label: 'All Tickets',

  // The default date grain for "last week / this month / since launch" questions:
  // when the ticket was BOUGHT (the sell timeline). Event date is separate.
  dateDimension: 'all_tickets.purchased_date',
  eventDateDimension: 'core_events.start_date',

  // ── Measures (the numbers the Owl can compute) ──────────────────────────────
  // `default: true` = headline metrics offered first. `aka` = natural-language
  // synonyms the Owl maps a question onto.
  measures: [
    // "Tickets sold" = the distinct ticket-record count. NB: this explore aliases
    // the core tickets table as `all_tickets`, so all_tickets.count IS the core
    // tickets count (there is no separate core_tickets.count field here).
    { name: 'all_tickets.count',                 label: 'Tickets Sold',         type: 'count_distinct', default: true,  aka: ['tickets sold', 'sold', 'sales volume', 'how many tickets', 'number of tickets', 'ticket count'] },
    { name: 'all_tickets.sum_revenue_decimal',   label: 'Total Revenue',        type: 'sum_distinct',   default: true,  unit: 'ZAR', aka: ['revenue', 'sales', 'gross', 'money', 'turnover'] },
    { name: 'all_tickets.Average_ticket_price',  label: 'Average Ticket Price', type: 'average',        default: true,  unit: 'ZAR', aka: ['average price', 'avg ticket price', 'price per ticket'] },
    { name: 'all_tickets.sold_tickets',          label: 'Tickets Sold (excl. comps)', type: 'sum',      default: false, aka: ['net sold', 'paid tickets', 'sold excluding complimentary'] },
    { name: 'all_tickets.issued_tickets',        label: 'Issued Tickets',       type: 'count_distinct', default: false, aka: ['issued'] },
    { name: 'all_tickets.complimentary_tickets', label: 'Complimentary Tickets',type: 'sum',            default: false, aka: ['comps', 'complimentary', 'free tickets'] },
    { name: 'all_tickets.sum_fee_decimal',       label: 'Total Ticket Fee',     type: 'sum_distinct',   default: false, unit: 'ZAR', aka: ['fees', 'booking fees'] },
    { name: 'all_tickets.sum_cost_decimal',      label: 'Ticket Cost Sum',      type: 'sum_distinct',   default: false, unit: 'ZAR', aka: ['cost', 'face value'] },
    { name: 'core_ticket_transactions_combined.sold',      label: 'Sold (inventory)', type: 'sum',     default: false, aka: ['sold against allocation'] },
    { name: 'core_ticket_transactions_combined.remaining', label: 'Remaining',        type: 'sum',     default: false, aka: ['remaining', 'left', 'inventory left', 'still available', 'unsold'] },
  ],

  // ── Dimensions (how the Owl can slice + filter) ─────────────────────────────
  // `filter: true` = safe to filter on (and to offer values for). `group` organises
  // the catalogue for the curation UI + the prompt.
  dimensions: [
    // Event
    { name: 'core_events.name',                    label: 'Event Name',     group: 'Event',  type: 'string', filter: true, aka: ['event', 'which event'] },
    { name: 'core_events.start_date',              label: 'Event Date',     group: 'Event',  type: 'date',   filter: true, aka: ['event date', 'when is the event'] },
    { name: 'core_events.status',                  label: 'Event Status',   group: 'Event',  type: 'number', filter: true },
    { name: 'core_events.currency',                label: 'Currency',       group: 'Event',  type: 'string', filter: true },
    { name: 'core_sa_city_location.city_name',     label: 'Event City',     group: 'Event',  type: 'string', filter: true, aka: ['city', 'event city', 'where'] },
    { name: 'core_sa_province_location.province_name', label: 'Event Province', group: 'Event', type: 'string', filter: true, aka: ['province', 'region'] },
    { name: 'core_organisers.name',                label: 'Organiser',      group: 'Event',  type: 'string', filter: true, aka: ['promoter', 'organiser'] },

    // Ticket
    { name: 'core_ticket_types.name',              label: 'Ticket Type',    group: 'Ticket', type: 'string', filter: true, aka: ['ticket type', 'vip', 'ga', 'general admission', 'tier'] },
    { name: 'core_ticket_categories.name',         label: 'Ticket Category',group: 'Ticket', type: 'string', filter: true, aka: ['category'] },
    { name: 'core_ticket_types.reporting_category',label: 'Reporting Category', group: 'Ticket', type: 'string', filter: true },
    { name: 'all_tickets.status',                  label: 'Ticket Status',  group: 'Ticket', type: 'string', filter: true, aka: ['status', 'valid', 'refunded'] },
    { name: 'all_tickets.is_complimentary',        label: 'Is Complimentary', group: 'Ticket', type: 'yesno', filter: true, aka: ['comp', 'free'] },

    // Purchase timing (relative — for sell curves + "N days before event")
    { name: 'all_tickets.purchased_date',          label: 'Purchased Date', group: 'Timing', type: 'date',   filter: true, aka: ['purchase date', 'when bought', 'sale date'] },
    { name: 'all_tickets.days_before_event',       label: 'Days Before Event', group: 'Timing', type: 'number', filter: true, aka: ['days before event', 'days out', 'lead time'] },
    { name: 'all_tickets.weeks_before_event',      label: 'Weeks Before Event', group: 'Timing', type: 'number', filter: true },

    // Buyer (aggregate demographics only — NO contact PII)
    { name: 'core_purchasers.city',                label: 'Buyer City',     group: 'Buyer',  type: 'string', filter: true, aka: ['buyer city', 'customer city'] },
    { name: 'core_purchasers.province',            label: 'Buyer Province', group: 'Buyer',  type: 'string', filter: true },
    { name: 'core_purchasers.gender',              label: 'Buyer Gender',   group: 'Buyer',  type: 'string', filter: true, aka: ['gender'] },
    { name: 'core_purchasers.age',                 label: 'Buyer Age',      group: 'Buyer',  type: 'number', filter: true, aka: ['age'] },
    { name: 'core_purchasers.country',             label: 'Buyer Country',  group: 'Buyer',  type: 'string', filter: true },
  ],

  // ── Synonym shortcuts (word → field) for the prompt's grounding ─────────────
  // Disambiguation the Owl should respect (e.g. "city" is ambiguous: event vs buyer).
  notes: [
    '"Tickets sold" = all_tickets.count (distinct ticket records — the core tickets count; this explore aliases core_tickets as all_tickets). all_tickets.sold_tickets EXCLUDES complimentary tickets — use it only when explicitly asked for paid/net sold.',
    '"Revenue" = all_tickets.sum_revenue_decimal (ZAR, gross). Fees and cost are separate measures.',
    '"City" is ambiguous — default to Event City (core_sa_city_location.city_name); use Buyer City only when the question is about where customers are from.',
    '"Remaining"/"sold out" use core_ticket_transactions_combined.remaining.',
    'All amounts are South African Rand (ZAR).',
  ],

  // What is intentionally NOT queryable here (privacy + noise control).
  excluded: {
    reason: 'PII/contact + low-value high-cardinality fields kept out of askData.',
    patterns: ['email', 'cellphone', 'id_number', 'passport', 'street', 'postal_code', 'date_of_birth', 'sign_in', 'barcode', 'reference', 'slug'],
  },
};
