# Report Studio — custom client reports (V1)

**Status:** V1 shipped to staging 2026-07-17. Owner: Pulse team.
**Where:** client + admin UI at `/reports` · public viewer at `/r/:token` ·
server module `server/reports.js` (+ `server/reportPdf.js`).

## What it is

A block-based report builder: compose a report from dashboard **tiles** (KPI /
chart / table), **sections** (headings), **text**, **images**, **links/buttons**
and **AI analysis** blocks (per-section or whole-report), then deliver it as a
**share link** (logged-out, client-branded web viewer), **PDF download**, and
**email** — one-off ("Generate now") or **recurring** (daily / weekly / monthly
schedule, timezone-aware). Built for Howler clients and, via the share link,
their stakeholders (sponsors, partners, execs) who have no Pulse login.

Dual-surface (CLAUDE.md rule): Howler staff manage any client's reports in
Admin → client → Reports; clients self-serve at `/reports` (permission
`reports.manage`).

## Model: template → snapshots

- A **report template** = ordered author blocks + schedule + recipients.
- **Generating** resolves the template against live data into an immutable
  **snapshot** (frozen numbers, chart PNGs, AI text) with its own share token.
  Recurring schedules just generate + send a new snapshot each run.
- Viewers/PDF/email all render the *snapshot*, so a stakeholder opening a
  3-week-old link sees what was reported, not drifted numbers.

## Author blocks (stored on the template)

| type | fields | resolves to |
|---|---|---|
| `heading` | text, level | section header (also delimits AI "section" scope) |
| `text` | text | paragraph(s), `**bold**` / `*italic*` |
| `image` | url (data URL), alt | hosted image |
| `button` | text, href | link button |
| `divider` | — | rule |
| `tile` | dashboardId, tileId, display auto/chart/value/table | `chart` (PNG via tileimg) · `kpi` chip · `table` rows |
| `campaign` | campaignId | sub-heading + KPI chips (audience, sent, opens, clicks, click-rate, conversions) from the Engage campaign's results |
| `app` | appView summary/trend/events, days 7/14/28/90 | native-app engagement (PostHog rollup, appanalytics-flag-gated): KPI chips · daily trend chart · per-event table |
| `goals` | — | table of the client's event goals with live progress (current, target, %, pace) — goals-flag-gated |
| `social` | socialView accounts/trend/posts, socialMetric, days | organic social (social-flag-gated): accounts table · daily metric trend chart · top-posts table |
| `live` | suiteId | the newest Live Pulse update sent for that event, verbatim (livepulse-flag-gated) |
| `ai` | scope section/report, focus | analyst paragraphs over the data blocks in scope (tiles + campaigns + app + goals + social + live) |

Tile data resolves through `buildFactsFromTiles` (briefing.js) — the same
scope-enforced query path as dashboards/digests, so a report can never leak
outside the client's entity scope. Chart PNGs render via `tileimg.renderTilePng`
and are stored in the module's own `report_assets` table (no 60-day prune,
unlike mail_assets) served at `GET /report-assets/:token`.

AI blocks call `insights.reportAnalysis` (prompt `REPORT_SYSTEM`, registered in
`promptRegistry()`; metered via `aiUsage` kind `report`). "Section" scope = tile
blocks since the previous heading; "report" scope = all tile blocks.

## Storage (owned by server/reports.js)

- `report_templates` — entity_id, title, blocks JSON, recipients JSON, cadence
  `none|daily|weekly|monthly`, time_of_day, weekday, monthday, timezone, status
  `active|paused`, next_run_at (claim-first scheduling, same crash-safety
  convention as server/scheduler.js), created_by, timestamps.
- `report_snapshots` — template_id, entity_id, title, content JSON (resolved
  blocks), token (share capability, 144-bit), created_at, sent_to JSON.
- `report_assets` — token, mime, bytes (chart PNGs, hosted images).

## Routes

Admin: `GET/POST /api/admin/entities/:id/reports`,
`PUT/DELETE /api/admin/reports/:tplId`, `POST .../generate`, `POST .../send`,
`GET /api/admin/reports/:tplId/snapshots`, `DELETE /api/admin/report-snapshots/:id`.
Client (`reports.manage`, entity-owned): same shapes under
`/api/my/reports/:entityId[...]`.
Public (token = capability, rate-limited): `GET /api/public/reports/:token`
(snapshot JSON + non-secret branding), `GET /api/public/reports/:token/pdf`,
`GET /report-assets/:asset`.

## Delivery

- **Share link** `/r/:token` — public SPA page (mounted pre-auth in App.jsx,
  like `/embed/*`), mobile-first, client branding (logo/colours), Download PDF.
- **PDF** — `server/reportPdf.js`, pdfkit (pure JS, no headless browser):
  branded header, KPI chips, chart PNGs, tables, AI sections, footer. Generated
  on demand from the snapshot.
- **Email** — resolved blocks map onto `emailBlocks` types → rendered and
  wrapped in `mailer.campaignBlocksEmail` chrome; KPI chips/tables as inline
  HTML; charts as hosted PNGs; "View the full report" button → share link.
  Respects `OUTBOUND_DISABLED` (staging can't email real people).

## Scheduling

Own 60s tick (module-local clone of scheduler.js maths + monthly cadence).
Slots are CLAIMED before the send (next_run_at advanced first) so a deploy
mid-run can miss at most one run, never double-send. Kill switch: settings key
`reports_enabled` ('0' disables tick + routes). Failures raise `notifyOps`.

## Client UI

- `ReportStudio.jsx` — dual-surface manager (scope `admin|my`, mirrors
  DigestManager): template list · **live WYSIWYG canvas** (the report rendered
  exactly as the share page shows it via the shared `ReportBlocks.jsx`
  renderers; headings/text/title edit inline on the canvas; data blocks show
  debounced REAL-data previews from `POST .../reports/preview` — a no-persist
  resolve that returns srcId-tagged blocks with inline chart data-URLs and AI
  placeholders; drag ⠿ to rearrange with native HTML5 dnd, ↑/↓ kept for touch;
  click a block for its settings strip) · schedule + recipients · Generate now /
  Send test · snapshot list with view/copy-link/PDF.
- `ReportsPage.jsx` — client page at `/reports` (nav item gated by
  `reports.manage`).
- `ReportViewPage.jsx` — the public viewer at `/r/:token`.
- Admin surface: Reports panel in Admin → client detail (next to Digests).

## Deliberate V1 cuts (V2 candidates)

- "➕ Add to report" straight from a dashboard tile (report basket).
- Owl/AI-composed reports ("build me a post-event wrap") — emailDesign-style.
- ~~Goals / social / live-pulse / campaign / app-analytics block types~~ — all shipped in V1.1.
- Per-recipient personalisation; comments on the viewer; report themes.
- PDF as an email *attachment* (mailer.send has no attachment support today).

## Security notes

- Share tokens are unguessable capabilities; the public endpoints return only
  snapshot content + non-secret branding, never live queries — revoke by
  deleting the snapshot.
- All tile resolution runs the scoped query path; templates/snapshots are
  entity-checked on every route; client surface additionally requires the
  `reports.manage` permission (roles.js).
