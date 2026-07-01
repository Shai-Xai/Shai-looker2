# PUBLIC_API.md — the Pulse read API & MCP server

How to read a client's Pulse data from outside the app: a REST API (`/api/v1`)
and a remote MCP server (`/mcp`) for AI agents. Both are thin adapters over the
same scope-enforced service core the app uses (`docs/API_MCP_BRIEF.md`). v1 is
**read-only**; writes arrive in P3 behind the existing approval/consent gates.

> **Shareable version:** this guide's client-facing twin is served live at
> `https://<pulse-host>/api-guide` (rendered from `docs/CLIENT_API_GUIDE.md`) —
> that's the link to hand to clients and their developers.

## Auth — per-client API keys
- **API access is OFF by default per client.** Howler switches it on in
  Admin → client → Integrations (the toggle on the API access card). Flipping
  it off instantly cuts every key that client has, across REST and MCP.
- Get a key in **Settings → Integrations → API access** (client self-service) or
  **Admin → client → Integrations** (Howler). The secret (`pulse_sk_…`) is shown
  **once**; after that only a masked hint is visible. Revoke any time.
- A key is pinned to **one client** and cannot see any other client's data.
- Scopes: every key carries `read` (aggregate reads — catalogue, KPI numbers,
  counts, results). **`read_rows`** is an explicit opt-in at creation time and
  unlocks row-level reads — the table behind a tile, e.g. customer/ticketing
  records, which may include personal data. Grant it only to tools that
  genuinely need rows; it never rides along with plain `read`.
- Send the key on every request:

```
Authorization: Bearer pulse_sk_…
```

Rate limits: 120 req/min per key (20/min for live resolves — metric, reach,
goal progress; 60/min on MCP). Every call is audited (who/what/when/outcome).

## REST endpoints (`/api/v1`)

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/me` | The key's client, scopes, and the client's events (suites) |
| `GET /api/v1/dashboards` | Dashboard catalogue — one entry per (dashboard, event), with `suiteId` |
| `GET /api/v1/dashboards/:id` | One dashboard's tiles (`id`, `title`, `type`) + filters + events |
| `GET /api/v1/metric?dashboardId=&tileId=&suiteId=` | The live number that KPI tile shows, `{ value, asOf }` |
| `GET /api/v1/segments` | Saved segments with cached size + per-channel reach |
| `GET /api/v1/segments/:id` | One segment |
| `GET /api/v1/segments/:id/reach` | Live re-resolve: current size + consent-aware reach |
| `GET /api/v1/campaigns?status=` | Campaigns with results counters (sent, clicks, opens, CTR) |
| `GET /api/v1/campaigns/:id` | One campaign's results (never the audience list) |
| `GET /api/v1/goals?suiteId=&progress=1` | Goals for one event; `progress=1` resolves live progress |
| `GET /api/v1/tiles/rows?dashboardId=&tileId=&suiteId=&limit=` | **`read_rows` scope only** — the table behind a tile: every column (incl. display-hidden ones) + rows (default 500, cap 10,000) |

Errors are JSON `{ error }` with meaningful status codes (401 bad/missing key,
403 missing scope, 404 not visible to this client, 429 rate-limited). Anything
another client owns is a **404**, not a 403 — existence is not disclosed.

## MCP server (`/mcp`)
Remote MCP over streamable HTTP (stateless), same Bearer key. Point any
MCP-capable agent platform at `https://<pulse-host>/mcp` with the header above
— e.g. in Claude, add a custom connector with that URL and the key.

Tools (all read-only): `pulse_get_me` · `pulse_list_dashboards` ·
`pulse_get_dashboard` · `pulse_get_metric` · `pulse_list_segments` ·
`pulse_get_segment_reach` · `pulse_list_campaigns` ·
`pulse_get_campaign_report` · `pulse_get_goals` · `pulse_get_tile_rows`
(the last one only appears for keys with the `read_rows` scope — an agent on a
plain read key is never even offered it).

Start with `pulse_get_me` (suite ids), then `pulse_list_dashboards` →
`pulse_get_dashboard` → `pulse_get_metric` for live numbers.

## Guarantees
- **One security boundary:** the key's synthetic principal rides the app's own
  scope gates (organiser locks, suite access, entity ownership). Fail closed.
- **Secrets are write-only** — shown once, stored hashed, reported masked.
- **Everything audited**, per key.
- **No send without a human** — and v1 has no send surface at all.

## For developers (repo map)
`server/apiKeys.js` (keys + audit + bearer auth) · `server/api.js` (REST + the
shared `core`) · `server/mcp.js` (MCP tools over `core`) ·
`client/src/components/ApiKeysCard.jsx` (dual-surface key management UI) ·
`test/apikeys.test.js` (route-level boundary tests).
