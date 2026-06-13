# Howler : Pulse — Project Overview

> A shareable brief for collaborators and agents (e.g. Hermes). Pairs with
> `CLAUDE.md` (working conventions) and `README.md` (dashboard internals).

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
> segments, journeys, channels), `docs/specs/EVENT_TASKS_SPEC.md`.

---

## What it is today

A **multi-tenant, white-label analytics + client-engagement platform** for
Howler (events / ticketing). It uses **Looker purely as a headless calculation
engine** — Howler's LookML defines the metrics and joins, but Pulse owns 100% of
the interface (no Looker embeds or iframes). Beyond dashboards it already spans
AI insights, a messaging inbox, scheduled digests, settlements & documents, and
a data-driven campaign engine (email + SMS) with a full approval workflow.

## The stack

**Backend** — Node.js + Express (single instance)
- **Express 4** REST API (`server/index.js` wires everything together)
- **better-sqlite3** — SQLite on a persistent disk; relational tables for most
  data, file-backed JSON for dashboard *content*
- **Auth** — `jsonwebtoken` (JWT in an httpOnly cookie) + `bcryptjs`; a
  role/permission catalog in `roles.js`
- **Anthropic SDK** (`@anthropic-ai/sdk`) — AI insights & copy drafting
  (`claude-opus-4-8`)
- **web-push** — browser push notifications (VAPID)
- **node-fetch** — Looker REST 4.0 client + outbound calls (Resend email,
  Clickatell SMS)
- No ORM; hand-written SQL. Features are built as **disposable, self-contained
  modules** — each owns its tables + routes and mounts in one line, so the
  system can keep accreting capabilities without entangling.

**Frontend** — React 18 + Vite (SPA, served by the same Express server)
- **react-router-dom 6** routing; **react-grid-layout** for the 24-column
  drag/resize dashboard grid
- **ECharts** + **Chart.js** for visualizations
- Styling via **CSS variables + inline styles** (no CSS framework); dark mode and
  an Apple "Liquid Glass" treatment on chrome/overlays
- **PWA** — installable; a push-only service worker (caches nothing, always
  fresh)
- **Mobile-first** throughout (`useIsMobile()`), single-column collapse on phones

**Infra / deploy**
- **Render** (Blueprint in `render.yaml`) — Node web service, starter plan,
  **1 instance**, **1GB persistent disk** for SQLite (`DATA_DIR`)
- **Auto-deploys from `main`**; health check at `/health`
- Build: server `npm ci` + client Vite build; start: `node server/index.js`
- Secrets via env (Anthropic, Looker, `SESSION_SECRET`, admin seed, Resend /
  Clickatell) — most are also settable in-app under **Admin → Integrations**

## Architecture

```
Browser (React SPA) ──/api/run-query──▶ Express ──/queries/run──▶ Looker API
   custom tiles      ◀──── JSON rows ────  (looker.js)  ◀─ calculated ─ (LookML)
```

- Dashboards are JSON definitions of **tiles**, each with its own Looker query
  (model / explore / fields / filters / sorts) + vis config.
- **Multi-tenant, scoped server-side**: clients see only their dashboards, and
  every query is force-filtered to their organiser/events **on the server**
  before it reaches Looker — can't be bypassed from the browser, and it fails
  closed if a client has no scope configured.
- **Data source is pluggable (not Looker-only):** Looker is the calculation
  engine today, but Pulse will also integrate **directly into BigQuery (or other
  sources)**, bypassing Looker. New work should treat the data source as
  abstracted — the server-side per-client scope must hold whatever the source,
  and audiences/segments resolve through a source-agnostic resolver (see
  `docs/ENGAGEMENT_ENGINE.md`).

## Key server modules (`server/`, ~7.5k LOC)

- `looker.js` — Looker REST client (auth + token cache, query run, metadata,
  dashboard fetch)
- `convert.js` / `drill.js` — import a Looker dashboard into an editable
  definition; parse drill links into runnable queries
- `store.js` / `db.js` / `migrate.js` — SQLite data layer (+ one-time
  JSON→SQLite migration)
- `auth.js` / `roles.js` — JWT auth + the role/permission catalog
- `insights.js` — AI tile insights via Claude
- `actions.js` / `actionTemplates.js` — the **campaign / action engine**:
  audiences (dashboard tile or pasted list), **email and/or SMS**, drip
  sequences, promo codes, conversion tracking, UTM, and a full **approval
  workflow** (named / "Howler" approvers, inbox + push + email notifications)
- `mailer.js` (Resend) / `messaging.js` (Clickatell SMS) — send channels;
  write-only secrets, graceful no-op when unconfigured
- `os.js` — **"Experience OS" spine**: the messaging inbox (threads, read/ack
  receipts, attachments, programmatic announcements)
- `scheduler.js` — recurring / one-off scheduled digests
- `push.js` — web-push subscriptions + delivery

## Key frontend (`client/src`, ~13.5k LOC)

- **Pages** — Login; HomePage (dashboard admin); Editor / Clone / View
  (dashboards); AdminPage (console with a left-rail nav); ClientLayout (client
  shell with a Suites→Sets→Dashboards sidebar); ClientHome; Actions (campaigns);
  Inbox; Digests; Settlements; Documents; Integrations.
- **Notable components** — `CampaignManager` (the campaign editor),
  `InboxNotifier` (app-wide toast + push nudge), `MailTemplateEditor`,
  `IntegrationsForm`, `EditableGrid`, tile renderers.

## Product surfaces today

1. **Dashboards** — build from scratch or import from Looker; KPIs, tables,
   charts; drill-through; per-tile AI insights.
2. **Admin console** (`/admin`) — clients, dashboard sets/suites, tile library,
   AI instructions, integrations, settlements, backups, admin logins.
3. **Client experience** — scoped dashboards, inbox, digests,
   settlements/documents, self-service settings & branding.
4. **Action / campaign engine** — data-driven email/SMS campaigns: audience
   targeting, drip sequences, promos, conversion tracking, and approvals.
5. **Messaging inbox** — client ↔ Howler threads with read/unread, delete, swipe
   actions, live refresh, and push/email notifications.

## Conventions worth knowing

- **Dual-surface rule** — every client-facing feature ships with **both** an
  admin management view *and* client self-service (`/api/my/...` enforces entity
  ownership; the admin equivalent is `/api/admin/entities/:id/...`). The same UI
  component usually serves both via a `scope` prop.
- **Write-only secrets** — API responses report only whether a value is set + a
  mask, never the value itself. Non-secret branding can ride to the browser.
- **Disposable modules** — self-contained features own their tables + routes and
  mount with one line; easy to add, easy to remove.
- **Mobile-first** — design and test the narrow viewport first.
- **Git** — develop on the assigned `claude/*` branch and push to it **and** to
  `main` (Render deploys from `main`).
