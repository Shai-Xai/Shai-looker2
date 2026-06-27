# What's next — 2026-06-27 · ecstatic-thompson

**Session focus:** Brainstormed and specced the "skills / agents" concept for Pulse — self-running workers (a ticketing manager, a digital-marketing analyst) that watch a slice of a client's data on a cadence and advise or propose actions. Output is a design brief, not code.

## Shipped this session
- **`docs/SKILLS_BRIEF.md`** — new vision/architecture brief (commit `fb82b37`). Defines a *Skill* in Pulse's own terms (`Trigger → Gather → Reason → Act`), maps each part to existing modules (`scheduler.js` / `query.js`+`looker.js`+`forecast.js`+`goals.js` / `insights.js`+`promptRegistry()` / `os.js`+`actions.js`), lays out the **observe → advise → suggest-and-confirm → auto-act** autonomy ladder on top of the existing approval workflow, sketches `skills` / `skill_runs` tables, and phases the two hero skills.
- **Cross-refs** so the brief sits in the doc graph: a pointer from ROADMAP §1.1 and a companion-doc line in `PROJECT_OVERVIEW.md` (same commit). *Note:* main's reconciled `docs/ROADMAP.md` already references `SKILLS_BRIEF.md` at §1.1, so the pointer survived the merge — did not re-touch ROADMAP this session.
- **No application code** — this was a brainstorm + spec + an Anthropic-Agent-Skills feasibility check, nothing wired into the server.

## Decisions made (and why)
- **Build a generic Skill runtime, not N bespoke modules.** A skill = config + a registered prompt + a gather fn + an act target, mirroring how Engage recipes sit on one engine. Avoids a sprawl of one-off agents.
- **Ticketing Manager first; Marketing second.** Ticketing rides `forecast.js` (already projects sell-through) + `goals.js` (already flags behind-pace) — **zero new external connectors**, so it proves the whole loop now. Marketing is the same runtime but front-loaded with inbound connector ingestion (Meta/TikTok/GA4), so it waits.
- **Default autonomy = L1 (advise-only) for v1.** The autonomy ladder reuses the existing `actions.js` approver flow — `GOAL_GAP_SYSTEM` already proves an L2 "detect → draft campaign" loop runs in prod. L3 (changing real ticket/price state) is gated on Howler integration (4.1).
- **Numbers stay computed, AI only phrases.** Same rule as goals/forecast — a skill grounds every claim in `forecast.js`/`goals.js`/the resolver; prompts stay registered + auditable.
- **Anthropic *Agent Skills* are for the "Reason"/artifact layer, not the whole agent.** Verified via the claude-api skill: Agent Skills run in Anthropic's sandboxed code-execution container and can't reach Looker/SQLite behind our auth — gather, scope, schedule and acting-through-approvals stay in our Node app. Use a skill only when a role produces a **deliverable file** (e.g. an `xlsx` pricing/allocation model or a `pdf` board report); for advise-only text, a registered system prompt is simpler. If we adopt skills, surface each `SKILL.md` in `/api/admin/ai-overview` to keep the "everything the AI is told" audit complete.
- **Don't hand the loop to Managed Agents for v1.** We already have `scheduler.js` + hard server-side entity scoping; Anthropic's scheduled deployments would be a bigger architectural shift than v1 warrants.

## What's next (priority order)
1. **P1 — Skill runtime + Ticketing Manager at L1.** New disposable module `server/skills.js` (`{trigger, gather, reason, act, autonomy}`) + `skills`/`skill_runs` tables; a `TICKETING_SYSTEM` prompt added to `insights.js` **and** `promptRegistry()` in the same change (else `test/prompts.test.js` fails) and surfaced in `ai-overview`; fact pack from `forecast.js`/`goals.js`; output posts to the home briefing. Dual-surface (admin + client self-service). See `SKILLS_BRIEF.md` §7.
2. **P2 — L2 suggest-and-confirm.** Wire a skill's proposed action into the existing `actions.js` approval flow (creates a pending campaign the human one-click approves). Mostly plumbing, no new approval machinery.
3. **P3 — `skill_runs` audit surface + token cost.** Show what each skill saw/said/did and what it cost; feeds API-cost-per-client (ROADMAP 5.3) and informs tier gating (5.2).
4. **P4 — Marketing skill.** Needs inbound connector ingestion first. **Check the head start on main:** `server/socialMetrics.js` and `server/slack.js` landed in the merge — see if they already pull the social/ad performance a marketing skill would reason over before scoping new connectors.
5. **Optional — artifact-producing roles via Agent Skills.** When a role needs an Excel model or PDF report, reach for Messages-API Agent Skills (`xlsx`/`pdf`) rather than text-only insights.

## Open questions / blockers
- **Default autonomy ship setting** — leaning L1-advise, L2+ opt-in per client; needs Shai's nod.
- **Skill ownership default** — AM-configured vs client self-service (same open question as Engage §9.3).
- **Commercial packaging** — are skills a premium-tier feature (5.2)? Sizing needs `skill_runs` cost data (5.3). Decide before GA.
- **L3 auto-act and behavioural (vs cadence) triggers** are both gated on **Howler integration (4.1)** — out of our control; keep tracked together.
- **Connector reuse** — does `socialMetrics.js` (new on main) already cover enough of the Marketing skill's inputs to skip a fresh Meta/TikTok/GA4 build? Worth a look before P4.

## Pointers
- Files/areas touched: `docs/SKILLS_BRIEF.md` (new), `PROJECT_OVERVIEW.md` (companion-doc line), `docs/ROADMAP.md` §1.1 (pointer — now reconciled on main).
- Related docs: `docs/SKILLS_BRIEF.md`, `docs/ENGAGEMENT_ENGINE.md` (the Action layer a skill acts through), `docs/ROADMAP.md` §1.1 / 4.1 / 4.3 / 5.2 / 5.3.
- Key modules a skill builds on: `server/scheduler.js`, `server/insights.js` (+ `promptRegistry()`), `server/forecast.js`, `server/goals.js`, `server/actions.js`, `server/os.js`. New on main worth scanning for P4: `server/socialMetrics.js`, `server/slack.js`.
