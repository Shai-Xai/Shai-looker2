# Howler : Pulse — Project Overview

> A shareable brief for collaborators and agents (e.g. Hermes). Pairs with
> `CLAUDE.md` (working conventions) and `README.md` (feature tour + internals).

## The vision (where this is going)

**Pulse is the Experience OS for Howler — for our clients *and* our internal
teams.** It is not "a dashboard tool." It is an evolving, data-driven operating
system whose job is to turn data into **insight → action → results**, and to
make the whole working process measurably more efficient.

The throughline:

- **Insight** — surface what matters from the data (dashboards, AI reads,
  briefings, digests) without anyone digging.
- **Action** — let that insight trigger work directly in-app (campaigns,
  approvals, messages, tasks) instead of being exported to another tool.
- **Results** — close the loop: track conversions and outcomes, report on them,
  and feed them back into the next decision.
- **Efficiency** — collapse the round-trips between Howler and its clients
  (chasing, approvals, reporting, sending) into one place, self-service where
  possible, automated where safe.

Everything below is **what exists today** — a snapshot of a system that will
keep growing toward that vision. New capabilities should be judged by whether
they advance the insight → action → results → efficiency loop for clients and
internal teams alike.

> **The North Star is `docs/EXPERIENCE_OS_BRIEF.md`** — the working brief for the
> Experience OS: the **Playbook** (reusable task knowledge), the **Spine**
> (unified tasks + messages anchored to an event), the **Owl** (narrate /
> extract / recall over an ingested corpus of every event conversation), the
> "CC the Owl" ingestion strategy, build order, and data model. Read it for
> intent before extending Pulse. Companion docs: `docs/TEAM_OVERVIEW.md`,
> `docs/INBOUND_SETUP.md`, `docs/playbook-capture-template.csv`,
> `docs/ROADMAP.md` (backlog), `docs/ENGAGEMENT_ENGINE.md` (the Action layer:
> segments, journeys, channels), `docs/SKILLS_BRIEF.md` (the autonomous layer:
> self-running skills/agents + the autonomy ladder), `docs/PUBLIC_API.md`
> (the public read API + MCP server), `docs/specs/EVENT_TASKS_SPEC.md`,
> `docs/PRODUCT_OVERVIEW_SALES.md` (sales/AM-facing feature guide, kept current).

---

## What it is today

A **multi-tenant, white-label Experience OS** for Howler (events / ticketing).
It uses **Looker purely as a headless calculation engine** — Howler's LookML
defines the metrics and joins, but Pulse owns 100% of the interface (no Looker
embeds or iframes) — and increasingly reads other sources directly (PostHog for
Howler-app analytics; its own tables for the social layer). Beyond dashboards
it spans:

- **The Owl** — an agentic AI analyst: native chat with text-to-query
  (`askData`) over a curated field catalogue and tools across every domain
  (dashboards, goals, campaigns, alerts, app analytics, event ops, data health,
  uploads / Google Sheets); auto-charts with citations; pin answers as live
  tiles. Doors beyond the app: **WhatsApp** (Clickatell), an organiser-portal
  **embed**, and the fan-facing **Fan Owl** widget on promoters' websites.
- **AI insights & briefings** — ✨ reads on tiles/dashboards/pages, a
  personalised home briefing, all grounded in computed facts.
- **Engage** — segments, email/SMS campaigns, drip journeys (with simulations),
  approvals, promo codes, consent, conversions, **fan surveys** (in-app via the
  Howler app, email, hosted web), CTA tracking, AI email design.
- **Goals & forecasts** — per-event goals with forecast-led pace tracking.
- **Alerts & Live Pulse** — metric watchers plus recurring event-day updates
  and staff alerts.
- **App analytics & the social layer** — direct PostHog integration (funnel,
  in-app revenue, audience↔ticket-holder match, super fans) and Pulse-served
  communities / feed / event chat for the Howler super app.
- **Event Ops & Map Studio** — device/station logistics with heatmaps, and
  self-service 3D event maps published into the app; a BigQuery→Looker
  **data-health** monitor.
- **Digests, inbox, settlements** — role-lensed digests (email / SMS /
  WhatsApp); the "CC the Owl" messaging inbox with AI ingestion of inbound
  mail + attachments; settlements & documents.
- **The open platform** — a read-only REST API (`/api/v1`) and remote **MCP
  server** (`/mcp`) with per-client keys, so clients can plug Pulse into
  Claude / ChatGPT / their own tools.
- **Skills & self-running ops** — scheduled advise-only specialists; an
  ops-alert triage agent that files product-board tickets and auto-dispatches
  high-confidence bugs to Claude (plan-first, staging-only); an in-app report
  widget with screen recording and AI-drafted tickets.

## The stack

**Backend** — Node.js + Express (single instance)
- **Express 4** REST API; `server/index.js` is the **composition root** — ~160
  small, disposable modules each mount in one line (a line-budget test stops
  god-files forming)
- **better-sqlite3** — SQLite on a persistent disk; relational tables for most
  data, file-backed JSON for dashboard *content*; **Litestream** replicates the
  DB continuously to R2, and `diskGuard.js` makes a filling disk loud
- **Auth** — `jsonwebtoken` (JWT in an httpOnly cookie) + `bcryptjs`; a
  role/permission catalog in `roles.js`; 2FA, magic-link and white-label
  `/<slug>` logins
- **Anthropic SDK** (`@anthropic-ai/sdk`) — the Owl, insights & copy drafting
  (`claude-opus-4-8`; lighter tasks on Sonnet); per-client keys, usage metering
- **@modelcontextprotocol/sdk** — the remote MCP server; **zod** for schemas
- **web-push** (VAPID) · **@resvg/resvg-js** (SVG→PNG for AI email banners)
- Outbound via fetch: Looker REST 4.0, Resend (email), Clickatell (SMS +
  WhatsApp), PostHog, Meta/TikTok, Slack, Google Drive, GitHub
- No ORM; hand-written SQL. ~52k LOC, with a **~120-file node:test suite**
  (`npm test`) gating deploys in CI

**Frontend** — React 18 + Vite (SPA, served by the same Express server)
- **react-router-dom 6** with route-level code-splitting;
  **react-grid-layout** for the 24-column drag/resize dashboard grid
- **ECharts** for visualizations (shared by dashboards and Owl auto-charts)
- Styling via **CSS variables + inline styles** (no CSS framework); dark mode
  and an Apple "Liquid Glass" treatment on chrome/overlays
- **PWA** — installable; a push-only service worker (caches nothing, always
  fresh); ~58k LOC
- **Mobile-first** throughout (`useIsMobile()`), single-column collapse on phones

**Infra / deploy**
- **Render** (Blueprint in `render.yaml`) — production deploys from `main`,
  plus a separate **staging** service (own disk, own secrets) deploying from
  the `staging` branch for staging-first tickets (`docs/STAGING.md`)
- **CI-gated auto-deploys**; health check at `/health`; external uptime probe
- Persistent disk for SQLite (`DATA_DIR`) + Litestream replication to R2 and
  scheduled off-box backups
- Secrets via env — most also settable in-app under **Admin → Integrations**
  (write-only / masked)

## Architecture

```
Browser (React SPA) ──/api/run-query──▶ Express ──/queries/run──▶ Looker API
   custom tiles      ◀──── JSON rows ────  (looker.js)  ◀─ calculated ─ (LookML)
```

- Dashboards are JSON definitions of **tiles**, each with its own Looker query
  (model / explore / fields / filters / sorts) + vis config. Imported Looker
  dashboards can **re-sync** without losing Pulse edits.
- **Multi-tenant, scoped server-side**: clients see only their dashboards, and
  every query is force-filtered to their organiser/events **on the server**
  before it reaches Looker — can't be bypassed from the browser, and it fails
  closed if a client has no scope configured. The same gate fronts the Owl's
  `askData`, the public API and MCP.
- **Feature flags are the control panel** (`server/flags.js`): every
  client-facing feature registers a flag; server-side route **gates** enforce
  it (UI hiding is cosmetic), and Owl act-tools are simply not offered to the
  model when their flag is off.
- **Data source is pluggable (not Looker-only):** Looker is the main
  calculation engine, but Pulse already reads **PostHog directly** for app
  analytics and serves its own social tables to the Howler app; direct
  BigQuery is the next step. The server-side per-client scope must hold
  whatever the source; audiences/segments resolve through a source-agnostic
  resolver (see `docs/ENGAGEMENT_ENGINE.md`).
- **Errors** flow through one `errorMiddleware` (`server/http.js`) —
  client-safe messages only; async routes wrapped in `asyncHandler`.
- **AI is auditable** — every hardcoded prompt lives in `server/insights.js`
  behind `promptRegistry()`, surfaced in Admin → AI alongside every
  configurable instruction layer (`/api/admin/ai-overview`).

## Key server modules (`server/`, ~160 files · ~52k LOC)

- `looker.js` / `query.js` — Looker REST client + the shared query pipeline
  (cache, scope, concurrency); `convert.js` / `recreate.js` / `drill.js` for
  dashboard import, re-sync and drill-through
- `auth.js` / `roles.js` / `twofactor.js` — auth, permissions, 2FA
- `insights.js` — every hardcoded Claude prompt + the prompt registry
- `owlChat.js` + `owl*.js` — the agentic Owl: chat loop & tool orchestration,
  tools, curated catalogue & field dictionary, uploads, memory, guidance,
  WhatsApp door, embeds (`owlEmbed.js`, `fanOwl.js`), inbound ingestion
  (`owlIngest.js`)
- `actions.js` / `segments.js` / `surveys.js` / `campaignTemplates.js` — the
  Engage engine: audiences, email/SMS + journeys, approvals, promos,
  conversions, surveys
- `goals.js` / `forecast.js` — goals + forecast-led tracking
- `alerts.js` / `livepulse.js` / `staffAlerts.js` — watchers + event-day beats
- `posthog.js` / `appMatch.js` / `social.js` + `social*.js` — app analytics,
  audience↔buyer match, the app's feed/communities/chat
- `eventops.js` / `mapstudio.js` / `dataHealth.js` — ops logistics, event
  maps, stream monitoring
- `publicSurface.js` → `api.js` + `mcp.js` + `apiKeys.js` — the public surface
- `os.js` / `mailer.js` / `messaging.js` / `push.js` / `slack.js` — inbox +
  channels; `scheduler.js` / `digests.js` — scheduled digests
- `skills.js` — autonomous specialists; `tickets.js` / `github.js` — product
  board + GitHub bridge; `ops.js` / `backup.js` / `audit.js` — ops alerting,
  backups, audit trail; `flags.js` — the feature-flag registry + gates

## Key frontend (`client/src`, ~58k LOC)

- **Pages** — Login (+ magic link / vanity); ClientLayout (Suites→Sets→
  Dashboards shell); ClientHome (briefing + goals + needs-you); View / Editor /
  Clone (dashboards); EngagePage; GoalsPage; AlertsPage; SocialPage;
  EventOpsPage (+ portal); DigestsPage; InboxPage; Settlements / Documents;
  OwlEmbed / FanOwlEmbed; AdminPage (console with a left-rail nav: clients,
  flags, AI, integrations, product board, data health, backups…).
- **Notable components** — the Owl chat panel, `EditableGrid` + tile
  renderers, `CampaignManager`, `SegmentManager`, `MailTemplateEditor`
  (shared across platform/admin/client scopes), `DigestManager`,
  `SetupWizard`, `InboxNotifier`.

## Product surfaces today

1. **Dashboards** — build or import (with re-sync); KPIs, tables, charts;
   drill-through; per-tile ✨ reads; branded PDF export.
2. **The Owl** — in-app chat, WhatsApp, portal embed, Fan Owl on public sites.
3. **Client experience** — briefing-led home, goals, alerts, app analytics &
   community, digests, inbox, settlements, self-service settings & branding.
4. **Engage** — campaigns, journeys, surveys, promos, approvals, conversions.
5. **Event Ops** — logistics, live heatmaps, Map Studio, data health.
6. **Admin console** — clients, suites/sets, flags matrix, AI audit & usage,
   integrations, setup wizard, product board, backups, billing.
7. **Public API + MCP** — `/api/v1`, `/mcp`, client guide at `/api-guide`.

## Conventions worth knowing

- **Dual-surface rule** — every client-facing feature ships with **both** an
  admin management view *and* client self-service (`/api/my/...` enforces
  entity ownership; the admin equivalent is `/api/admin/entities/:id/...`).
  The same UI component usually serves both via a `scope` prop.
- **Every feature registers a flag** — in `server/flags.js` (registry + route
  gates + Owl tool map) in the same change; a feature that can't be switched
  per client isn't done.
- **Write-only secrets** — API responses report only whether a value is set +
  a mask, never the value itself. Non-secret branding can ride to the browser.
- **Disposable modules with line budgets** — self-contained features own their
  tables + routes and mount with one line; `test/architecture.test.js` caps
  file sizes and budgets only ratchet down.
- **Mobile-first** — design and test the narrow viewport first.
- **Git** — develop on the assigned `claude/*` branch and push to it **and** to
  `main` (Render deploys production from `main`); product-board tickets marked
  for staging PR against `staging` instead (`docs/STAGING.md`).
