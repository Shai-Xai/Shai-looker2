// ─── Owl data catalogue — curated DEFAULT seed for ticket sales ────────────────
// The agentic Owl's `askData` tool queries a CURATED slice of one explore (never
// the raw firehose). Source: platform45, model `combined`, explore
// `tickets_purchased` ("Active Tickets"), verified live 2026-06-28.
//
// WHY tickets_purchased / core_tickets (not all_tickets): the `all_tickets` explore
// counts EVERY ticket state (refunded, cancelled, transferred, historical timeline
// rows) and massively over-counts — e.g. Kappa FuturFestival 2026 reads 202,684
// there vs 56,221 active/purchased tickets here. `core_tickets.*` is the realistic
// "sold" grain. Caveat: this explore is PURCHASED/active tickets, so fully
// sponsored/free events read 0 (they were never "purchased").
//
// Shape is consumed by server/dataCatalogue.js + server/owlTools.js and stored in
// owl_catalogue as the `global` default; an admin can widen/narrow per client.
// Curation quality IS the accuracy ceiling (docs/specs/AGENTIC_OWL_P1_PLAN.md).
//
// DELIBERATELY EXCLUDED: per-person PII/contact fields (email, cellphone, id,
// passport, street, date_of_birth, sign-in timestamps). askData answers AGGREGATE
// questions; audience-building from contact data stays in the segment resolver.

module.exports = {
  model: 'combined',
  explore: 'tickets_purchased',
  label: 'Active Tickets',

  // Default date grain for "last week / this month / since launch": when the ticket
  // was BOUGHT (the sell timeline). Event date is separate.
  dateDimension: 'core_tickets.purchased_date',
  eventDateDimension: 'core_events.start_date',

  // ── Measures ────────────────────────────────────────────────────────────────
  // "Tickets sold" = core_tickets.sold_tickets — tickets actually SOLD, EXCLUDING
  // complimentary/comp tickets (Howler policy; matches the dashboards). The raw
  // record count (core_tickets.count) INCLUDES comps and is the "incl. comps"
  // variant, offered only when explicitly asked. Getting this right matters: the
  // WhatsApp Owl once reported 56,404 (incl. ~1,854 comps) vs the dashboard's
  // excl-comps figure — same label, wrong measure.
  measures: [
    { name: 'core_tickets.sold_tickets',         label: 'Tickets Sold',         type: 'sum_distinct',   default: true,  aka: ['tickets sold', 'sold', 'sales volume', 'how many tickets', 'number of tickets', 'ticket count', 'net sold', 'paid tickets', 'sold excluding complimentary'] },
    { name: 'core_tickets.sum_revenue_decimal',  label: 'Total Revenue',        type: 'sum_distinct',   default: true,  unit: 'ZAR', aka: ['revenue', 'sales', 'gross', 'money', 'turnover'] },
    { name: 'core_tickets.Average_ticket_price', label: 'Average Ticket Price', type: 'average_distinct', default: true, unit: 'ZAR', aka: ['average price', 'avg ticket price', 'price per ticket'] },
    { name: 'core_tickets.count',                label: 'Tickets Sold (incl. comps)', type: 'count_distinct', default: false, aka: ['tickets incl comps', 'including complimentary', 'all ticket records', 'issued count'] },
    { name: 'core_tickets.issued_tickets',       label: 'Issued Tickets',       type: 'count_distinct', default: false, aka: ['issued'] },
    { name: 'core_tickets.complimentary_tickets',label: 'Complimentary Tickets',type: 'sum_distinct',   default: false, aka: ['comps', 'complimentary', 'free tickets'] },
    { name: 'core_tickets.sum_fee_decimal',      label: 'Total Ticket Fee',     type: 'sum_distinct',   default: false, unit: 'ZAR', aka: ['fees', 'booking fees'] },
    { name: 'core_tickets.sum_cost_decimal',     label: 'Ticket Cost Sum',      type: 'sum_distinct',   default: false, unit: 'ZAR', aka: ['cost', 'face value'] },
    { name: 'core_ticket_transactions_combined.sold',      label: 'Sold (inventory)', type: 'sum',     default: false, aka: ['sold against allocation'] },
    { name: 'core_ticket_transactions_combined.remaining', label: 'Remaining',        type: 'sum',     default: false, aka: ['remaining', 'left', 'inventory left', 'still available', 'unsold'] },
  ],

  // ── Dimensions (slice + filter) ─────────────────────────────────────────────
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
    { name: 'core_tickets.status',                 label: 'Ticket Status',  group: 'Ticket', type: 'string', filter: true, aka: ['status', 'valid', 'refunded'] },
    { name: 'core_tickets.is_complimentary',       label: 'Is Complimentary', group: 'Ticket', type: 'yesno', filter: true, aka: ['comp', 'free'] },
    // Add-on flag: "Yes" = an extra product (drink pack, locker, shuttle, WC…), "No"
    // = a genuine entry ticket. The reliable ticket-vs-addon split (matches add_on_type).
    { name: 'core_ticket_types.is_addonable',      label: 'Is Add-on (Yes = extra/add-on)', group: 'Ticket', type: 'yesno', filter: true, aka: ['add-on', 'addon', 'extra', 'is add-on', 'drink pack', 'locker'] },

    // Purchase timing (relative — sell curves + "N days before event")
    { name: 'core_tickets.purchased_date',         label: 'Purchased Date', group: 'Timing', type: 'date',   filter: true, aka: ['purchase date', 'when bought', 'sale date'] },
    // Intraday grain. Hour of day (0–23) is the workhorse: group by it for the busiest
    // sell hour / an intraday pattern, OR filter it to "0 to <current hour>" (with a
    // 2-day range, grouped by Purchased Date) for a like-for-like "today so far vs
    // yesterday to the same time" cut. Purchased Hour is an hourly datetime bucket for
    // an hour-by-hour trend within a day. The hour is the FINEST grain — no minute field.
    { name: 'core_tickets.purchased_hour_of_day',  label: 'Purchased Hour of Day', group: 'Timing', type: 'number', filter: true, aka: ['hour', 'hour of day', 'time of day', 'per hour', 'hourly', 'by hour', 'busiest hour', 'sales by hour', 'what hour', 'peak hour'] },
    { name: 'core_tickets.purchased_hour',         label: 'Purchased Hour', group: 'Timing', type: 'date', filter: true, aka: ['hourly trend', 'hour bucket', 'hour by hour', 'sales each hour'] },
    { name: 'core_tickets.days_before_event',      label: 'Days Before Event', group: 'Timing', type: 'number', filter: true, aka: ['days before event', 'days out', 'lead time'] },
    { name: 'core_tickets.weeks_before_event',     label: 'Weeks Before Event', group: 'Timing', type: 'number', filter: true },

    // Buyer (aggregate demographics only — NO contact PII)
    { name: 'core_purchasers.city',                label: 'Buyer City',     group: 'Buyer',  type: 'string', filter: true, aka: ['buyer city', 'customer city'] },
    { name: 'core_purchasers.province',            label: 'Buyer Province', group: 'Buyer',  type: 'string', filter: true },
    { name: 'core_purchasers.gender',              label: 'Buyer Gender',   group: 'Buyer',  type: 'string', filter: true, aka: ['gender'] },
    { name: 'core_purchasers.age',                 label: 'Buyer Age',      group: 'Buyer',  type: 'number', filter: true, aka: ['age'] },
    { name: 'core_purchasers.country',             label: 'Buyer Country',  group: 'Buyer',  type: 'string', filter: true },

    // Customer lookup ONLY (PII): filter to a KNOWN email/mobile to find that one
    // customer's tickets. `filterOnly` = usable as a FILTER but NEVER listed, grouped
    // or returned — so the Owl can answer "what did john@x.com buy?" but can't
    // enumerate or dump customers' contact details.
    { name: 'core_purchasers.email',            label: 'Customer Email',   group: 'Customer lookup', type: 'string', filterOnly: true, aka: ['email', 'customer email', 'find customer', 'search by email', 'look up'] },
    { name: 'core_purchasers.cellphone_number', label: 'Customer Mobile',  group: 'Customer lookup', type: 'string', filterOnly: true, aka: ['mobile', 'phone', 'cellphone', 'search by phone'] },
    { name: 'core_purchasers.first_name',       label: 'Customer First Name', group: 'Customer lookup', type: 'string', filterOnly: true, aka: ['first name', 'name', 'search by name'] },
    { name: 'core_purchasers.last_name',        label: 'Customer Surname', group: 'Customer lookup', type: 'string', filterOnly: true, aka: ['surname', 'last name', 'search by surname'] },
  ],

  // ── Grounding notes for the prompt ──────────────────────────────────────────
  notes: [
    '"Tickets sold" = core_tickets.sold_tickets — tickets actually SOLD, which EXCLUDE complimentary/comp tickets. This is the canonical sold number (it matches the dashboards). NEVER use core_tickets.count for "tickets sold": that COUNTS comps too and overstates the figure. Only use core_tickets.count ("incl. comps") if the user explicitly asks to include complimentary/comps, or asks for issued/all ticket records.',
    'IMPORTANT — the sold/revenue measures INCLUDE add-on products (drink packs, lockers, shuttles, WC, etc.). When asked for tickets sold or revenue, ALWAYS split genuine entry tickets from add-ons: group by or filter core_ticket_types.is_addonable ("No" = entry ticket, "Yes" = add-on) and report them as SEPARATE lines (e.g. "48,615 tickets sold, plus 7,728 add-ons"). Treat the headline "tickets sold" as entry tickets (is_addonable = No) unless the user explicitly asks for the combined total.',
    '"Revenue" = core_tickets.sum_revenue_decimal (gross, in the client\'s reporting currency). Fees and cost are separate measures.',
    'This explore is ACTIVE/PURCHASED tickets — refunded/cancelled tickets are excluded, and fully sponsored/free events read 0. Say so if a total looks unexpectedly low for a free event.',
    '"City" is ambiguous — default to Event City (core_sa_city_location.city_name); use Buyer City only when the question is about where customers are from.',
    '"Remaining"/"sold out" use core_ticket_transactions_combined.remaining. Monetary amounts are in the client\'s reporting currency (stated in the Currency note when it is not Rand) — never relabel them.',
    'CUSTOMER LOOKUP: to find one customer, FILTER core_purchasers.email / cellphone_number / first_name / last_name to the specific known value the user gives — then report that person\'s tickets (type, status, date, count). You CANNOT list, group by, or output customers\' emails/phones/names (no enumeration / no dumping contact lists) — those fields are filter-only. If asked to list everyone\'s contacts, decline and explain that contact lists come from the governed segment/Engage tools with consent.',
    'INTRADAY (per hour): you CAN break sales down by time of day. For "busiest sales hour", an hourly pattern, or "sales per hour", group by core_tickets.purchased_hour_of_day (0–23); for an hour-by-hour trend within a day, group by core_tickets.purchased_hour. The finest grain is the HOUR — there is no minute-level field, so don\'t promise per-minute breakdowns.',
    'SAME-TIME COMPARISON ("today so far vs yesterday"): today is naturally partial (midnight→now) while a plain "yesterday" filter is the FULL 24h, so never compare today against yesterday\'s full-day total — it isn\'t like-for-like. Instead make a clean cut: filter core_tickets.purchased_hour_of_day to "0 to <the current hour>" AND set dateRange to span both days (e.g. "2 days"), then group by core_tickets.purchased_date — so each day is trimmed to the SAME window and the comparison is fair. State the cut-off hour you used.',
  ],

  // What is intentionally NOT queryable here (privacy + noise control).
  excluded: {
    reason: 'PII/contact + low-value high-cardinality fields kept out of askData.',
    patterns: ['email', 'cellphone', 'id_number', 'passport', 'street', 'postal_code', 'date_of_birth', 'sign_in', 'barcode', 'reference', 'slug'],
  },
};
