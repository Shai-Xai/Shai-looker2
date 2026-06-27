# Spec — Portfolio / Global View + Client Customer Master (v1)

> Status: **draft for review** · Owner: (tbd) · Roadmap: 3.1 (global dashboards),
> with ties to 4.3 (audience-sync) and the Engagement Engine. North Star:
> `docs/EXPERIENCE_OS_BRIEF.md`. This spec covers BOTH halves the team asked for:
> a **portfolio rollup** (insight across a client's events) and a **client
> customer master** (a per-client unified audience, the "master list").

## 1. Problem & goal
Everything in Pulse today keys off the **event** (`suite_id`): dashboards, the
home briefing, digests, segments. But a client rarely *is* one event — they run
**many events over time**, and a single login/brand may hold **several client
profiles** (entities). There is no way to see *"how is my whole business doing
across all my events"*, and no **cross-event audience** ("everyone who ever
bought from me") to act on.

**Goal:** give a client a **portfolio view** that rolls up across **all their
events (and, where a login owns several, all their profiles)** — headline KPIs,
trends, and event-to-event comparison — **and** a **customer master**: a
per-client unified people view across those events that powers cross-event
segments, lifetime value, and audience-sync (Engage → Meta/TikTok).

Hard rule, unchanged: this **never crosses client boundaries**. A portfolio is
the union of *one client's own* events/profiles. There is **no cross-client
master database**. (See `docs/EXPERIENCE_OS_BRIEF.md` on server-side scope.)

## 2. The key architectural insight (why this is tractable)
Scoping is already **two layers merged** (`server/db.js`, `server/auth.js`
`scopeForQuery`):

- **Entity.lockedFilters** = the **organiser** scope (the client).
- **Suite.lockedFilters** = the **event** scope (one event).
- Every Looker query today injects **both**.

So a **portfolio query = run the existing tiles with the entity (organiser)
scope but WITHOUT the per-suite event filter** → Looker aggregates across all of
that client's events natively. The `all_organisers` management client is already
a degenerate, unscoped case of exactly this. **We therefore need a new *query
mode* + *navigation surface*, not a new warehouse model.**

For the **multi-profile** tier (a login/brand owning several entities), a
portfolio query is the **union of those entities' organiser scopes** — an `OR`
across each entity's `lockedFilters`, still entirely within what that login
already accesses (`user_entities`).

## 3. The three rollup layers (vocabulary)
| Layer | Scope | Notes |
|---|---|---|
| **Event** | entity + suite | today's behaviour, unchanged |
| **Portfolio** | one entity, all its suites | drop the suite filter; entity scope only |
| **Multi-profile** | union of several entities one login owns | OR of organiser scopes; needs a **group** concept (§5) |

## 4. Goals / non-goals (v1)

**In scope**
- A **portfolio query mode**: resolve a tile/dashboard at entity-scope (no event
  filter), and at **multi-profile** scope (union of a group's entities).
- A **Portfolio home** surface for a client: rollup KPIs (tickets, revenue,
  orders), a trend, and a **per-event comparison** table; drill into one event.
- A **client group** concept so a login/brand can be rolled up across its
  entities (the multi-profile union) — admin-managed + reflected in the shell.
- **Portfolio segments** (the customer master *list*): an entity- or
  group-scoped segment that resolves a cross-event audience, reusing the existing
  resolver + the Meta/TikTok audience-sync already built.
- Mobile-first single-column layout (the portfolio home is a phone surface first).

**Out of scope (later slices)**
- **Customer-master *metrics*** that need true cross-event **identity
  resolution** — lifetime value, repeat-buyer %, first/last seen per person.
  These need a person-keyed source (likely **BigQuery-direct**, per the brief's
  source-agnostic resolver) and a consent/identity model; specced in §8, built
  after v1.
- Non-additive metric correctness via bespoke app-side math — push aggregation to
  Looker/BigQuery, never sum averages/distinct-counts in Pulse (§6).
- Cross-client anything. Always forbidden.
- Portfolio-level **AI briefing/digest** (a natural follow-on once the rollup
  query mode exists — reuse `briefHome`/`digestBrief` with portfolio facts).

## 5. Data model (v1)
Most of v1 rides existing tables. The one genuinely new primitive is the
**group** (for multi-profile union).

```
entity_groups                      -- a brand/portfolio grouping of entities
  id            TEXT PRIMARY KEY
  name          TEXT NOT NULL
  created_at    TEXT NOT NULL

entity_group_members
  group_id      TEXT NOT NULL REFERENCES entity_groups(id) ON DELETE CASCADE
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
  PRIMARY KEY (group_id, entity_id)
```

- A login sees a **group** when *all* (or a defined subset of) its `entityIds`
  belong to that group — the shell offers an "All profiles" rollup above the
  per-profile views.
- **Scope resolution** extends `scopeForQuery`: given a `portfolioScope` of
  `{ kind:'entity', entityId }` or `{ kind:'group', groupId }`, build the
  organiser filter as the **union** of the member entities' `lockedFilters`
  (and omit any suite filter). Enforced server-side, exactly like today —
  a login can only request a group whose members are all within its `entityIds`.
- **Portfolio segments** reuse the `segments` table. Add `scope` to the
  definition: `event` (today, default) | `portfolio-entity` | `portfolio-group`.
  The resolver picks the scope accordingly; everything downstream
  (preview, members, Meta/TikTok sync, auto-mirror) is unchanged.

No change to `suites`/`entities` shape; `entity_groups` is a disposable module
(`server/groups.js`) mounted in one line.

## 6. Aggregation model (the roadmap's open question — resolved)
- **Default: reuse the entity/group organiser-scope query path.** Looker
  aggregates across events for any metric the LookML already models at organiser
  grain. This is the bulk of the portfolio dashboards and needs **no new model**.
- **Per-event comparison:** run the tile **once per suite** and stack the rows
  (cheap, N events) — for the "compare my events" table and trend.
- **Customer master / identity metrics → BigQuery-direct** (later): person-grain
  questions (LTV, repeat across events) want a person-keyed query, not a Looker
  explore shaped per event. This is the brief's "data sources are pluggable" path.
- **Never** sum non-additive measures (averages, rates, distinct counts) in
  Pulse — always push the aggregation down to Looker/BQ.

## 7. Surfaces (dual-surface rule)
- **Client self-service:** a **Portfolio / "All events"** entry in the shell
  (above the per-event suites), with the rollup home, comparison, and
  portfolio-segment creation. When the login owns a group, an **"All profiles"**
  toggle switches between one profile and the brand union.
- **Admin:** manage **groups** (which entities roll up together) in Admin →
  client tabs; preview a client's portfolio exactly as they see it.

## 8. Customer master — the identity problem (design note for the later slice)
The master *list* (a cross-event audience) is achievable in v1 because entity
scope already spans a client's events. The master *profile* (one row per real
person, with LTV/recency across events) needs:
- **Identity key:** email (+ phone) normalised/hashed; decide match precedence
  and how to treat a person appearing under multiple events.
- **Per-source consent:** consent is per channel **and** per event/source — a
  master profile must carry consent provenance, not a single flag (POPIA).
- **Source:** a person-grain BigQuery query scoped to the organiser, resolved
  through the source-agnostic resolver with the **hard scope gate** (the resolver
  refuses any source not entity/group-scoped).
This slice is **deferred**; v1 ships the list + dashboards, not the per-person
master table.

## 9. Build order (slices)
1. **Group primitive + scope union** (`server/groups.js`, `scopeForQuery`
   extension) — admin-manage groups; server enforces union-within-login.
2. **Portfolio query mode** — resolve a dashboard/tile at entity scope and group
   scope (no suite filter); validate on a real multi-event client.
3. **Portfolio home** — rollup KPIs + trend + per-event comparison + drill-down;
   shell entry + "All profiles" toggle. Mobile-first.
4. **Portfolio segments** — `scope` on segment definition; resolver honours it;
   feed Engage + the existing Meta/TikTok sync. (The "master list" lands here.)
5. **Customer-master metrics** (deferred) — BigQuery-direct person source,
   identity + consent model, LTV/repeat tiles.
6. *(optional)* **Portfolio AI briefing/digest** — reuse `briefHome`/`digestBrief`
   with portfolio facts.

## 10. Open questions (for review)
- **Group definition:** is a "brand" an explicit admin-created group, or inferred
  from a login owning multiple entities? (Spec assumes explicit groups, admin-managed.)
- **Default landing:** for a multi-event/multi-profile client, does the shell open
  on the **portfolio** or the **last event**? (Lean: portfolio when >1 event.)
- **LookML readiness:** do the key dashboards aggregate correctly at organiser
  grain with the event filter removed, or do some tiles assume a single event?
  (Audit a sample before slice 3.)
- **Comparison axis:** compare events by calendar date, or by the **days-before-
  event** relative axis (roadmap 3.2) so different events line up at the same
  lifecycle point? (Lean: offer both; default relative.)
- **Customer-master priority:** how soon after v1 do we need LTV/repeat (slice 5)
  vs. the list being enough for now?
