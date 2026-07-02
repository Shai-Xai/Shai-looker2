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
| `GET /api/v1/data-sources` | The curated data sources this client can query directly (measures, dimensions, filter-only fields) |
| `POST /api/v1/query` | Direct aggregate query — `{source?, measure, measures?, dimensions?, filters?, dateRange?, suiteId?, limit?}` — no dashboard/tile needed |
| `GET /api/v1/tiles/rows?dashboardId=&tileId=&suiteId=&limit=` | **`read_rows` scope only** — the table behind a tile: every column (incl. display-hidden ones) + rows (default 500, cap 10,000) |
| `GET /api/v1/event-ops?suiteId=&query=` | **`read_rows` scope only** — per-event ops: `overview` \| `locate` (`&code=`) \| `devices` \| `issues` \| `staff` \| `stations` \| `checkpoints`; honours the per-client Event Ops switch |
| `POST /api/v1/segments` | **`write` scope only** — create a saved segment from a curated cohort `{name?, filters, suiteId?, folder?}`; PII fields can never define a cohort |
| `POST /api/v1/campaigns/draft` | **`write` scope only** — draft a campaign `{goal, channel?, segmentName? \| filters?, name?, ctaUrl?, language?, suiteId?}`; Pulse's AI writes the content; **always lands status `draft`** for human approval in Engage — this surface cannot send |

Errors are JSON `{ error }` with meaningful status codes (401 bad/missing key,
403 missing scope, 404 not visible to this client, 429 rate-limited). Anything
another client owns is a **404**, not a 403 — existence is not disclosed.

## MCP server (`/mcp`)
Remote MCP over streamable HTTP (stateless), same Bearer key.

**Connecting Claude (or any OAuth-capable MCP client):** add a custom connector
with the URL `https://<pulse-host>/mcp`, leave Client ID/Secret blank, and
click Connect. Pulse implements the standard MCP auth flow (`server/oauth.js`:
RFC 9728 + 8414 discovery, RFC 7591 dynamic client registration, PKCE S256) —
the user approves on a Pulse page (logged-in cookie session, picks the client +
row-level opt-in) and the token handed back **is a normal per-entity API key**,
visible and revocable on the key card like any other.

Clients that support static headers can skip OAuth entirely and send
`Authorization: Bearer pulse_sk_…` directly.

**OpenAI / ChatGPT:** the same `/mcp` server works with OpenAI. The Responses
API's built-in MCP tool takes `server_url` + a Bearer `headers` entry. ChatGPT
custom connectors additionally require the MCP server to expose `search` and
`fetch` tools — Pulse does (server/mcp.js, OpenAI's structuredContent schema:
`search(query)`→`{results:[{id,title,url}]}`, `fetch(id)`→`{id,title,text,url,
metadata}`), so Pulse works as a ChatGPT connector and for Deep Research. Those
two tools are aggregate-only (never row-level) and available to any `read` key.

Tools (all read-only): `pulse_get_me` · `pulse_list_dashboards` ·
`pulse_get_dashboard` · `pulse_get_metric` · `pulse_list_data_sources` ·
`pulse_query_data` · `pulse_list_segments` · `pulse_get_segment_reach` ·
`pulse_list_campaigns` · `pulse_get_campaign_report` · `pulse_get_goals` ·
`search` · `fetch` (the OpenAI-compatible pair) · `pulse_get_tile_rows` ·
`pulse_event_ops` (`read_rows` keys only) · `pulse_create_segment` ·
`pulse_draft_campaign` (`write` keys only — drafts land behind the approval
flow; the MCP surface cannot send). Scope-gated tools are invisible to keys
without the scope. Connect-time instructions carry the Owl persona, the
client's stored AI context (same grounding as in-app), and — for write keys —
confirm-in-chat-first guidance.

**Direct queries (no dashboard needed):** `pulse_query_data` / `POST
/api/v1/query` run bounded aggregate queries straight against the curated data
catalogue — the SAME engine the in-app Owl uses (`server/owlTools.js`):
admin-ticked fields only (Admin → Owl data catalogue, incl. per-client on/off
for extra explores), PII fields are filter-only lookups (never groupable or
listable), and the organiser scope is forced fail-closed on every query. This
is deliberately NOT raw Looker API access — the catalogue is the boundary.

Start with `pulse_get_me` (suite ids), then `pulse_list_dashboards` →
`pulse_get_dashboard` → `pulse_get_metric` for live numbers.

## Performance
- **Two speeds of endpoint.** Catalogue/list reads (dashboards, segments,
  campaigns, goals-without-progress, `me`, `search`) are served from SQLite —
  effectively instant. Live reads hit Looker: `metric`, `segment reach`,
  `tiles/rows`, `goals?progress=1`, and a `fetch` of a dashboard.
- **Live reads are cached** ~5 min fresh + 30 min stale-while-revalidate, with
  in-flight de-duplication, so repeat/parallel questions are fast; only a cold
  metric pays full Looker latency. Tune with `QUERY_CACHE_TTL` (seconds).
- **A dashboard `fetch`** resolves its tiles' values concurrently (capped), not
  serially — but for a single number, `metric` (one query) is always cheaper.
- **MCP guidance:** the server sends top-level instructions + per-tool latency
  hints so the agent picks the cheap path and avoids redundant calls. If you
  wrap the tools yourself, keep those hints.

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
