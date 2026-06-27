# What's next — 2026-06-27 · ecstatic-thompson

**Session focus:** Scoped how Pulse should integrate with ad/social platforms
(Meta, X, TikTok), researched the current X API, and shipped the first slice:
pulling **organic social metrics** (Facebook / Instagram / TikTok) *into* Pulse.

## Shipped this session
- **Inbound social-metrics connector** (`server/socialMetrics.js`, commit
  `148f398`) — a disposable module that pulls organic social stats into Pulse at
  two grains: account-level daily series (followers, reach, impressions, profile
  views) and per-post engagement (reach, likes, comments, shares, saves, video
  views). Idempotent upserts, a never-throwing per-platform sync chokepoint, and
  a daily background sync started from `index.js`.
- **Schema** — `social_accounts`, `social_account_metrics` (daily), `social_post_metrics`.
- **Wiring** (`server/index.js`) — new non-secret integration fields
  `metaPageId` / `metaIgUserId`; dual-surface routes (admin
  `/api/admin/entities/:id/social`, client `/api/my/social/:id`) with `sync` +
  `verify`; social rolled into the admin connector-health view.
- **Connection UI** (`client/src/components/IntegrationsForm.jsx`) — Facebook
  Page ID + Instagram account ID fields on the Meta card, plus read-only-metrics
  scope guidance on the Meta/TikTok cards. Write-only-secret convention kept.
- **Social page** (`client/src/pages/SocialPage.jsx`) — mobile-first: connected
  accounts, 30-day trend with a metric switcher, top posts, one-tap "Refresh
  now". Serves client self-service *and* admin preview via the `/api/my` path
  (admins pass `ownsEntity`). Wired into the client nav — **now sits under
  Engage, below Segments** (commit `688c270`) — and routed at `/social`.
- **Tests** (`test/social-metrics.test.js`) — schema, configured-platform
  detection, idempotent upserts, summary roll-up. Full suite green (126+).
- **Docs** — `docs/PRODUCT_OVERVIEW_SALES.md` section 5e + changelog (🟡🧪).
- Post-merge housekeeping that rode in from main rebases: ESLint hooks-deps fix
  + route-level code-splitting (`9c12e2d`, `077f624`).

## Decisions made (and why)
- **Direction split: inbound vs outbound.** The existing `meta.js` / `tiktok.js`
  are *outbound* audience-sync (push segments → Custom Audiences). This session
  built the *inbound* read path as a **separate module** rather than overloading
  those — keeps the disposable-module boundary clean.
- **Reused the existing tokens, added only id fields.** Social metrics read with
  the same `metaAccessToken` / `tiktokAccessToken`, plus new non-secret Page/IG
  ids. Chosen for a simpler connect UX (one token, a properly-scoped Meta
  system-user token can serve both). **Caveat:** the audience-sync token and the
  organic-insights token need *different scopes* (`ads_management` vs
  `pages_read_engagement` / `read_insights` / `instagram_manage_insights`; TikTok
  Marketing/DMP vs Display API `user.info.stats` + `video.list`). An
  under-scoped token surfaces as a ⚠ error on the account card, not a crash.
  Open: may later split into separate `*SocialToken` fields if clients manage
  ad-ops and social-insights separately. (Shai: *"let me test and we can see."*)
- **Dedicated Social page first; dashboard tiles deferred.** Shai asked for both
  surfaces. The page shipped; wiring social as a dashboard-grid data source needs
  Looker `json_detail` row-shaping + a tile-editor field picker + renderer
  verification — that touches the core engine rendering live client dashboards,
  so it's a separate, careful pass rather than rushed plumbing.
- **Aggregator vs direct, and platform priority.** Discussed: for *multi-tenant*
  ad-campaign management the Meta App Review / Tech Provider path is ~2–4 months
  (mostly waiting on Meta), so an aggregator (write-capable, embedded OAuth) is
  the fast path; reporting-only aggregators (Supermetrics et al.) cover metrics
  but **not** campaign writes. **X is now pay-per-use** (Feb 2026: no free tier,
  ~$0.005/read, 2M-read/mo cap → Enterprise ~$42k+/mo) and real-time streaming
  is on the closed legacy Pro tier — so X is a low-priority phase-2 at best.

## What's next (priority order)
1. **Live API verification.** No Meta/TikTok creds in this env — the Graph /
   Display API calls are untested. Connect one real account, hit "Refresh now",
   and confirm response shapes / metric names against current docs (they drift
   between API versions). This is the gating step before calling it 🟢.
2. **Resolve the token-scope question** based on (1): keep the single reused
   token, or split social metrics onto their own `metaSocialToken` /
   `tiktokSocialToken` fields.
3. **Dashboard-tile data source** — surface account series + top posts as
   non-Looker tiles in the 24-col grid (json_detail shaping → editor picker →
   renderer check). Query helpers (`accountSeries`, `topPosts`) are the foundation.
4. **Nav visibility check** — Social now inherits the Engage/`CAMPAIGNS_VIEW`
   gate (side effect of sitting under Segments). Confirm that's intended, or give
   it its own gate (e.g. show when a social integration is connected).
5. **Setup wizard** — confirm the new Page/IG fields surface in the wizard's
   integrations step (it reuses the real editor, so likely automatic) and add
   tour copy if needed.

## Open questions / blockers
- **Blocker for "done":** live credentials to verify the connectors end-to-end.
- **TikTok organic** has no historical day-series via the Display API (snapshot
  only) — we store a daily snapshot per sync. Confirm that's acceptable, or pull
  from the Business API if richer history is needed (separate approval).
- **Whose accounts / multi-tenant?** Still the big fork for the *campaign
  management* ambition (own accounts = quick; clients connecting theirs = App
  Review + Business Verification + Tech Provider). Not needed for metrics, but it
  determines the next phase's effort.

## Pointers
- Files: `server/socialMetrics.js`, `server/index.js`, `test/social-metrics.test.js`,
  `client/src/pages/SocialPage.jsx`, `client/src/components/IntegrationsForm.jsx`,
  `client/src/pages/ClientLayout.jsx`, `client/src/App.jsx`, `client/src/lib/api.js`,
  `docs/PRODUCT_OVERVIEW_SALES.md`.
- Commits: `148f398` (feature), `688c270` (nav move).
- Mockup of the page (sample data): produced this session as a standalone HTML
  preview (not committed).
