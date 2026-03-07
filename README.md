# Howler — Looker Dashboard Recreator

A lightweight Node.js tool that connects to Looker via the REST API, fetches an existing dashboard (tiles + filters), and recreates it programmatically. Built for Howler's event management workflow — spin up a fresh analytics dashboard per event in seconds.

## Features

- OAuth2 client credentials auth with automatic token refresh on 401
- Fetches dashboard shell, all tiles (look-backed, inline-query, and text), and all filters
- Recreates everything via `POST` — no LookML dependency
- Remaps filter→tile links to the new element IDs automatically
- Returns a summary: _X tiles created, Y failed_ with per-item error messages
- Simple, zero-framework UI with a live "Preview" before committing

## Project Structure

```
.
├── client/
│   └── index.html       # Single-page UI
├── server/
│   └── index.js         # Express API + Looker auth/fetch/recreate logic
├── .env.example         # Required environment variables
├── package.json
└── README.md
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
LOOKER_BASE_URL=https://your-company.looker.com
LOOKER_CLIENT_ID=your_client_id_here
LOOKER_CLIENT_SECRET=your_client_secret_here
PORT=3000
```

To obtain API credentials in Looker: **Admin → Users → [your user] → Edit API Keys** (or ask your Looker admin to create a dedicated service account).

### 3. Run

```bash
# Production
npm start

# Development (auto-restarts on file changes, requires Node 18+)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Source Dashboard ID** — paste the numeric ID from the Looker URL (e.g. `/dashboards/42` → `42`). Hit **Preview** to confirm it exists and see the tile/filter count.
2. **New Dashboard Title** — the name for the recreated copy (e.g. `Howler — Glastonbury 2025`).
3. **Target Folder ID** — the Looker folder where the new dashboard will be saved. Find the ID in Looker under **Folders → [folder name]** in the URL.
4. Click **Recreate Dashboard**. A link to the new dashboard in Looker is returned on success.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/dashboard/:id` | Fetch dashboard metadata (title, tile count, filter count) |
| `POST` | `/api/recreate` | Recreate a dashboard |

### `POST /api/recreate`

**Request body:**

```json
{
  "sourceDashboardId": "42",
  "newTitle": "Howler — Glastonbury 2025",
  "targetFolderId": "7"
}
```

**Response:**

```json
{
  "dashboardId": "99",
  "dashboardUrl": "https://your-company.looker.com/dashboards/99",
  "tilesCreated": 8,
  "tilesFailed": 1,
  "filtersCreated": 3,
  "filtersFailed": 0,
  "errors": [
    "Tile \"Revenue by Channel\" failed: ..."
  ]
}
```

## Error Handling

- Partial failures are non-fatal — the new dashboard is still created with all tiles/filters that succeeded.
- Each failure includes the tile or filter name and the Looker API error message.
- Auth errors (401) trigger an automatic token refresh and a single retry.

## Looker API Reference

- [Dashboard object](https://developers.looker.com/api/explorer/4.0/methods/Dashboard/dashboard)
- [Dashboard elements](https://developers.looker.com/api/explorer/4.0/methods/Dashboard/dashboard_dashboard_elements)
- [Dashboard filters](https://developers.looker.com/api/explorer/4.0/methods/Dashboard/dashboard_dashboard_filters)
- [Create dashboard](https://developers.looker.com/api/explorer/4.0/methods/Dashboard/create_dashboard)
