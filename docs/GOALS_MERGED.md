# GOALS_MERGED.md — the **Results** pillar (canonical spec)

> **Status:** Canonical, build-ready. Merges `GOALS_HERMES.md` (Hermes) and
> `GOALS_BRIEF.md` (Claude) into one spec. The two drafts were ~80%
> complementary, not competing — Claude went deep on the **metric resolver +
> attribution**; Hermes went deep on **baseline onboarding + lifecycle + the
> year-over-year loop**. This document keeps the best of each and **resolves
> every divergence** (see §12). Companion to `EXPERIENCE_OS_BRIEF.md` and
> `ENGAGEMENT_ENGINE.md`. Decisions are flagged **DECIDED**; Claude's 7 open
> questions are answered in §13.

---

## 1. Thesis
Pulse is **insight → action → results**. **Results** is the weakest pillar
today: a campaign has a free-text "goal" and one bespoke conversion re-check,
and that's it. Goals make outcomes **first-class** — a *target on a metric*,
tracked live against a **baseline**, surfaced where people already look. A goal
turns "here's a number" into "here's the number **vs where it needs to be**,
**vs where it was last year**, and **what's closing the gap**."

A goal is also what makes an **action relevant**: not "you have abandoned
carts," but "you're 12% behind your sell-through goal, and recovering these 80
carts closes a third of the gap."

Everything keys off `suite_id` (the event) — the same spine as briefings,
settlements, documents and the Owl.

---

## 2. The model — layered, source-aware, cascading (phased)
Three scopes, rolling **up** (Claude's bottom-up `rollsUpTo` is the build
mechanism; the **event goal / North Star is always the top**):

```
Campaign / action goal   →   Role goal   →   Event goal (North Star at top)
("recover R50k abandoned")   ("Marketing:    ("25k tickets · R5m ·
                              drive 5k sales") 80% sell-through")
```

- **Event goals** — set **upfront** per suite. The top-line targets. **Exactly
  one is the North Star** (primary), reorderable, swappable (logged). **DECIDED.**
- **Role goals** — each role (`exec` / `marketing` / `finance` / `ops` — the
  existing `ROLE_LENSES` keys) owns goals that contribute to the event.
- **Campaign / action goals** — set **during**, per action; roll up via explicit
  `rollsUpTo` links into role/event goals.

**Cascade = explicit `rollsUpTo` links — DECIDED.** Curated and predictable; a
parent shows its own metric plus a roll-up of its children. Shared-metric
auto-rollup is a later option, not P1. **Two-level minimum in practice; the tree
is not artificially capped, but v1 doesn't expose cascade at all (see phasing).**

---

## 3. Goal object (sketch — evolve)
```
Goal {
  id,
  suite_id, entity_id,
  scope:    'event' | 'role' | 'campaign',
  owner:    suiteId | { role, entityId } | actionId,
  name:     'Sell-through',
  is_north_star: bool,            // exactly one true per event
  position: int,                  // ordering on the widget/briefing

  metric:   { label, source, ref },   // see §4 resolver
  target:   { value, unit:'tickets'|'ZAR'|'%'|'count',
              direction:'at_least'|'at_most', byDate },

  baseline: { event_id?, value?, source, comparable?:bool },  // see §5
  conversion?: ref,               // the goal's "done" event, for attribution (§8)
  rollsUpTo?: parentGoalId,       // cascade (P3)

  status:   'active' | 'archived',
  result_band?: 'smashed'|'hit'|'near'|'missed',   // set at deadline (§6)
  created_by/at, updated_by/at,
}
progress = resolveMetric(goal, ctx)  vs  target  (respecting direction + pace)
```

---

## 4. The metric resolver — the real deliverable
*(Same lesson as the segment resolver in `server/segments.js`: the table is
easy; the **source-agnostic resolver** is the value.)*

**Contract:** `resolveMetric(goal, ctx) → { value, asOf }`. **Lock this now,
populate sources later. DECIDED.**

- **Source adapters:** the source field selects an adapter. Callers never
  change; a new source = a new adapter.
- **Tile-sourced Looker goals — DECIDED (Claude's killer idea).** `ref =
  { dashboardId, tileId }` (optionally a field). The goal reads the **number
  already on a dashboard**, so **the goal's value == what people see** (no "why
  are these different?") and there's **zero query-building** for the user — the
  tile you look at *becomes* the goal you track. A goal defining its **own**
  query is a later add for metrics not yet tiled.
- **Live sources today (Hermes inventory):** `ticketing`, `cashless`, `access`,
  `audience`, `ga4`, `app` — all already feeding dashboards, so all reachable
  via tile-sourcing now. Funnel goals (traffic→checkout via `ga4`) work in v1.
- **Coming:** `social_paid` (Meta / Google Ads / TikTok — spend, ROAS,
  attributed sales, CAC). Adapter shape locked now, connector later (P4).
- **`manual` adapter — DECIDED (both drafts).** A hand-entered actual/target for
  anything not tiled (signed sponsorship figure, cash float). Universal fallback:
  a `manual` goal can be set **today** and **auto-promotes to a live source** if
  one lands later — no schema change.
- **Hard scope gate:** org/event scope enforced **inside** the resolver (same
  boundary as run-query / the segment resolver), never trusted to a caller.
- **Deterministic:** goal values are **computed**; the AI only *phrases* them.

---

## 5. Baseline — "recreate the previous event" (Hermes, kept in full)
A goal arrives **pre-loaded with context**, not as a naked number. On set, Pulse:

1. **Offers a baseline source** — defaults to the **most recent comparable
   event**; lets them pick a different past event; or **start from scratch**.
2. **Pulls the actuals** from that event (revenue, units, segment mix, sell-by
   curve) as the baseline number → feeds `% progress` and pace.
3. **The Owl advises off the baseline** — *"last year you sold 60% by two weeks
   out then stalled, and door-sales were 22%. To grow 15%, fix the mid-campaign
   stall."*

**No history** → manual target + lighter advice (*"no comparable event found —
we'll track from zero."*). **`comparable` flag** (P2): mark a baseline "not
comparable" (different venue/capacity/COVID year) so the Owl softens to "limited
comparison" rather than being confidently wrong.

---

## 6. Pace + result bands
**Pace, not just percent (both drafts — DECIDED).** A goal is "% vs
**expected-by-now**", not raw %. With `byDate` + a curve, each goal gets a
status: **ahead / on-track / behind**. **Curve = linear by default**; the
baseline sell-by curve refines it where a time-series exists; seasonality much
later. Pace shows **only where a time-series exists** (revenue, volume,
sell-out, attendance pace); flat metrics (segment mix, engagement %, CAC) show
**actual-vs-target only** — we don't fake a curve.

**Result bands at deadline (Hermes — DECIDED):** **smashed / hit / narrowly-
missed (~5%) / missed**. Bands close the **year-over-year loop**: they become
next event's baseline advice (*"smashed attendance but missed bar spend — fix
per-head this time"*).

---

## 7. Surfacing — Results, everywhere
- **Home / dashboard:** a **Goals widget** — progress bars + on-pace chips. The
  **North Star leads.**
- **Briefing:** the Owl leads with the **North Star in one line** —
  > *"North Star: R500k revenue — R420k in, on pace to hit ~R485k by event day
  > (3% short)."*
  …then secondary goals. Grounded in **resolved values** (deterministic facts;
  AI phrases only; links validated).
- **Digests:** **role-lensed** — each role's email leads with *their* goals
  (reuses `ROLE_LENSES` / scheduler lenses).
- **Per-campaign:** the campaign report shows **result vs its goal** ("drove
  R32k of R50k · 64%") and feeds the contribution breakdown (§8).
- **Dashboards:** goal line overlaid on the source tile.

---

## 8. Campaign contribution — attribution (Claude §8a — kept, the payoff)
The reason to link a campaign's goal `rollsUpTo` a parent: **see how each
campaign helped reach it.** A campaign's **contribution** = *conversion
tracking* — which recipients did the goal's **conversion event** (e.g. *bought*)
after receiving it. This **generalises the abandoned-cart conversion re-check**
already in `actions.js` (the `target` field + conversion check at lines ~136 /
~1357). Every goal carries a `conversion` ref; each linked campaign checks which
recipients converted.

Goal results view shows the breakdown:
```
Sell-through — 16,200 / 25,000 (65%)
Campaigns drove 3,200:
  Abandoned-cart 1,100 · VIP upsell 800 · Pre-event reminder 1,300
  …the rest organic.
```

**Attribution — last-touch for v1, labelled "influenced" (DECIDED).** Most
recent campaign before conversion gets credit; we say *influenced*, never
*caused*. **Conversion window: 7 days from send, per-goal override (DECIDED,
answers Q7).** Multi-touch / weighted = later.

---

## 9. Recipe ↔ goal (Claude — kept)
Each **recipe** (`ENGAGEMENT_ENGINE.md`) carries a **default campaign goal**
(metric + target template). Picking a recipe **seeds** the goal; the campaign's
results measure against it. A recipe = *play + default goal*; a segment = *who*;
a campaign = the three combined.

---

## 10. Sponsorship (Hermes — flagged bigger than "manual")
Sponsorship is too big a North-Star lever to leave as a hand-typed number
forever. **v1: `manual` goals** (revenue secured, # sponsors, activation value,
YoY retention). **Fast-follow: a light deal pipeline**
(prospect → pitched → signed → delivered → paid) that *feeds a number into*
goals — its own mini-module, not just a goal type. Flagged as a **bigger build**;
does **not** block goals v1.

---

## 11. How it maps to what's built (generalise, don't rebuild)
- Campaign **free-text goal** → structured **campaign goal**.
- Abandoned-cart **conversion re-check** (`actions.js`) → one instance of
  "campaign measured vs its goal" — **generalise it** (§8).
- Digest **role lenses** (`ROLE_LENSES`, `index.js:1721`) → role goals +
  role-lensed surfacing.
- **Segment resolver** (`segments.js`) → the **metric resolver** mirrors it
  (source-agnostic, scope-enforced).
- **Tiles** (`buildFactsFromTiles`) → the metric source (read the number shown).
- **`suite_id`** → the anchor, as everywhere in Pulse.

---

## 12. Divergences — resolved
| Topic | Hermes draft | Claude draft | **Resolved** |
|---|---|---|---|
| **Cascade timing** | Parked to v2, top-down by revenue stream | Central, bottom-up `rollsUpTo`, P3 | **Claude's `rollsUpTo` mechanism**, **Hermes's late phasing** — cascade is **P3**, not v1. Schema carries `rollsUpTo` from day one (dormant). |
| **Dashboard relationship** | Goal *overlaid on* a tile | Goal *sourced from* the tile (value == tile) | **Claude — tile-sourced.** Stronger: no divergence between goal and dashboard. |
| **Attribution** | Under-specified | Last-touch "influenced", 7-day window | **Claude — kept in full (§8).** The payoff of the system. |
| **Baseline / recreate-last-event** | Full onboarding flow + Owl advice | Optional `baseline` number only | **Hermes — kept in full (§5).** Was an explicit ask. |
| **Result bands + YoY loop** | smashed/hit/near/missed → next-year advice | absent | **Hermes — kept (§6).** Closes the loop. |
| **Sponsorship** | Needs a deal pipeline (fast-follow) | "manual" only | **Hermes — manual v1, pipeline fast-follow (§10).** |
| **Live source inventory** | Concrete: ticketing/cashless/access/audience/ga4/app | Generic looker→meta/google/tiktok | **Hermes inventory** *inside* **Claude's adapter contract.** |

---

## 13. Claude's open questions — answered (Shai × Hermes)
1. **Pace curve — linear default OK for P1?** **Yes.** Linear default; refine
   with the baseline sell-by curve where a time-series exists; seasonality much
   later. Per-goal override: P2+.
2. **Manual metrics?** **Yes — `source:'manual'` adapter, day one.** Universal
   fallback; auto-promotes to a live source if one lands. (Sponsorship, floats.)
3. **Role goals — per-event or standing?** **Per-event in v1** (anchored to
   `suite_id`, like everything). Standing/templated role goals can come with the
   Playbook later.
4. **Who sets goals (dual-surface)?** **Both — DECIDED.** Admin sets event/role
   goals on the client's behalf (`/api/admin/entities/:id/...`); **client
   self-serves event goals** (`/api/my/...`, entity-scoped). Role/campaign goals
   admin-first in v1, client self-serve as it proves out. Same component, `scope`
   prop (per CLAUDE.md / `MailTemplateEditor`).
5. **Units / currency?** **Single currency per entity for v1** (ZAR default).
   Multi-currency deferred; store unit on the goal so it's not a blocker.
6. **3rd-party identity/attribution (ROAS, ad conversions)?** **Defer (P4).**
   Adapter shape (`social_paid`) locked now so it slots in; no connector in v1.
7. **Conversion window + last-touch?** **7 days from send default, per-goal
   override; last-touch for v1, labelled "influenced".** Multi-touch later.

---

## 14. Phasing (canonical)
- **P1 — Foundation.** Goal object + **tile-sourced Looker resolver** + `manual`
  adapter + **event goals set upfront per suite** (with **baseline + Owl
  advice**, §5) + **North Star** + **Goals widget** with **pace** + **result
  bands** at deadline. Smallest end-to-end loop, **dual-surface**.
- **P2 — Campaign goals + results + contribution.** Structured campaign goal;
  link via `rollsUpTo`; report shows result vs goal AND the goal shows the
  **per-campaign contribution breakdown** (§8). Generalise the conversion
  re-check. Recipe↔goal seeding (§9). Baseline `comparable` flag.
- **P3 — Roles + cascade.** Role goals, `rollsUpTo` roll-up, role-lensed goals
  in digests + briefing.
- **P4 — Third-party sources + sponsorship pipeline.** Meta / Google / TikTok
  adapters (connector + attribution); sponsorship deal pipeline (§10).

---

## 15. Non-negotiables
- Goal values are **computed** (resolver); AI only **phrases**.
- **Scope enforced in the resolver**, not per caller.
- Tile-sourced goal value **equals** the dashboard number — never diverges.
- Adapters are **additive**: new source = new adapter, **callers unchanged**.
- **Exactly one North Star** per event, always present.
- Goals **editable mid-event, lightly logged** (audit trail — no silent rewrite).

---

## 16. Data model sketch (engineering review)
```
goals          id, suite_id, entity_id, scope(event|role|campaign), owner_ref,
               name, metric_key, source(ticketing|cashless|access|audience|ga4|
                 app|social_paid|sponsorship|manual), metric_ref(json),
               target_value, unit, direction(at_least|at_most|exact),
               by_date, is_north_star(bool), position,
               baseline_event_id?, baseline_value?, baseline_source,
                 baseline_comparable?(bool),         -- P2
               conversion_ref?(json),                -- §8 attribution
               rolls_up_to?(goal_id),                -- P3 cascade (dormant in v1)
               status(active|archived), result_band?(smashed|hit|near|missed),
               created_by/at, updated_by/at

goal_snapshots id, goal_id, at, actual_value, pace_projection?, on_pace(bool)
               -- time-series → pace, dashboard overlay, result band at deadline.
               -- manual goals: actual_value is human-entered here.

goal_attrib    id, goal_id, action_id, converted_count, window_days,
               model('last_touch'), at      -- §8 per-campaign contribution

goal_audit     id, goal_id, field, old, new, by, at   -- lifecycle log
```
Scoped by `suite_id` + `entity_id`; same security boundary as the rest of Pulse.
