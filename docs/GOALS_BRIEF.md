# GOALS_BRIEF.md — the **Results** pillar

Working brief for goals/results in Pulse. Companion to
`docs/EXPERIENCE_OS_BRIEF.md` and `docs/ENGAGEMENT_ENGINE.md`. Opinionated and
meant to be marked up (Shai + Hermes) before we build. Decisions already taken
are flagged **DECIDED**; the rest is **for review**.

## 1. Thesis
Pulse is **insight → action → results**. Today **results** is the weakest pillar:
a campaign has a free-text "goal" and one bespoke conversion re-check, and that's
it. Goals make outcomes **first-class** — a *target on a metric*, tracked live,
surfaced where people already look. A goal turns "here's a number" into "here's
the number **vs where it needs to be**."

## 2. The model — layered + cascading
Three scopes, rolling **up**:

```
Campaign / action goal   →   Role goal   →   Event goal
("recover R50k abandoned")   ("Marketing:    ("25k tickets ·
                              drive 5k sales") R5m · 80% sell-through")
```

- **Event goals** — set **upfront** per event (suite). The top-line targets.
- **Role goals** — each role (Marketing / Finance / Ops) owns goals that
  *contribute* to the event (e.g. Finance: "refunds < 3%").
- **Campaign / action goals** — set **during**, per action; roll up into the
  role and event goals.

**Cascade = explicit `rollsUpTo` links — DECIDED.** Curated and predictable; a
parent shows its own metric plus a roll-up of its children. (Shared-metric
auto-rollup — "campaign revenue auto-counts toward event revenue" — is a *later*
option, not P1.)

## 3. Goal object (sketch — evolve)
```
Goal {
  id,
  scope:  'event' | 'role' | 'campaign',
  owner:  suiteId | { role, entityId } | actionId,
  name:   'Sell-through',
  metric: { label, source: 'looker' | 'meta' | 'google' | 'tiktok', ref },
  target: { value, unit: 'tickets'|'ZAR'|'%'|'count',
            direction: 'at_least' | 'at_most', byDate },
  rollsUpTo?: parentGoalId,
  baseline?: number,          // optional start point for % progress
}
progress = resolveMetric(goal)  vs  target (respecting direction + pace)
```

## 4. The metric resolver — the real deliverable
*(Same lesson as the segment resolver: the table is easy; the source-agnostic
resolver is the value.)* Contract: **`resolveMetric(goal, ctx) → { value, asOf }`**.

- **Source adapters:** `looker` today; `meta` / `google` / `tiktok` later
  (ad spend, ROAS, conversions). Adding a source = adding an adapter; callers
  don't change. **Lock the contract now, populate sources later.**
- **Looker source = point at an existing tile — DECIDED.** `ref = { dashboardId,
  tileId }` (optionally a field). The goal reads the **number already on a
  dashboard**, so *the goal's value == what people see* (no "why are these
  different?"), and there's **zero extra query-building** for the user. The tile
  you look at *becomes* the goal you track. (A goal defining its **own** query is
  a later add for metrics that aren't tiled yet.)
- **Hard scope gate:** the org/event scope is enforced **inside** the resolver
  (same boundary as run-query / the segment resolver), never trusted to a caller.
- **Deterministic:** goal values are **computed**; the AI only *phrases* them.

## 5. Pace, not just percent
A goal is "% vs **expected-by-now**", not raw %. With a `byDate` (and a curve),
each goal gets a status: **ahead / on-track / behind**. Curve = **linear by
default** (override later; seasonality/sales-curve much later). This is what makes
the briefing useful ("64% to sell-through — *ahead of pace*").

## 6. Surfacing — Results, everywhere
- **Dashboard / home:** a **Goals widget** — progress bars + on-pace chips.
- **Briefing:** the Owl weaves goal progress + pace into the headline/bullets,
  grounded in resolved values (deterministic facts, links validated).
- **Digests:** **role-lensed** — each role's email leads with *their* goals
  (reuses the existing digest role lenses).
- **Per-campaign:** the campaign's report shows **result vs its goal**
  ("drove R32k of R50k · 64%").

## 7. Recipe ↔ goal
Each **recipe** (see `ENGAGEMENT_ENGINE.md`) carries a **default campaign goal**
(metric + target template). Picking a recipe seeds the goal; the campaign's
results then measure against it. Keeps recipes and goals consistent — a recipe is
*play + default goal*, a segment is *who*, a campaign is the three combined.

## 8. How it maps to what's built (generalise, don't rebuild)
- Campaign **free-text goal** → becomes a structured **campaign goal**.
- Abandoned-cart **conversion re-check** → one instance of "campaign measured vs
  its goal" (generalise it).
- Digest **role lenses** (`ROLE_LENSES`) → role goals + role-lensed surfacing.
- **Segment resolver** pattern → the **metric resolver** mirrors it
  (source-agnostic, scope-enforced).
- **Tiles** → the metric source (read the number already shown).

## 9. Phasing
- **P1 — Foundation.** Goal object + Looker (tile-sourced) metric resolver +
  **event goals** set upfront per suite + a **Goals widget** on home/dashboard
  with pace. The smallest end-to-end loop.
- **P2 — Campaign goals + results.** Structured campaign goal; report shows
  result vs goal; generalise conversions.
- **P3 — Roles + cascade.** Role goals, `rollsUpTo` rollup, role-lensed goals in
  digests + briefing.
- **P4 — Third-party sources.** Meta / Google / TikTok metric adapters (the
  connector + attribution work).

## 10. Open decisions (for review — Hermes)
1. **Pace curve:** linear default OK for P1? Per-goal override when?
2. **Manual metrics:** allow a **hand-entered** actual/target for things not in
   Looker (a signed sponsorship figure, a cash float)? (Lean: yes — `source:
   'manual'` adapter, so non-tiled goals aren't blocked on connectors.)
3. **Role goals:** per-role **per-event**, or standing per-role across events?
4. **Who sets goals (dual-surface):** admin sets event/role goals on the client's
   behalf; which subset can the client self-serve?
5. **Units / currency:** single currency per entity, or multi?
6. **3rd-party identity/attribution** (ROAS, ad conversions): defer — flag the
   shape so it slots in.

## 11. Non-negotiables
- Goal values are **computed** (resolver); AI only phrases.
- **Scope enforced in the resolver**, not per caller.
- Tile-sourced goal value **equals** the dashboard number — never diverges.
- Adapters are additive: new source = new adapter, **callers unchanged**.
