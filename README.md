# Howler : Pulse — the Experience OS

Pulse is Howler's **Experience OS** for clients and internal teams — a
data-driven system that turns data into **insight → action → results**, and
makes the work measurably more efficient. It started as a custom analytics
front-end (Looker as a headless calculation engine, 100% of the UI ours — no
embeds) and has grown into a multi-tenant platform spanning dashboards, the
**Owl** (an agentic AI analyst that lives in the app, on WhatsApp and on
promoters' websites), goals & forecasts, alerts & live event-day updates, app
analytics + a social layer for the Howler super app, an email/SMS engagement
engine with surveys, digests, a messaging inbox, settlements/documents, Event
Ops & Map Studio, and a public read API + MCP server.

> **Orientation for collaborators & agents:** read `PROJECT_OVERVIEW.md` (stack +
> current state) and the North-Star brief **`docs/EXPERIENCE_OS_BRIEF.md`**.
> `CLAUDE.md` holds the working conventions (mobile-first, dual-surface, the
> scope boundary). Judge new work by whether it advances the
> **insight → action → results → efficiency** loop.

---

## What's in it today

- **Dashboards, fully owned by us.** Build from scratch (Looker model → explore →
  fields → vis, drag/resize on a 24-col grid) or **import** a Looker dashboard
  into an editable definition — with **re-sync from Looker** that preserves Pulse
  edits. Looker only ever **runs queries** / serves metadata — it never renders
  UI. Drill into any value to see underlying rows, inspect any tile's query,
  export a branded PDF.
- **The Owl — the native AI analyst.** An agentic chat that answers questions of
  the client's own data: text-to-query (**askData**) over a curated, no-code
  field catalogue, plus tools for dashboards, goals, campaigns, alerts, app
  analytics, event ops, data health and attached CSVs / live Google Sheets.
  Auto-charts (with table view + CSV/PNG/PDF export), citation chips showing the
  underlying rows, saved chats & folders, pin any answer to Home or a dashboard
  as a live tile, voice dictation, share via email/WhatsApp/Slack. Rolling out
  behind an owner-managed allowlist.
- **AI insights & briefings.** The ✨ read on any tile, whole-dashboard and
  page summaries, and a personalised **home briefing** — all grounded in
  computed facts (the AI only phrases them; deep links validated server-side).
  Uses Claude (`claude-opus-4-8`, lighter tasks on Sonnet); per-client API key
  with a Howler fallback; every prompt auditable in Admin → AI, token usage
  metered.
- **The Owl beyond the app.** A **WhatsApp door** (Clickatell) with
  provenance-logged answers and scheduled WhatsApp editions; an embeddable Owl
  for organiser portals (`docs/OWL_EMBED.md`); and **Fan Owl** — a fan-facing
  booking guide widget on a promoter's public website (per-site personality,
  languages, quick-nav into the site, catalogue drafted from a ticket-site
  crawl).
- **Engage — the Action layer.** Reusable **Segments** (live, source-agnostic
  audiences; "create segment from a tile", one-tap app-audience and
  CTA-clicker segments), **Campaigns** (email / SMS / both, one-off or drip
  **journeys** with simulations, approvals, promo codes, per-channel reach &
  **consent**, conversions/reporting), **fan surveys** (in-app via the Howler
  app contract, plus email & hosted web pages; results by day / ticket type /
  channel), recipes ("Make it happen"), campaign templates, and an AI email
  designer + banner generator.
- **Goals & forecasts.** Per-event goals with forecast-led tracking (on-pace /
  behind bands), goal-aware briefings, digests and Owl answers.
- **Alerts & Live Pulse.** Threshold alerts on any metric (including custom
  metrics) delivered to inbox / email / SMS / push / Slack; **Live Pulse**
  recurring event-day multi-metric updates; staff alerts for the ops crew.
- **App analytics & the social layer.** Direct PostHog integration for the
  Howler super app: checkout funnel, in-app revenue, time-in-app, breakdowns,
  device/OS splits, **app-audience ↔ ticket-holder match**, super fans, and a
  warehouse bridge feeding Howler orders back into PostHog. Plus Pulse's own
  social layer for the app — feed, communities, event chat (live via SSE),
  Instagram/TikTok import, post CTAs with click tracking, media on R2.
- **Event Ops & Map Studio.** An ops-only surface for device/station logistics
  with live heatmaps; **Map Studio** — self-service event maps (3D terrain,
  anchored pins, publish lock) published straight into the Howler app's map
  WebView; a **data health** monitor watching the BigQuery→Looker stream.
- **Digests.** Scheduled, role-lensed briefings by email, **SMS** and
  **WhatsApp**; AI-led or curated tiles, per-recipient personalisation.
- **Inbox & settlements.** "CC the Owl" client↔Howler messaging (inbound
  attachments AI-ingested), Slack mirroring, push notifications; settlement
  reports and document viewing.
- **Open platform — API & MCP.** A read-only REST API (`/api/v1`) and a remote
  **MCP server** (`/mcp`) so clients can plug Pulse into Claude, ChatGPT or
  their own tools: per-client keys (off by default), `read` vs `read_rows`
  scopes, rate limits, full audit; client-facing guide served at `/api-guide`
  (`docs/PUBLIC_API.md`).
- **Skills & self-running ops.** Autonomous specialist **skills** (advise-only,
  scheduled — e.g. the Chief of Operations event-day debrief); an ops-alert
  **triage agent** that turns alerts into product-board tickets and
  auto-dispatches high-confidence bugs to Claude (plan-first, staging-only);
  an in-app **report widget** with screen recording and AI-drafted tickets the
  reporter reviews before submitting.
- **Platform hardening.** 2FA, magic-link and white-labelled `/<slug>` logins,
  per-client sending domains, per-client currency / language / reporting
  timezone, POPIA/GDPR export & deletion tooling, staging + CI-gated deploys,
  Litestream SQLite replication to R2 with off-box backups, structured logs +
  request ids, uptime probes.
- **Installable PWA, mobile-first throughout.** Stale-while-revalidate query
  cache tuned to the ~30-min data pipeline, route-level code-splitting,
  background pre-warm of the briefing + top dashboards, silent auto-refresh.

## Roles, multi-tenancy & the scope boundary

- **Admin** (Howler internal): builds/imports dashboards, manages clients
  (entities), suites (events), sets, logins & roles; can preview any client.
- **Client**: logs in and sees only their suites/dashboards, with every query
  **forced to their organiser/event scope server-side** before it reaches Looker
  — it can't be bypassed from the browser. **Fails closed** if a client has no
  organiser configured (mark an internal/management client *"all organisers"* to
  opt out deliberately). The same scope gate fronts the Owl, the public API and
  MCP.
- **Dual-surface rule:** every client-facing feature ships with both admin
  management (Admin → client) and client self-service (`/api/my/...`, entity-scoped).

The app talks to Looker via a single service account, so scoping is enforced by
Pulse (not Looker user attributes).

## How it works

```
Browser (React)  ──run-query──▶  Express server  ──/queries/run──▶  Looker API
  custom tiles   ◀──json rows──   (looker.js)     ◀──calculated────   (your LookML)
                                  + scope forced server-side (org/event)
```

A dashboard lists **tiles**, each with its own Looker query + vis config. The
browser asks the server to run each tile's query (`POST /api/run-query`); the
server injects the client's scope, runs it through a cache, and returns raw rows
that React renders as KPI / table / chart tiles.

## Project structure

The server is ~100 small, disposable modules that each mount in one line from
the composition root — `test/architecture.test.js` enforces a per-file line
budget so nothing grows into a god-file (see `CLAUDE.md`). Highlights:

```
server/
  index.js        # composition root — wiring + a thin route layer
  auth.js         # users, sessions, roles/permissions, scopeForQuery (the boundary)
  db.js           # SQLite (better-sqlite3): entities, suites, sets, dashboards, users…
  looker.js       # Looker REST client: auth, query run, metadata
  query.js        # shared query pipeline: cache, scope, concurrency
  insights.js     # every hardcoded Claude prompt + promptRegistry() (the AI audit)
  owl*.js         # the Owl: chat loop, tools, catalogue, embeds, WhatsApp, memory…
  actions.js / segments.js / surveys.js       # Engage: campaigns, journeys, surveys
  goals.js / forecast.js                      # goals + forecast-led tracking
  alerts.js / livepulse.js / staffAlerts.js   # alerts + event-day updates
  posthog.js / appMatch.js / social*.js       # app analytics + the social layer
  eventops.js / mapstudio.js / dataHealth.js  # Event Ops, Map Studio, data health
  publicSurface.js → api.js + mcp.js          # public REST /api/v1 + MCP /mcp
  scheduler.js / digests.js                   # scheduled digests (email/SMS/WhatsApp)
  mailer.js / messaging.js                    # email (Resend) + SMS/WhatsApp (Clickatell)
  os.js           # inbox / "CC the Owl" messaging
  tickets.js / github.js / ops.js             # product board, GitHub bridge, ops alerting
client/src/
  pages/          # ViewPage, EditorPage, ClientHome, EngagePage, GoalsPage,
                  #   AlertsPage, SocialPage, EventOpsPage, DigestsPage, InboxPage,
                  #   SettlementsPage, AdminPage, OwlEmbedPage, FanOwlEmbedPage…
  components/     # EditableGrid, TileFrame, FilterBar, CampaignManager,
                  #   SegmentManager, DigestManager, OwlChat, tiles/, editor/…
  lib/            # api.js, useTileData.js, ScopeContext, auth, profile…
docs/             # EXPERIENCE_OS_BRIEF, ENGAGEMENT_ENGINE, PUBLIC_API,
                  #   GOALS_MERGED, SKILLS_BRIEF, ROADMAP, STAGING, specs/…
```

## Quick start

```bash
npm install            # server deps
cp .env.example .env   # fill in Looker creds + admin seed
npm run build          # installs + builds the React client into client/dist
npm start              # serves API + client on PORT (default 3045)
```

Development with hot reload:

```bash
npm run dev            # server (watch) + vite dev server on :5173 (proxies /api → :3045)
```

### Environment (core — see `.env.example` for the full set)

```env
LOOKER_BASE_URL=https://your-company.looker.com
LOOKER_CLIENT_ID=your_client_id
LOOKER_CLIENT_SECRET=your_client_secret
ADMIN_EMAIL=you@howler.co.za        # seeds the first admin on boot
ADMIN_PASSWORD=change-me
ANTHROPIC_API_KEY=                  # enables AI insights/briefings/Owl (per-client key overrides)
PORT=3045
DATA_DIR=/var/lib/pulse             # SQLite db lives here — use a persistent disk
# QUERY_CACHE_TTL=60  QUERY_CACHE_STALE=600   # query cache windows (seconds)
```

Most integrations (Looker / Anthropic / Resend / Clickatell / PostHog / Meta /
Slack / Google Drive…) can also be set per-client or platform-wide in
**Admin → Integrations** (write-only/masked), overriding env.

## Docs

| Doc | What |
|---|---|
| `PROJECT_OVERVIEW.md` | Stack + current state (start here) |
| `docs/EXPERIENCE_OS_BRIEF.md` | North Star: Playbook · Spine · Owl, build order, data model |
| `docs/PUBLIC_API.md` | The public read API (`/api/v1`) + MCP server (`/mcp`); client twin at `/api-guide` |
| `docs/ENGAGEMENT_ENGINE.md` | The Action layer: segments, journeys, channels, consent |
| `docs/GOALS_MERGED.md` | The Results pillar: goals model (canonical, build-ready) |
| `docs/SKILLS_BRIEF.md` | Skills & agents — the autonomous layer |
| `docs/PRODUCT_OVERVIEW_SALES.md` | Sales/AM-facing feature guide (kept current per `CLAUDE.md`) |
| `docs/STAGING.md` | The staging service + staging-first rollout |
| `docs/ROADMAP.md` | Backlog |
| `CLAUDE.md` | Working conventions (mobile-first, dual-surface, git) |

## Deploy

Hosted on Render; **CI-gated** deploys from `main`, with a separate staging
service for staging-first rollouts (`docs/STAGING.md`). Data persists in
`DATA_DIR` (SQLite) on a Render disk, continuously replicated off-box to R2 via
Litestream, with scheduled off-box backups on top.
