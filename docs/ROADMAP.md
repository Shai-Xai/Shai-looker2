# Pulse — Roadmap / Backlog

> Raw ideas, fleshed out. These are **one-liners captured for shaping** — not
> commitments or final specs. Each item keeps the original note verbatim
> (*italic*) plus a first-pass description and how it ties to the
> [Experience OS vision](EXPERIENCE_OS_BRIEF.md) and what's already built.
> Last updated 2026-06-27.

Legend: **Effort** S/M/L/XL · **Status** 💡 idea · 🏗️ in progress ·
✅ shipped · ⏸️ parked · **Ties to** = existing module or vision layer.

> **How this stays current.** This roadmap is the deduplicated source of truth.
> Its raw input is `docs/whats-next/` — the per-session notes. Periodically a
> session *reconciles* the notes into this file (see the reconcile prompt in
> `docs/whats-next/README.md`): mark shipped items ✅, move started ones to 🏗️,
> add genuinely new items, and re-sequence. Bump "Last updated" when you do.
>
> **Status set conservatively on 2026-06-27** from code + git evidence (see
> `docs/whats-next/2026-06-27__account-sessions-review.md`). Items left 💡 either
> have no implementation yet or only a spec — those are flagged *confirm*.

---

## 1. AI, the Owl & agents

### 1.1 🏗️ Conversational AI assistant / analyst / agents
*"AI Conversational Assistant/Analysis/Agents to help execute."*
A chat surface (the Owl) where clients and internal teams ask questions in
natural language and get grounded answers, analysis, and — crucially — the
ability to **execute**: "draft an abandoned-cart campaign for Bushfire VIPs",
"what changed since last week?", "remind the organiser about the contract".
Three escalating capabilities: **answer** (recall over data + corpus, cited) →
**analyse** (insight beyond a single tile) → **act** (agentic: propose/execute
campaigns, tasks, messages with human confirm). Ties to `insights.js`, the Owl
Narrate/Extract/Recall layers, and the action engine (`actions.js`).
Effort: XL. The flagship of insight → action.
**Status:** 🏗️ — the analyst drawer (`AnalystDrawer.jsx`, `OwlAddressCard.jsx`,
`RefineButton.jsx`) + `insights.js`/`actions.js` deliver **answer/analyse**
today; the full **agentic "act"** layer and the autonomous skills below remain.

> The **autonomous half** of 1.1 — self-running skills/agents (a ticketing
> manager, a digital-marketing analyst) that watch a slice of the data on a
> cadence and advise or propose actions — is specced in
> **`docs/SKILLS_BRIEF.md`** (Skill runtime on `scheduler.js` + `insights.js` +
> `actions.js`; the observe → advise → suggest → auto-act autonomy ladder).

### 1.2 💡 Voice assistant
*"Voice assistant."*
Voice front-end to 1.1 — speak a question/command, hear/see the answer. Likely
mobile-first (PWA mic capture → transcription → same assistant pipeline).
Effort: L. Build after the text assistant is solid.

### 1.3 ✅ Run the morning briefing in the background
*"Run the morning briefing in background when open so clients don't have to wait
for it to load."*
Precompute each client's briefing (Owl narrative + ops state) on a schedule /
ahead of open so it's instant, instead of generating on view. Ties to
`scheduler.js`, digests, `insights.js`. Effort: M.
**Status:** ✅ — `briefingCache.js` (SWR cache + background warmer) +
`scheduler.js`; commit `9cf0682` "persist + background-warm so the home briefing
loads instantly".

---

## 2. Onboarding & client UX

### 2.1 ✅ Product updates on sign-in ("What's new")
*"Product Update on sign in — give an update of new features to clients when they
login; we also need a way to manage this on the backend."*
A "What's new" announcement shown on login (modal/banner), dismissible, with
read tracking so it shows once. **Dual-surface:** an admin backend to author,
schedule, target (all clients / specific tiers / entities) and version these
updates. Could ride the OS `announce()` spine. Effort: M.
**Status:** ✅ — `releaseNotes.js` + `releaseNotesSeed.js` engine with admin
authoring (`/api/admin/release-notes/*`) and scheduled generation.

### 2.2 🏗️ Setup wizard for clients
*"Setup Wizard for clients."*
Guided first-run onboarding: connect/confirm data scope, set branding
(logo/colours/background), choose starter dashboards, invite team, enable
notifications. Reduces AM hand-holding. Ties to integrations, branding, team
manager. Effort: M–L.
**Status:** 🏗️ — client self-service onboarding checklist shipped
(`server/onboarding.js`, `/api/my/onboarding/:entityId`, `OnboardingCard.jsx`,
auto-detecting branding/team/alerts/digests/segments/campaigns/social). The
full *guided* first-run wizard is partial — see open **PR #2 "Client onboarding
wizard"**.

### 2.3 💡 Client background colour / image
*"Add background colour or images to clients background."*
Extend white-label branding so a client can set a background colour or image for
their shell (behind cards) — and it makes the Liquid Glass surfaces shine. Admin
+ client self-service. Ties to `brand.js`, branding settings. Effort: S.
*(confirm: logo + brand colour exist, but no shell-background setting found.)*

---

## 3. Data & dashboards

### 3.1 💡 Global / portfolio-level dashboards (multi-event, multi-profile)
*"At the moment the dashboard is based on event level; will need to think how we
do on a global level where a client has many profiles or events."*
Today everything keys off `suite_id` (the event). Need a **portfolio view** that
rolls up across a client's many events/profiles — aggregate KPIs, trends, and
comparisons. Architectural: decide aggregation model (union of events vs a
global explore), scoping, and navigation. Effort: XL. Foundational.
*(confirm: spec drafted — `docs/specs/PORTFOLIO_VIEW_SPEC.md` — implementation
pending.)*

### 3.2 ✅ "Days before the event" relative filter
*"Update days-before filter so it passes onto filters — need a way to set the
number of days before the event and then set the days based on that."*
A relative-date control: pick "N days before the event" and it computes the
concrete date filter **per event** from that event's date, then injects it into
the tile queries. Makes one dashboard work across events at the same lifecycle
point. Ties to the filter system + event dates we already store. Effort: M.
**Status:** ✅ — `query.js` `daysBeforeOverlayFor()` computes per-event and
injects the filter at query time (`daysBeforeSync.mode === 'apply'`).

### 3.3 💡 Prioritised background loading of popular dashboards
*"Prioritise background loading screens of certain dashboards so customers don't
wait for them to load, especially the most popular ones they view."*
Warm/prefetch the most-viewed dashboards (per client) so they render instantly —
track view counts, prefetch top-N on login/idle, cache results briefly. Effort:
M. Pairs with nicer skeleton/loading states.

---

## 4. Platform, integrations & the Howler core

### 4.1 💡 Deep integration with Howler (event setup, ticket changes, tasks)
*"Integration into Howler to manage all event setup, ticket changes, tasks."*
Two-way link with Howler's core platform so Pulse can read event/ticket state
and **action** changes (setup steps, ticket edits) — the backbone for the
Playbook auto-verification ("On sale" completes when the first ticket sells) and
for turning insights into real operational changes. Ties to the Playbook /
`event_tasks` and data-signal verification in the brief. Effort: XL.

### 4.2 💡 Outbound API / JSON for third-party AI analysis
*"Create API/JSON to integrate with a third-party AI data analysis that we
already have in place."*
A documented, authenticated API/JSON feed exposing the client's (scoped) data so
an existing external AI analysis tool can ingest it. Decide: push (webhook) vs
pull (REST), auth (key per client/entity), scope enforcement (same server-side
organiser boundary). Effort: M.
*(confirm: spec drafted — `docs/API_MCP_BRIEF.md` (GraphQL + MCP, per-entity API
keys) — not yet implemented in code.)*

### 4.3 🏗️ Social actions — Meta / X (Twitter) / TikTok
*"Build out more actions that can link into Meta/Twitter/TikTok."*
Mostly **audience-sync** (push a segment → Meta/TikTok Custom Audience for ad
targeting/exclusion) rather than per-recipient messaging, plus later
post/ad publishing. Per-channel OAuth + a sync/send adapter mirroring
`mailer.js` / `messaging.js`. See **`docs/ENGAGEMENT_ENGINE.md`** for the full
model. Effort: L (per channel).
**Status:** 🏗️ — **Meta + TikTok** audience-sync shipped (`meta.js`,
`tiktok.js`, `socialMetrics.js`, `AudienceHub.jsx`, `/api/my/audiences/sync/*`,
tables `meta_audiences`/`tiktok_audiences`/`audience_sync_log`). **X (Twitter)**
not built; post/ad publishing not built.

### 4.6 💡 Multiple ad accounts per channel (multi-brand)
*"Clients may have multiple TikTok / Meta accounts for different brands."*
Today a connection is stored as **flat fields on the client entity** (one
`tiktokAccessToken` + `tiktokAdvertiserId`, one Meta `adAccountId`) and audiences
key on **(entity, segment)** — so the pipeline assumes **one account per channel
per client**. A client running several brands has nowhere to put a second
TikTok advertiser, and a sync can't choose which brand's account to push to.
**Proper fix:** an **ad-account sub-record** — entity → N connections per channel,
each with its own token + account id + brand **label**. Then audiences key on
**(entity, connection, segment)**, sync routes take a connection/account id, and
the **Ad audiences hub** gains a per-brand grouping *inside* each channel sub-tab
(e.g. TikTok ▸ Brand A / Brand B). Migration: new `ad_connections` table; existing
single connections backfill as one row; audience rows gain `connection_id`.
**Cheap habit meanwhile:** design any *new* connector (e.g. Google Ads) to store a
**list of accounts from day one**, so we don't unwind single-account assumptions
twice. Workaround that exists today: model each brand as its **own client entity**
(separate scoping/login) — fine when brands are separate, fragmenting when it's one
client wanting one view. Ties to `tiktok.js` / `meta.js`, the `/api/my/audiences`
endpoints + `AudienceHub.jsx` (built 2026-06). Effort: M–L (mostly a data-model
migration; the channel-tab UI already gives it a home).
*(confirm: still flat single-account fields; no `ad_connections` table yet.)*

### 4.5 💡 Howler app push notifications (channel)
*"Howler app notifications."*
A message channel that reaches **attendees in Howler's own app** (highest-reach,
where ticket-holders already are) — distinct from Pulse's web-push (which targets
Pulse users). Needs the **Howler integration (4.1)** + an attendee-push API and
an identity link between a Looker person and a Howler app user. Part of the
Engagement Engine (`docs/ENGAGEMENT_ENGINE.md`). Effort: M (once 4.1 exists).
*(note: Pulse web-push exists — `server/push.js` — but that targets Pulse users,
not Howler-app attendees; this item is the attendee channel.)*

### 4.4 💡 Chotu Links integration
*"Integrate Chotu Links into the platform."*
Integrate Chotu Links (link shortening / tracking) so campaign + share links are
shortened and click-tracked through it. **Confirm scope:** which product, API
available, and whether it replaces or augments the current tracked-link/`/c/`
redirect. Effort: S–M (pending confirmation).

---

## 5. Roles, ops & monetisation

### 5.1 🏗️ Account-manager / ops roles + event taskbar system
*"Setup the client operation/account manager roles and event taskbar system."*
The internal **AM/ops roles** and the **event task system** — i.e. the Playbook
→ Spine → `event_tasks` from the brief: tasks-as-threads with owners, due dates,
data-signal verification, blocking, and an AM cockpit (cross-client board: due
this week, overdue, readiness %). Ties directly to `roles.js`, `os.js`, and the
brief's build order. Effort: XL. Core Experience-OS work.
**Status:** 🏗️ — roles shipped (`roles.js`: owner/manager/marketing/finance/
viewer with per-area permissions) and an AM setup checklist (commit `e446527`).
The **event task system** (`event_tasks`, AM cockpit) is spec-only —
`docs/specs/EVENT_TASKS_SPEC.md`, no routes yet.

### 5.2 💡 Packages / tiers with feature gating
*"As we create packages, we will want to be able to have different packages/tiers
with certain features available and others only available for premium
customers."*
An entitlements layer: define tiers (e.g. Standard / Premium), map features to
tiers, gate UI + endpoints per entity's plan, and surface upsell where a feature
is locked. Needs a per-entity plan field + a `can(feature)` check mirroring the
permission model. Effort: M–L. Unlocks commercial packaging.

### 5.3 💡 API costs per client (backend)
*"Ability to see the API costs per client in the backend."*
Attribute AI (Anthropic) + other metered API usage to each client and show
cost/usage in the admin console — per client, per period. Log tokens/cost at each
`insights.js` / assistant call keyed by entity; aggregate for an admin report.
Effort: M. Informs tier pricing (5.2) and margins.

---

## 6. ✅ Already shipped (was not on the roadmap)

Captured here so the roadmap reflects reality. These are live modules surfaced
during the 2026-06-27 reconciliation; spin any into its own roadmap item only if
it needs further shaping.

- **Goals & forecast** — event goals / North Star, pace + result bands,
  sell-curve forecasting (`goals.js`, `forecast.js`, `client/src/components/goals/*`).
- **Status Notices** — human-authored platform-incident timeline + status page,
  severity-based fan-out (`notices.js`, `StatusNoticesAdmin.jsx`).
- **Settlements / documents** — ticketing settlement docs, upload, notes audit
  (`settlements.js`).
- **Inbox / messaging hub** — client notifications, campaign-approval badge
  (`messaging.js`).
- **Digests** — scheduled briefings, role personalisation, history + feedback
  (`digests.js`, `DigestManager.jsx`, `DigestHistory.jsx`).
- **Alerts** — metric-threshold / stock / sold-out alerts into the inbox
  (`alerts.js`).
- **SMS / WhatsApp** — Clickatell One API channel (`messaging.js`).
- **Slack integration** — outbound alerts/goals/share, Block Kit (`slack.js`).
- **Web Push (PWA)** — browser notifications, VAPID, per-user subs (`push.js`).
- **Activity auditing** — usage reports, inactive users/clients (`audit.js`).
- **Setup nudges** — personalised "complete your setup" reminders (`setupNudge.js`).
- **Campaign templates** (`campaignTemplates.js`).

---

## Suggested sequencing (for discussion)
- **Finish what's started:** 1.1 (the agentic "act" layer + autonomous skills),
  2.2 (close out the guided client wizard — PR #2), 4.3 (X/Twitter + publishing),
  5.1 (the event-task system on top of shipped roles).
- **Foundational / high-leverage:** 3.1 (global dashboards — spec exists),
  4.1 (Howler integration) — these unblock the most.
- **Quick wins / "wow":** 2.3 (client backgrounds), 3.3 (instant loads).
- **Commercial:** 5.2 (tiers) + 5.3 (cost visibility) together.
- **The flagship continues:** 1.1 → 1.2 (voice).
- **Integrations as demand dictates:** 4.2 (spec exists), 4.4, 4.5, 4.6.

> Next step: pick the top few, flesh each into a proper spec (problem, users,
> scope, data model, surfaces, acceptance), and slot into the brief's build order.
