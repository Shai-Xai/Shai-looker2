# Engagement Engine — vision & architecture

> Status: **vision / architecture draft** · North Star: `docs/EXPERIENCE_OS_BRIEF.md`
> · Roadmap: 4.3 (social), and the generalisation of today's "Actions".
> This is the **Action** layer of the Experience OS — how Pulse turns insight
> into outreach and results. No code yet; this locks the mental model + schema
> direction before we build more on top of `actions.js`.

## 1. The thesis
Today's "Actions" area ships one recipe — **abandoned cart**. But that campaign
is already a special case of a **general, data-driven engagement engine**:

> abandoned cart = *segment* (abandoners tile) + *trigger* (entered the segment)
> + *journey* (3-step drip) + *goal* (bought).

A newsletter, a pre-event reminder, a win-back, a VIP upsell, a Meta retargeting
audience — all the **same engine**, different configuration. So we should build
the engine and express recipes on top of it, not build each campaign type
separately.

**Why this is uniquely Pulse (not just Mailchimp/Klaviyo):** the audience comes
from the **same Looker data that powers the client's dashboards**, scoped
server-side per client. The client sees an insight → turns it into an audience →
acts → sees the result, all in one governed place. That's
**insight → action → results** made literal.

## 2. The hero flow: "Segment from a Looker tile"
The keystone interaction. Anywhere a tile lists or counts people (abandoners,
VIPs, lapsed buyers, a city, a ticket type), a **"Create segment"** affordance
turns that tile (+ its filters) into a **named, reusable segment**. From a
segment you can then:
- **Message** it (email / SMS / WhatsApp / Howler app push),
- **Sync** it to an ad platform (Meta / TikTok / Google Custom Audience),
- **Enrol** it into a journey/automation,
- **Track** it over time (size, conversions).

One click from *seeing* a cohort to *acting* on it. This is the bridge between
the dashboard (insight) and the engine (action), and it's the thing to nail.

> **Data sources are pluggable — not Looker-only.** Looker is the calculation
> engine *today*, but Pulse will also integrate **directly into BigQuery (or
> other sources)**, bypassing Looker. So a segment's source can be a Looker tile
> **or** a direct query, and resolution goes through a **source-agnostic
> resolver**. Two non-negotiables hold whatever the source: (a) the per-client
> **organiser/event scope is enforced server-side** before any query runs, and
> (b) a recipient maps to the same **identity** (email/phone/app-user/ad-match)
> regardless of where the row came from. Don't couple the engine to Looker.

## 3. Core primitives
| Primitive | What it is |
|---|---|
| **Segment** | A saved, named audience: a Looker tile + filters, a **direct query** (e.g. BigQuery), a rule set, or a pasted list. Resolves to recipients (and/or ad-platform identifiers) at run time through a **source-agnostic resolver**, scoped to the client. **Reusable** across campaigns, journeys and syncs. |
| **Channel** | How we reach them — per-recipient (email, SMS, WhatsApp, Howler app push) or broadcast (social audience-sync / publish). Each plugs into a send/sync adapter. |
| **Template / content** | The message: email template/HTML, SMS/WhatsApp text, promo codes, CTA, UTM. Channel-aware. |
| **Trigger** | What starts it: **manual** blast · **scheduled** · **behavioural/data** (entered segment, abandoned cart, bought X, didn't open, N days before event). |
| **Journey** | A node graph: trigger → wait → send → condition (opened? clicked? converted?) → branch → send → goal. Today's linear drip is the simple case. |
| **Goal / conversion** | The success event (bought, registered, renewed). Already tracked for drips + once-off. |
| **Approval + report** | Governance (named/Howler approvers) + results. Already built. |

## 4. Action types (important: not everything is a per-recipient "send")
- **Message action** — per-recipient send to contactable identities (email/phone/
  WhatsApp/app-user). Needs a contact per person.
- **Audience-sync action** — push a segment's identifiers (emails/phones, hashed)
  to an **ad platform** as a Custom/Matched Audience for targeting or exclusion.
  *This* is the right model for most "Meta/socials" use — it's not a message, and
  it pairs perfectly with §2 (segment from a tile → Meta audience).
- **Publish action** *(later)* — create/schedule an organic post or ad creative.

Modelling these as distinct types (sharing **Segment**) keeps the per-recipient
send logic clean and lets social ride in without contorting it into a "channel".

## 5. Channels & connectors
| Channel / platform | Type | Mechanism | Status / dependency |
|---|---|---|---|
| **Email** | message | Resend (`mailer.js`) | ✅ built |
| **SMS** | message | Clickatell (`messaging.js`) | ✅ built |
| **WhatsApp** | message | Business API **template** messages (opt-in, pre-approved templates) — plugs into the `messaging.js` chokepoint shape | next; **note:** outbound templates are viable now and are *separate* from the WhatsApp *group-ingestion* problem deferred in the brief |
| **Howler app push** | message | Notifications into Howler's **attendee** app (reach ticket-holders where they already are) | **needs Howler integration (4.1)** + an attendee-push API; distinct from Pulse's own web-push (which targets Pulse users) |
| **Meta (FB/IG)** | audience-sync / publish | Custom Audiences API (hashed match) · later Marketing API for ads | needs OAuth app + per-client connection |
| **TikTok** | audience-sync / publish | Custom Audiences / Ads API | needs OAuth + connection |
| **Google** | audience-sync | Customer Match | optional |

Each connector is a **disposable module** mirroring the mailer/messaging shape:
write-only secrets, graceful no-op when unconfigured, one send/sync chokepoint.

## 6. Data model sketch (for review — evolve, don't cram into `actions.config`)
```
segments        id, entity_id, name, source(tile|query|rules|paste),
                definition(json: identity-column mapping + {dashboardId,tileId,filters}
                           | {connection,sql} | rules | pasted),
                last_count, last_resolved_at, created_by, created_at
                -- NO consent column — a segment is "who matches"; consent is
                -- per-channel, applied at SEND (see §9.4). Resolves via the
                -- source-agnostic resolver (§6a), HARD entity/event-scoped.

channel_connections  id, entity_id, channel(meta|tiktok|google|whatsapp|...),
                     status, secret_ref (write-only), meta(json), connected_by/at

actions (today's table, generalised) →
                id, entity_id, kind(message|audience_sync|publish),
                segment_id, channel, trigger(manual|schedule|behavioural),
                trigger_config(json), content(json), goal(json),
                status, approval…, results…           -- supersedes the abandoned-cart-only config

journeys        id, entity_id, segment_id, trigger, status, goal
journey_nodes   id, journey_id, type(send|wait|condition|goal|split),
                config(json), next[](branch refs), position
enrolments      id, journey_id, person_ref, node_id, status, enrolled_at, next_at
                -- generalises the current drip enrolment loop

audience_syncs  id, action_id, channel, segment_id, pushed_count, last_synced_at, status
```
Everything stays **entity-scoped** (and event-scoped via the segment's tile where
relevant). The existing `actions` row becomes a campaign/journey *instance*;
`segments` and `journeys` become first-class.

## 6a. The resolver — the real deliverable (not the table)
*Per Hermes review:* the table is easy; the **source-agnostic resolver** is the
high-value piece. Contract: `resolveSegment(definition, ctx) → { members, count, meta }`.
- **Source adapters:** `tile` (Looker) + `paste` today (the tile adapter delegates
  to the campaign engine's `audienceFor`); `query` (direct BigQuery) and `rules`
  later. Adding a source = adding an adapter; callers don't change.
- **Hard scope gate (not a convention):** the resolver **refuses** to run any
  source that isn't entity/event-scoped. `tile` is scoped by the client catalogue;
  for `query` the org filter is injected/enforced *inside* the resolver — a raw SQL
  segment is never trusted to scope itself. Enforced in the resolver, not per caller.
- **Stable member output shape (lock now, populate later):**
  `member = { identity:{ email, phone, appUserId?, adMatch? }, name, attributes:{} }`.
  Email/phone now; `appUserId` (Howler app) + `adMatch` (hashed) reserved — adding
  them later *populates* fields, never *reshapes* the output. So cross-system
  identity is not a blocker for email/SMS segments today.
- **Consent: stored per-channel, VISIBLE at preview (not a silent send-time drop).**
  The resolver returns *who matches* plus **per-channel contactable counts** so a
  segment can show "4,000 people · 3,800 emailable · 1,500 SMS · 1,200 WhatsApp
  opted-in" *before* a campaign runs. Consent is a per-channel mapping
  (channel → consent column), surfaced at preview and enforced at send — never an
  invisible filter. Output: `meta.reach = { email, sms, whatsapp, ... }`.
  (Where the consent mapping lives — entity-level default vs per-segment override —
  is the one remaining sub-decision; lean **entity-level**, since a client's
  consent columns are usually consistent across tiles.)

## 7. How it maps to what's built
- `actions.js` already has audiences (tile/paste/snapshot + filters), email/SMS/
  both, drip **sequences** (the linear journey), recurring **auto-check**
  (the seed of behavioural triggers), promos, **conversions**, **approvals**,
  reports. → **Generalise**, don't rebuild.
- `mailer.js` / `messaging.js` are the channel-adapter pattern → WhatsApp, app
  push and social connectors follow the same shape.
- Segment-from-a-tile reuses the existing tile→audience resolver (the same code
  that powers campaign audiences today).
- Goals/conversions + the approval workflow carry over unchanged.

## 8. Phasing
- **P1 — Generalise the engine + recipe library.** Make Actions channel/
  trigger-agnostic in model + UI; abandoned-cart becomes one **recipe** among
  several (pre-event reminder, post-event thank-you, win-back, VIP upsell).
- **P2 — Segments first-class + "Create segment from tile."** Reusable saved
  audiences; the hero flow (§2). Self-service for clients (dual-surface).
- **P3 — WhatsApp outbound** (template messages) as a third message channel.
- **P4 — Meta audience-sync** (segment → Custom Audience), then TikTok. The first
  social win, and the natural payoff of segments.
- **P5 — Visual journey builder** (waits, branches, conditions). Subsumes drips.
- **P6 — Howler app push** + full **behavioural/data triggers** (bought, opened,
  did-not-X) — gated on the Howler/Looker signal integration (roadmap 4.1).

## 9. Open decisions
1. **Naming / IA — DECIDED (Jun 2026): top-level concept is "Engage", built as
   a unified hub.** Engage is one first-class area at `/engage` with **tabs**:
   **Campaigns** (`/engage/campaigns`) and **Segments** (`/engage/segments`)
   today, plus *Automations · Templates · Connections* shown as **"soon"** so the
   shape of the area is legible before each ships. The nav "Engage" group points
   into these tabs. Legacy `/actions` and `/segments` **redirect** into the hub
   (query strings preserved, so approval/`?action=` and "make it happen"/`?goal=`
   deep links survive). "Actions" is freed up for a future user action-center.
   Dual-surface: admin manages a client's Campaigns + Segments under Admin →
   client detail; clients self-serve the same in the Engage hub.
2. **Schema timing** — **DECIDED (Jun 2026), split per Hermes review:**
   - **2a. Segments + resolver — DONE.** `segments` table + source-agnostic
     resolver shipped (keystone for §2). Additive; campaigns untouched.
   - **2b. Journeys schema — DEFERRED to P5.** Don't design `journey_nodes` /
     `enrolments` until the visual builder, when the node types are actually known
     (designing the graph now risks getting it wrong). Today's linear drip stays.
3. **Self-service depth** — default split of who builds campaigns/segments (client
   vs AM). Dual-surface says both; the default matters. *(still open)*
4. **Consent & compliance — DECIDED: per-channel, stored + VISIBLE at preview,
   enforced at send.** A segment is "who matches"; opt-in differs by channel
   (email ≠ SMS ≠ WhatsApp). Consent is a per-channel mapping (channel → column),
   modelled per-recipient-per-channel, and the resolver surfaces **per-channel
   contactable counts at preview** (not a silent drop at send). POPIA-relevant (SA).
   Removed the single consent field from the segment; per-channel reach lands with
   the resolver formalisation. *Sub-decision:* consent-mapping home = entity-level
   (default) vs per-segment override — lean entity-level.
5. **Identity — DECIDED: lock the output SHAPE now, resolve later.** Resolver
   returns `member.identity{ email, phone, appUserId?, adMatch? }` (§6a). We don't
   solve cross-system identity now (needs the Howler integration); we only guarantee
   adding those keys won't reshape the output — so it's not a blocker for email/SMS
   segments today.

## 10. Dependencies & risks
- **Identity ↔ Howler integration (4.1) — tracked future bottleneck.** Cross-system
  identity (Looker-person → Howler app-user → hashed ad-match) is *deferred* and
  safe today (the resolver's member shape is identity-extensible). But it flips to
  **critical-path the moment Meta audience-sync (P4) or app-push (P6) lands** — and
  it's gated on 4.1, which we don't fully control. Keep 4.1 timing and identity
  resolution tracked **together** so P4 doesn't get surprised. (No action now.)
- **Howler integration (4.1)** unlocks app push + purchase/behaviour signals —
  the richest triggers and the highest-reach channel.
- **OAuth + per-client connections** for social; secrets handled write-only.
- **Compliance** is real once we export audiences off-platform — design consent
  and retention before the first sync.
- **Scope discipline** — the visual journey builder (P5) is the big build; keep it
  behind segments + triggers so each earlier slice ships standalone value.
