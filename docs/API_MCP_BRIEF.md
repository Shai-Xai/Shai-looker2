# API_MCP_BRIEF.md — Pulse as a platform (GraphQL API + MCP)

Working brief for opening Pulse up so other platforms (Howler's own, partners,
and **AI agents**) can read and act on it. Companion to `EXPERIENCE_OS_BRIEF.md`,
`ENGAGEMENT_ENGINE.md`, `GOALS_MERGED.md`. For review (Shai + Hermes). Decisions
already taken are flagged **DECIDED**.

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
Service ────┼─ Public GraphQL    API key, per-entity scope        ← partners / Howler platforms
 layer      └─ MCP server        API key, per-entity scope        ← AI agents
(audienceFor, resolveScope, segment/metric resolvers, actions —
 scope-enforced, the single source of truth)
```

- **DECIDED — GraphQL for the public API** (Howler is GraphQL): ecosystem fit,
  typed/self-documenting, and Pulse can expose a **subgraph that federates into
  Howler's graph** (one unified graph, not a bolted-on API).
- **MCP wraps the same service layer**, not a second implementation. A new source
  = a new adapter; callers never change (same lesson as the segment/metric
  resolver).
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

## 4. The GraphQL surface (sketch — evolve)
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

## 6. The MCP server
A thin **remote** MCP server (`server/mcp.js`, disposable module) exposing curated
tools over the service layer, authed by the **same per-entity API key**.

- **Transport:** remote (HTTP/streamable) so any agent platform (Claude, etc.)
  can connect — not just local stdio.
- **Read tools (P2):** `pulse_list_dashboards`, `pulse_get_metric`,
  `pulse_list_segments`, `pulse_get_segment_reach`, `pulse_list_campaigns`,
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

## 8. Phasing
- **P1 — Keys + read graph.** Per-entity API-key system (issue/scope/revoke,
  enforced via the resolver) + dual-surface key management + a **read-only
  GraphQL** surface (dashboards, metric, segments+reach, campaigns+reports).
- **P2 — MCP (read).** Remote MCP server wrapping the read graph as tools.
- **P3 — Writes + webhooks.** Mutations (create/draft/requestSend) with the
  approval/consent gates intact; outbound webhooks; write MCP tools.
- **P4 — Federation + docs.** Expose as a **subgraph into Howler's graph**;
  published schema/SDL + docs + partner onboarding; goals queries once goals ship.

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

## 10. Open decisions (for review)
1. **GraphQL server lib:** Apollo Server vs graphql-yoga vs Mercurius — pick for
   easiest **federation into Howler's existing graph** (whatever Howler runs).
2. **Federation model:** Pulse as an Apollo Federation **subgraph**, or a
   standalone graph Howler stitches? (Depends on Howler's setup — needs their input.)
3. **Key granularity:** entity-only (DECIDED) — but also per-*user* keys for
   personal agents, or entity-only for v1?
4. **`send` scope policy:** allow unattended sends at all, or *always* require
   human approval for external-initiated sends in v1? (Lean: always require.)
5. **Rate limits / quotas** per key tier.
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
