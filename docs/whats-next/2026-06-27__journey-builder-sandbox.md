# What's next — 2026-06-27 · journey-builder-sandbox

**Session focus:** Designing and prototyping **custom branching journeys** (Braze/Canvas-style) for Engage — conditional, multi-step, multi-channel flows with easy setup (recipes + AI drafter) and a decision-tree visualisation. Built on a sandbox branch (`claude/journey-builder-sandbox`), not yet on `main`.

## Shipped this session
- **Spec** — `docs/specs/JOURNEY_BUILDER_SPEC.md`: the branching journey engine, the easy-setup tiers (recipes → wizard → AI), the concrete node schema (§6b), the J3 execution plan (§6c), and the locked v1 decisions (§10). Extends `docs/ENGAGEMENT_ENGINE.md` P5.
- **`server/journeys.js`** — new **disposable module** that owns the journey AI drafter (`JOURNEY_SYSTEM` + `draft()`), its routes (`GET /api/journeys/:entityId/recipes`, `POST /api/journeys/:entityId/draft`), and a `promptRegistry()` that `insights.js` spreads into the AI audit. Mounts in one line from `index.js`. (Extracted from `insights.js`/`actions.js` to satisfy the line-budget architecture test — never raise a budget, extract a module — which is J2's first step anyway.)
- **Journey recipes** — 4 pre-wired **branching decision-tree** recipes in `server/actionTemplates.js` (abandoned-cart, win-back, pre-event, thank-you→upsell) + `listJourneys()` / `getJourney()`.
- **Client** — `client/src/components/JourneyWizard.jsx`: recipe gallery + AI "describe your journey" box + a read-only **decision tree** review (horizontal side-by-side branches with connector lines, full-width, scrolls when wide) + "Create as draft campaign" (maps the opening pre-decision sequence onto the existing drip engine). New 🧭 **Journeys** tab in `EngagePage.jsx`; `journeyRecipes`/`draftJourney` added to `client/src/lib/api.js`.
- **Merged `origin/main`** into the branch (resolved conflicts in `EngagePage.jsx`, `actions.js`, `insights.js`) — main meanwhile shipped Engage's **Ad audiences** + **Templates** tabs; both kept alongside Journeys.

> Note: `claude/*` branches don't auto-deploy (Render builds from `main`), so all of the above is in the sandbox until deliberately promoted. The data model + tree are real; **branch execution is not wired yet** (see below).

## Decisions made (and why)
- **Generalise, don't rebuild.** Journeys extend today's drip (`action_enrollments`, `steps`); opens/clicks are already tracked per-step/channel (`action_opens`/`action_clicks`), so they're the branching signal — no new tracking needed.
- **Branching model = a tree of `message` + `decision` nodes.** Decisions branch on **bought / clicked / opened / no response**. This maps 1:1 onto the planned `journey_nodes` graph (a `decision` → a condition node whose branches are `next[]` edges).
- **v1 visual = read-only decision tree**, not drag-and-drop. Full editable canvas (React Flow / `@xyflow/react`) stays deferred to J6 — keeps the easy-setup promise.
- **Easy setup = recipes + AI drafter** (natural language → tree). **AI is always human-reviewed before launch** — never auto-launches.
- **v1 behaviour rules:** multi-journey membership allowed (no frequency cap yet); re-entry allowed with a cooldown; AI review always required; canvas read-only. (From the AskUserQuestion round.)
- **"Purchased" is inferred today** = "left the source segment" (works for abandoned-cart). A true *"they bought → send X"* branch needs a real purchase event (Howler integration, roadmap 4.1).

## What's next (priority order)
1. **J2 — persist the tree (foundation, invisible/safe).** Add a `journey_nodes` table and move enrolments from scalar `step_index` → `node_id` (current node). Re-express the linear drip as `send`/`wait` nodes first — **no behaviour change** — and ship behind tests. This de-risks everything after.
2. **J3 — evaluate decisions.** When a token reaches a `decision`, set `next_at = now + waitHours`; on the tick, resolve the branch from signals already written (`action_clicks` / `action_opens` for this person+step, audience re-check for "bought"), first-match-wins else the timeout/default branch; advance `node_id`. This is the first point real people route by behaviour.
3. **Goal/exit + journey-position-as-segment.** Once `node_id` is queryable, "everyone currently at node N" becomes a resolver source → syncs to Meta/TikTok via the existing `syncAudience()`. "Bought" routes to a thank-you branch instead of silently exiting.
4. **Per-step channel execution.** Today a mixed email+SMS journey draft sends *both* channels on every step (the engine's channel is campaign-level). Needs per-node channel once the graph runs.
5. **Wizard polish.** Light on-tree editing (wait times, copy), guardrail checks (no exit → loop risk, empty audience, no consent), and the proactive insight→journey nudge ("Lapsed VIPs grew 18% — build a win-back?").

## Open questions / blockers
- **Purchase signal** (roadmap 4.1, Howler integration) gates real "they bought → do X" branching. Until then the buy-branch fires off segment-exit only.
- **Recipe ownership** — platform/AM-curated only, or can clients save their own journeys as reusable recipes? (Still open from the spec.)
- **IA overlap** — main just shipped **Ad audiences** + **Templates** tabs in Engage. Journeys is its own 🧭 tab; confirm it doesn't collide with the reserved **Automations** tab (journeys ≈ automations) before promoting.
- **Promotion** — the whole feature is on the sandbox branch only. Decide whether to merge to `main` (goes live) or keep prototyping; the J2/J3 execution work touches the live `processSequences` loop and wants its own careful, test-backed pass.

## Pointers
- **Files touched:** `server/journeys.js` (new), `server/actionTemplates.js`, `server/insights.js`, `server/index.js`, `client/src/components/JourneyWizard.jsx`, `client/src/pages/EngagePage.jsx`, `client/src/lib/api.js`, `docs/specs/JOURNEY_BUILDER_SPEC.md`
- **Merge note:** resolved conflicts vs `origin/main` (EngagePage, actions.js, insights.js); ran `npm --prefix client install` for main's new `react-icons` dep. Full suite green (156/156), incl. the line-budget + prompt-audit tests.
- **Related docs:** `docs/specs/JOURNEY_BUILDER_SPEC.md` (esp. §6b node schema, §6c J3 execution plan), `docs/ENGAGEMENT_ENGINE.md` (P5 — visual journey builder)
- **Branch:** `claude/journey-builder-sandbox` (off `main`; merged `origin/main` this session)
