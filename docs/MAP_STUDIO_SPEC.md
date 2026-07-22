# Pulse Map Studio — build spec

Self-service event maps: an AM or a client builds the event map themselves —
drop pins, upload logos, write descriptions, wire CTAs — and publishes it as a
web page served by Pulse. The Howler app already renders a per-event map URL in
a WebView (`mobileAppConfiguration.mapboxUrl`), so a published Pulse map goes
live in the app with **zero Flutter changes and no app release**. Mockups (v1
discussion): https://claude.ai/code/artifact/a619ed07-be10-4a86-8a69-07051750c894

## Why
Today each event's 3D map is outsourced to a professional (expensive, slow, not
scalable). The app's native map path is baked-in (one style, one GLB model,
hardcoded POIs); the WebView path is the per-event lever. Map Studio makes that
lever self-service and turns the map into a data surface (POI tap analytics,
live busyness) instead of a design cost.

## Architecture (v1 — shipped in this change)

Disposable module pattern:
- `server/mapstudio.js` — owns `map_places`, `map_configs`, `map_events`
  tables + all `/api/mapstudio/*` and public `/maps/*` routes. One mount line
  in `index.js`. Delete file + line + tables to uninstall.
- `server/mapstudioPage.js` — factory that renders the standalone map page
  HTML (live mode + editor preview mode). No routes of its own.
- `client/src/components/MapStudio.jsx` — the editor, dual-surface via
  `scope` prop (`admin` under Admin → client → Map Studio; `my` at
  `/event-map` for clients). Same component both sides, per the dual-surface
  rule.

### Data model
- `map_places` — the per-event place registry: name, kind (category key),
  emoji icon or logo (data-URL, entity-logo convention), description, CTA
  (label + URL — https or app deep link), lat/lng, show-in-filters, sort,
  and `station_id` — the link to the matching Event Ops station.
- `map_configs` — one row per suite: style preset, camera (lat/lng/zoom/
  pitch/bearing), categories JSON (festival starter set by default, editable),
  slug, and the immutable `published` snapshot + version.
- `map_events` — analytics beacons from the published page: `open`,
  `poi_tap`, `cta_click`, `filter` (kind + placeId + at). Powers the map
  engagement panel; sponsor reporting later.

### Shared registry with Event Ops (the founding decision)
Map places and Event Ops stations must be ONE source, not two lists that share
names. v1 implements the link half: `map_places.station_id` + one-click
"Import stations" (creates places from `eventops_stations`, kind-mapped, ready
to drag into position). The live busyness layer (phase 3) reads station
throughput through that id — never by name. Full unification (eventops reading
station identity FROM places) is a follow-up migration once both surfaces are
proven; do not add a second place-like table anywhere in the meantime.

### Publishing & the app
- Publish snapshots config + visible places into `map_configs.published` and
  bumps `version`. The public page + `/maps/:slug/config.json` serve ONLY the
  snapshot — drafts are never publicly visible. Slug is unguessable
  (`<event-name>-<6 hex>`); rotating = republish with new slug (kept stable on
  normal republish).
- The published URL goes into the event's `mobileAppConfiguration.mapboxUrl`
  in Howler admin (manual for now; HowlerApp repo has headless Active Admin
  automation — wire "set it for me" later).
- Mid-event edits: republish → live on next map open. No app involvement.

### Rendering
Mapbox GL JS v3 (CDN) in the standalone page. Token resolution:
`settings.mapbox_public_token` (set in the editor by an admin) →
`MAPBOX_TOKEN` env. `pk.` tokens are public-by-design (they ship to every
browser); still keep URL restrictions on the token in the Mapbox console
(https://console.mapbox.com). **No token → the page still works**: it renders
the POI list + filters + sheets without the basemap, so nothing 500s.
Editor preview = same page in `edit` mode (authed route, suite-gated), talking
to the editor via postMessage: map click → add pin, marker drag → move pin,
"Save this view" → camera capture.

### Permissions & feature flag
New atomic permission `map.manage` (roles.js + client PERMS mirror). Granted
to owner (ALL), manager, marketing, ops. Suite gating mirrors eventops:
view = admin or suite member; manage = admin or member with `map.manage`.
Public routes are published-snapshot-only.

Feature flag `mapstudio` (registry in `server/flags.js`, default OFF/beta —
flip on per client from Admin → Product → Flags). Off = the `/api/mapstudio`
routes 403 for client users (admins pass), the client nav item hides, AND the
client's published `/maps/:slug` pages stop serving (the public-page check in
`bySlug`) — the flag is a complete kill switch.

## Phases
1. **This change** — studio editor (pins, categories/filters, logos,
   descriptions, CTAs, camera, style presets), import-from-stations, publish,
   public map page (mobile-first; also fine on desktop), tap analytics panel.
2. **Self-service superpowers** — site-map image overlay (upload PDF/PNG,
   drag to georeference), drawn 3D extrusions (fill-extrusion footprints),
   starter templates, clone from previous event, CSV import, Owl-assisted POI
   extraction from an uploaded site plan, wizard step + tour.
3. **Live layer** — busyness per linked station from the data-health scan/tx
   timelines (rate vs the station's own rolling baseline → quiet/busy/packed),
   halos + queue chips + per-station "popular times" graph on the public page,
   organiser station-load view, Owl "move the crowd" nudge via Live Pulse.
4. **Premium/native** — GLB model upload tier, native in-app rendering
   (offline + blue dot) consuming the same published JSON, sponsor packages
   with tap/CTA reporting.

## Non-goals (v1)
No per-attendee location tracking (busyness = aggregate station throughput
only). No GLB/3D model hosting yet. No automatic Howler-admin `mapboxUrl`
write-back yet.
