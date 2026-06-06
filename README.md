# Howler — Analytics Studio

A custom analytics front-end for Howler that uses **Looker as a headless calculation engine**. Your LookML defines the metrics and joins; this app owns 100% of the interface. No Looker embeds, no iframe — every tile is rendered by our own React components.

You can:

- **Build dashboards from scratch** — pick a Looker model → explore → fields/measures, choose a visualization, drag & resize tiles on a 24-column grid.
- **Replicate any Looker dashboard** — import an existing Looker dashboard; it's converted into a fully editable definition owned by this app.
- **Clone inside Looker** — the original workflow that copies a dashboard into a new *Looker* dashboard (still available under `/clone`).
- **Drill into any value** — click a KPI, table cell, or chart point to see the underlying rows (parses Looker's drill links).
- **Serve multiple clients (multi-tenant)** — clients log in and see only their dashboards, with every query **scoped server-side** to their organiser name(s) and (optionally) specific events. Admins build dashboards and manage client accounts.

## Roles & multi-tenancy

- **Admin** (Howler internal): builds/imports/edits dashboards, manages clients & logins (`/admin`), assigns each dashboard to "all clients (shared)" or a specific client, and sees all data unscoped.
- **Client**: logs in, sees shared dashboards + any assigned to them, read-only, with data **forced** to their organiser/events. The scope filter is injected on the server before the query reaches Looker, so it can't be bypassed from the browser.

On first run an admin is seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (see `.env`). Because the app talks to Looker via a single API service account, scoping is enforced by this app (not Looker user attributes) — it fails closed if a client has no organiser configured.

Dashboards are stored as JSON in this app's own store (file-backed by default). Looker is only ever called to **run queries** and to **browse metadata** — it never renders UI.

## How it works

```
Browser (React)  ──run-query──▶  Express server  ──/queries/run──▶  Looker API
   custom tiles  ◀──json rows──   (looker.js)     ◀──calculated────   (your LookML)
```

1. A dashboard definition lists **tiles**, each with its own Looker **query** (model / explore / fields / filters / sorts) and **vis config**.
2. The browser asks the server to run each tile's query (`POST /api/run-query`). Looker computes; raw JSON rows come back.
3. React renders the rows as a KPI card, table, or chart — entirely under our control.

## Project structure

```
.
├── server/
│   ├── index.js      # Express app + route wiring
│   ├── looker.js     # Looker REST client: auth, query run, metadata, dashboard fetch
│   ├── store.js      # File-backed persistence for dashboard definitions
│   ├── convert.js    # Looker dashboard → editable definition (the "import" path)
│   └── recreate.js   # Clone a dashboard inside Looker (original feature)
├── client/
│   └── src/
│       ├── pages/         # HomePage, ViewPage, EditorPage, ClonePage
│       ├── components/     # EditableGrid, TileFrame, FilterBar, tiles/, editor/
│       └── lib/            # api.js, useTileData.js
├── .env.example
└── package.json
```

## Quick start

```bash
npm install            # server deps
cp .env.example .env   # fill in Looker credentials
npm run build          # installs + builds the React client into client/dist
npm start              # serves API + client on PORT (default 3000)
```

For development with hot reload:

```bash
npm run dev            # server (watch) + vite dev server on :5173 (proxies /api → :3000)
```

### Environment

```env
LOOKER_BASE_URL=https://your-company.looker.com
LOOKER_CLIENT_ID=your_client_id
LOOKER_CLIENT_SECRET=your_client_secret
PORT=3000
# DATA_DIR=/var/data/howler-dashboards   # optional: where dashboard JSON is stored
```

API credentials: **Looker Admin → Users → [user] → Edit API Keys** (a dedicated service account is recommended).

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/dashboards` | List saved dashboards |
| `POST` | `/api/dashboards` | Create a dashboard |
| `GET` | `/api/dashboards/:id` | Get a dashboard definition |
| `PUT` | `/api/dashboards/:id` | Update a dashboard |
| `DELETE` | `/api/dashboards/:id` | Delete a dashboard |
| `POST` | `/api/dashboards/import` | Import a Looker dashboard → editable definition |
| `GET` | `/api/looker/models` | List LookML models + explores |
| `GET` | `/api/looker/explores/:model/:explore` | List an explore's dimensions & measures |
| `POST` | `/api/run-query` | Run a Looker query (with filter overrides) → rows |
| `POST` | `/api/filter-suggest` | Filter value suggestions |
| `GET` | `/api/looker-dashboard/:id` | Preview a live Looker dashboard's metadata |
| `POST` | `/api/recreate` | Clone a dashboard inside Looker |

## Roadmap / next steps

- More visualization types and per-vis formatting controls (axes, colors, number formats)
- Authentication + per-client (multi-tenant) dashboard separation
- Swap the file store for a real database (interface in `store.js` is ready)
- Scheduled refresh / caching of query results
- Themeing controls in the editor (brand color, fonts, backgrounds)

## Looker API reference

- [Run query](https://developers.looker.com/api/explorer/4.0/methods/Query/run_inline_query)
- [LookML models](https://developers.looker.com/api/explorer/4.0/methods/LookmlModel)
- [Dashboard elements](https://developers.looker.com/api/explorer/4.0/methods/Dashboard/dashboard_dashboard_elements)
