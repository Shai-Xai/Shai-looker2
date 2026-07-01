# API_MCP_BRIEF.md — Pulse as a platform (API + MCP)

Working brief for opening Pulse up so other platforms (Howler's own, partners,
and **AI agents**) can read and act on it. Companion to `EXPERIENCE_OS_BRIEF.md`,
`ENGAGEMENT_ENGINE.md`, `GOALS_MERGED.md`. Decisions already taken are flagged
**DECIDED**. Revised after Hermes' review (`REVIEW_API_MCP_BRIEF_HERMES.md`) —
its recommendations are folded in below.

> **STATUS (2026-07-01): P1 + P2 are SHIPPED.** Per-entity API keys (issue /
> scope / revoke, hashed + masked, dual-surface management, `api_audit` table,
> per-key rate limits) in `server/apiKeys.js`; the read-only REST surface
> (`/api/v1`) in `server/api.js`; the remote MCP server (`/mcp`, streamable
> HTTP, curated read tools) in `server/mcp.js`. One shared `core` backs both
> surfaces. Reference: `docs/PUBLIC_API.md`. Route-level tests:
> `test/apikeys.test.js`. Next: P3 (writes + webhooks).

---

## 1. Thesis
Pulse becomes a **platform**, not just an app: a documented, authenticated
surface so other systems can read insights and *act* (segments, campaigns,
goals), and so **AI agents** can do the same conversationally. Same loop —
**insight → action → results** — now reachable from outside.

---

## 2. Architecture — one core, three surfaces
**The security boundary and the logic live in ONE place** (the service layer that
already powers the app); the public surfaces are thin adapters over it.

```
            ┌─ Web app          internal REST, cookie session   (today)
Service ────┼─ Public REST /api/v1   API key, per-entity scope    ← partners / integrations  (SHIPPED)
 layer      └─ MCP server /mcp       API key, per-entity scope    ← AI agents               (SHIPPED)
(audienceFor, resolveScope, segment/metric resolvers, actions —
 scope-enforced, the single source of truth)
```

- **REVISED (per Hermes' P0) — GraphQL is a candidate, not decided.** The only
  reason to pick GraphQL is federation into Howler's graph, and that decision is
  still open (§10.1–2). The public wire format gets decided at **P4**, once
  federation is genuinely committed. Near term, the actual differentiator — MCP —
  doesn't care about wire format, and a thin REST read surface serves machine
  access today. If federation lands, GraphQL is added as another thin adapter
  over the same `core` (server/api.js) — additive, not a rewrite.
- **MCP wraps the same service layer**, not a second implementation. A new source
  = a new adapter; callers never change (same lesson as the segment/metric
  resolver). Implemented: `server/api.js` exports a `core` of read functions;
  the REST routes and every MCP tool are thin wrappers over it.
- Web app keeps its internal REST — we *add*, we don't rewrite.

---

## 3. Auth — per-entity API keys (the foundation)
Everything hangs off this; build it first.

- **DECIDED — per-entity API keys.** A key is scoped to exactly **one client
  (entity)**. Issued, named, revocable; secret shown **once**, stored hashed,
  reported write-only/masked (same pattern as Looker/Anthropic creds).
- **Scopes on a key:** `read` · `write` · `send` (granular; least-privilege).
  An agent key can be `read` only; an integration `read+write`; `send` is opt-in
  and rare.
- **Scope gate is the resolver, not a convention.** Every external call resolves
  the entity from the key and runs the **same `resolveScope` / `audienceFor`
  enforcement** as in-app. A key **cannot** reach another client's data or widen
  scope. Fail closed.
- **Dual-surface key management** (per CLAUDE.md): admin issues keys for a client
  (Admin → client → Integrations); the client self-serves their own
  (Settings → Integrations). Same component, `scope` prop.
- Per-key **rate limits** + **audit log** (who/what/when). Optional IP allowlist.

---

## 3b. What P1 actually had to build (named, per Hermes' review)
The "reuse, don't rebuild" story in §9 held for scope enforcement, secret
masking and rate limits — but three things were **new builds**, and were:
- **A synthetic principal.** The service layer wants a `user` object
  (`entityIds`, `memberships`). An API key has no user, so key auth constructs a
  user-shaped principal pinned to the key's ONE entity (owner-role membership —
  the same shape the segments auto-mirror already used). Tenancy lives in the
  principal; capability lives in the key's scopes (`requireScope`) at the surface.
- **The `api_audit` table.** "Everything audited" needed a real append-only
  store: every REST call and MCP tool call lands there with key id, action and
  outcome (`server/apiKeys.js`).
- **Dormant schema for later granularity.** `api_keys.role` and
  `api_keys.created_by` exist (nullable, unused) so role-narrowed or per-user
  agent keys can light up later without a migration.

## 4. The read surface (SHIPPED — /api/v1; wire-format sketch for P4 below)
Backed entirely by existing service functions.

**Queries (read):**
```graphql
me: Viewer                                   # the key's entity + scopes
dashboards: [Dashboard!]!                    # catalogue for this client
dashboard(id): Dashboard
metric(dashboardId, tileId): MetricValue     # the number already on a tile
segments: [Segment!]!                        # + reach { total, email, sms }
segment(id): Segment
campaigns(status): [Campaign!]!
campaign(id): Campaign                        # + report (sent, clicks, ctr…)
goals(suiteId): [Goal!]!                      # once GOALS P1 lands
goal(id): Goal                                # progress, pace, contribution
```

**Mutations (write — `write`/`send` scopes):**
```graphql
createSegmentFromTile(input): Segment         # mirrors the in-app keystone
createSegment(input): Segment
updateSegment(id, input): Segment
draftCampaign(input): Campaign                # status: draft (never auto-sends)
updateCampaign(id, input): Campaign
requestSend(campaignId): Campaign             # enters the APPROVAL workflow
setGoal(input): Goal / updateGoal(id, input)  # once goals land
```

Types reuse the shapes the app already returns (reach, report, pace…). Pagination
+ `asOf` timestamps on resolved values. Errors are typed (scope/limit/validation).

---

## 5. Writes & safety — DECIDED
Read+write is in scope, but **nothing sends without a human**, exactly as in-app:
- Mutations can **create/draft** segments and campaigns freely (`write` scope).
- **Sending real messages requires the existing approval workflow.** `requestSend`
  enters it; the campaign still honours the client's "require approval" setting
  and approvers. A `send` scope can auto-approve *only* where the client has
  explicitly allowed unattended sends — off by default.
- **Consent + transactional rules apply unchanged** (per-channel consent, the
  `ignoreConsent` flag) — external callers can't bypass them.
- **Idempotency keys** on mutations; **rate limits** on sends; everything audited.

---

## 6. The MCP server (SHIPPED)
A thin **remote** MCP server (`server/mcp.js`, disposable module) exposing curated
tools over the service layer, authed by the **same per-entity API key**.

- **Transport:** remote (MCP streamable HTTP at `/mcp`, **stateless** — each POST
  carries its own auth) so any agent platform (Claude, etc.) can connect — not
  just local stdio.
- **Read tools (P2, live):** `pulse_get_me`, `pulse_list_dashboards`,
  `pulse_get_dashboard`, `pulse_get_metric`, `pulse_list_segments`,
  `pulse_get_segment_reach`, `pulse_list_campaigns`,
  `pulse_get_campaign_report`, `pulse_get_goals`.
- **Write tools (P3, gated):** `pulse_create_segment_from_tile`,
  `pulse_draft_campaign`, `pulse_request_send` (→ approval). Each tool's
  description states the scope it needs and that sends need approval — so an agent
  can't surprise-send.
- Tools are **curated**, not a 1:1 dump of the schema — clear names, tight inputs,
  honest descriptions (the agent reads these to decide).

---

## 7. Webhooks (events out)
So other platforms react to Pulse, not just poll it. Signed, per-entity,
retried: `campaign.sent`, `campaign.approved`, `segment.changed`,
`goal.hit` / `goal.off_pace`, `briefing.ready`. P3.

---

## 8. Phasing (revised per Hermes; P1–P2 shipped 2026-07-01)
- **P1 — Keys + scope layer + read. ✅ SHIPPED.** Per-entity API keys
  (issue/scope/revoke, hashed/masked, dual-surface management) · synthetic
  principal so every existing gate applies · `api_audit` table · per-key rate
  limits (reusing `ratelimit.js`) · read-only REST surface `/api/v1`
  (dashboards, metric, segments+reach, campaigns+reports, goals).
- **P2 — MCP (read). ✅ SHIPPED.** Remote MCP server at `/mcp` (streamable
  HTTP, stateless) wrapping the same `core` as curated tools. *The
  differentiator; needed no GraphQL.*
- **P3 — Writes + webhooks.** `write`/`send`-scoped mutations
  (create/draft/requestSend) with approval + consent gates intact — external
  sends **always human-approved in v1** (decided, was §10.4); outbound webhooks
  (signed/retried/DLQ — a real chunk, not a footnote); write MCP tools.
- **P4 — Public-API wire format + federation + docs.** Decide GraphQL vs REST
  **here**, once Howler federation is committed; subgraph/SDL if GraphQL;
  partner onboarding.

---

## 9. How it maps to what's built (reuse, don't rebuild)
- `resolveScope` / `audienceFor` / segment + metric resolvers → the **enforced
  core** every external call goes through.
- Entity integration creds (Looker/Anthropic, write-only/masked) → the **API-key**
  storage pattern.
- Segments / actions / dashboards modules → the **resolvers** behind the graph.
- The approval workflow + per-channel consent → **unchanged** gates on writes.
- Disposable-module pattern (`server/os.js`, `server/mailer.js`) → `server/api.js`
  (GraphQL) and `server/mcp.js` mount in one line each.

---

## 10. Open decisions
1. **Is Howler federation committed, or aspirational?** (Hermes' hinge question —
   needs a yes/no from Howler.) This gates the P4 wire-format decision; nothing
   shipped so far is blocked on it.
2. **If yes: federation model + server lib** (Apollo subgraph vs stitched;
   Apollo Server vs graphql-yoga vs Mercurius — match whatever Howler runs).
3. ~~Key granularity~~ **RESOLVED:** entity-only for v1, with dormant
   `role`/`created_by` columns on `api_keys` so per-user/role-narrowed agent keys
   need no migration later.
4. ~~`send` scope policy~~ **RESOLVED:** external sends **always** require human
   approval in v1; unattended send is a P3+ explicit per-client opt-in.
5. **Rate limits / quotas** per key tier (shipped defaults: 120 req/min per key,
   20/min for live resolves, 60/min MCP — revisit when real usage exists).
6. **Does Pulse also *consume* Howler's GraphQL** for connectors (the inverse
   direction)? Out of scope here but flag the shape.

---

## 11. Non-negotiables
- **One security boundary:** every surface (app, GraphQL, MCP) enforces entity
  scope in the **resolver**, never per caller. Fail closed.
- **No send without a human** unless the client explicitly opts into unattended.
- **Consent/transactional rules are inviolable** from outside.
- Secrets (keys) are **write-only/masked**; shown once.
- Surfaces are **additive over one core** — no duplicated business logic.
- Everything **audited**.
