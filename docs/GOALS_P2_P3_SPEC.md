# GOALS — P2 & P3 build spec (for review)

> **Status:** DRAFT for Shai to review. Nothing here is built yet. It extends the
> canonical spec `docs/GOALS_MERGED.md` (§8 attribution, §9 recipe↔goal, §3 model,
> §14 phasing) with a concrete, code-grounded plan based on what's already in the
> repo. Decisions you need to make are flagged **⟶ DECIDE**.
>
> **Author:** Claude · **Date:** 2026-06-22

---

## 0. Where we are (so the plan is honest)

**P1 is done and well past the baseline**, plus this session's work:
- Event + personal goals, North Star, source-aware resolver, pace + result bands.
- Forecast = shape × recent-momentum blend; sell-curve/forecast chart (target-pace,
  interactive, date/event-aware axis, last-real-sale trim).
- Year comparison with a "Compare against" picker; same-calendar-day reads;
  calendar/monthly support; weekly nudge + test; digest goal commentary.
- **Goal templates** (client + 🌐 global, carry dashboard name + tile, resolve by name).

**The schema is already P2/P3-ready** (`server/goals.js`): the `goals` table carries
`scope` (today `event` | `personal`), `conversion_ref`, `rolls_up_to`,
`baseline_comparable` — all parsed in `rowToGoal` but dormant. So both phases are
mostly **new logic + UI on an existing shape**, not migrations.

**What we reuse (don't rebuild):**
- Campaigns live in `actions` (`server/actions.js`): `config.goal` (free-text today),
  `audience` snapshot (emails), `results.{sent,clicks,opens,converted}`, plus
  `action_clicks`/`action_opens`/`action_enrollments` tables.
- **Conversion detection already exists**: `checkConversions()` (~line 1722) re-resolves
  a campaign's audience and counts who **dropped out** of it = converted (the
  abandoned-cart pattern). Drip sequences mark `action_enrollments.status='converted'`.
- **Recipes**: `server/actionTemplates.js` (only `abandoned_cart` today) with a
  `preset` block — the natural home for a default goal.
- **Role lenses**: `ROLE_LENSES` (`exec`/`marketing`/`finance`/`ops`) in
  `server/index.js` (~line 2130), already feeding digests + briefing via
  `roles.lensForRole()`.
- **Segments** (`server/segments.js`): a live-resolved audience *definition* — the
  basis for "who converted".

---

## 1. P2 — Campaign goals + contribution / attribution (the payoff)

**Thesis:** connect the campaigns you already send to the goals they're meant to move,
and show **how much each campaign contributed** — "Campaigns drove 3,200 of 16,200;
the rest organic." This turns goals from a scoreboard into proof of ROI.

### 1.1 Model
A **campaign goal** is a `goals` row with:
- `scope = 'campaign'`, `owner_ref = <actionId>` (the campaign it measures),
- `rolls_up_to = <parent event goalId>` (so the event goal can show the roll-up),
- `target_value` + `unit` (the campaign's own target, e.g. "recover 1,000 carts"),
- `conversion_ref` (how we count a conversion — see §1.2).

A campaign also gains a back-link: `actions.config.goalId` (so the editor and the
checker can go both ways). Free-text `config.goal` stays for AI copy; the structured
link is new.

### 1.2 Conversion detection — generalising the abandoned-cart re-check
A **conversion** = a recipient who **did the goal's conversion event** after a send,
within the window. We already detect one kind (audience drop-out). Generalise to a
**`conversion_ref`** with two supported kinds:

- **`audience-drop`** (cart-recovery shape): converted = a recipient who was in the
  campaign's target audience at send and is **no longer in it** now. This is exactly
  `checkConversions()` today — lift it to read `conversion_ref` instead of assuming the
  campaign's own audience.
- **`audience-join`** (the general "bought" shape): `conversion_ref` points at a
  **segment** that represents the converted population (e.g. "ticket buyers",
  "upgraded"). Converted = a recipient whose email appears in that segment **after**
  their send (within the window). Reuses the segment resolver + email matching that
  campaigns already do.

> **⟶ DECIDE 1:** Confirm both kinds (audience-drop *and* audience-join) for v1, or
> start with **audience-join only** (more general; "buyers" segment covers most goals)
> and keep audience-drop as the existing special case. Recommendation: **ship both** —
> audience-drop is already built, audience-join is the new general engine.

### 1.3 Attribution (per the canonical decisions)
- **Last-touch**, labelled **"influenced"** (never "caused").
- **7-day window from send**, with a **per-goal override** (`conversion_ref.windowDays`).
- A recipient who converts is credited to the **most recent campaign that reached them**
  (email match) within the window; ties broken by latest send.
- Anything converted with **no campaign touch in window** = **organic**.

Identity match is by **email** internally (segments hash only when leaving Pulse, so the
attribution join runs on in-house data). SMS-only recipients match by phone where present.

### 1.4 The contribution view (the deliverable)
On a parent **event goal** with `conversion_ref`, surface the breakdown:
```
Sell-through — 16,200 / 25,000 (65%)
Campaigns influenced 3,200:
  Abandoned-cart 1,100 · VIP upsell 800 · Pre-event reminder 1,300
  …the rest organic.
```
- Each child campaign goal shows its converted count + result vs its own target.
- Computed by an **attribution sweep** (see §1.6), cached on the goal; recomputed on a
  schedule + on demand.

### 1.5 Recipe ↔ goal seeding (§9)
Give recipes a structured **default goal** in their `preset` (today
`actionTemplates.js` only has `abandoned_cart`): picking a recipe **seeds** the campaign
goal (metric + target template + `conversion_ref`). The campaign's results then measure
against it automatically. Minimal v1: add `preset.goal` to `abandoned_cart` and wire the
campaign editor to create the campaign goal from it on approve.

### 1.6 Server work
- **Schema:** no migration — use existing `scope`, `conversion_ref`, `rolls_up_to`.
  Add `actions.config.goalId` (JSON, no column needed).
- **Sanitiser:** extend `cleanInput` to accept `scope:'campaign'`, `conversionRef`,
  `rollsUpTo`, `ownerRef` for campaign goals (currently ignored for event goals).
- **Attribution engine** (new, in `goals.js` or a small `goalsAttribution.js`):
  `computeContribution(eventGoalId)` → resolves the converted population, walks each
  linked campaign's recipients, last-touch within window, returns
  `{ total, byCampaign:[{actionId,name,converted}], organic }`. Reuse
  `audienceFor` + segment resolver + `action_clicks`/snapshot emails.
- **Scheduler hook:** piggyback the existing `checkConversions()` cadence (every ~30 min,
  14-day horizon) to refresh contributions; store on the goal (`conversion_ref.lastRun`,
  cached counts) so the card is instant.
- **Endpoints (dual-surface):**
  - `GET /api/goals/:goalId/contribution` — the breakdown (member or admin).
  - campaign goals flow through the existing create/update goal routes with the new scope.
  - `POST /api/goals/:goalId/contribution/refresh` — force a recompute.

### 1.7 Client work
- **Campaign editor (`CampaignManager`)**: a "This campaign's goal" picker — link to an
  existing event goal (sets `rollsUpTo`) or seed from the recipe; set target + conversion.
- **Goal detail**: a **Contribution** section (the breakdown above) on goals that have a
  `conversion_ref`, with each campaign's influenced count + link to the campaign.
- **Digest/brief**: extend the existing goal commentary to name the top contributing
  campaign ("Abandoned-cart influenced 1,100 of the 3,200 campaign-driven").

### 1.8 P2 milestones
- **P2a — Attribution engine + contribution view** (audience-join), read-only on event
  goals. *Smallest end-to-end payoff.*
- **P2b — Structured campaign goals** (scope=campaign, rollsUpTo, per-campaign target +
  result) + the campaign-editor link.
- **P2c — Recipe seeding** (`preset.goal`) + the abandoned-cart special case folded in.

---

## 2. P3 — Roles + cascade

**Thesis:** the same goal tree, lensed by role — so Marketing sees demand/conversion
goals, Finance sees revenue/settlement goals, and an exec sees the roll-up. The roll-up
mechanism (`rolls_up_to`) already powers personal goals; P3 generalises it.

### 2.1 Model
- **Role goal** = `goals` row with `scope = 'role'`, `owner_ref = <roleKey>` (one of
  `exec|marketing|finance|ops`, from `ROLE_LENSES`), optionally `rolls_up_to` an event
  goal.
- **Cascade** = explicit `rolls_up_to` links (already DECIDED in the canonical spec —
  curated, predictable). A parent goal shows **its own metric PLUS a roll-up of its
  children** (campaign goals from P2 + role goals + personal goals).
- Two-level minimum in practice; the tree isn't artificially capped.

### 2.2 Roll-up computation
- `rollup(goalId)` → aggregate children by their relationship to the parent metric:
  - **same unit** → sum children's contribution toward the parent (e.g. campaign goals
    summing tickets toward Sell-through);
  - **different unit** → list children as supporting goals (no false addition).
- Reuses the P2 attribution where children are campaigns; for role/personal children it's
  their resolved progress.

> **⟶ DECIDE 2:** For v1 roll-up, **sum only same-metric children** and **list** the rest
> (no weighted blends). Confirm.

### 2.3 Role-lensed surfacing (reuse what's there)
- **Digest + briefing** already take a `role` and a `lens` (`ROLE_LENSES`). Filter the
  goals block by role: show role goals for that role + the North Star, lead with the
  role's focus. Hook points: `buildDigestContent` (role lens ~line 2197) and the briefing
  (`lensForRole`, ~line 1634) — both already receive goals.
- **Goals page**: an optional role filter/segmented view (exec view = roll-up; marketing
  view = marketing goals). Admin + client surfaces share the component.

### 2.4 Server work
- **Sanitiser:** accept `scope:'role'`, `ownerRef` = role key (validate against
  `roles`/`ROLE_LENSES`).
- **Listing:** `listGoals` currently filters `scope='event'`; add `listRoleGoals(suiteId, role)`
  and include role/campaign goals in a unified tree fetch for the parent view.
- **Roll-up endpoint:** `GET /api/goals/:goalId/rollup` (or fold into the goal payload).
- **Digest/brief:** pass role goals into the existing goals fact block, role-filtered.

### 2.5 Client work
- **Goal editor:** a scope/role selector (event vs role-goal; pick the role) — admin and
  client, gated by `goals.manage`.
- **Goals page:** role view toggle; parent goals render a roll-up strip of children.
- **Digest editor:** the existing role selector already exists; just ensure role goals
  flow into the role-lensed digest.

### 2.6 P3 milestones
- **P3a — Role goals** (scope=role) + role-filtered goals on the Goals page.
- **P3b — Cascade roll-up** (parent shows children; same-metric sum) — leans on P2's tree.
- **P3c — Role-lensed digests/briefing** (goals block filtered by the reader's role).

---

## 2.5 Proposed addition — Goal **compositions** (mix / distribution goals)

> Raised by Shai. Not in the original canonical phasing; folding it in here because it's
> a natural extension of the **range/band** type just shipped, and several real goals are
> this shape. Could land before or alongside P2.

**Thesis:** many goals are **shares of one whole that must sum to ~100% and move
together** — they're not independent. Examples:
- **New vs Returning** customers (30% / 70%),
- **Age bands** (18–24 / 25–34 / 35–44 / …),
- **Local vs International**, **ticket tiers**, **acquisition channels**.

Modelling these as separate goals is wrong: a move in one silently breaks the others,
and nothing enforces the interlink.

### Model
One goal, **`scope`/type `composition`**, owning the whole split:
- **parts**: `[{ key, label, targetShare, band? }]` — each a % of total; targets ≈ sum to 100.
- Reads a **breakdown** (a category→value tile) and **normalises to actual shares**, so
  parts are interlinked *by construction* (shared denominator = the sum). Up on one ⇒ down
  on another, truthfully — no sync rule to maintain.
- **Per-part status reuses the range/band engine** (just shipped): in band → ok; out →
  flagged. Overall = **✓ Balanced** vs **⚠ Mix drifting** (names the offending slice).

### Growth ("grow the 18–24 band")
- Each part shows **movement vs last time** (share ↑/↓) + vs its target.
- Optional **focus slice** (the one you're growing): Owl's "close the gap" then targets it
  (e.g. acquisition skewed to 18–24, or a New-customer push when New is below band).

### Two shapes (both reduce to "shares")
- **(a) Composition goal** — the whole distribution (the audience mix).
- **(b) Single share goal** — one slice tracked alone ("18–24 ≥ 25% of total") = a
  **derived-share %** metric (part ÷ total) on the existing `at_least`/`range` types. Needs
  only a "share of total" metric source; no new viz.

### Data + UI + reuse
- **Source:** one category-breakdown tile (`resolveTileSeriesAll` already returns
  columns/rows) mapped to parts; total = sum of parts (or an explicit total tile).
- **Display:** a stacked bar (target vs actual) or split ring; per-slice colour; drift +
  focus highlighted; per-slice vs-last-time arrows.
- **Reuses:** the band/range engine (per part), the breakdown resolver, the close-the-gap
  campaign flow, vs-last-time.
- **New work:** a distribution metric (read breakdown → shares), multi-part goal config in
  the editor, and the composition viz. Focused build; leans on shipped pieces.

### ⟶ DECIDE (compositions)
- **C1 — Source:** single breakdown tile (recommended) vs N per-part tiles.
- **C2 — Bands per part:** explicit min/max vs target ± tolerance (recommend target ± tol).
- **C3 — Focus slice + action targeting** in v1? (recommend yes — it's the payoff.)
- **C4 — North Star interplay:** allow a single slice as North Star while the composition
  shows the balance? (recommend yes.)
- **C5 — Sequencing:** ship compositions **before P2** (it extends the range type and is
  client-facing value), or after? 

---

## 3. Cross-cutting decisions to confirm

- **⟶ DECIDE 3 (sequencing):** Recommended order is **P2a → P2b → P2c → P3a → P3b → P3c**
  — attribution first (it's the headline value and the harder engine), roles/cascade
  after (they reuse the tree). OK to lock this?
- **⟶ DECIDE 4 (conversion source):** Most goals' "converted" population is **ticket
  buyers**. Do we define that once per client (a standard "buyers" segment the goals
  reference), or per goal? Recommendation: a **client-level default buyers segment**,
  overridable per goal.
- **⟶ DECIDE 5 (privacy/labeling):** Keep last-touch + "influenced" language everywhere
  (no "caused"); show the conversion window on the breakdown so it's auditable. Confirm.
- **⟶ DECIDE 6 (scope creep guard):** Sponsorship pipeline (§10) and third-party ad
  attribution (Meta/Google/TikTok, P4) stay **out** of P2/P3. Confirm.

---

## 4. Risks & notes
- **Attribution accuracy** depends on email identity coverage; SMS-only recipients are
  partial. Label clearly; don't overclaim.
- **Cost/latency:** the attribution sweep re-resolves segments/audiences — reuse the
  existing 30-min `checkConversions` cadence and cache on the goal; never block the card.
- **Cross-client templates** (from this session) and **global role goals** are separate
  concerns — role goals are per-suite, not templated globally in v1.
- **No schema migration** is expected for P2/P3 (columns exist); only additive logic,
  `config.goalId`, and possibly `conversion_ref` sub-fields.

---

## 5. TL;DR for tomorrow
- P2 = **campaigns → goals → "influenced N"**, built on the existing conversion re-check,
  segment resolver, and click/snapshot data. Schema already supports it.
- P3 = **role goals + roll-up**, built on the existing `rolls_up_to` (personal goals
  already use it) and `ROLE_LENSES` (digests/brief already use it).
- Six **⟶ DECIDE** points above are all I need from you to turn this into a build plan.
