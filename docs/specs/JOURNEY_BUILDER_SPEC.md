# Spec — Custom Journeys + Easy Setup (Journey Builder)

> Status: **draft for review (sandbox)** · Owner: (tbd) · Roadmap: extends
> Engagement Engine **P5 (visual journey builder)** · North Star:
> `docs/EXPERIENCE_OS_BRIEF.md`; Action layer: `docs/ENGAGEMENT_ENGINE.md`.
> Drafted on branch `claude/journey-builder-sandbox` — nothing here is wired to
> production (Render deploys from `main` only).

## 1. Problem & goal
Today a campaign is either a one-off send or a **linear drip** (`server/actions.js`:
`campaignMode: 'sequence'`, up to 12 steps with `delayHours`, per-person state in
`action_enrollments`). That covers "send, wait, send again" — but not "**if** the
customer opens but doesn't click, do X; **if** they open *and* click, do Y," and
not "follow up on a *different channel* based on what they did." Customers can't
branch, and journeys can't react to behaviour.

CRM platforms (Braze, Customer.io, Iterable) solve this with a node-graph journey
builder — but they're **technical to set up**: the canvas is the only way in, so a
promoter faces a blank graph, raw event filters and templating syntax. Most never
build one.

**Goal — two halves, equally important:**
1. **Capability:** a conditional, multi-step, multi-channel **journey engine** —
   branch on behaviour (opened / clicked / converted), wait, switch channels, and
   sync journey position to ad platforms (Meta / TikTok).
2. **Ease:** a non-technical **promoter** can set one up in minutes via **recipes,
   a goal-first wizard, and an AI "describe your journey" drafter** — the graph is
   *generated*, not hand-built. The canvas is the pro view ~90% never open.

The two halves ship in the order **ease-first**: the recipe library + AI drafter
land on top of today's linear drip *before* full branching, so we prove "a
promoter can actually do this" early.

## 2. Users
- **Promoter / organiser (client)** — the primary user. Wants an outcome ("sell
  the last 200 tickets," "win back lapsed buyers"), not a graph. Lives in the
  wizard / recipe picker / AI chat. Self-serves in the **Engage** hub.
- **Account Manager (Howler admin)** — builds/manages journeys *on behalf of* a
  client under Admin → client detail (dual-surface), and curates the recipe
  library.
- **The AI assistant (Owl)** — drafts journeys + copy on request; not a separate
  AI, a new registered skill of the existing one (see §7).

## 3. Goals / non-goals

**In scope**
- Journey = node graph (trigger → send → wait → condition → branch → goal/exit),
  generalising the current linear drip.
- Node types: **send** (email / SMS / push), **wait** (duration / until-time),
  **condition** (attribute-instant + event-wait with timeout), **split** (A/B %),
  **audience-sync** (Meta / TikTok add/remove), **goal/exit**.
- Behaviour branching off the **per-step open & click events already tracked**
  (`action_opens`, `action_clicks`, both carry `step` + `channel`).
- **Recipe library** of whole pre-wired journeys (not just copy templates).
- **Goal-first wizard** that generates the graph from a few answers.
- **AI drafter**: plain-language description → journey graph + draft copy.
- **Journey-position-as-segment**: "everyone currently at node N" resolvable as an
  audience and syncable to ad platforms.
- Dual-surface (admin + client self-service); mobile-first wizard.
- Carry over unchanged: approvals, goals/conversions, reporting, per-channel
  consent/reach.

**Out of scope (v1)**
- Full drag-and-drop *editing* on the canvas (read-only/light-tweak first; full
  editor is a later slice — the AI/wizard generate, the user reviews).
- WhatsApp + Howler app-push channels (slot in via the channel-adapter shape when
  they land — `mailer.js` / `messaging.js` pattern).
- Custom behavioural event intake beyond opens/clicks/conversion (gated on the
  Howler signal integration, roadmap 4.1).
- Cross-journey frequency capping (see open questions).

## 4. The setup experience (the heart of this spec)

The front door is **never a blank canvas.** Three tiers, simplest first; all three
produce the same underlying journey graph.

### 4.1 Recipe library (tier 1 — covers most promoters)
A gallery of **whole journeys**, pre-wired with nodes, conditions, default wait
times and frequency caps. The promoter picks an outcome and fills only what's
truly theirs (which event, dates, offer, copy). Examples:

| Recipe | Shape (pre-built) |
|---|---|
| Abandoned cart | email → wait 24h → condition(clicked?) → SMS / email → goal: bought |
| Last-chance push | segment(looked, didn't buy) → email → wait 48h → condition(opened-no-buy) → SMS w/ code |
| Win-back lapsed | email → wait 3d → condition(no open) → SMS → wait → audience-sync(Meta retarget) |
| Pre-event reminder | scheduled N days before → email → wait → condition → SMS day-of |
| Post-event thank-you → upsell | email thanks → wait → condition(opened) → next-event offer |

Recipes are **data structures** (the same JSON the engine runs), stored so the
library is extendable by AMs without code. Abandoned-cart is reframed as *one
recipe among several* (per `ENGAGEMENT_ENGINE.md` P1).

### 4.2 Goal-first wizard (tier 2 — anything not in the library)
A short guided flow, **mobile-first**, that generates the graph behind the scenes:

1. **What do you want to achieve?** sell more / fill a slow show / win back / thank
   & upsell.
2. **Who?** Pulse suggests segments **from the client's own Looker data** ("1,240
   people looked but didn't buy in the last 7 days") via the source-agnostic
   resolver (`server/segments.js`). One tap to target.
3. **How?** only the channels actually connected, with live per-channel reach
   ("3,800 emailable · 1,500 SMS").
4. **Review & launch** — the generated journey shown as a plain-language summary
   ("We'll email them; if they don't buy in 2 days, we'll text a 10% code"), with
   the graph viewable for those who want it.

### 4.3 AI drafter (tier 3 — the leapfrog)
Promoter types it in plain language:

> "When someone opens the email but doesn't buy within 2 days, send an SMS with a
> 10% code. If they still don't buy, add them to a Meta retargeting audience."

The assistant returns a **structured journey graph + draft copy**, lays it out,
and the promoter reviews → launches. This reuses existing AI machinery
(`@anthropic-ai/sdk`, copy drafting in `server/insights.js`). The journey-drafter
system prompt is a **new registered prompt** via `promptRegistry()` (enforced by
`test/prompts.test.js`) and surfaced in `GET /api/admin/ai-overview` — auditable
like every other prompt. Output is validated against the node schema (§6) before
it's shown; the AI proposes, the engine + user dispose.

### 4.4 Guardrails (all tiers)
- Plain-language node labels, no jargon/templating exposed by default.
- Safe defaults: wait times pre-filled, frequency cap on, exit/goal required.
- "This looks off" checks: no exit condition (loop risk), channel with no consent,
  empty audience — flagged before launch.
- **Proactive nudge:** an insight card ("Lapsed VIPs grew 18% — want a win-back
  journey?") deep-links into a pre-filled wizard. This is insight → action made
  literal.

## 5. The engine (what the setup tiers generate)

A journey is a **directed graph**; each enrolled person is a token walking it,
driven by two inputs — **timers firing** and **events arriving** — exactly the
shape the current drip tick already has (`processSequences()` every 3 min).

**Node types**
- **Trigger / entry** — segment (batch) or behavioural (entered segment /
  abandoned). Generalises today's auto-enrol.
- **Send** — channel + template (today's drip step).
- **Wait** — fixed duration / until time-of-day (today's `delayHours`, promoted to
  its own node so it can sit *between* conditions).
- **Condition** — two flavours:
  - *attribute-instant* — "in VIP segment?" resolves immediately via the resolver.
  - *event-wait* — "opened but didn't click": **wait up to a timeout**, branch on
    `action_opens` / `action_clicks` (per step + channel — already recorded), with
    a default edge when the window expires.
- **Split** — random % for A/B.
- **Audience-sync** — add/remove on Meta / TikTok via existing `syncAudience()`.
- **Goal / Exit** — terminal with a reason (converted / completed / ejected).
  Conversion detection exists (person left the abandoned audience).

The "email → open+click → SMS → next condition" flow is just: Send → Condition
(wait 48h) → [clicked] Send SMS → Wait → Condition → … Each branch is an edge.

## 6. Data model (extends ENGAGEMENT_ENGINE.md §6, deferred there to P5)

The core change: an enrolment stops pointing at a scalar `step_index` and points
at a **node**, and nodes decide the next node.

```
journeys        id, entity_id, name, segment_id, trigger, trigger_config(json),
                status(draft|active|paused|done), goal(json), version,
                source(recipe|wizard|ai|manual), approval…, results…

journey_nodes   id, journey_id, type(send|wait|condition|split|sync|goal),
                config(json), next[](edge refs: {when, targetNodeId}), position(x,y)
                -- `next` edges carry the branch predicate (clicked/opened/timeout/
                --  segment-match/split-bucket); first-match-wins, ordered.

enrolments      id, journey_id, person_ref, node_id (CURRENT node, not a scalar),
                status(active|converted|done|ejected), enrolled_at, next_at,
                anchor_at, variant
                -- generalises action_enrollments.
```
- **Versioned & immutable on publish** — editing a live journey forks a new
  version so in-flight tokens aren't disrupted.
- **Journey-position segment source** — because `enrolments.node_id` is queryable,
  add a resolver source `journey-position` ("everyone at node N of journey J").
  Feeds `syncAudience()` with no new connector code → the direct answer to
  "segments based on where customers are in the campaign."
- Stays **entity/event-scoped** through the resolver's hard scope gate.

**Migration path:** re-express today's linear drip as a chain of Send/Wait nodes
(pure internal refactor, no user-visible change) *before* adding condition/split —
de-risks everything after.

## 7. Relationship to the platform AI (the Owl) — complementary, not duplicate
Same brain, new surface. The Owl / `insights.js` does the **insight** side
(narrate / extract / recall / draft copy); the journey drafter is the **action**
side of the same assistant — the literal insight → action handoff ("VIPs lapsing"
→ "want a win-back journey?"). Kept coherent by the existing discipline: all
prompts in `insights.js`, registered via `promptRegistry()`, aggregated in
`ai-overview`. One assistant, more tools — not a second AI.

## 8. Dual-surface & mobile-first
- **Client self-service:** Engage hub (`/engage`) — wizard, recipes, AI drafter,
  scoped to their entity (`/api/my/...`).
- **Admin on-behalf:** Admin → client detail (`/api/admin/entities/:id/...`); AMs
  also curate the recipe library.
- Same components, `scope` prop (`platform | admin-client | my`), per the
  `MailTemplateEditor` pattern.
- **Mobile-first:** wizard + AI chat + plain-language review all work on a phone;
  the node canvas is a desktop-enhanced, mobile-viewable pro view.

## 9. Phasing (each slice ships standalone value)
- **J1 — Recipe library + AI drafter on today's linear drip.** Proves easy-setup
  before branching exists. Promoter picks/describes → generated linear journey →
  review → launch.
- **J2 — Graph refactor.** `journey_nodes` + enrolment-by-node; re-express drips
  as Send/Wait chains. No user-visible change.
- **J3 — Condition (event-wait) node.** Delivers "open-no-click → SMS." Reads
  existing open/click events.
- **J4 — Audience-sync node + journey-position segment.** Meta/TikTok payoff.
- **J5 — Split (A/B), richer recipes.**
- **J6 — Visual canvas** (React Flow / `@xyflow/react`) for view + light edit;
  full drag-build last, once node types are stable.

## 10. Open questions
1. **Multi-journey membership** — can a person be in several journeys at once? If
   yes, need cross-journey frequency capping (don't send 3 emails one morning).
2. **Re-entry** — can the same person run a journey twice, and on what cooldown?
3. **Canvas now or later** — is the plain-language review + read-only graph enough
   for v1, deferring full drag-edit? (Lean: yes.)
4. **AI autonomy** — does the AI-drafted journey always require human review before
   launch (lean: yes, always), and does it need approval-workflow sign-off too?
5. **Recipe ownership** — platform-curated only, or can AMs/clients save their own
   journeys as reusable recipes?

## 11. How it maps to what's built
- `server/actions.js` — drips, enrolments, auto-check triggers, promos,
  conversions, approvals, reports → **generalise, don't rebuild.**
- `action_opens` / `action_clicks` (per step + channel) → the branching signal,
  already recorded.
- `server/segments.js` resolver → wizard audience suggestions + journey-position
  source.
- `server/meta.js` / `server/tiktok.js` `syncAudience()` → audience-sync node.
- `server/insights.js` + `promptRegistry()` → AI drafter as a registered prompt.
- `mailer.js` / `messaging.js` / `push.js` → send-node channel adapters.
- Frontend: React 18 + Vite; add `@xyflow/react` for the canvas (J6); coexists
  with `react-grid-layout`.
