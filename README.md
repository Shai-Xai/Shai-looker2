# Howler : Pulse — the Experience OS

Pulse is Howler's **Experience OS** for clients and internal teams — a
data-driven system that turns data into **insight → action → results**, and
makes the work measurably more efficient. It started as a custom analytics
front-end (Looker as a headless calculation engine, 100% of the UI ours — no
embeds) and has grown into a multi-tenant platform spanning dashboards, AI
reads, briefings, a messaging inbox, digests, settlements/documents, and an
email/SMS engagement engine.

> **Orientation for collaborators & agents:** read `PROJECT_OVERVIEW.md` (stack +
> current state) and the North-Star brief **`docs/EXPERIENCE_OS_BRIEF.md`**.
> `CLAUDE.md` holds the working conventions (mobile-first, dual-surface, the
> scope boundary). Judge new work by whether it advances the
> **insight → action → results → efficiency** loop.

---

## What's in it today

- **Dashboards, fully owned by us.** Build from scratch (Looker model → explore →
  fields → vis, drag/resize on a 24-col grid) or **import** a Looker dashboard
  into an editable definition. Looker only ever **runs queries** / serves
  metadata — it never renders UI. Drill into any value to see underlying rows.
- **AI insights & the Owl.** A ✨ read on any tile, a whole-dashboard summary,
  and a personalised **home briefing** — all grounded in computed facts (the AI
  only phrases them; deep links validated server-side). Uses Claude
  (`claude-opus-4-8`); per-client API key with a Howler fallback.
- **Engage — the Action layer.** Reusable **Segments** (live, source-agnostic
  audiences; "create segment from a tile"), **Campaigns** (email / SMS / both,
  one-off or drip **journeys**, approvals, promo codes, per-channel reach &
  **consent**, conversions/reporting), recipes ("Make it happen"), and reserved
  areas (Automations · Templates · Connections).
- **Digests.** Scheduled, role-lensed briefing emails (and **SMS**), AI-led or
  curated tiles, per-recipient personalisation.
- **Inbox & settlements.** "CC the Owl" client↔Howler messaging; settlement
  reports and document viewing.
- **Inventive (AI analyst).** Embedded per-client conversational analyst — one
  Inventive workspace per Pulse client (the **/ask** surface).
- **Performance.** Stale-while-revalidate query cache tuned to the ~30-min data
  pipeline, a manual **Refresh**, background **pre-warm** of the briefing + top
  dashboards on login, and silent auto-refresh on tab focus / interval.
- **Installable PWA**, mobile-first throughout.

## Roles, multi-tenancy & the scope boundary

- **Admin** (Howler internal): builds/imports dashboards, manages clients
  (entities), suites (events), sets, logins & roles; can preview any client.
- **Client**: logs in and sees only their suites/dashboards, with every query
  **forced to their organiser/event scope server-side** before it reaches Looker
  — it can't be bypassed from the browser. **Fails closed** if a client has no
  organiser configured (mark an internal/management client *"all organisers"* to
  opt out deliberately).
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

```
server/
  index.js        # Express app + most routes, scope enforcement, AI, caching, prewarm
  auth.js         # users, sessions, roles/permissions, scopeForQuery (the boundary)
  db.js           # SQLite (better-sqlite3): entities, suites, sets, dashboards, users…
  looker.js       # Looker REST client: auth, query run, metadata
  store.js        # dashboard-definition accessor over db
  actions.js      # Engage: campaigns, segments audience resolver, journeys, conversions
  segments.js     # Segments module (live, source-agnostic audiences)
  scheduler.js    # Scheduled digests (email + SMS), timezone-aware
  insights.js     # Claude prompts: tile/dashboard insights, briefing, digest, refine
  mailer.js / messaging.js   # email (Resend) + SMS (Clickatell) channel adapters
  os.js           # inbox / "CC the Owl" messaging
client/src/
  pages/          # ViewPage, EditorPage, ClientHome, EngagePage, DigestsPage,
                  #   InboxPage, SettlementsPage, AdminPage, InventiveAskPage…
  components/     # EditableGrid, TileFrame, FilterBar, CampaignManager,
                  #   SegmentManager, DigestManager, tiles/, editor/…
  lib/            # api.js, useTileData.js, ScopeContext, auth, profile…
docs/             # EXPERIENCE_OS_BRIEF, ENGAGEMENT_ENGINE, GOALS_MERGED,
                  #   API_MCP_BRIEF, ROADMAP, TEAM_OVERVIEW, specs/…
```

## Quick start

```bash
npm install            # server deps
cp .env.example .env   # fill in Looker creds + admin seed
npm run build          # installs + builds the React client into client/dist
npm start              # serves API + client on PORT (default 3000)
```

Development with hot reload:

```bash
npm run dev            # server (watch) + vite dev server on :5173 (proxies /api → :3000)
```

### Environment (core — see `.env.example` for the full set)

```env
LOOKER_BASE_URL=https://your-company.looker.com
LOOKER_CLIENT_ID=your_client_id
LOOKER_CLIENT_SECRET=your_client_secret
ADMIN_EMAIL=you@howler.co.za        # seeds the first admin on boot
ADMIN_PASSWORD=change-me
ANTHROPIC_API_KEY=                  # enables AI insights/briefings (per-client key overrides)
PORT=3000
DATA_DIR=/var/data/howler           # SQLite db (howler.db) lives here
# QUERY_CACHE_TTL=300  QUERY_CACHE_STALE=1800   # query cache windows (seconds)
# INVENTIVE_API_KEY=  INVENTIVE_EMBED_AUTH_TOKEN=   # Inventive embed (or set in Admin → Integrations)
```

Most integrations (Looker/Anthropic/Resend/Inventive) can also be set per-client
or platform-wide in **Admin → Integrations** (write-only/masked), overriding env.

## Docs

| Doc | What |
|---|---|
| `PROJECT_OVERVIEW.md` | Stack + current state (start here) |
| `docs/EXPERIENCE_OS_BRIEF.md` | North Star: Playbook · Spine · Owl, build order, data model |
| `docs/ENGAGEMENT_ENGINE.md` | The Action layer: segments, journeys, channels, consent |
| `docs/GOALS_MERGED.md` | The Results pillar: goals model (canonical, build-ready) |
| `docs/API_MCP_BRIEF.md` | Opening Pulse up: GraphQL API + MCP (for review) |
| `docs/ROADMAP.md` | Backlog |
| `CLAUDE.md` | Working conventions (mobile-first, dual-surface, git) |

## Deploy

Hosted on Render; deploys from `main`. Data persists in `DATA_DIR` (SQLite) — keep
it on a Render disk so it survives restarts.
