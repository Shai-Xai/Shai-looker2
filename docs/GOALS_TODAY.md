# GOALS — today's roadmap (continuation)

> Working plan for the goals/Results-pillar continuation session (2026-06-20).
> Builds on `docs/GOALS_MERGED.md` (canonical spec). P1 foundation shipped last
> night; this session takes it from "built but hidden + edit-only" to "a real,
> navigable surface with milestones and personal goals."

## Decisions locked (Shai, this session)
1. **Mobile fix — tap opens a *detail view*, not the editor.** Goals currently
   have no read view: tapping a card opens `GoalEditor` (the settings sheet),
   which on mobile is a trap. Tap → detail; **Edit/Delete live inside detail.**
2. **Personal goals = per-user** (owner is the user, not a role slot). Roles only
   **seed suggested defaults** and drive digest lensing. **People can hold
   multiple roles** — a multi-role user can seed from any of theirs. Personal
   goals **roll up** to the event goal (`rollsUpTo`).
3. **Company / standing goals — DEFERRED.** Everything keys off `suite_id`;
   company goals need an entity-level anchor. Its own project, not today.
4. **Milestones = weekly/monthly checkpoints on ONE goal** (not separate
   sub-goals). `{ byDate, targetValue }[]`. **Pace measures against the nearest
   checkpoint** — piecewise + honest, fixes the back-loaded-ticketing problem
   (linear-to-event-day pace over-claims "behind" early).
5. **Event-name link on every goal.** A goal is bound to an event (suite) +
   dashboard tile; show the event name as a **link** through to that event's
   dashboard, on the card and in detail (always, not only in multi-event view).
6. **Dedicated Goals page** (`/goals`). Home strip becomes a **teaser**
   (North Star + a few) that links into the page; the page is the real surface
   (event + personal sections, detail, milestones, event links).

7. **Baseline is the spine of goal-setting** (elevated from §5-deferred). Setting
   a goal should *start from* a baseline, not a blank target. Because goals are
   tile-sourced, the baseline = **the same tile resolved under a comparable past
   event's scope** (`resolveTileValue` with the previous suite's locks). Flow:
   pick a comparable past event → read last time's actual for that tile → the
   target pre-fills (e.g. *"18,432 last time → +15% = 21,200"*). The baseline
   then (a) drives % progress + pace, (b) shows as "vs last time" on the card /
   detail, and (c) later **seeds the milestone curve** (last year's sell-by shape
   → suggested weekly checkpoints). **Chain: baseline → target → milestones.**

## Surface model
`home GoalsStrip (teaser)` → `/goals` page (event goals → personal goals) →
`GoalDetail` (progress, "vs last time", milestones, event link; Edit/Delete) →
`GoalEditor` (form, baseline-first).

## Build slices (each: code + tests + client build green)
- **A — Goals page + surface refactor.** New `/goals` route + nav entry;
  `GoalsPage`; `GoalDetail` read view; strip → teaser that links in; mobile card
  tap navigates to detail; event-name link to the event dashboard.
- **B — Baseline-first goal-setting (core).** `GoalEditor` "compare to a past
  event" picker → resolve the same tile under that suite → baseline number →
  target suggestion (+growth %). Persist `baseline_event_id`/`baseline_value`
  (columns already exist). Show "vs last time" on card + detail. Tests.
- **C — Milestones.** Schema (`goal_milestones`), editor UI, pace-vs-nearest in
  `computeProgress`, display in detail; later seedable from the baseline curve.
  Tests.
- **D — Personal goals.** `scope:'personal'`, per-user owner, multi-role seeding,
  `rollsUpTo` rollup shown on the event goal, page section + guards. Tests.
- **E — Goal templates.** A template = a **named bundle of goal definitions**
  (metric/tile map, unit, direction, display, default milestones) **without
  targets**. Pick a template ("Festival" / "Club night" / "Conference") → goals
  appear pre-built → **just enter the targets** (pre-filled from baseline where a
  comparable event exists). System-seeded **and** "save this event's goals as a
  template." (= spec's recipe↔goal / Playbook, applied to goals.) Tests.

## Progress
- **A — shipped** (page, detail, mobile fix, event link).
- **B — shipped** (baseline-first; always-available picker + manual entry).
- **C — shipped** (milestones + milestone-aware pace).
- **D / E — pending.**

## Realistic phasing
This is now a multi-day program, not one day. **Today: land Slice A** (the page,
detail view, mobile fix, event link — the surface everything else renders into),
**then start B** (baseline-first). C/D/E follow in subsequent sessions. Templates
(E) intentionally come after baseline (B), since a template's value is mostly
realised once targets can be baseline-suggested.

## Deferred (named, not lost)
- Company/standing goals (entity anchor — breaks `suite_id`, its own project).
- Briefing/digest surfacing of the North Star (`resolveMetric` is exported but the
  `goals.mount` return is currently discarded in `index.js` — wire after the page).
- Owl *advice* off the baseline (the narrative layer — after baseline numbers land).
- P2 campaign-contribution attribution.
</content>
</invoke>
