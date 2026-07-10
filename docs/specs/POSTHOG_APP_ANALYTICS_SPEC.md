# Spec — Direct PostHog integration: app analytics in Pulse (v1)

> Status: **v1 SHIPPED 2026-07-10** (steps 1–3 + 5: app-user profiles with
> paging/top-users, property-qualified mapping incl. `=*`, breakdowns with
> per-value trend lines, diagnostics + property-value explorer, and the
> `getAppAnalytics` Owl tool. Funnels/retention — step 4 — remain) ·
> Implementation: `server/posthog.js`,
> `client/src/components/AppAnalytics.jsx`, `client/src/pages/AppAnalyticsPage.jsx`,
> flag `appanalytics` (default off, beta) · Owner: Shai · North Star:
> `docs/EXPERIENCE_OS_BRIEF.md`. Decided direction (Shai, 2026-07-10): the
> **Looker path stays** for anything app data must join to other Howler data
> (revenue, ticketing); a **direct PostHog path** is added for app-ONLY
> analytics where it wins on freshness (live) and richness (funnels,
> retention, paths) — plus a **management view of ALL app data** across
> clients. PostHog: https://posthog.com · Query API:
> https://posthog.com/docs/api/queries

## 1. Problem & goal

Howler's consumer app tracks all product analytics into **PostHog**; today the
only way that data reaches Pulse is PostHog → warehouse export → Looker →
Pulse. That hop makes app data **a day old**, flattens PostHog-native analyses
(funnels/retention have to be rebuilt in LookML), and burns Looker query slots
(`server/looker.js` caps concurrency at 8).

**Goal:** a `server/posthog.js` module that talks to the PostHog API directly
for app-only reporting:

1. **Client surface** — each client sees live app engagement around *their*
   events (scoped, self-service, zero per-client setup).
2. **Management surface** — Howler leadership sees the whole app: actives,
   growth, top events, funnels, retention, across all clients.
3. **Owl** — a read tool so the AI can narrate app behaviour.

**Non-goal:** replacing the Looker path. Anything that joins app behaviour to
ticketing/revenue/other Howler data stays in LookML. Pulse does NOT become a
second metric layer for cross-domain questions.

## 2. Key architectural insights (why this is tractable)

- **App events already carry the Howler event id** (confirmed by Shai). Pulse
  suites already resolve to organiser/event scope server-side
  (`auth.scopeForQuery`, fail-closed — see `test/scope.test.js`). So client
  scoping = inject `properties.<event-id property> IN (suite's event ids)`
  into every HogQL query **on the server**, exactly mirroring the Looker
  scoping contract. Nothing per-client to configure or connect.
- **One PostHog project for the one Howler app** → the connection is
  **platform-level** (like Looker: `db.getSetting` → `.env` fallback,
  configured in Admin → Integrations), NOT per-entity like Meta/TikTok.
- The house already has the module shape: `server/metaAds.js` /
  `server/socialMetrics.js` (external API → local SQLite rollups + a
  self-guarded daily tick + "Sync now"), and `server/looker.js` (token/creds
  handling, concurrency gate). This module is those two patterns glued.

## 3. Connection (platform-level, write-only secret)

Admin → Integrations gains a **PostHog** card:

- `posthog_host` — e.g. `https://eu.posthog.com` or `https://us.posthog.com`
- `posthog_project_id`
- `posthog_api_key` — a **personal API key** with read/query scope (project
  API keys are ingest-only and cannot query). Stored write-only: responses
  return set/mask only, never the value (house secrets rule).
- `posthog_event_id_property` — the event-property name that carries the
  Howler event id (configurable so a tracking rename doesn't need a deploy).
- A **Test connection** button (runs a trivial HogQL `select 1`-style query).

Kill switch setting `posthog_sync_enabled = '0'`, mirroring
`meta_ads_sync_enabled`.

> ⚠️ Like `tiktok.js`/`socialMetrics.js` before go-live: PostHog **rate-limits
> the query endpoints** and limits move — verify current limits + exact
> HogQL/endpoint shapes against https://posthog.com/docs/api/queries during
> the build. Design below assumes queries are expensive and scarce.

## 4. Data strategy — two tiers

**Tier 1 · Daily rollups → SQLite (cheap, powers most UI).** A scheduler tick
(once daily, plus "Sync now" on both surfaces) runs a small set of HogQL
aggregate queries and upserts into:

- `posthog_daily_app` — date × (dau, new_users, sessions, screen_views …):
  the whole-app series for the management view.
- `posthog_daily_event` — date × howler_event_id × (views, unique_viewers,
  add_to_carts, shares …): the per-event series; client surfaces JOIN this to
  their suite scope. Upserts re-state the trailing few days (PostHog restates
  late-arriving events), same idempotent pattern as `social_*_metrics`.

**Tier 2 · Live queries (scarce, powers "right now" + rich analyses).**
Direct HogQL / insight queries with a short in-memory TTL cache (≈5 min) and a
small concurrency gate (reuse the `looker.js` acquire/release-slot pattern):

- "Live today" numbers (actives today, views today per event).
- **Funnels** (e.g. app open → event view → ticket CTA) and **retention**
  cohorts — requested with PostHog's native funnel/retention query kinds, not
  rebuilt by hand.

Rollups mean a rate-limited or down PostHog degrades to "yesterday's data",
never a broken page; the sync chokepoint **never throws** (records last-sync
error on a status row, rest of Pulse carries on — house rule).

## 5. Surfaces (dual-surface rule)

**Admin / management — Admin → 📱 App analytics (new tab):**
- Whole-app headline row (DAU/WAU/MAU, new users, sessions) + trend charts
  from `posthog_daily_app`.
- Top Howler events by in-app attention (from `posthog_daily_event`),
  click-through to a per-event breakdown; filter by client.
- Funnel + retention panels (Tier 2). This is the "management view of all app
  data".
- Available to the `all_organisers` management login as well, consistent with
  the portfolio-view degenerate-scope idea.

**Client self-service — an "App" section (likely on/next to `SocialPage`
pattern):**
- Scoped strictly to the client's events via suite scope (server-side,
  fail-closed: no scope → no data, never "everything").
- Their events' in-app views/engagement, live-today numbers, and the app-side
  funnel for their events. Mobile-first, single-column.
- Routes: `/api/my/app-analytics/...` (entity-ownership enforced) mirroring
  `/api/admin/app-analytics/...`; same React component with a `scope` prop
  where sensible (the `MailTemplateEditor` pattern).

**Owl:** one read tool `getAppAnalytics` (catalogued in `owlCatalogue`,
scoped like `getPaidPerformance`), returning the rollup series + latest live
snapshot so the Owl can narrate app behaviour in briefings/digests later.

## 6. Module conventions checklist

- Self-contained disposable module `server/posthog.js`: owns its tables +
  routes + tick, mounts in ONE line in `server/index.js`; ≤1500 lines
  (`test/architecture.test.js` budget).
- `asyncHandler` + `HttpError` for routes; no hand-rolled try/catch → 500s.
- Tests with recorded HogQL response fixtures (normalise + upsert + scoping +
  fail-closed), like `test/metaAds.test.js` / `test/socialMetrics` style.
- No AI prompts in v1 (nothing for `promptRegistry()`); if the Owl tool grows
  guidance text later, register it then.
- Ship-time doc updates in the SAME change: `docs/PRODUCT_OVERVIEW_SALES.md`
  (new section, 🟡 needs setup → ✅ once the key is in) and this spec's status.
  Setup wizard: nothing per-client to wire (platform-level connection), so no
  wizard step; revisit only if a per-client toggle is added.

## 7. Build order

1. **Core + connection** — module skeleton, settings card in Admin →
   Integrations, test-connection, HogQL request helper (auth, gate, timeouts).
2. **Rollup sync + management view** — daily tick, the two tables, Admin →
   App analytics tab (headlines + trends + top events). *Management value
   lands here.*
3. **Client surface** — scoped `/api/my/app-analytics`, App section UI,
   live-today numbers. *Client value lands here.*
4. **Rich analyses** — funnels + retention (Tier 2) on both surfaces.
5. **Owl tool** — `getAppAnalytics` + catalogue entry.

Each step ships independently; stopping after any step leaves a working,
smaller feature.

## 8. Open questions — ANSWERED (Shai, 2026-07-10)

1. **Event-id property:** `eventID` (configurable in the connection card in
   case the tracking plan renames it; event display names via `eventName`).
   No organiser id stamped — scoping stays event-id based.
2. **Region:** EU — default host `https://eu.posthog.com`.
3. **Metrics wanted first:** active users, uniques, interactions, CTA taps,
   notification events, purchases (+ value where the app sends it) — all in
   the v1 rollup. Funnels/retention are the remaining step-4 work.
4. **Client surface:** shipped as its own 📲 App page (route `/app-analytics`,
   nav gated by the `appanalytics` flag).
5. **(Added)** **App-user profiles:** pull person properties — email
   (`$email`), first name, surname, mobile — per client (only people who
   touched their events) and app-wide for management; property names
   configurable in the mapping editor; CSV export in the UI.
