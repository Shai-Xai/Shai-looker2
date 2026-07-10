# Sponsor Pulse: the sponsor's window into the event
**Working brief — sponsor dashboards, activation analytics & lead capture · July 2026 · internal**

## The one-liner
Sponsor Pulse gives every event sponsor their own live, branded window into the
things sponsors actually buy — audience reached, activation footfall, product
sales, leads captured, promo performance — powered by data Howler already has,
scoped as tightly as everything else in Pulse, and wrapped up in an
auto-generated post-event report they can forward straight to their CMO.

It turns sponsorship reporting from a manual, weeks-late PDF into a live
product — one that organisers can sell as part of their sponsorship packages
and Howler can sell directly to brands.

---

## Why (the jobs a sponsor is hiring us for)
Everything on a sponsor's surface must ladder up to one of these:

1. **Prove ROI to their own boss** — the wrap report is the single most
   valuable artefact; it's what gets forwarded internally and justifies next
   year's spend.
2. **Understand the audience they reached** — demographics, geography,
   spending power, repeat attendance (aggregates only — see guardrails).
3. **Measure the activation** — footfall at their stand (RFID / QR scans),
   samples handed out, competition entries.
4. **Capture leads** — opted-in contacts they can legally remarket to. This is
   the data that is *theirs*.
5. **Sell product on-site** — cashless spend at their bars/outlets, attributed
   to their vendors and products (confirmed: Howler's data can do this today).
6. **Amplify** — promos and campaigns to the audience before, during and after
   the event — without ever touching the organiser's PII (see the approval
   flow below).

## The core reframe
Pulse today serves one relationship: Howler ↔ organiser, scoped to an entity
and its events (suites). A sponsor is a third party whose natural scope is **a
brand across events** — one brand may sponsor five events run by three
different organisers.

So the foundational object is not "a sponsor dashboard"; it is a
**sponsorship deal**: sponsor ↔ suite (event), with a tier and a bundle of
attributions (which vendors, which activation scan points, which promo codes,
which lead forms belong to this sponsor at this event). Everything the sponsor
sees is force-filtered server-side through their deals — same fail-closed
scoping discipline as client scoping today. A sponsor with deals across
several organisers gets a portfolio view; Sponsor Pulse is the first surface
that legitimately aggregates *across* organisers.

## Data feeds (confirmed reality, July 2026)
| Feed | Source | Status |
|---|---|---|
| Ticket sales pacing + buyer demographics | Existing ticketing data (Looker/BigQuery) | ✅ have — needs sponsor-scoped tiles only |
| **Cashless spend per vendor / product** | Cashless data — attributable to a sponsor's vendors & SKUs | ✅ confirmed available |
| **Activation footfall** | RFID / QR activation scans per stand | ✅ confirmed measurable |
| Promo code sales & redemptions | Existing promo/campaign engine | ✅ have |
| Campaign engagement (sends, opens, clicks, conversions) | `actions.js` engine | ✅ have |
| **Lead capture** | Net-new: QR microsite per activation → `sponsor_leads` with explicit consent | 🔨 small new module |
| Brand impressions (modelled) | Attendance × branded touchpoints; methodology stated on-tile | 🔨 derived metric, define formula |

## Surfaces (dual-surface rule — plus one)
Sponsor Pulse has **three** surfaces, not two:

1. **Admin (Howler)** — Admin → Sponsors: create sponsor entities, define
   deals (event, tier, dates), map attributions (vendor IDs, scan points,
   promo codes, lead forms), manage sponsor logins. Lives under
   `/api/admin/sponsors/...` following the existing admin patterns.
2. **Organiser self-service** — the commercial unlock. In the client shell,
   organisers see + manage *their* sponsors for *their* events: invite a
   sponsor, pick what the package includes (which tiles/modules the tier
   unlocks), see what the sponsor sees. "Give your sponsors a live portal"
   becomes a line item organisers charge for. `/api/my/sponsors/...`,
   entity-ownership enforced.
3. **Sponsor portal** — the sponsor's own login (mobile-first, PWA — event-day
   usage is standing at a stand with a phone). Their dashboards, their leads,
   their wrap reports, their branding.

## The dashboard, by event lifecycle
**Pre-event (anticipation + confidence)**
- Ticket sales pacing — "your brand will land in front of a full crowd."
- Audience profile of buyers so far (age / gender / geo, aggregate-only).
- Reach + engagement of co-branded campaign sends.
- Sales attributed to their promo codes.

**Live (event day — the phone-at-the-stand view)**
- Live footfall at their activation(s): RFID/QR scans, unique vs repeat,
  scans-per-hour curve, peak times.
- Live cashless spend on their SKUs; share of category where fair to show.
- Leads captured today vs target.
- A sponsor-scoped LivePulse-style "right now" strip (extends `livepulse.js`).

**Post-event (the wrap)**
- Attendance + modelled brand impressions (methodology stated).
- Full audience breakdown; activation totals (footfall, dwell where derivable,
  engagement rate = scans ÷ attendance).
- Leads delivered (count + export), promo redemptions + attributed revenue,
  product spend totals.
- Portfolio benchmark when they sponsor multiple events ("Bushfire
  outperformed your other activations 2:1 on leads").
- Delivered automatically as a **branded wrap digest** (scheduler/digest
  engine) — the forwardable artefact that sells the whole product.

## The two differentiators
1. **Sponsor campaigns with organiser approval.** The approval workflow in
   `actions.js` already exists. A sponsor drafts a campaign ("20% off at the
   Heineken bar, to attendees"); the *organiser* approves; Pulse sends to the
   organiser's audience. The sponsor never touches the PII — which neatly
   solves the POPIA problem that kills most sponsor-data conversations, and
   it's a feature neither side can get anywhere else.
2. **A sponsor-scoped Owl.** "How many leads did we capture at Bushfire vs
   last year?" answered conversationally, grounded only in that sponsor's
   deals. The Owl/MCP plumbing exists; this is scoping work, not new AI work.

## Lead capture (the small net-new module)
A disposable module in the house style (`server/sponsorLeads.js` or folded
into a `server/sponsors.js`):
- Each deal can have one or more **capture forms** → a public QR microsite
  ("scan to enter the competition / get the voucher"), branded per sponsor.
- Explicit consent checkbox (wording configurable, POPIA-compliant), captured
  timestamped alongside the lead.
- Writes to `sponsor_leads`; live count on the event-day view; CSV export +
  wrap-report inclusion. Optionally doubles as a footfall proxy where RFID
  isn't deployed.

## Privacy guardrails (non-negotiable)
- Audience insights are **aggregate-only with a minimum cohort size** — no
  drilling to individuals, no "the 3 people from Nelspruit."
- PII crosses to a sponsor only via (a) leads they captured with explicit
  consent, or (b) never — campaigns to the organiser's audience are sent *by
  Pulse* under organiser approval.
- Sponsor scope fails closed: a deal with no attributions shows nothing, not
  everything.
- Secrets/branding follow the existing write-only-secrets rules.

## Commercial model (confirmed direction)
A **combination**: sold by Howler directly to brands, and/or through
organiser buy-in (the organiser bundles portals into sponsorship packages).
Practical implications:
- Tiering lives on the **deal** (e.g. headline / gold / silver → which modules
  and tiles unlock), so one sponsor can have different tiers at different
  events.
- Billing ownership is per-deal (`sold_by: howler | organiser`) so both motions
  coexist; wire into `billing.js` when pricing is settled.

## Build order
1. **Sponsor tenancy + deals + scoped dashboard template** — sponsor entity
   kind, `sponsor_deals` + attribution mapping, force-filtered queries,
   sponsor login + portal shell. Almost all reuse.
2. **Wrap-report digest** — auto post-event branded report via the existing
   scheduler/digest engine. The artefact that sells the product.
3. **Lead capture microsite + QR** — small new module, biggest sponsor
   delight.
4. **Event-day live view** — footfall (RFID/QR feed) + live spend + leads.
5. **Sponsor Owl** (scoped read-only) → **sponsor campaigns with organiser
   approval**.
6. **Portfolio view** across events/organisers; benchmarks.

## Data model sketch (for engineering review)
```
sponsors            id, name, branding{logo,colour,...}, created_at
sponsor_deals       id, sponsor_id, suite_id, entity_id, tier, sold_by(howler|organiser),
                    starts_at, ends_at, modules{live,leads,campaigns,owl,...}, status
deal_attributions   id, deal_id, kind(vendor|product|scan_point|promo_code|lead_form),
                    ref (source-side id), label
sponsor_logins      id, sponsor_id, email, password_hash, role, last_seen   -- or extend logins with kind
sponsor_leads       id, deal_id, form_id, name, email, phone?, answers{json},
                    consent_text, consented_at, source(qr|manual), created_at
lead_forms          id, deal_id, title, fields{json}, consent_wording, qr_slug, active
```
Everything keys off `suite_id` (the event) on one side and `sponsor_id` on the
other; `deal_attributions` is the bridge that makes server-side force-filtering
possible whatever the data source (Looker today, BigQuery direct tomorrow —
keep the resolver source-agnostic per `docs/ENGAGEMENT_ENGINE.md`).

## Risks register
- **Attribution mapping drift** (vendor renamed, scan point re-used) → admin
  UI shows unmapped/ambiguous attributions; wrap report refuses to render with
  broken mappings rather than under-reporting.
- **Small-cohort leakage** in audience tiles → enforce minimum cohort size in
  the query layer, not per-tile.
- **Sponsor sees a competitor's numbers** (share-of-category tiles) → only
  show category shares where the organiser has opted the event in.
- **Organiser channel conflict** (Howler sells direct to a brand at an
  organiser's event) → deals always visible to the organiser; no silent
  direct-sold deals on their events.
- **Wrap-report overclaiming** (modelled impressions) → state methodology on
  the tile and in the report; never present modelled numbers as measured.

## How this maps to what's already built (July 2026)
- **Scoping & tenancy** — the server-side fail-closed per-client scope is the
  exact pattern to extend; sponsors are a new scope kind, not a new mechanism.
- **Dashboards / tiles** — the grid, tile library and per-tile AI insights are
  reused as-is; Sponsor Pulse is a dashboard template + scope filter.
- **Digests** — `scheduler.js` + digest rendering already produce branded
  scheduled reports; the wrap report is a new template on that engine.
- **Campaigns + approvals** — `actions.js` already has audiences, promo codes,
  conversion tracking and a full approval workflow; sponsor-drafted /
  organiser-approved is a permission arrangement, not a new engine.
- **Owl** — read-only MCP + chat exists; sponsor Owl is a scope, plus a small
  system-prompt lens registered in `promptRegistry()`.
- **Branding** — per-entity branding (logo / colour / sender display) extends
  naturally to sponsors.
- **Net-new** — sponsor tenancy tables above, the lead-capture module, the
  RFID/QR footfall ingestion path, and the wrap-report template.
