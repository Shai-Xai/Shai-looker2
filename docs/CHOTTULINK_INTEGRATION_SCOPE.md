# ChottuLink Integration — Scope

**Status:** 📋 Scoped, not started · **Last updated:** 2026-07-07

Bring [ChottuLink](https://chottulink.com/) deep-link management into Pulse so
links are created via their [REST API](https://docs.chottulink.com/rest-api/postman)
instead of one-by-one in their dashboard — including **link templates that
stamp out every link an event needs in one click** — and pull click analytics
back into Pulse.

## Why (insight → action → results)

Today every deep link into the Howler app is created manually at
https://app.chottulink.com. For each event that's the same handful of links
(tickets link for Instagram, for Facebook, for email, for SMS, poster QR, …)
differing only in UTMs and destination. Pulse already knows the client, the
event and the campaign context — it should mint the links, keep them tied to
the event, and report the clicks next to campaign stats.

## What ChottuLink's API gives us

Base `https://api2.chottulink.com`, auth via a single `API-KEY` header
(`c_api_…` key from [Dashboard → Keys](https://app.chottulink.com/api-keys)).

| Capability | Endpoint | Notes |
|---|---|---|
| Create link | `POST /chotuCore/pa/v1/create-link` | domain, destination_url, link_name, iOS/Android behaviour (browser/app), optional custom path, all 5 UTMs, social title/description/image. Returns `short_url`. |
| List links | `GET /chotuCore/pa/v1/links/page` | paginated (max 100/page) — lets us import links created manually. |
| Link info | `POST /chotuCore/pa/v1/links/info` | single link detail. |
| Update link | `PATCH /chotuCore/pa/v1/update-link/{linkId}` | partial: destination, name, behaviours, UTMs, social. |
| Enable/disable | `PATCH /chotuCore/pa/v1/links/change-status/{linkId}` | kill a link without deleting. |
| Analytics | `POST /chotuCore/pa/v1/analytics` | **per link only**: `total_clicks`, `clicks_last_7_days`, `clicks_last_30_days`. No per-day history, geo or platform breakdown via API. |

**Constraints to design around:**
- Analytics windows are fixed (total/7d/30d) → Pulse snapshots daily and builds
  its own history/trends (same trick as goals snapshots).
- Rate limits are unpublished ("contact support") → bulk creation runs
  sequentially with per-item success/failure tracking, never a blind fan-out.
- No delete endpoint documented → "remove" in Pulse = disable + archive locally.

## Module shape

One disposable module **`server/chottuLink.js`** (clone the `server/apiKeys.js`
skeleton): owns its tables, mounts in one line in `server/index.js`, uses
`asyncHandler`/`HttpError` from `server/http.js`.

### Config & secrets (layered, write-only)

Per the platform → client layering rule:
- **Platform default** (settings table): `chottuApiKey`, `chottuDomain` — one
  Howler ChottuLink account covering all clients.
- **Per-client override** (`entities.integrations` JSON): `chottuApiKey`,
  `chottuDomain` for clients with their own ChottuLink org/domain. Blank =
  inherit platform; UI shows what's inherited.

Key fields end in `ApiKey` so `server/secretbox.js` auto-seals them at rest.
Read views return `{ keySet, keyHint }` via the `maskSecret` convention; write
path goes through `applyIntegrationsPatch` / `entityIntegrationsView` in
`server/index.js` (mirror the Meta/TikTok token blocks).

### Data model (new tables, created in `mount()`)

```
chottu_links        id, entity_id, suite_id (nullable — event link vs evergreen),
                    chottu_link_id (external UUID), short_url, link_name,
                    destination_url, path, ios_behavior, android_behavior,
                    utm JSON, social JSON, is_enabled,
                    template_id, template_item_key (provenance when bulk-created),
                    source ('pulse' | 'imported'), created_by,
                    created_time, modified_time

chottu_link_stats   link_id, captured_on (date), total_clicks,
                    clicks_7d, clicks_30d          -- daily snapshot; deltas
                                                   -- between snapshots give a
                                                   -- per-day clicks series

chottu_templates    id, entity_id (NULL = platform template usable for any
                    client), name, description, items JSON,
                    created_time, modified_time
```

**Template items** — each item is one link the event needs:

```json
{
  "key": "tickets-instagram",
  "link_name": "{{event.name}} — Tickets (Instagram)",
  "destination_url": "https://howler.co.za/events/{{event.slug}}",
  "path": "{{event.slug}}-ig",
  "utm": { "source": "instagram", "medium": "social", "campaign": "{{event.slug}}" },
  "social": { "title": "{{event.name}} tickets 🎟️" },
  "ios_behavior": 2, "android_behavior": 2
}
```

Placeholders resolved at apply time: `{{event.name}}`, `{{event.slug}}`
(slugified name), `{{event.id}}`, `{{event.date}}` (via `resolveEventDate`),
`{{client.name}}`. Anything unresolvable is flagged in the preview, not
silently blanked.

### One-click bulk create (the headline flow)

1. Pick a template + an event (suite) — admin or client surface.
2. **Preview (dry run):** server resolves every item's placeholders and returns
   the exact links about to be created (name, path, destination, UTMs), with
   per-item warnings (path already used, missing placeholder). Editable before
   confirm — a user can tweak or untick items.
3. **Confirm:** server creates links **sequentially** against ChottuLink,
   recording each success/failure. Response = per-item results; failed items
   can be retried individually without re-creating the successes.
4. All created links land in `chottu_links` tagged with the event, template and
   item key.

Endpoints:

```
Admin  (auth.requireAdmin)                     Client (requirePermission + myEntity guard)
GET    /api/admin/entities/:id/chottu/links    GET    /api/my/chottu/links?entityId=
POST   /api/admin/entities/:id/chottu/links    POST   /api/my/chottu/links
PATCH  .../chottu/links/:linkId                PATCH  /api/my/chottu/links/:linkId
PATCH  .../chottu/links/:linkId/status         PATCH  /api/my/chottu/links/:linkId/status
GET    .../chottu/templates  (+POST/PATCH/DELETE)  same under /api/my/chottu/templates
POST   .../chottu/templates/:tid/preview       POST   /api/my/chottu/templates/:tid/preview
POST   .../chottu/templates/:tid/apply         POST   /api/my/chottu/templates/:tid/apply
POST   .../chottu/import                       —      (admin-only: pull existing links
GET    .../chottu/links/:linkId/stats          GET    /api/my/chottu/links/:linkId/stats
```

Ownership on `/api/my/...` uses the `myEntity(req)` guard + a permission
(reuse `integrations.manage` for settings; links/templates management sits
under a `links.manage`-style permission — final name to match the existing
permission catalogue in `server/auth.js`).

### Import of existing links

Admin-only sync: page through `GET /links/page`, upsert by `chottu_link_id`
with `source='imported'`, then let admins/clients attach each link to an event.
Keeps the current manually-created estate visible in Pulse from day one.

### Analytics sync

- Daily tick inside the module's `mount()` (same `setInterval` pattern as
  `server/scheduler.js`), guarded by a `chottu_enabled` setting, alerting
  failures via `ops.alert('chottu', …)`.
- For every enabled link: call the analytics endpoint, snapshot into
  `chottu_link_stats`. Sequential, throttled.
- On-demand refresh button per link/event in the UI (rate-limit friendly:
  refreshes just that event's links).
- Rollups computed Pulse-side: per-event totals (sum of its links), per-source
  split (group by `utm.source`), and a clicks-over-time series from snapshot
  deltas.

## UI (mobile-first, both surfaces)

Shared component `ChottuLinks` with a `scope` prop (`admin-client` | `my`) —
same pattern as `MailTemplateEditor`.

**Admin surface** — new tab in Admin → client detail (`nav` array in
`client/src/pages/AdminPage.jsx`, `ClientDetail`): `🔗 Deep links`.
Sections (stacked single-column):
1. **Setup** — inherited vs overridden key/domain (masked), test-connection button.
2. **Links by event** — grouped list: short URL (tap to copy), destination,
   clicks (total/7d/30d + trend), enabled toggle; filter by event; "＋ New link"
   form; import button.
3. **Templates** — list + editor (items as stacked cards, placeholder helper),
   "Apply to event…" launcher → preview → confirm.

**Client surface** —
1. **Settings → Integrations** (https://howler-pulse-v2.onrender.com/settings):
   ChottuLink key/domain override fields (masked, write-only, "inherited from
   Howler" hint when blank).
2. **Engage** (https://howler-pulse-v2.onrender.com/engage): new `links` tab
   rendering the same `ChottuLinks` component scoped to their entity — create
   links, run templates against their events, see clicks.

Tap targets ≥ 40px, no side-by-side grids; `useIsMobile()` collapses the
template editor/preview into a stack.

## Wiring checklist (per CLAUDE.md house rules)

- [ ] `server/chottuLink.js` ≤ 1500 lines (architecture test); ChottuLink HTTP
      client kept inside the module.
- [ ] Secrets write-only + sealed; never echo the key.
- [ ] Setup wizard: ChottuLink key/domain surfaces as an **optional** item in
      the integrations step (`WIZARD_DEFAULTS` copy + tour anchor if the step
      has a tour). Not required to go live.
- [ ] `docs/PRODUCT_OVERVIEW_SALES.md`: add "Deep links" section (🔜 → ✅ as it
      ships) + changelog line, in the same change that ships each phase.
- [ ] Tests: template placeholder resolution, apply partial-failure handling,
      `/api/my` ownership guard, stats snapshot delta maths, secret masking.

## Build phases

| Phase | Ships | Size |
|---|---|---|
| **1 — Foundation** | Module + tables, key/domain settings (platform + per-client, masked), ChottuLink API client, manual link create/edit/disable tied to events, import of existing links, admin tab + client Engage tab (list/create). | ~2–3 sessions |
| **2 — Templates** | Template CRUD (platform + per-client), placeholder engine, preview → one-click apply with per-item retry. | ~1–2 sessions |
| **3 — Analytics** | Daily stats snapshots, per-link + per-event rollups, trends, on-demand refresh, `ops` alerting. | ~1–2 sessions |

## Open questions

1. **Account topology:** is all of Howler on one ChottuLink org/domain (e.g.
   `howler.chottu.link`), or will big clients get their own? Scope assumes one
   platform account + optional per-client override, matching the layering rule.
2. **Rate limits:** unpublished — worth an email to ChottuLink support before
   Phase 2 (bulk create) and Phase 3 (nightly sweep across all links).
3. **Path collisions:** custom paths are global per domain — template paths
   include the event slug to stay unique, but preview must surface collisions
   (ChottuLink's error response on a taken path needs confirming with a real
   key).
4. **QR codes:** ChottuLink markets QR support but the REST docs don't expose a
   QR endpoint — Pulse can render a QR client-side from the short URL (no API
   needed) if posters are a wanted use case.

## References

- API overview: https://docs.chottulink.com/rest-api/postman
- Create: https://docs.chottulink.com/rest-api/rest-api-create ·
  List: https://docs.chottulink.com/rest-api/rest-api-list ·
  Update: https://docs.chottulink.com/rest-api/rest-api-update ·
  Analytics: https://docs.chottulink.com/rest-api/rest-api-analytics
- Keys: https://app.chottulink.com/api-keys
- Internal prior art: `server/actionTracking.js` (Pulse's own short-link/UTM
  engine), `server/apiKeys.js` (module skeleton), `server/scheduler.js` (daily
  tick pattern).
