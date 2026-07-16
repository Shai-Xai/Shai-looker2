# Spec — The Loyalty & Preference Engine (the Fan Owl's memory)

> Status: **DESIGN (2026-07-15)** — nothing built yet · Owner: Shai ·
> North Star: `docs/EXPERIENCE_OS_BRIEF.md` · Companions:
> `docs/specs/FAN_OWL_SPEC.md` (the surface this rides on),
> `docs/ENGAGEMENT_ENGINE.md` (where the fan data lands),
> `docs/specs/PORTFOLIO_VIEW_SPEC.md` (the scoping layers + customer master
> that portfolio/brand-wide loyalty rides on),
> `server/audienceQuery.js` (the PII boundary this mirrors).
>
> **Scope of this spec:** giving the Fan Owl *memory and a wallet* — a verified
> identity handshake (email/mobile + OTP), a derived fan profile computed from
> Howler purchase + preregistration history, budgeted promo-code pools the Owl
> can issue rewards from, a spin-the-wheel skin over the same reward engine,
> and the ROI reporting that closes the loop. **Out of scope (reserved for a
> follow-up spec):** the friend-invite / referral flow — but the data model
> reserves its fields (§6) so it lands on prepared ground.

## 0. In plain English (read this first)

The Fan Owl today is a brilliant stranger: it knows the event inside out but
nothing about the fan. Meanwhile Pulse holds years of the answer — who bought
what, how much they spent, whether they preregistered, whether they bring
friends. This spec connects the two, consent-first:

1. **"Want me to check if you qualify for a reward?"** The fan gives their
   email or mobile in the chat, we send a 6-digit code, they type it back.
   Verified. That verification is the price of admission for everything below —
   and it's also the *pipeline*: every verified fan is a real, deliverable,
   consented contact in the client's CRM.
2. **The Owl now knows them** — not their raw transactions, but a derived
   profile: *returning fan, 2 events, bought GA last year, preregistered in
   March, usually buys for 4*. It guides accordingly: the right ticket first,
   the honest upgrade tip second.
3. **And it can reward them.** Organisers load promo codes (generated in the
   Howler ticketing system) into per-event **pools** with a budget, a tier
   target and rules. The Owl offers the right code to the right fan — new,
   returning, loyal, preregistered-but-never-bought, group leader — and stops
   dead when the pool is spent. Discounts always drive one behaviour: **buy
   tickets.**
4. **The wheel** is the fun front door to the same engine: verify → spin →
   win a slot (discount, upgrade, sponsor giveaway, meet & greet). The server
   picks the outcome from the pools before the wheel ever animates — the wheel
   is theatre; the budget maths is real.

The strategic frame: **the loyalty engine is really an identity engine.**
Discounts are the price we pay to turn anonymous traffic into a verified,
consented, history-enriched fan CRM — and every future campaign, digest and
Owl conversation gets smarter off the back of it.

---

## 1. Principles (non-negotiable)

1. **Verified identity only.** History is NEVER shown for a typed-in address
   alone — anyone could type their mate's email. OTP (email or SMS) proves
   control of the address before anything personal unlocks. Unverified fans
   get exactly today's anonymous experience.
2. **Derived traits, never raw history, reach the model.** The server computes
   a compact profile (tier, signals, favourite ticket type, spend band); the
   Owl's context gets *that*, not transaction rows. Same philosophy as
   `audienceQuery.js`: PII stays server-side; the model sees shapes, not rows.
3. **Deterministic issuance.** The model may *offer*; only the server *grants*.
   Which pool, which code, one-per-profile, budget remaining — all server
   checks, same pattern as `getCheckoutLink` (the model can only hand out
   things that exist).
4. **The budget is a hard cap.** A pool's codes are finite and visible as a
   burn-down. Empty pool = no more offers, mid-conversation if necessary. The
   pricing conversation is explicit at setup: the promo value is baked into
   the baseline ("you're planning to sell X tickets at Y% off").
5. **Honesty is the brand.** The fan prompt already forbids invented scarcity;
   the reward layer holds the same line. Real odds on the wheel, real prizes,
   published rules. No "everyone wins but feels lucky" tricks.
6. **Consent-first, as today.** Verification ≠ marketing consent — the
   existing explicit opt-in (`CONSENT_WORDING_VERSION`) stays its own question.
7. **Dual-surface from day one.** Every management screen ships in Admin →
   client detail AND client Settings (`/api/admin/entities/:id/loyalty` +
   `/api/my/loyalty/:id`), per the platform rule.
8. **Legal per market.** Prize promotions are regulated (SA: CPA §36 —
   published rules, no entry fee; EU markets vary by country). Each wheel
   campaign carries its own T&Cs link; the mechanic gets a once-off legal
   review before first launch. Not a blocker — a checklist item.

## 2. Architecture

A new **disposable module** `server/loyalty.js` (own tables, own routes,
mounted from `index.js` in one line), riding the Fan Owl session:

- **OTP delivery** reuses the existing send chokepoints — `mailer.js`
  (Resend) for email, `messaging.js` (Clickatell) for SMS. Codes are 6 digits,
  10-minute expiry, rate-limited per session AND per address, single-use.
- **History lookup** reuses the scoped Looker query layer (`server/query.js`)
  with the `core_purchasers.email` / `cellphone_number` filter-only identity
  columns — exactly the customer-lookup gate `audienceQuery.js` already
  enforces. The lookup runs once at verification (and on a stale-profile
  refresh), computes the derived profile, and caches it on the fan profile
  row. No live Looker call per chat message.
- **Preregistration** joins the same profile (§4).
- **The Owl toolbox grows** (in `fanOwl.js`, gated on a verified session):
  `startVerification`, `confirmVerification`, `getMyReward`. The system prompt
  gains a VERIFIED FAN context block (the derived profile) injected
  server-side per message — the model never fetches it.
- **The wheel** is a widget surface (`/embed/fan` UI + two endpoints), not a
  second engine: `POST /api/fan/spin` asks the server for an outcome from the
  event's wheel-enabled pools; the animation lands on what was already
  granted.

### PII boundary (unchanged, extended)

| Where | What it may see |
|---|---|
| Browser / widget | Derived tier label + the fan's OWN granted codes |
| Model context | Derived profile block (tier, signals, traits) — no other fans, no raw rows |
| Server | Everything, scoped to the entity, as today |

## 3. The derived profile: a signal matrix, not a ladder

Two axes, all computed server-side from data we already hold:

**History tier** (from Looker purchase history, per entity):

| Tier | v1 rule | Typical reward |
|---|---|---|
| **New** | no purchase history | small welcome discount |
| **Returning** | ≥ 1 past event | discount or add-on (camping, parking) |
| **Loyal** | ≥ 2 events or top spend band | upgrade (GA→VIP), presale, meet & greet |

**Engagement signals** (booleans/traits on the profile):

- `preregistered` — on the event's prereg list (§4)
- `lead_no_purchase` — captured by the Owl (`fan_profiles`) but never bought:
  Pulse's *native* preregistration
- `group_buyer` — bought ≥ N tickets in one basket at a past event
  (tickets-per-purchaser-per-event, derivable today)
- `attended` vs bought — from cashless check-in data: a past buyer who
  no-showed is a *win-back* segment, not an upsell one
- `high_onsite_spender` — bar/product spend band from the cashless explore
  (already registered in Pulse, `owlCatalogue.js` cashless field families).
  Product spend is keyed **by email** (confirmed 2026-07-15), so it joins the
  verified profile with the same lookup as purchase history — phase-1 viable.
  Arguably the strongest loyalty signal we hold: it measures engagement AT
  the event, not just the purchase
- `app_engaged` — active in the Howler app. Data lives in **PostHog**
  (product analytics events) and the **Social+ community** platform
  (posts/comments/reactions — potentially its own `community_member` signal);
  both expose APIs, so this is a periodic per-identity pull, not a new
  pipeline (§9 for the definition question). Rewarded with LOW-COST currency
  only (extra wheel spin, presale access, first pick) — engagement isn't a
  purchase, so it never earns deep discounts; the budget stays pointed at
  conversion
- `interests[]` — already logged by `logInterest` / `captureLead`
- traits: favourite ticket type, ticket + on-site spend bands, last event
  attended, and `history[]` — the fan's OWN orders itemised at event ×
  ticket-type grain (added 2026-07-16: a verified fan asking "what did I buy
  last year?" deserves a real answer; still derived — no per-ticket rows)

**Companions (design note, 2026-07-16 — build with holder/transfer data):**
tickets a fan bought FOR someone or transferred carry the companion's
identity in ticketing. Hugely valuable memory ("going with the same crew
again? want the group code?") — with hard privacy lines: companion names may
only ever be reflected back to the purchaser who supplied them (first names
at most), never listed to anyone else, never used to CONTACT the companions
(they get marketed to only via their own consent), and the derived form
should usually be the pattern, not the names ("you usually bring the same 4
people"). Needs holder/transfer fields added to the curated slice (§9 Q10)
— the current explore deliberately excludes per-person PII.

**Pools target a combination** ("preregistered AND never bought" → comeback
offer; "returning AND group_buyer" → group-leader code), which is barely more
complex than tiers but far more expressive — and every pool still has its own
stock and burn-down regardless of targeting.

### Scope: event, portfolio, or brand (aligns with PORTFOLIO_VIEW_SPEC)

Rewards are *offered* per event, but loyalty is *earned* across a
relationship — so the two scopes must not be conflated, and
`docs/specs/PORTFOLIO_VIEW_SPEC.md` already defines the layers this adopts:

| Layer | Loyalty meaning |
|---|---|
| **Event** (entity + suite) | where a pool spends: codes, budget, wheel — per-event by default, as the organiser's promo budget is per-event |
| **Portfolio** (one entity, all suites) | where loyalty is EARNED: the derived profile's history lookup already runs entity-wide (tier = "2+ events" is inherently cross-event), and `fan_profiles` is keyed by entity — portfolio loyalty is the DEFAULT, not an extension |
| **Multi-profile** (entity group) | a brand owning several client profiles: profile + history union across the group's entities, via the portfolio spec's `entity_groups`. Deferred until that ships; the loyalty tables need no rework — pools gain a nullable group scope and the profile lookup unions the group's organiser scopes |

Two consequences:

- **`promo_pools.suite_id` is nullable**: an entity-level pool ("any of my
  events this season") is the portfolio-loyalty surface — same stock, budget
  and one-per-fan rules, just redeemable against any of the client's events.
- **The hard rule is inherited unchanged**: loyalty NEVER crosses client
  boundaries. A fan's tier at one Howler client says nothing at another —
  there is no cross-client fan graph. (Within a brand's own entity group it
  may, once groups exist.)

## 4. Preregistration: two sources, one signal

Howler already runs preregistration lists — this engine plugs into that
mechanic rather than inventing one:

1. **Native (primary) — RESOLVED (2026-07-16): it's a Looker guestlist.**
   Preregistration lives as a **guestlist attached to the event** in the
   ticketing system, queryable through Looker — so the `preregistered` signal
   is one more scoped lookup at verification time (email ∈ the event's
   guestlist), no new pipeline. Two build notes: the guestlist fields need
   adding to the curated slice (server-side-only, like the customer-lookup
   fields), and "attach the prereg guestlist to the event" becomes a client
   setup step — wire it into the Setup wizard when this ships (per CLAUDE.md).
2. **Pulse-native.** An existing `fan_profiles` row with no matching purchase
   history IS a preregistrant — someone who chatted with the Owl, left their
   email, didn't buy. The comeback moment ("you asked about camping in March —
   that early-bird rate is still yours") is nearly free to build.
3. **CSV fallback.** For lists that live outside Howler (a Facebook lead
   campaign, a venue's own form): per-event upload (email, registered_at,
   source), both surfaces.

Tactical bonus: prereg happens *before* on-sale — so on day one, the most
anonymous, highest-intent traffic surge of the cycle arrives pre-identified,
and the Owl can greet it by name with a live early-bird code.

## 5. Promo pools & codes

Codes are **generated in the Howler ticketing system** (discount enforcement
happens at checkout, not in Pulse) and **uploaded into pools**. Confirmed
2026-07-16: bulk generation exists (manual for now; auto-provisioning comes
when the Howler API is linked) with **min quantity, expiry, and single- or
multi-use** as native options. That gives pools two modes:

- **Unique-code stock** (single-use codes): one code per grant, stock = the
  hard budget — the default for discounts.
- **Shared multi-use code**: ONE code many fans receive; ticketing enforces
  its rules, Pulse enforces the budget by capping GRANTS (one per profile,
  pool grant limit). Cheaper to provision, right for broad offers (prereg
  comeback, wheel small-wins) — but treat the cap as softer, since the code
  itself can leak beyond the Owl.

- **Pool** = event (suite) + name + target (tier/signal combination **or a
  saved segment**) + reward kind (discount / upgrade / add-on / prize /
  **credit bundle**) + value + expiry + code stock + optional wheel flag &
  weight.
- **Segments as targets (decided 2026-07-15).** A pool may target a saved
  Pulse segment instead of (or alongside) tiers/signals: eligibility = "this
  verified email is in segment X", checked server-side via the existing
  segment resolver (`audienceQuery.js` already returns the people list to
  server-side callers only). This turns EVERY cohort anyone ever saved — a
  prereg list, an Owl-built cohort, a campaign audience — into a promo
  target with zero new targeting UI, and it's how external prereg lists can
  enter without a dedicated importer (upload → segment → pool). Membership
  is resolved at offer-time and cached briefly (Looker queries are slow);
  a segment's reach preview doubles as the pool's audience estimate.
- **Cashless credit rides a bundle, not a voucher.** Topup vouchers cannot be
  issued as codes (confirmed 2026-07-15) — but ticketing CAN bundle tickets +
  credit as a product. So the credit reward is a **ticket+credit bundle**
  ("Saturday Pass + R150 bar credit"), offered either as its own catalogue
  item behind a deep link (a pool can gate WHO gets shown it) or with a
  discount code applied to the bundle. This is neater than vouchers anyway:
  it fits the existing catalogue/deep-link pattern, redemption is just a
  ticket sale, and it's likely the cheapest reward per conversion (breakage +
  product margin) while lifting on-site spend.
- **Merch works the same way.** The fan catalogue already carries a
  `merchandise` kind (`fanOwl.js` KINDS), so an organiser can attach merch to
  a ticket type as a reward ("buy the VIP pass, the tour tee is on us") —
  either a ticket+merch bundle item a pool gates, or a merch grant on
  purchase of a qualifying ticket type (the pool's `rules.ticket_types`
  already expresses "applies when buying X"). Merch is also a natural wheel
  slot (§7): high perceived value at product cost, and it walks around the
  event as marketing afterwards.
- **Code metadata matters:** min quantity (group codes), applicable ticket
  types, expiry — captured at upload so the Owl only offers a code when the
  fan's intent matches its rules (a group code goes to someone buying for 4,
  not a solo buyer).
- **Comps: include or exclude (decided 2026-07-16).** A comp guest attended
  but didn't pay — organisers choose per pool whether comps EARN rewards. The
  derived profile keeps both views (`eventsCount` counts attendance incl.
  comps — that's what the Owl greets from; `paidEventsCount` + spend count
  paid only; `comp_guest` flags the gap), and each pool's target gets a
  `comps: count | ignore` rule — eligibility maths use the paid view when
  comps are ignored. Default: `count` for recognition-style rewards, but the
  pool editor should nudge discounts toward `ignore` ("reward buyers, greet
  guests").
- **Issuance:** one grant per profile per pool; grant is recorded before the
  code is revealed; redeemed status reconciles back from ticketing data
  (v1: matched via the code's appearance in purchase rows / manual CSV; the
  cleaner redemption webhook is an open question, §9).
- **Budget view:** stock × value = budget; issued vs redeemed vs remaining as
  a burn-down on both surfaces. Pool empty → the Owl's `getMyReward` returns
  "nothing available", and it says so gracefully.
- **Attribution:** every Owl checkout link already carries UTM params; grants
  add the code, so `redemptions → revenue` closes per pool.

## 6. Data model sketch

```
fan_verifications   id, entity_id, session_id, profile_id?, channel(email|sms),
                    address, code_hash, expires_at, attempts, verified_at?,
                    created_at
fan_profiles        + phone, verified_at, verified_channel,
                    + tier(new|returning|loyal), signals(json: preregistered,
                      lead_no_purchase, group_buyer, attended,
                      high_onsite_spender, app_engaged, …),
                    + traits(json: fav_ticket_type, spend_band,
                      onsite_spend_band, events_count, last_event,
                      group_size), profile_refreshed_at
prereg_lists        id, entity_id, suite_id, source(howler|csv|pulse),
                    name, uploaded_by, created_at
prereg_entries      id, list_id, email, phone, registered_at, meta(json)
promo_pools         id, entity_id, suite_id?,  -- null = portfolio-wide pool (any of the entity's events)
                    name, target(json: tiers[],
                    signals[], segment_id?),  -- segment: eligibility via the saved-segment resolver
                    reward_kind(discount|upgrade|addon|credit_bundle|merch|prize),
                    value_label, rules(json: min_qty, ticket_types[], expires_at),
                    bundle_item_id?,  -- credit_bundle: the fan_catalogue item it gates
                    wheel_enabled, wheel_weight, terms_url, active, created_at
promo_codes         id, pool_id, code, status(available|issued|redeemed|void),
                    issued_to_profile?, issued_at?, redeemed_at?
promo_grants        id, pool_id, code_id, profile_id, session_id,
                    surface(chat|wheel), referrer_profile_id?, group_id?,  -- reserved: referral spec
                    created_at
```

Everything keys off `entity_id` (+ `suite_id` for event scoping), same as the
rest of the `fan_*` family. Codes at rest: store plaintext (they're
low-sensitivity, finite-value coupons the fan is meant to see) but never list
them in bulk to the browser — pool views return counts; a code's value is only
revealed to its grantee.

## 7. The wheel (a skin, not an engine)

- Entry gate = verification (that's the capture mechanic); one spin per
  profile per event.
- `POST /api/fan/spin` → server draws from wheel-enabled pools by weight
  (including explicit "try again next time" weight — losing slots are honest),
  writes the grant, returns the outcome → the widget animates *to* it.
- Slots come FROM pools: discounts, an upgrade, merch, sponsor giveaway,
  meet & greet — plus enough small wins that most spins still push toward a
  purchase.
- Every wheel campaign has a `terms_url` (CPA §36 / local equivalents) and a
  published prize list. No fee, no purchase required to spin.

## 8. Build order

1. **Identity handshake** — OTP verify (email first, SMS second), history
   lookup, derived profile, VERIFIED FAN context block. Ships value alone:
   personalised guidance + verified pipeline, before any promo exists.
2. **Promo pools + rewards** — pool CRUD (both surfaces), code upload with
   rules, `getMyReward`, prereg ingestion (native + CSV), the
   preregistered-comeback offer, group codes. Burn-down views.
3. **The wheel** — spin endpoint + widget UI + T&Cs plumbing + legal review.
4. **ROI reporting** — funnel (prereg → verified → offered → redeemed →
   purchased), budget burn-down, attributed revenue per pool. (Parts ship
   with 2; the consolidated report is its own deliverable.)

**Rollout (decided 2026-07-15): staging-first.** Every phase lands as a PR
against `staging`, gets tested on the staging Render service (using the
`/fan-owl-test` preview page + a test entity), and rides the promote-to-
production release train only after reporter approval — per the
two-environment flow in `CLAUDE.md`. Additionally each phase ships behind a
feature flag (`server/flags.js` REGISTRY + GATES + `OWL_TOOL_FLAGS` for the
new fan tools), default off, enabled per pilot client from the flag matrix —
so even production deploys are dark until a client is switched on.

On shipping each phase: update `docs/PRODUCT_OVERVIEW_SALES.md` (status tags +
changelog) and wire new client-setup steps into the Setup wizard, per
`CLAUDE.md`.

## 9. Open questions

1. **Prereg data plumbing** — where does the native list live, what identity
   fields, Looker join or API? (Owner: whoever runs the prereg mechanic.)
2. ~~Code generation ergonomics~~ **PARTLY RESOLVED (2026-07-16):** bulk
   generation confirmed, manual for now (Howler API link automates later),
   with min qty + expiry + single/multi-use options (§5). Still open: can
   Pulse READ redemptions (does the purchase explore carry the promo code
   used?), or is pool ROI reconciled another way?
3. **Budget denomination** — is a pool's budget best expressed as code count ×
   face value (simple, v1) or monetary cap (needs redemption feed)?
4. **Legal review** — per-market prize-promo rules before the first wheel
   campaign (SA CPA §36; EU per-country).
5. **Phone-only verification** — Clickatell SMS costs per message; do we gate
   SMS OTP behind a per-site toggle/budget like the chat's `daily_budget`?
6. ~~Cashless identity join~~ **RESOLVED (2026-07-15):** product spend is
   keyed by email — joins the verified profile directly, no mapping layer.
7. ~~Cashless credit as a reward~~ **RESOLVED (2026-07-15):** topup vouchers
   can't be code-issued, but ticketing can bundle tickets + credit as a
   product — the credit reward ships as a ticket+credit bundle (§5).
   Remaining detail: how bundle margin/breakage shows in the pool ROI view.
8. ~~App engagement definition~~ **RESOLVED (2026-07-16):** "engaged" =
   active users in the app (PostHog) + Social+ interactions — post
   impressions, reactions/comments on posts, comments in chats. Suggested
   shape: two levels — `app_active` (any app activity, window ~90 days) and
   `community_contributor` (reacted/commented/chatted — the stronger signal,
   worth the better perk). Remaining detail: identity match (same email in
   PostHog/Social+?) and thresholds/window, tuned when the pull is built.
9. **Brand-wide (multi-profile) loyalty** — depends on the portfolio spec's
   `entity_groups` + customer-master identity resolution. Which pilot brand
   actually needs it, and does its tier maths differ per profile (a fan loyal
   to one of the brand's festivals vs the brand overall)?
10. ~~Holder / transfer data for companions~~ **RESOLVED (2026-07-16):**
    Looker DOES carry ticket-holder details. The companions memory (§3) is
    buildable — remaining work is adding the holder fields to the curated
    slice as server-side-only (customer-lookup pattern), then the privacy
    lines in §3 govern how they surface.

## 10. Risks

- **PII leak via lookup** → OTP before any history; derived-traits-only to the
  model; rate limits on send + confirm; addresses normalised + hashed codes.
- **Promo over-spend** → hard stock caps, one-per-profile, server-side grants,
  burn-down visibility, pool `active` kill-switch.
- **Prompt-injection on a reward surface** → the fan toolbox stays the whole
  world; `getMyReward` takes no free-text arguments the model could abuse —
  the server decides eligibility from the profile, not from the conversation.
- **Discount habit-forming** ("fans learn to wait for codes") → pools are
  per-event and finite by design; the organiser sees redemption vs full-price
  mix in the ROI report and tunes.
- **Wheel legal exposure** → T&Cs per campaign, no entry fee, published odds
  policy, legal review before launch.
- **OTP abuse (SMS pumping)** → per-address + per-IP rate limits, email-first
  default, SMS behind a toggle.
