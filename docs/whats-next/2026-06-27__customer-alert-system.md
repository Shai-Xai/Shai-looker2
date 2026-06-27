# What's next — 2026-06-27 · customer-alert-system

**Session focus:** Build a customer-facing **platform incident / status-notice**
system — Howler staff post an issue (company-wide or per-client), update it on a
timeline, and mark it resolved; clients see it in-app.

## Shipped this session
- **`server/notices.js`** — new disposable module (commit `af095f3`). Owns three
  tables (`status_notices`, `notice_targets`, `status_notice_updates`), all
  `/api/admin/notices` + `/api/my/notices` routes, kill switch `notices_enabled`.
  Status-page-style: a notice = the incident; updates = the timeline; Resolve = a
  closing update + `resolved_at` stamp.
- **Admin surface** — `client/src/components/StatusNoticesAdmin.jsx`, mounted as a
  new **🚨 Status** tab in `AdminPage.jsx`. Create (severity + global/specific-client
  picker), post updates that advance status, Mark resolved, delete.
- **Client surface** — `client/src/components/StatusNoticeBanner.jsx`, mounted in
  `ClientLayout.jsx`. Severity-coloured banner for active incidents (expand to full
  timeline), resolved ones turn green and linger 48h, local per-update dismiss.
  Polls `/api/my/notices` every 60s.
- **Wiring** — one-line mount in `server/index.js`; API methods in
  `client/src/lib/api.js`; sales overview §11 + changelog in
  `docs/PRODUCT_OVERVIEW_SALES.md`.
- All 156 tests pass; client build clean; lint 0 errors in new files.

## Decisions made (and why)
- **Separate module from `server/alerts.js`.** `alerts.js` watches *data* and fires
  automatically on a tick; this is *human-authored* incident comms. Folding them
  together would have muddied two different mental models. Named "notices" to avoid
  the `alerts` table/route collision.
- **Severity-keyed fan-out (`SEVERITY_CHANNELS`).** Per Shai: default **banner +
  email**, but "plan for full fan-out depending on severity." So info/maintenance →
  email, degraded → +push, outage → +SMS; banner always-on. The map is a single dial
  to make it louder later. Email/push reuse the OS spine (`os.announce`, one thread
  per notice per entity); SMS goes direct.
- **Scope: global OR multiple specific clients.** Shai chose multi-client over
  single-client-only, so targeting is a `notice_targets` join table (global = no
  rows; targeted = N rows), not a single `entity_id`.
- **No acknowledgement — "just see it."** Clients can't be made to click; banner
  shows until resolved (or local dismiss). A *new* update re-surfaces a dismissed
  banner (dismissal keyed to `updatedAt`).
- **Dual-surface = read-side for clients.** Clients don't author platform-status, so
  the "client self-service" half of the rule is the banner/feed they consume;
  authoring is admin-only.

## What's next (priority order)
1. **Real SMS recipient source for outages.** Today SMS only reaches numbers an admin
   pastes onto the notice (mirrors `alerts.js`). A global outage has no auto
   per-client phone list to fan out to — wire one (entity contact numbers / team
   notify-prefs) before SMS is genuinely "full fan-out."
2. **Standalone client Status page / history.** Right now clients only get the banner
   + a 48h lingering feed. A dedicated `/status` page (past incidents, uptime-ish
   history) would let them self-serve "was there an issue yesterday?" without asking.
3. **Per-update notification throttling.** Each posted update re-notifies the whole
   audience. For a fast-moving incident that could spam push/email — add a "notify on
   this update? (y/n)" toggle or a min-interval guard.
4. **Setup-wizard / health surfacing (optional).** Consider a small "active incidents"
   count in the admin console header so on-call staff see open notices at a glance.

## Open questions / blockers
- **SMS for global outages** — what's the canonical recipient list? Per-entity contact
  number, every team member's mobile, or a Howler ops broadcast list? Blocks item 1.
- **Do clients want a full status *page*** (history/uptime), or is the banner + 48h
  feed enough? Drives whether item 2 is worth it.
- **Should "important" people (e.g. a client's primary contact) always get SMS** even
  for degraded, regardless of severity policy? Touches the channel-resolution logic.

## Pointers
- Files/areas touched: `server/notices.js`, `server/index.js`,
  `client/src/lib/api.js`, `client/src/pages/AdminPage.jsx`,
  `client/src/pages/ClientLayout.jsx`, `client/src/components/StatusNoticesAdmin.jsx`,
  `client/src/components/StatusNoticeBanner.jsx`, `docs/PRODUCT_OVERVIEW_SALES.md`.
- Related: §11 of `docs/PRODUCT_OVERVIEW_SALES.md`. Kill switch setting:
  `notices_enabled`. Severity→channel map lives at the top of `server/notices.js`
  (mirrored for display in `StatusNoticesAdmin.jsx`).
- Note for roadmap reconcile: this is distinct from the **Alerts** roadmap items —
  don't merge the two.
