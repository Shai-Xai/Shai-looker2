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
   usage is standing at a stand with a phone). Its pages: **briefing** (the
   Owl's daily read), **pre-event** (pacing + audience), **live** (event day),
   **engage** (campaigns + audience sync), **leads**, **reports** (wrap +
   portfolio), and the **package page** (their tier, value delivered, and
   what's unlocked vs locked). All branded for the sponsor.

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

## The engage layer — campaigns, audiences, ad accounts
Sponsors don't just watch; higher tiers can **act**, on a ladder that is safe
by construction:

1. **See results** (every tier) — dashboards, reports, briefing.
2. **Campaigns to their own leads** — self-serve email/SMS through the
   existing actions engine (`actions.js`); the audience is their opted-in
   `sponsor_leads` and nothing else. Runs the same approval workflow as every
   Pulse send (approver = Howler or a named sponsor-side approver).
3. **Campaigns to the organiser's audience** — the sponsor drafts ("20% off at
   the Karoo bar, to attendees"); the **organiser approves**; Pulse sends.
   The list never leaves Pulse and the sponsor never touches the PII — which
   neatly solves the POPIA problem that kills most sponsor-data
   conversations, and it's a feature neither side can get anywhere else.

**Audience sync to the sponsor's own ad accounts.** The existing audience-sync
rails (Meta / Google / TikTok custom audiences via `segments.js`, `metaAds.js`,
`tiktok.js`) get a sponsor scope: a sponsor connects **their own** ad accounts
and syncs the audiences **they own — their opted-in leads, and only those**.
Nightly refresh, match-rate reporting, disconnect anytime. Organiser audiences
can never sync to a sponsor's ad account; sponsors reach those via rung 3.

**The sponsor briefing.** The same briefing engine organisers get
(`briefing.js`), through a sponsor lens: "gates opened 11:00; your first-hour
footfall is 18% ahead of your last event; your Sunday campaign is still
awaiting organiser approval." Owl-narrated, on the portal home and as a digest
email, with a "needs you" block (pending approvals, creative sign-offs).

**A sponsor-scoped Owl** — see the dedicated section below.

## The Owl & bring-your-own-AI (MCP)
Two ways sponsors get *answers* instead of dashboards:

1. **In the portal — the sponsor Owl.** A chat page: "How did our stand do vs
   City Sundowner?" answered conversationally, grounded only in that sponsor's
   deals, every figure cited to its source (vendor IDs, scan points), strictly
   read-only. The Owl/MCP plumbing exists; this is scoping work plus a sponsor
   prompt lens in `promptRegistry()` — not new AI work.
2. **In their own AI tools — Claude & ChatGPT connectors.** Pulse already runs
   an MCP server (`server/mcp.js`, endpoint
   `https://howler-pulse-v2.onrender.com/mcp`) that organisers connect to
   Claude and ChatGPT today. Issue **sponsor API keys scoped to their deals**
   (same `apiKeys.js` model, revocable) and a sponsor adds their Pulse data as
   a connector in [Claude](https://claude.ai/settings/connectors) or
   [ChatGPT](https://chatgpt.com/#settings/Connectors) — live event data inside
   the assistant their marketing team already uses every day:
   - "Pull my Riverfields numbers into this quarterly deck."
   - "Draft our post-event sponsorship report with the actuals."
   - "Compare lead cost at our three events against our Meta CPL."
   - Weekly agency reporting without CSV-export round-trips.

   The scope boundary rides the same rails as the portal: deal-scoped,
   read-only, aggregates only, no organiser PII reachable — a sponsor's key
   can never see more through MCP than they can see in the portal. Flag-gated
   by tier (Gold+ suggested), enforced at the route/tool layer
   (`OWL_TOOL_FLAGS`), and every key is revocable from the deal editor.

   This is a genuine differentiator to sell with: *"your sponsorship comes
   with an AI analyst — and it plugs into the Claude/ChatGPT your team
   already has."*

## Tiers, entitlements & the package page
What a sponsor can *do* is set by their **tier on the deal** — the module
toggles admins/organisers control. An illustrative default ladder (per-deal
overrides always possible):

| Tier | Adds |
|---|---|
| **Bronze** | Results only — dashboards + wrap report |
| **Silver** | + briefing, lead capture & export, live event-day view |
| **Gold** | + campaigns (own leads + organiser-approved sends), audience sync to own ad accounts, sponsor Owl + Claude/ChatGPT connector (MCP) |
| **Platinum** | + portfolio benchmarks across events/organisers, API access |

The **package page** is the sponsor-facing mirror of those toggles: what their
sponsorship includes, what each module has delivered so far (a value summary —
footfall, leads, attributed revenue), and what's locked — shown, not hidden,
with "included in Platinum" as the built-in upsell. Every module registers a
flag + route gate in `server/flags.js` per the house rule, so entitlement is
enforced server-side, not cosmetically.

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
- **Ad-account sync is leads-only and one-way** — a sponsor's connected ad
  accounts can only ever receive audiences built from their own opted-in
  leads; organiser audiences and event buyer lists are not syncable objects
  in sponsor scope, at any tier.
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
5. **Engage layer** — sponsor campaigns (own leads first, then
   organiser-approved audience sends) + **audience sync** to the sponsor's own
   ad accounts on the existing sync rails.
6. **Briefing + package page** — sponsor lens on `briefing.js`; the
   entitlement/value page mirroring the deal's module toggles.
7. **Sponsor Owl** (scoped read-only) → **portfolio view** across
   events/organisers; benchmarks.

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
sponsor_ad_accounts id, sponsor_id, platform(meta|google|tiktok), account_ref,
                    status(connected|error), connected_by/at   -- secrets write-only, as everywhere
sponsor_audience_syncs id, sponsor_ad_account_id, deal_id, source(leads), audience_ref,
                    last_synced_at, matched_count, status
```
Sponsor campaigns reuse the existing campaign tables in `actions.js` with a
sponsor owner + an audience resolver locked to `sponsor_leads` (rung 2) or an
organiser-approved segment reference that resolves at send time (rung 3).
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
- **Audience sync** — the Meta / Google / TikTok custom-audience rails
  (`segments.js`, `metaAds.js`, `tiktok.js`) already exist for organisers;
  sponsor sync is those rails with the audience source locked to
  `sponsor_leads` and the sponsor's own ad-account connections.
- **Briefing** — `briefing.js` already narrates for organisers; the sponsor
  briefing is a lens over the same engine, registered in `promptRegistry()`.
- **Owl** — read-only MCP + chat exists; sponsor Owl is a scope, plus a small
  system-prompt lens registered in `promptRegistry()`.
- **Branding** — per-entity branding (logo / colour / sender display) extends
  naturally to sponsors.
- **Net-new** — sponsor tenancy tables above, the lead-capture module, the
  RFID/QR footfall ingestion path, the wrap-report template, and the
  sponsor ad-account connection tables.
