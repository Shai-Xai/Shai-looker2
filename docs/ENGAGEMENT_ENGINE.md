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
                definition(json: {dashboardId,tileId,filters} | {connection,sql} | rules | pasted),
                email_field, phone_field, consent_field, created_by, created_at
                -- resolves to recipients/identifiers via a SOURCE-AGNOSTIC resolver
                -- (Looker today; direct BigQuery/other later), scoped per client

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
1. **Naming / IA** — top-level concept: "Actions" vs "Campaigns" vs "Engage"? Client
   sub-areas: *Campaigns · Automations · Segments · Templates · Connections*?
2. **Schema timing** — introduce `segments` + `journeys` tables now (before more
   is stuffed into `actions.config`), or defer until P2/P5?
3. **Self-service depth** — default split of who builds campaigns/segments (client
   vs AM). Dual-surface says both; the default matters.
4. **Consent & compliance per channel** — WhatsApp opt-in, ad-platform hashing/
   consent, POPIA/GDPR for audience export. Needs a consent model per channel.
5. **Identity for app push / social match** — what identifier links a Pulse/Looker
   person to a Howler app user and to a hashed ad-platform match? (Ties to 4.1.)

## 10. Dependencies & risks
- **Howler integration (4.1)** unlocks app push + purchase/behaviour signals —
  the richest triggers and the highest-reach channel.
- **OAuth + per-client connections** for social; secrets handled write-only.
- **Compliance** is real once we export audiences off-platform — design consent
  and retention before the first sync.
- **Scope discipline** — the visual journey builder (P5) is the big build; keep it
  behind segments + triggers so each earlier slice ships standalone value.
