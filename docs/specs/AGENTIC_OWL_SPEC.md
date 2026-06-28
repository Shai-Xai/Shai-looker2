# Spec — The Agentic Owl & `askData` (the native conversational + action layer)

> Status: **draft for review** · Owner: (tbd) · Roadmap: **1.1** (conversational/
> agentic Owl — the flagship) · North Star: `docs/EXPERIENCE_OS_BRIEF.md` (Owl =
> Narrate · Extract · Recall) · Companions: `docs/SKILLS_BRIEF.md` (the autonomous
> half), `docs/ENGAGEMENT_ENGINE.md` (the act layer + the source-agnostic resolver).
>
> **Scope of this spec:** the *native* Owl — a Claude tool-use loop that can be
> **asked questions of the data** (`askData`, the foundation) and, on top of that,
> **act** (draft a campaign, set an alert, raise a task) under the existing
> approval workflow. The conversational front-end (chat) and the autonomous
> back-end (Skills) are **two doors into the same loop**; this spec defines the
> shared brain and tool layer.

## 1. Problem & goal

Today Pulse has **two Owls on two brains**:

- The **conversational** Owl clients touch ("Ask") is **Inventive** — a
  third-party iframe (`server/inventive.js`, `AnalystDrawer.jsx`). It's a
  placeholder: embed-only (no read/write API — see the note at the top of
  `inventive.js`), storage-partitioned (slow), and a **separate brain** from the
  one that writes briefings/digests. It cannot call any Pulse function, so it can
  never *act*.
- The **analytical** Owl is native Claude (`server/insights.js`): per-tile
  insights, dashboard summaries, home briefings, digests, goals briefs, settlement
  extraction, campaign drafting. `GOAL_GAP_SYSTEM` already runs a proto-agentic
  loop (detect a goal falling short → mine the data → **draft a campaign** → human
  one-click approves).

**The gap.** The native Owl only ever reasons over **already-resolved tile rows**
(`generateInsight(tileContext)`, `streamDashboardInsight(ctx)`, `briefHome({tiles})`).
It reads what's on the dashboard. It **cannot take a free-form question and form a
new query** ("VIP sales in Cape Town last week" when no tile shows that). That
capability — **text-to-query** — is the foundation everything agentic stands on.

**Goal.** Build the native Owl as a **Claude tool-use loop**, starting with the
`askData` read-tool (text-to-query, governed + grounded), then layering act-tools
(campaign / alert / task) behind the existing approval workflow — replacing
Inventive as the conversational surface and unlocking the flagship "act" of
roadmap 1.1.

## 2. Decision: build native on Claude (not rent the query brain)

We evaluated three ways to get text-to-query. **Recommendation: build native on
Claude (Path B)**, with Looker Conversational Analytics retained only as an
*optional, flagged accelerant/benchmark* — never the default.

| | Path A — **Looker Conversational Analytics** (rent) | Path B — **Native text-to-query on Claude** (build) ✅ |
|---|---|---|
| NL→query by | Google/Gemini over LookML | Claude over a curated field catalogue |
| Brain | **Second brain** (Gemini) for the query step | **One brain** (Claude) — same voice + memory as briefings/digests/skills |
| Grounding | Inherits LookML joins/semantics | Curated, whitelisted explores + the catalogue `looker.js` already exposes |
| Data source | **Re-couples to Looker** | **Source-agnostic** — works for BigQuery-direct later via the same resolver |
| Accuracy work | Google owns it | **We own it** (the real cost — tamed by curation, §5) |
| Has an API? | Yes (unlike Inventive) | n/a (it's ours) |

**Why native wins here.** (1) **We already have a second brain (Inventive) and
it's the problem, not the solution** — adding a *third* (Gemini) to answer
questions fragments the Owl's voice and memory further. (2) `askData` is the
**foundation of the whole agentic loop** (every act-tool reads through it); owning
it keeps grounding, scope and audit in one place. (3) The project's stated
direction is **pluggable data sources, not Looker-only** (`PROJECT_OVERVIEW.md`,
`ENGAGEMENT_ENGINE.md`) — betting the Q&A layer on Looker CA re-couples us to
Looker exactly where we're trying to abstract it. (4) We already own the raw
materials: `looker.js` `listModels()` + `getExploreFields()` produce a semantic
catalogue, and `applyScope` already force-scopes every query.

**When we'd reconsider Path A:** if the LookML is too sprawling to curate, or Q&A
must ship faster than native accuracy allows. In that case Looker CA wraps as a
*tool* behind a capability flag (it has an API), the native loop stays the
conductor, and we benchmark native against it — same "pluggable specialist"
pattern we'd have used for Inventive.

## 3. Users

- **Organiser (client)** — opens the Owl from anywhere (the floating owl / top-bar
  button that today opens Inventive). Asks questions in plain language, scoped to
  their own data; later, drives actions ("draft a reminder for VIPs") with
  one-click approval.
- **Howler AM / ops (admin)** — the same Owl in "preview as client" + (later) an
  internal cockpit Owl that can answer across the clients they manage. Likely the
  **safer first home for "act"** (higher trust, staff-supervised).
- **The autonomous Skills** (`SKILLS_BRIEF.md`) — the *same loop*, triggered by
  `scheduler.js` instead of a human. Not a user, but the second door (§7).

## 4. Architecture: one loop, shared tools, two doors

```
        chat (pull, human-in-loop)         scheduler/trigger (push, autonomous)
                    │                                   │
                    └───────────────┬───────────────────┘
                                    ▼
                        ┌───────────────────────┐
                        │   Owl loop (Claude     │   registered, auditable prompt
                        │   tool-use, insights.js)│   (promptRegistry() + ai-overview)
                        └───────────┬───────────┘
                                    ▼  picks tools
   ┌─────────────── TOOL REGISTRY (all entity-scoped, all already-existing fns) ──────────────┐
   │ READ      askData(question)            → text-to-query over curated explores (§5) — NEW   │
   │           getGoals / getForecast       → goals.js / forecast.js (deterministic)           │
   │           getTile(dashboardId,tileId)  → existing resolved-tile path                       │
   │ ACT       draftCampaign(segment,goal)  → actions.js (→ pending approval) — generalise      │
   │           createSegment(def)           → the source-agnostic resolver (shipped)            │
   │           createAlert / createTask     → alerts.js / event_tasks (when built)              │
   │           announce(msg)                → os.js spine (advise / FYI)                         │
   └──────────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                       ┌────────────┴────────────┐
                       ▼                         ▼
              HARD SCOPE GATE             AUDIT LEDGER
        applyScope injects org/event    every turn logs: question,
        filter server-side on EVERY     tools called, query bodies,
        read — the generated query is   rows, action ids, tokens/cost
        NEVER trusted to scope itself   (feeds 5.3 cost-per-client)
```

**Read capability = answer/analyse; act tools = the autonomy ladder (§8).** Chat
and Skills differ only in what *starts* a turn — same brain, tools, grounding,
governance, voice, ledger.

## 5. `askData` — the foundation (text-to-query), in detail

The whole agentic Owl stands on this. Build it first.

### 5.1 The taming strategy: a *curated* catalogue, not the firehose
Open NL→query over raw LookML is where text-to-query gets wrong answers (wrong
measure, bad join, hallucinated field). We constrain it:
- **Whitelist** the explores + fields the Owl may query, per data source. Source
  the catalogue from `looker.js` `listModels()` / `getExploreFields()` (labels,
  types, descriptions, group labels), then **curate** — hide ambiguous/duplicate
  measures, add synonyms ("revenue" → `gross_amount`), mark the canonical date
  dimension and the default measures.
- Feed Claude a **compact field catalogue** (not the whole schema) for the
  client's explores, and have it emit a **structured query** (model, explore,
  fields, filters, sorts, limit) — *not* raw SQL — which we validate against the
  whitelist before running.
- **Numbers are computed, the model only phrases** (same rule as goals/forecast):
  `askData` returns rows; a second pass narrates them. The Owl never invents a
  figure it didn't get back.

### 5.2 The non-negotiable: the hard scope gate
- `askData` runs **only** through the existing scoped path; `applyScope` injects
  the organiser/event filter **server-side, inside the tool**, on every query. The
  generated query is **never trusted to scope itself** — identical rule to the
  segment resolver's hard scope gate (`ENGAGEMENT_ENGINE.md` §6a).
- Fails **closed**: no scope configured → no query. A wrong answer is
  embarrassing; a **cross-client** answer is a breach.
- Multi-event clients: the Owl resolves/asks which event (suite) the question is
  about, same as the segment builder's event-first flow.

### 5.3 P1 cheap win — *bounded re-run* before unbounded NL→query
A large share of real questions ("VIP sales last week", "how's Cape Town doing")
are an **existing measure + a different filter/date range**. Ship that first:
the Owl picks a measure + dimension filter from the curated catalogue and re-runs
a known-good query body. Bounded, safe, rides existing query construction, and
already feels like "ask anything" — *then* widen to freer NL→query.

### 5.4 Acceptance (askData)
- Asks scoped to the client's own data only; a crafted question can never reach
  another client's or another event's rows (tested, like the existing scope tests).
- Every answer is grounded — figures trace to a returned row; "I can't ground that"
  when the catalogue can't answer, never a guess.
- The `askData` prompt is registered in `promptRegistry()` and surfaced in
  `GET /api/admin/ai-overview` (the `test/prompts.test.js` rule).
- Latency at parity-or-better with the Inventive iframe for common questions.

## 6. Replacing Inventive (migration)
- Inventive stays as a **flagged placeholder** (🧪) — *don't* invest in making the
  iframe feel native (cosmetic integration just makes it harder to remove).
- Build native chat behind a capability flag (`client/src/lib/features.js`); the
  floating owl / top-bar button opens **native chat** when the flag is on, falling
  back to `AnalystDrawer` (Inventive) otherwise. A/B per client.
- Cut over per client as native reaches answer/analyse parity (§5.4). Remove
  `inventive.js` + the drawer once every client is migrated — it's a disposable
  module (one mount line), exactly as designed.

## 7. The second door: Skills (autonomous) reuse this loop
Per `SKILLS_BRIEF.md`: a Skill is `Trigger → Gather → Reason → Act` on a cadence.
It uses the **same tool registry** — `askData`/`getForecast`/`getGoals` to gather,
`draftCampaign`/`announce` to act — just started by `scheduler.js` not a human.
Building the loop + tools here is therefore most of the Skills runtime; the Skills
spec adds the `skills`/`skill_runs` registry + the autonomy policy rows on top.
**Do not build a separate brain for Skills.**

## 8. The autonomy ladder (governance on the act-tools)
Reuses the existing `actions.js` approval workflow — nothing new for safety:

| Level | Behaviour | Built on |
|---|---|---|
| **L0 Observe** | logs only (the audit ledger) | telemetry + `os.js` |
| **L1 Advise** | recommendation into briefing/chat; human acts | `insights.js` + briefing |
| **L2 Suggest-and-confirm** | Owl **drafts** an action → one-click approve | `actions.js` approval (already live via `GOAL_GAP_SYSTEM`) |
| **L3 Auto-act in bounds** | pre-authorised lane; logs everything | `actions.js` + policy row + Howler integration (4.1) |

Default every act-tool to **L2 (draft → approve)** in chat. Read tools (`askData`)
are L0/L1. Nothing escalates silently.

## 9. Data model sketch (evolve, don't cram)
```
owl_threads     id, entity_id, user_id, suite_id?, title, created_at
                -- a conversation; may anchor to an event for scope
owl_messages    id, thread_id, role(user|owl|tool), body,
                tool_calls(json), tool_results(json: query bodies + row refs),
                tokens, cost, created_at
                -- the audit ledger for chat; mirrors skill_runs for Skills

data_catalogue  entity_id/source, explore, curated(json: whitelisted fields,
                synonyms, canonical date dim, default measures, hidden)
                -- the curated semantic layer askData queries against (§5.1)
```
Reads need no new tables (they run through existing scoped query paths). Actions
**reuse the existing `actions`/approval tables** — a drafted action is a normal
`pending approval` row, no new approval machinery. Chat threads + the catalogue
are the only net-new storage.

## 10. Phasing
- **P1 — `askData` (bounded re-run, §5.3) + native chat shell** behind a flag.
  The curated catalogue, the scope gate, the registered prompt, the audit ledger.
  Reaches "ask your data" parity with Inventive on a brain that can grow.
- **P2 — Freer NL→query** (structured-query emission + validation, §5.1) over the
  curated explores. Widen coverage; keep grounding strict.
- **P3 — First act-tool: `draftCampaign` → approval.** Generalise `GOAL_GAP_SYSTEM`
  from goal-triggered to chat-triggered. The flagship "act" moment.
- **P4 — More act-tools** (`createAlert`, `createSegment`, `createTask`,
  `announce`) at L2; the autonomy policy for L3 lanes.
- **P5 — Skills reuse the loop** (`SKILLS_BRIEF.md` runtime) — the push door.
- **P6 — Voice** (roadmap 1.2) on top of the solid text loop.
- **Inventive removed** once every client is migrated (§6).

## 11. Open decisions
1. **First "act" home — clients or internal AM?** Lean **internal AM first**
   (higher trust to prove act), client chat ships read-only (`askData`) earlier.
2. **Catalogue curation owner** — who whitelists/labels the explores per client?
   Probably a Howler-side admin surface (Admin → AI → data catalogue), reusing the
   `getExploreFields` metadata. Curation quality *is* the accuracy ceiling.
3. **Looker CA as a flagged fallback** — build the `askData` tool interface so a
   Looker-CA adapter *could* drop in behind it (optionality), without making it the
   default. Decide if it's worth the adapter now or purely native.
4. **Per-source scope enforcement** — `tile`/Looker is scoped by the catalogue;
   when BigQuery-direct lands, the org filter must be injected *inside* the
   resolver (never trust raw SQL) — same gate, new adapter. Track with 4.1.
5. **Memory depth** — does chat share the Owl's Recall corpus (ingested comms,
   Experience-OS brief) from day one, or start data-only and add Recall later?
   Lean **data-only first**, Recall when the corpus/ingestion matures.

## 12. Risks
- **Hallucinated/wrong-measure answers** → curated whitelist + structured-query
  validation + compute-don't-invent; "I can't ground that" over a guess.
- **Cross-client leakage** → the hard scope gate inside the tool, fails closed,
  covered by scope tests. The single highest-severity risk.
- **A third brain creep** → resist adding Gemini (Looker CA) as the default; keep
  it a flagged adapter only. One Owl voice.
- **Cost** → every turn logs tokens/cost (feeds 5.3); cheap models for
  high-frequency/bounded reads, Opus for deep reasoning; cadence-tunable for Skills.
- **Scope creep vs. parity** → ship P1 (bounded re-run) standalone before freer
  NL→query; don't block "replace Inventive" on the full act layer existing.

---

*Next step: pick P1 scope (the curated catalogue + `askData` bounded re-run + the
native chat shell behind a flag) and turn it into an implementation plan — the
catalogue admin surface, the `askData` tool + scope gate, the registered prompt,
the chat thread storage + audit ledger, and the acceptance/scope tests — then slot
it under the Experience OS build order ahead of the Skills runtime.*
