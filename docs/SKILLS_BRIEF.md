# Skills & Agents — vision & architecture

> Status: **vision / architecture draft** · North Star: `docs/EXPERIENCE_OS_BRIEF.md`
> · Roadmap: **1.1** (conversational/agentic Owl) — this brief is the *autonomous*
> half of 1.1. · Companion: `docs/ENGAGEMENT_ENGINE.md` (the Action layer a skill
> acts through). No new code yet; this locks the mental model + schema direction
> before we build a skill runtime on top of `scheduler.js` + `insights.js` +
> `actions.js`.

## 1. The thesis
Pulse's job is **insight → action → results → efficiency**. Today a human sits in
the middle of that loop: they read the briefing (insight), decide (judgement),
open Engage and build a campaign (action). A **Skill** is a named, self-running
worker that closes part of that loop *on its own cadence* — it watches a slice of
the client's data, reasons about it like an analyst, and either **advises** (drops
a recommendation into the briefing) or **proposes an action** (drafts a campaign
the human one-click approves).

> A *digital-marketing skill* that watches a client's ad/website/social
> performance and advises how to optimise the campaign. A *ticketing-manager
> skill* that watches sell-through, pricing and allocation and advises when to
> release inventory or change price. Both are the **same machine**, different
> config — so we build the machine (the Skill runtime) and express skills on top
> of it, exactly as the Engagement Engine generalises "abandoned cart" into a
> recipe library.

**Why this is uniquely Pulse (not just "a chatbot"):** a skill reasons over the
**same scoped Looker/BigQuery data that powers the client's dashboards**, acts
through the **same governed Engage engine with its approval workflow**, and speaks
in the **same Owl voice** as the briefing. Insight → action → results, made
autonomous and kept in one accountable place.

## 2. What a Skill *is* (in Pulse's own terms)
A Skill is a **disposable, self-contained module** (our standard shape: owns its
table + routes, mounts in one line, prompt registered in `promptRegistry()`,
entity-scoped, dual-surface, mobile-first). It is four parts wired together —
each part already exists in the codebase:

```
Skill = Trigger → Gather → Reason → Act
        │         │        │        │
        │         │        │        └─ insight → Owl/briefing (os.js announce / digest)
        │         │        │           OR proposal → actions.js (with approval workflow)
        │         │        └─ a REGISTERED Claude prompt (insights.js / promptRegistry)
        │         └─ scoped data via query.js + looker.js + the segment resolver;
        │            forecast.js / goals.js for projections
        └─ scheduler.js tick (cadence) OR a behavioural/data trigger (actions.js auto-check)
```

The only structural difference between today's *scheduled digest* and a *skill* is
that a digest only **narrates**; a skill **decides and may act**. The plumbing is
the same.

| Skill need | What already does it | Gap to close |
|---|---|---|
| **Trigger** — run on its own | `scheduler.js` (60s tick, cadence, TZ-aware); `actions.js` auto-check (seed of behavioural triggers) | a `skills` registry + a per-skill schedule row |
| **Gather** — scoped data | `query.js` + `looker.js` (force-scoped server-side); the source-agnostic segment resolver; `forecast.js` (deterministic projection); `goals.js` (pace / result bands / North Star) | a small "fact pack" builder per skill |
| **Reason** — analyst brain | `insights.js`, `claude-opus-4-8`, **auditable** prompts via `promptRegistry()` | one new registered system prompt per skill |
| **Act** — do something | `os.js announce()` (advise); `actions.js` campaigns + **approval workflow** (propose) | a typed "skill output" → route to advise vs propose |

## 3. The autonomy ladder (maps onto the existing approval workflow)
This is the safety model **and** it's mostly already built — `actions.js` has
named/Howler approvers and an inbox + push + email notify flow. A skill declares
its **autonomy level**; nothing escalates silently.

| Level | Behaviour | Built on |
|---|---|---|
| **L0 Observe** | Writes findings to a log / quiet feed. Builds trust, measures accuracy before anyone is bothered. | telemetry + `os.js` |
| **L1 Advise** | Recommendation lands in the home briefing / digest. Human acts manually. | `scheduler.js` + `HOME_SYSTEM` / `DIGEST_SYSTEM` |
| **L2 Suggest-and-confirm** | Skill **drafts** a concrete action (campaign / message); human one-click approves. *Already exists for one case:* `GOAL_GAP_SYSTEM` drafts a targeted campaign when a goal is forecast to fall short. | `actions.js` approval workflow |
| **L3 Auto-act within bounds** | Approver pre-authorises a lane (e.g. "discount Tier C ≤ 15%; anything bigger escalates"). Acts inside the lane, logs everything. | `actions.js` + a per-skill policy row |

**Discipline:** default every new skill to **L1**. L2 requires the action engine
(have it). L3 requires (a) a written policy lane and (b) the **Howler integration
(4.1)** for anything that changes real ticket/price state. Most value is L1–L2.

## 4. The two hero skills

### 4.1 Ticketing Manager (the near-win — build first)
Watches sell-through, pricing and allocation per event; advises on inventory
releases and price changes.
- **Gather:** tier sell-through %, days-to-event, price points, refunds — all
  already queryable; `forecast.js` already projects final sell-through (shape +
  momentum); `goals.js` already flags *behind pace / forecast to fall short* with
  a North Star per event.
- **Reason:** a new registered `TICKETING_SYSTEM` prompt that turns those computed
  numbers into allocation/pricing advice — *"Tier A 92% sold, 40 days out → demand
  outpacing supply → release held inventory or raise price; Tier C 30% at 10 days →
  discount or bundle."* (Numbers computed deterministically; the AI only phrases —
  same rule as goals/forecast.)
- **Act:** **L1 advise** into the briefing now. **L2** can already draft the
  matching campaign via the Engage engine. **L3** (actually changing tiers/prices)
  needs **Howler integration (4.1)**.
- **Why first:** zero new external connectors — it rides `forecast.js` / `goals.js`
  on data we already have. Proves the whole runtime end-to-end.

### 4.2 Digital Marketing (same skeleton, bigger front-load — build second)
Watches ad pages, website and social performance; advises how to optimise the
campaign.
- **Gather:** needs data we **don't ingest yet** — Meta/TikTok ad performance, GA4,
  social. Today the Engagement Engine pushes *audience-sync* **out** (segment →
  Custom Audience, roadmap 4.3) but doesn't pull performance **in**.
- **Reason:** a registered `MARKETING_SYSTEM` prompt — *"CPA on Campaign X up 35%,
  conversions flat → creative fatigue; landing-page bounce up → friction."*
- **Act:** L1 advise; L2 draft a counter-campaign / audience change.
- **Why second:** identical Skill runtime, but front-loaded with a **connector
  ingestion** project (the inbound mirror of the existing outbound connectors).

## 5. Data model sketch (for review — evolve, don't cram into a job row)
```
skills            id, key(ticketing|marketing|...), entity_id, name,
                  autonomy(observe|advise|suggest|auto), status(active|paused),
                  schedule(json: cadence|time|tz|behavioural-trigger),
                  config(json: which dashboards/tiles/goals/thresholds to watch),
                  policy(json: L3 lanes + bounds),  prompt_key,
                  created_by, created_at, updated_at
                  -- entity-scoped like everything; one row per (skill, client)

skill_runs        id, skill_id, started_at, finished_at, status(ok|error|skipped),
                  fact_pack_ref(json: the scoped numbers fed in),
                  output(json: findings + any proposed action), usage(tokens/cost),
                  acted_as(advise|proposal_id|auto_action_id)
                  -- the audit trail: what it saw, what it said, what it did

-- proposals reuse the EXISTING actions/approval tables; a skill that proposes
-- creates an actions row in 'pending approval' — no new approval machinery.
```
`skill_runs` is the trust ledger: every autonomous decision is inspectable (inputs,
reasoning output, action, token cost — feeds roadmap **5.3** API-cost-per-client).

## 6. How it maps to what's already built
- **Trigger** → `scheduler.js` already runs due jobs on a 60s tick; a skill is a new
  job `type`. Behavioural triggers extend `actions.js` auto-check.
- **Gather** → the scoped query path (`query.js` + `applyScope`), `forecast.js`,
  `goals.js`, and the segment resolver are the fact-pack sources. **Reuse, don't
  rebuild.**
- **Reason** → add one registered system prompt per skill in `insights.js` and to
  `promptRegistry()` in the same change (the `test/prompts.test.js` rule), and
  surface its instruction layers in `GET /api/admin/ai-overview`.
- **Act** → `os.js announce()` for advise; `actions.js` + approval workflow for
  propose. `GOAL_GAP_SYSTEM` is the proof a skill-style "detect → draft campaign"
  loop already runs in production.
- **Dual-surface** → admin manages a client's skills under Admin → client detail;
  clients self-serve toggles/cadence in their own area (`/api/my/...` enforcing
  entity ownership). Same component, `scope` prop.

**Net-new (the actual build):** the `skills` + `skill_runs` tables, a thin **skill
runtime** that the scheduler invokes (`gather → reason → act` with the autonomy
gate), the per-skill registered prompts, and the admin/client surfaces to
configure + audit them.

## 7. Phasing
- **P1 — Skill runtime + Ticketing Manager at L1 (advise).** One disposable
  module (`server/skills.js`): `{ trigger, gather, reason, act, autonomy }`. First
  skill rides `forecast.js`/`goals.js`, posts to the briefing. No external
  connectors. Ships the whole loop.
  **Status 🏗️ (2026-07-03): the foundation shipped.** `server/skills.js` owns the
  `skills` + `skill_runs` tables, the daily tick (rows born paused = shadow mode),
  and dual routes. It runs as the **"push" door onto the agentic Owl** — the same
  `runOwlLoop` + scope-gated `owlTools` (getGoals + askData) as chat, NOT a fixed
  fact pack — with the Ticketing Manager prompt + a layered, trainable playbook
  (registered in `promptRegistry()`), per-run token cost via `aiUsage`, the
  **backtest** mode (date-clamped tools; the skill cannot read past the freeze)
  and AM **grading** (👍/👎 + note) from the training loop. The **admin UI**
  shipped too (Admin → client → 🤖 Skills: configure/run/backtest/grade), and a
  **second specialist** — the **Chief of Operations** (event-day debrief:
  gates/entry, bars/cashless, devices via `eventOps` + the `ask_*` extra
  explores, `liveTools` wildcards) — proved the "new skill = config + prompt"
  claim. Remaining for P1: briefing delivery + the client surface.
- **P2 — L2 (suggest-and-confirm).** Skill drafts a campaign via Engage; human
  approves. Mostly wiring the skill output into the existing approval flow.
- **P3 — `skill_runs` audit surface + cost.** Admin can see what each skill saw,
  said, did, and what it cost (feeds **5.3**, informs tier gating **5.2**).
- **P4 — Marketing skill.** Build the inbound connector ingestion (Meta/TikTok/GA4)
  — the mirror of outbound 4.3 — then the skill is config + a prompt.
- **P5 — L3 (auto-act within bounds).** Policy lanes + the **Howler integration
  (4.1)** so a skill can change real ticket/price state inside authorised bounds.
- **P6 — Skills as the agentic arm of the conversational Owl (1.1).** "Turn on a
  ticketing agent for Bushfire" from chat; the Owl explains what each skill found.

## 8. Open decisions
1. **Runtime granularity** — one generic `skills.js` runtime with pluggable
   skill definitions (lean this way — mirrors how recipes sit on the Engage
   engine) **vs** one disposable module per skill. Generic runtime + per-skill
   config is the recommendation; revisit if skills diverge wildly.
2. **Default autonomy** — confirm **L1 advise** as the ship default for every new
   skill, L2+ opt-in per client. (Lean yes.)
3. **Who owns the skill** — AM-configured vs client self-service (dual-surface
   says both; the *default* matters — same open question as Engage §9.3).
4. **Commercial packaging** — are skills a **premium tier** feature (roadmap 5.2)?
   Likely yes; `skill_runs` cost data (5.3) sizes the margin. Decide before GA.
5. **Cadence vs behavioural** — P1 is cadence-only (scheduler). When do we need
   true behavioural triggers ("fired the moment Tier A crosses 90%")? Gated on
   richer signals from **4.1**.

## 9. Risks
- **Autonomy over-reach** → strict ladder; default L1; L3 needs a written policy
  lane *and* 4.1. Never let a skill change money/inventory silently.
- **Notification fatigue** → skills feed the **digest/briefing**, not a stream of
  drips (same discipline as the Owl). One considered recommendation > ten pings.
- **Grounding / hallucinated advice** → numbers are **computed** (`forecast.js`,
  `goals.js`, the resolver); the AI only phrases. Prompts stay registered +
  auditable. A skill that can't ground a claim says so.
- **Cost** → every run logs tokens/cost in `skill_runs`; cadence is tunable; cheap
  models (Haiku) for high-frequency watchers, Opus for the deep weekly read.
- **Scope** → the runtime is the keystone; keep each skill shippable standalone at
  L1 so value lands before L2/L3 exist. Don't build the Marketing connector
  ingestion (P4) before the runtime + Ticketing skill prove the shape.

---

*Next step: pick P1 scope (the runtime + Ticketing Manager at L1) and flesh it
into a proper spec — fact pack, the `TICKETING_SYSTEM` prompt, the `skills` /
`skill_runs` tables, the admin + client surfaces, and acceptance criteria — then
slot it under the Experience OS build order.*
