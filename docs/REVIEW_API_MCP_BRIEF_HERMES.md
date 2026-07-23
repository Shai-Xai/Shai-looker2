# Review — API_MCP_BRIEF.md (Hermes)

> **Reviewer:** Hermes. **Scope:** `docs/API_MCP_BRIEF.md` (commit `1e257c4`).
> Doc review + code cross-check — **no code changed.** I verified the brief's
> "reuse what's built" claims against the actual server before commenting.
> Findings ordered by priority. Verdict first.

---

## TL;DR — verdict
**Strong and unusually honest brief — approve the direction, with one decision to
reverse and four build-cost items to make explicit before P1.** The core
instinct (one scope-enforced core; GraphQL + MCP as thin adapters; writes keep
the human-approval + consent gates) is right, and it's *grounded in real code* —
not hand-waving. The single biggest issue is that **GraphQL is flagged DECIDED
while the only reason to choose it (federation into Howler's graph) is still an
OPEN question.** Un-decide that and lead with MCP. Everything else is naming
build cost the brief currently undersells as "reuse."

### What I verified in the code (the brief's §9 claims hold)
- `resolveScope` / `audienceFor` — **real** (`server/auth.js`, `server/actions.js`).
- Approval workflow — **real**: `requireApprovalFor(entityId)`, `action_approvals`
  table, named approvers + `howler` approver (`server/actions.js`).
- Per-channel consent + `ignoreConsent` transactional override — **real**
  (`server/actions.js` ~L260, L409–474).
- Write-only / masked secrets pattern — **real**: `maskSecret`, `keySet`/`keyHint`,
  clear-flags (`server/index.js` ~L841–920).
- Rate limiting — **real**: `server/ratelimit.js` exists to reuse.

So §9 "reuse, don't rebuild" is accurate where it claims reuse. The items below
are where it claims reuse but the thing isn't actually built yet.

---

## P0 — the one to fix: "GraphQL DECIDED" contradicts its own open question
The entire justification for GraphQL (§2, §4) is **federation into Howler's
graph**. But §10.2 admits the federation model is **OPEN** and "depends on
Howler's setup — needs their input." You cannot have the answer (GraphQL) be
**DECIDED** while the reason for it (whether/how we federate) is undecided.

- For Pulse's **near-term consumer — AI agents — GraphQL is irrelevant.** MCP
  tools wrap service functions directly; they don't care about the wire format.
- The **app is REST internally.** GraphQL is net-new cost paid *now* (server lib,
  resolver wiring, N+1 discipline, federation plumbing) for a benefit that only
  lands at **P4**, gated on a decision **no one has made**.
- This cuts against the project's stated instinct: *ship lean, expose complexity
  later.*

**Recommendation:** Downgrade GraphQL from DECIDED to "candidate, pending the
federation decision." Re-sequence:
1. **MCP first** — it's the actual differentiator and needs no GraphQL.
2. **Thin REST/JSON read API** for P1 if partners need machine-read access now.
3. **Defer the public-API wire format** (GraphQL vs REST) until Howler federation
   is genuinely greenlit and its model is known.

**Counter-argument I concede:** if federation is *already committed* and
near-term, then REST-now means a rewrite later, which violates the "additive, not
rewrite" value. Fair — **but then someone has to actually commit to it.** Right
now §10.2 says it's aspirational. Don't let a DECIDED flag paper over an
unmade decision. → **Action: get a yes/no from Howler on federation before P1
locks the API shape.**

---

## P1 — "ONE security boundary" is aspirational, not current
§2/§11 describe a single resolver chokepoint every surface passes through. Today
that doesn't exist as one thing:
- `resolveScope` is specifically a **Looker-query scoper** — signature
  `(query, user, suiteId)`, and it injects an *organiser filter*. It is **not** a
  general "resolve entity + scopes for any call" gate.
- Segments / campaigns / threads each enforce scope **their own way**:
  `requirePermission(perm, entityFrom)` middleware reading `entityId` off the
  route, `entity_id` columns, `canAccessSuite`.

So there are **several domain boundaries that each work**, not one. Building keys
"enforced via the resolver" really means **building a new unified
scope-enforcement layer and auditing that every read/write path routes through
it.** That's the load-bearing P1 work — the brief should name it as new, not
imply the chokepoint already exists.

## P1 — there is no principal behind an API key
`resolveScope` and `audienceFor` both require a **`user`** object (they derive
`entityIds` from `user.entityIds` / `memberships` / `role === 'admin'`). An API
key has **no user.** P1 must construct a **synthetic principal / scope-context**
from the key (entity + scopes → a user-shaped object the service layer accepts).
That's a concrete refactor, not a one-line adapter. Call it out explicitly.

## P1 — audit store is unbuilt (a non-negotiable that's hiding a build)
§11 makes *"everything audited"* non-negotiable, but §9 lists **no existing audit
store to reuse.** So P1 includes a **new append-only `api_audit` table** (who /
what / when / key id / outcome). Fine — just don't let the non-negotiable hide
the build cost. (Contrast: rate limits genuinely reuse `server/ratelimit.js`.)

---

## P2 — schema future-proofing (the cheap, high-value one)
§10.3 leaves **per-entity vs per-user keys** open. An entity key with
`read+write` is effectively **owner-equivalent on that entity** — it bypasses the
whole role / permission / lens system in `roles.js`. Fine for v1, **but add
dormant columns on the keys table NOW** (`role`, `created_by`, nullable) so
role-scoped / per-user *agent* keys can light up later **with no migration**.
Ship entity-only; schema ready for more. (This is exactly the "future-proof
schema, expose complexity later" pattern already used elsewhere.)

---

## Agreements (lock these in)
- **§10.4 — external sends ALWAYS require human approval in v1.** Make unattended
  send a P3+ explicit opt-in. Kills the riskiest surface up front. The brief
  already leans this way — make it a decision, not a lean.
- **Webhooks at P3 is right** — but don't underestimate signing + retries +
  dead-letter; it's a real chunk, not a footnote.
- **MCP tools curated, not a 1:1 schema dump (§6)** — agreed and important; the
  tool descriptions are the agent's UX.
- **Idempotency keys on mutations (§5)** — yes, especially anything touching sends.

---

## Suggested phasing (revised)
- **P1 — Keys + unified scope layer + read.** Per-entity API keys
  (issue/scope/revoke, write-only/masked, reuse the creds pattern) · the **new
  synthetic-principal + single enforcement chokepoint** · **`api_audit` table** ·
  reuse `ratelimit.js` · a **thin REST/JSON read surface** (dashboards, metric,
  segments+reach, campaigns+reports). *(GraphQL deferred — see P0.)*
- **P2 — MCP (read).** Remote MCP server wrapping the read layer as curated tools.
  *This is the differentiator; it does not depend on GraphQL.*
- **P3 — Writes + webhooks.** Mutations (create/draft/requestSend) with approval +
  consent gates intact; outbound webhooks (signed/retried/DLQ); write MCP tools;
  external sends still always human-approved.
- **P4 — Public-API shape + federation + docs.** *Decide GraphQL vs REST here,
  once Howler federation is committed.* Subgraph/SDL, partner onboarding, goals
  queries once goals ship.

---

## One open question back to you (Shai)
**Is Howler federation actually committed and near-term, or aspirational?** Your
answer flips P0: if committed → GraphQL-now is defensible and we plan the subgraph
early; if aspirational → defer the wire format and lead with MCP. Everything in
the revised phasing hinges on this single yes/no.
