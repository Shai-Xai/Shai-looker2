# Build plan — Agentic Owl **P1**: `askData` + native chat shell

> Status: **draft for review** · Spec: `docs/specs/AGENTIC_OWL_SPEC.md` (read §0 +
> §5 first) · Roadmap: 1.1. This is the implementation plan for **P1 only** — the
> "ask your data" foundation on a native Claude loop, behind a flag, replacing
> Inventive *for the clients we switch over*. Later phases (freer NL→query, the
> act-tools, Skills, voice) are out of scope here and live in the spec.

## 0. What P1 ships (the one-paragraph version)
A client opens the Owl, types a question in plain English, and gets a **grounded
answer pulled live from their own data** — not just a read of an existing chart.
Under the hood: a **native Claude chat loop** with **one tool, `askData`**, that
turns the question into a query over a **curated catalogue** of fields, runs it
through the **existing scope gate** (so it can only ever touch that client's data),
and narrates the rows. Every turn is logged. It's behind a feature flag, A/B
against Inventive, so we cut clients over as it reaches parity.

**Explicitly deferred to P2+:** act-tools (campaigns/alerts/tasks), freer
open-ended NL→query, Skills. P1 is read-only and bounded.

## 1. The two bounded layers of `askData` (ship 1a first)
Per spec §5.3 — start bounded, widen later:

- **1a — Bounded re-run (ship first).** The Owl may only pick **one curated
  measure + filters/date-range** from the catalogue and run a **known-good query
  body**. It cannot invent arbitrary field combinations. Covers "VIP sales last
  week", "revenue in Cape Town", "tickets sold for event X" — a large share of
  real questions, with a small, safe surface.
- **1b — Multi-field structured query (ship second, still P1).** The Owl emits a
  **structured query object** (model, explore, fields[], filters, sorts, limit)
  validated against the whitelist before running. Still no raw SQL, still
  catalogue-bounded. Widens coverage to grouped/breakdown questions.

Both return rows; a narration pass phrases them (compute-don't-invent).

## 2. New code (all disposable modules, each < 1500-line budget)

| File | Responsibility | Mirrors |
|---|---|---|
| `server/dataCatalogue.js` | Build the curated catalogue from Looker metadata; store curation; admin routes to edit it | `inventive.js` mount shape; `looker.js` `listModels`/`getExploreFields` |
| `server/owlChat.js` | The chat loop (Claude tool-use), thread + message storage, streaming routes, the audit ledger | `os.js` (tables + routes + return API), `insights.js` streaming |
| `server/owlTools.js` | The tool registry; **`askData`** (builds query → **scope gate** → run → rows). Keeps `owlChat.js` under budget and is where P2 act-tools land | `query.js` (`applyScope`, `runLookerQuery`) |
| `client/src/components/OwlChat.jsx` | Native chat UI (message list, input, streaming, citations), drops into the existing drawer slot | `AnalystDrawer.jsx` open/close state machine |

New prompts go in `insights.js` (registered) — **not** a new prompt file — to keep
the `promptRegistry()` + `ai-overview` audit in one place.

## 3. The data model (new tables)
Follow the `db.js` pattern (CREATE TABLE IF NOT EXISTS in the module mount, like
`os.js`; helpers with camel↔snake mapping, JSON columns parsed on read):

```sql
-- the curated semantic layer askData queries against (spec §5.1)
CREATE TABLE IF NOT EXISTS owl_catalogue (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,        -- 'global' or entity_id (per-client overrides)
  model       TEXT NOT NULL,
  explore     TEXT NOT NULL,
  curated     TEXT NOT NULL DEFAULT '{}', -- {whitelist:[field], synonyms:{}, dateDim, defaultMeasures:[], hidden:[]}
  updated_by  TEXT, updated_at TEXT NOT NULL
);

-- chat threads + the audit ledger (one row per message; tool calls captured)
CREATE TABLE IF NOT EXISTS owl_threads (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, user_id TEXT NOT NULL,
  suite_id TEXT, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owl_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, -- user|owl|tool
  body TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',   -- what the Owl asked to run
  tool_results TEXT NOT NULL DEFAULT '[]', -- query bodies + row refs (the grounding trail)
  tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, created_at TEXT NOT NULL
);
```
`entity_id` is the scope anchor on threads, exactly like `briefing_feedback`. No
new tables for reads themselves — they run through existing query paths.

## 4. `askData` — the tool, step by step (in `server/owlTools.js`)
This is the heart. The flow for **1a (bounded re-run)**:

1. **Input** the Owl provides: `{ measure, filters?, dateRange?, suiteId }` — all
   referencing the **curated catalogue** (validated: measure ∈ whitelist, filter
   fields ∈ whitelist). Reject anything off-catalogue before touching Looker.
2. **Build** a query body from the catalogue's known-good template for that measure
   (model/explore/fields/sorts/limit), applying the requested filters/date range.
3. **SCOPE GATE (non-negotiable).** Call `applyScope(query, user, suiteId)`
   (`server/query.js:69`). If it returns `false` (no scope configured) → **refuse,
   fail closed**, return "no data scope set" — never run. The forced organiser
   filter is a *ceiling*; the Owl's filters can only ever narrow within it.
4. **Run** via `runLookerQuery('/queries/run/json', body)` (`server/query.js:46`) —
   reuses the cache + inflight dedupe.
5. **Return** `{ rows, queryBody, count }` to the loop. The `queryBody` is stored in
   `tool_results` as the grounding trail.
6. **Narrate** — the loop feeds rows back to Claude, which phrases the answer and
   **cites the figures it was given**. If `askData` returned nothing usable, the
   Owl says "I can't ground that from your data" — never guesses.

The tool registry is a map `{ askData: { schema, run(args, ctx) } }` so P2 adds
`draftCampaign` etc. by adding entries — same shape.

## 5. The chat loop (in `server/owlChat.js`)
Claude tool-use loop (the SDK supports it; extends the `insights.js` streaming
pattern):

```
POST /api/owl/chat  (auth.requireAuth, entity-scoped)
  1. load/create thread; append the user message
  2. call c.messages.stream({ model, system: OWL_CHAT_SYSTEM(+instructions),
       tools: [askData schema], messages: history })
  3. stream assistant text to the browser (res.write, like /api/dashboard-insight)
  4. on a tool_use block → run the tool (owlTools.askData) with ctx={user,suiteId,apiKey}
       → append tool_result → continue the stream (loop to 2) until end_turn
  5. persist assistant + tool messages (the audit ledger); end()
```
- **System prompt:** new `OWL_CHAT_SYSTEM` const in `insights.js`, wrapped with
  `systemWith(...)` so the existing per-client/standing instructions still layer in.
- **Scope context** (`user`, `suiteId`, `apiKey`) is resolved server-side and
  passed into the tool — the browser never supplies scope.
- Multi-event clients: if `suiteId` is ambiguous, the Owl asks which event (mirrors
  the segment builder's event-first flow) before querying.

## 6. The curated catalogue (in `server/dataCatalogue.js`)
- **Build:** pull `listModels()` + `getExploreFields(model, explore)` (`looker.js:216,228`)
  → a raw field list (labels, types, descriptions, group labels; hidden already
  filtered).
- **Curate + store:** an admin surface (Admin → AI → **Data catalogue**) to
  whitelist explores/fields, add synonyms ("revenue" → `gross_amount`), mark the
  canonical date dimension + default measures, hide ambiguous duplicates. Stored in
  `owl_catalogue` (global default + optional per-entity override).
- **Curation quality = the accuracy ceiling** (spec §11.2). Start with **one or
  two clean explores** rather than the whole LookML firehose.

## 7. Prompts & audit (the house rules)
- Add `OWL_CHAT_SYSTEM` (and any `askData` narration prompt) as consts in
  `insights.js` **and** register them in `promptRegistry()` in the *same change* —
  `test/prompts.test.js` fails otherwise (CLAUDE.md rule).
- Surface the new instruction layer in `GET /api/admin/ai-overview`
  (`index.js:1231`) so the "Everything the AI is told" audit stays complete.

## 8. Client (behind the flag)
- `features.js`: add `owlNativeChat: false` (default off). Keep `ask` for Inventive.
- `ClientLayout.jsx`: where the floating owl renders `AnalystDrawer` (line ~706),
  branch — `FEATURES.owlNativeChat ? <OwlChat/> : <AnalystDrawer/>`. **Reuse the
  same `askOpen`/`prewarmAsk` state + owl button** so only the panel body swaps.
- `OwlChat.jsx`: message list + streaming reader (consume the `res.write` stream
  like other streamed AI calls in `lib/api.js`), an input box, and **citation
  chips** showing which figures came from a query (the grounding made visible).
  Mobile-first, single-column (it *is* the phone surface).

## 9. Tests (gating)
- **Scope tests (highest priority).** A crafted question / tool-args cannot reach
  another client's or another event's rows; `applyScope` returning `false` blocks
  the run. Mirror the existing scope tests.
- **Catalogue validation.** Off-whitelist measure/filter is rejected before Looker.
- **Prompt registry.** `OWL_CHAT_SYSTEM` is in `promptRegistry()` (existing test
  enforces).
- **Grounding.** Given empty rows, the Owl declines rather than fabricates
  (assert on the no-data path).
- **Architecture.** Each new `server/*.js` stays < 1500 lines (`architecture.test.js`).

## 10. Acceptance criteria (P1 done =)
1. A client asks a plain-English question matching the curated catalogue and gets a
   **grounded, cited** answer from **their own live data**.
2. Scope is enforced inside the tool, **fails closed**, and is covered by tests —
   no path reaches another client/event.
3. Every turn is logged (question, tool calls, query bodies, rows, tokens/cost).
4. The new prompt is registered + visible in `ai-overview`.
5. It runs behind `owlNativeChat`, A/B against Inventive, parity-or-better latency
   on common questions; Inventive untouched when the flag is off.
6. Mobile-first; works on a phone first.

## 11. Sequencing (each milestone ships something demoable)
- **M1 — Catalogue.** `dataCatalogue.js` + admin curation surface over one or two
  clean explores. **First explore = "All Tickets" — confirmed live as model
  `combined`, explore `all_tickets`** (platform45, 2026-06-28). The raw explore is
  the firehose the spec warned about: **692 visible dimensions + 63 measures**
  (plus 371 hidden) — curation is mandatory, not optional. A **curated default is
  already captured** in `server/owlCatalogueSeed.js` (~10 measures, ~20 dimensions,
  synonyms, canonical date dim `all_tickets.purchased_date`, PII excluded) — that
  is M1's pre-seed. Remaining M1 work: `dataCatalogue.js` loads the seed into
  `owl_catalogue` as the `global` default + the admin surface to widen/narrow it,
  and a runtime path that can re-pull `getExploreFields('combined','all_tickets')`
  (`looker.js:228`) to refresh candidates. Demo: a curated "All Tickets" field list
  an admin can edit.
- **M2 — `askData` (1a) + scope gate + tests. ✅ core built (2026-06-28).**
  `server/owlTools.js` — the `askData` tool factory: validates against the curated
  catalogue → builds the Looker query body → **`applyScope` gate (fails closed)** →
  `runLookerQuery` → returns grounded rows + the `queryBody` trail. Bounded to the
  catalogue via enum'd tool schema. `test/owlTools.test.js` (7 tests, green) pins
  the boundary against the REAL scope engine with Looker stubbed: forces the org
  lock, clamps a widen-attempt to the ceiling, fails closed on no-scope and on
  cross-suite access, refuses off-catalogue fields before touching Looker. Full
  suite 172/172. **Remaining:** mount a thin authenticated route
  (`POST /api/owl/ask` or fold into the chat loop) so it's callable end-to-end.
  **This is the foundation — kept bullet-proof before the UI.**
- **M3 — Chat loop + `OwlChat.jsx` behind the flag. 🏗️ server done (2026-06-28).**
  `server/owlChat.js` (disposable module): `owl_threads` + `owl_messages` tables,
  the Claude **tool-use loop** (`runOwlLoop` — pure + injectable), the streaming
  `POST /api/owl/chat` route, and the per-turn **audit trail** stored on the owl
  message. The `OWL_CHAT_SYSTEM` prompt lives here (self-contained module) and is
  registered in `insights.promptRegistry()` via a lazy reference so the AI audit
  stays complete without bloating `insights.js`. `test/owlChat.test.js` (4 tests):
  a tool_use runs under scope then the model answers from the result; a scope
  failure reaches the model as `ok:false` (no fabricated number); a no-tool turn
  returns immediately; an unknown tool is handled not thrown. Full suite 176/176,
  budgets green (prompt relocated, not bumped). **✅ Client done (2026-06-28):**
  `client/src/components/OwlChat.jsx` — a native, mobile-first chat panel that
  mirrors the Inventive drawer's docked/overlay shell, streams the answer in as
  plain text (`api.owlChat` reads the stream + `X-Owl-Thread`), and has an
  empty-state with example questions. Gated by `FEATURES.owlNativeChat` (default
  OFF); `ClientLayout` swaps `OwlChat` in for `AnalystDrawer` behind the flag,
  reusing the same floating-owl launcher, and passes the current event
  (`suiteId`, falling back to the client's first event). Client build green.
  **Remaining for a live demo:** flip the flag on in an environment with the
  Looker + Anthropic keys set and ask a real question. **Next:** citation chips
  (surface which figures came from a query) + M1's admin curation UI.
- **M4 — 1b structured query** over the catalogue (grouped/breakdown questions) +
  parity check vs Inventive; pick first client to A/B.
- **M5 — Cutover loop.** Migrate clients as parity holds; once all are over, the
  `inventive.js` module + `AnalystDrawer.jsx` are removed (one mount line + a file).

## 12. Risks / cut-lines (what to drop if time is tight)
- **Keep:** the scope gate + its tests, grounding/decline behaviour, the audit
  ledger, the flag. These are non-negotiable.
- **Can trim for a first demo:** per-entity catalogue overrides (ship global-only
  first), citation chips (text citation first), 1b (ship 1a only and widen later).
- **Don't:** start with the raw LookML firehose, or let any read skip `applyScope`.
  A wrong answer is embarrassing; a cross-client answer is a breach.

---

*Next step after sign-off: confirm the first one or two explores to curate (M1
input), then build M1→M2 and get the scope tests green before any UI.*
