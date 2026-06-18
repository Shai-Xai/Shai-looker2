# Session handoff — context for a new Claude Code workspace

> **Why this file exists:** project context (`CLAUDE.md`, `PROJECT_OVERVIEW.md`,
> `docs/`) and git history travel **with the repo** and are read automatically.
> But the *conversation* history from Claude Code sessions does **not** move
> between workspaces. This doc captures the decisions + current state so a fresh
> workspace starts informed. Read `CLAUDE.md` first (the standing rules), then this.
>
> **Last updated:** 2026-06-18.

## How to pick up in a new workspace
1. Point the company Claude Code workspace at the **same repo** — `CLAUDE.md` +
   `docs/` load automatically, so the "project memory" is already there.
2. **Re-enter environment secrets.** Secrets are write-only and are NOT in the
   repo, so a new environment starts blank. Reconfigure the env vars the app
   needs (set in Render / the environment, never committed): Looker API creds,
   `ANTHROPIC_API_KEY`, Resend (email), Clickatell (SMS), web-push VAPID keys,
   Inventive key/token, and the inbound-email shared secret. The app also stores
   many secrets per-client in its DB (write-only), which live with the data, not
   the repo.
3. Deployment: Render auto-deploys from **`main`**. Live data is the server's
   SQLite DB on Render (entities, campaigns, digests, billing rates, inbox…) — it
   is NOT in the repo. Moving hosting later needs a DB export/import.

## Git workflow (unchanged — see CLAUDE.md)
- Active feature branch: **`claude/ecstatic-thompson-vUFsS`**.
- Push to the branch **and** to `main`: `git push -u origin <branch> && git push origin <branch>:main`. Render deploys from `main`.
- A parallel session has at times pushed to the branch; fetch + merge before pushing.

## What this app is
Howler **Pulse** — the "Experience / Intelligent OS" for events-ticketing clients:
dashboards (Looker as headless calc engine), AI insights, a messaging inbox,
scheduled digests + a home briefing, settlements/documents, and an email/SMS
campaign engine. North star: `docs/EXPERIENCE_OS_BRIEF.md`; stack/state:
`PROJECT_OVERVIEW.md`; sales view: `docs/PRODUCT_OVERVIEW_SALES.md` (keep current).

## Standing conventions (the ones that bite)
- **Dual-surface rule:** every client feature ships with admin management
  (`/api/admin/entities/:id/...`) **and** client self-service (`/api/my/...`,
  entity-ownership enforced). Same component, `scope` prop.
- **Mobile-first** always.
- **Write-only secrets:** responses report set/mask, never the value.
- **AI prompts auditable:** every hardcoded prompt in `server/insights.js` must be
  in `promptRegistry()` — `test/prompts.test.js` fails the build otherwise.
- **Org scoping fails closed:** `applyScope`/`resolveScope` force the organiser
  filter per the query's own explore; GA4 etc. resolve their own organiser field.
- **Never** put the model identifier in commits/PRs/code/artifacts (chat only).
- Run `npm test` (24 tests) + `cd client && npm run build` before pushing.

## Module map (where things live)
- Server (`server/*.js`, mounted in `index.js`): `actions.js` (campaign engine),
  `segments.js`, `billing.js` (NEW — costs), `scheduler.js` (digests), `insights.js`
  (AI + prompt registry), `os.js` (inbox/Experience-OS spine + inbound email),
  `mailer.js`, `messaging.js` (SMS), `meta.js`/`tiktok.js` (audience sync),
  `tileimg.js` (NEW — server-side chart→PNG for digest emails), `looker.js`,
  `db.js`, `store.js`, `auth.js`, `roles.js`.
- Client (`client/src`): `pages/` (AdminPage, ClientHome, ClientLayout,
  ClientIntegrationsPage, ViewPage, EngagePage…), `components/` (CampaignManager,
  DigestManager, RateCard NEW, DigestHistory, OnboardingCard…), `os/` (InboxPage),
  `lib/` (profile.jsx, auth.jsx, access.js, api.js).

## Work shipped in the recent session (newest first)
- **Campaign costs & billing** (`server/billing.js`, `RateCard.jsx`): master
  rate card (Admin → Billing) + per-client overrides (Admin → client → Fees;
  blank inherits) + client self-service (Settings → Fees & billing). Cost on
  each campaign **before** send (reach × rate) and **after** (report), plus a
  **master-report rollup** and an admin all-client rollup. Per message sent, ZAR.
  Default rates seeded: email R0.03, SMS R0.25, WhatsApp R0.70. ROI/revenue is
  deliberately deferred (cost-only v1); rate card shaped to add margin/ROI later.
- **Digests:** include **saved tiles** (pinned ∪ followed, per-tile checklist),
  optionally rendered as **charts/metrics** in the email (ECharts SSR → PNG via
  `@resvg/resvg-js`, pivot-aware); GA4/analytics **guaranteed** in AI-led digests
  *when the client has a GA4 dashboard*; Pause/Resume; "Recent digests" collapsed
  by default; live-preview shows **excluded tiles + reason** (diagnose missing data).
- **Inbound email (CC-the-Owl):** decode MIME encoded-word subjects + multipart
  bodies (charset-aware), **trim quoted replies/signatures**, wrap long tokens in
  the UI; one-time cleanup of already-stored garbled messages.
- **Profile/entity fixes:** home briefing/snapshot bound to the active profile
  (`homeEntityId`); digest "Open Pulse" deep-links to the right profile
  (`?entity=`); admin sidebar footer no longer shows an unrelated client's logo;
  Settings reachable for an admin acting as a client; swept first-entity leakage.
- **Misc:** login tagline → "Intelligent OS"; Admin Clients alphabetical + search;
  "Ask" hidden behind `client/src/lib/features.js` flag; pitch deck served at
  **`/pitch`** (`docs/experience-os-pitch.html`).
- **Build-Value Tracker** (repo root, separate side-tool): `update_tracker.py`
  + `Build_Value_Tracker.xlsx` — replacement-cost estimate (LOC × effort factor →
  rand), build-only vs full-delivery (delivery multiplier) + sensitivity band.
  Daily refresh via `.github/workflows/build-value-tracker.yml` → publishes to a
  `build-value-tracker` branch + artifact (kept off `main` so no app redeploy).

## Open threads / standing offers (not yet done)
- **ROI via promo-code attribution:** campaigns already inject a unique promo code
  into the buy link — pull matching ticket sales from Looker to compute
  ROI = (attributed revenue − cost)/cost, surfaced on reports + rollups.
- Refresh `docs/experience-os-pitch.html` to "Intelligent OS" wording + the latest
  features (billing, GA4 digests, digest charts).
- Confirm GitHub **Actions enabled** + "Read and write" workflow permissions so the
  daily build-value tracker job runs (and `main` is the default branch).
- Optional: digest chart shows only the primary measure when a tile mixes scales;
  extend the one-time inbound cleanup to also trim quoted replies on old messages;
  pause SMS alongside email in the global kill-switch.
