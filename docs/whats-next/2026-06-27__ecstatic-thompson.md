# What's next — 2026-06-27 · ecstatic-thompson

> Two working sessions ran on this branch today; each note is kept below as its
> own section (per the README's "append, don't overwrite" rule).

---

## Session A — Social-platform integration (organic metrics)

**Session focus:** Scoped how Pulse should integrate with ad/social platforms
(Meta, X, TikTok), researched the current X API, and shipped the first slice:
pulling **organic social metrics** (Facebook / Instagram / TikTok) *into* Pulse.

### Shipped this session
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

### Decisions made (and why)
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

### What's next (priority order)
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

### Open questions / blockers
- **Blocker for "done":** live credentials to verify the connectors end-to-end.
- **TikTok organic** has no historical day-series via the Display API (snapshot
  only) — we store a daily snapshot per sync. Confirm that's acceptable, or pull
  from the Business API if richer history is needed (separate approval).
- **Whose accounts / multi-tenant?** Still the big fork for the *campaign
  management* ambition (own accounts = quick; clients connecting theirs = App
  Review + Business Verification + Tech Provider). Not needed for metrics, but it
  determines the next phase's effort.

### Pointers
- Files: `server/socialMetrics.js`, `server/index.js`, `test/social-metrics.test.js`,
  `client/src/pages/SocialPage.jsx`, `client/src/components/IntegrationsForm.jsx`,
  `client/src/pages/ClientLayout.jsx`, `client/src/App.jsx`, `client/src/lib/api.js`,
  `docs/PRODUCT_OVERVIEW_SALES.md`.
- Commits: `148f398` (feature), `688c270` (nav move).
- Mockup of the page (sample data): produced this session as a standalone HTML
  preview (not committed).

---

## Session B — Skills / agents concept + brief

**Session focus:** Brainstormed and specced the "skills / agents" concept for Pulse — self-running workers (a ticketing manager, a digital-marketing analyst) that watch a slice of a client's data on a cadence and advise or propose actions. Output is a design brief, not code.

### Shipped this session
- **`docs/SKILLS_BRIEF.md`** — new vision/architecture brief (commit `fb82b37`). Defines a *Skill* in Pulse's own terms (`Trigger → Gather → Reason → Act`), maps each part to existing modules (`scheduler.js` / `query.js`+`looker.js`+`forecast.js`+`goals.js` / `insights.js`+`promptRegistry()` / `os.js`+`actions.js`), lays out the **observe → advise → suggest-and-confirm → auto-act** autonomy ladder on top of the existing approval workflow, sketches `skills` / `skill_runs` tables, and phases the two hero skills.
- **Cross-refs** so the brief sits in the doc graph: a pointer from ROADMAP §1.1 and a companion-doc line in `PROJECT_OVERVIEW.md` (same commit). *Note:* main's reconciled `docs/ROADMAP.md` already references `SKILLS_BRIEF.md` at §1.1, so the pointer survived the merge — did not re-touch ROADMAP this session.
- **No application code** — this was a brainstorm + spec + an Anthropic-Agent-Skills feasibility check, nothing wired into the server.

### Decisions made (and why)
- **Build a generic Skill runtime, not N bespoke modules.** A skill = config + a registered prompt + a gather fn + an act target, mirroring how Engage recipes sit on one engine. Avoids a sprawl of one-off agents.
- **Ticketing Manager first; Marketing second.** Ticketing rides `forecast.js` (already projects sell-through) + `goals.js` (already flags behind-pace) — **zero new external connectors**, so it proves the whole loop now. Marketing is the same runtime but front-loaded with inbound connector ingestion (Meta/TikTok/GA4), so it waits.
- **Default autonomy = L1 (advise-only) for v1.** The autonomy ladder reuses the existing `actions.js` approver flow — `GOAL_GAP_SYSTEM` already proves an L2 "detect → draft campaign" loop runs in prod. L3 (changing real ticket/price state) is gated on Howler integration (4.1).
- **Numbers stay computed, AI only phrases.** Same rule as goals/forecast — a skill grounds every claim in `forecast.js`/`goals.js`/the resolver; prompts stay registered + auditable.
- **Anthropic *Agent Skills* are for the "Reason"/artifact layer, not the whole agent.** Verified via the claude-api skill: Agent Skills run in Anthropic's sandboxed code-execution container and can't reach Looker/SQLite behind our auth — gather, scope, schedule and acting-through-approvals stay in our Node app. Use a skill only when a role produces a **deliverable file** (e.g. an `xlsx` pricing/allocation model or a `pdf` board report); for advise-only text, a registered system prompt is simpler. If we adopt skills, surface each `SKILL.md` in `/api/admin/ai-overview` to keep the "everything the AI is told" audit complete.
- **Don't hand the loop to Managed Agents for v1.** We already have `scheduler.js` + hard server-side entity scoping; Anthropic's scheduled deployments would be a bigger architectural shift than v1 warrants.

### What's next (priority order)
1. **P1 — Skill runtime + Ticketing Manager at L1.** New disposable module `server/skills.js` (`{trigger, gather, reason, act, autonomy}`) + `skills`/`skill_runs` tables; a `TICKETING_SYSTEM` prompt added to `insights.js` **and** `promptRegistry()` in the same change (else `test/prompts.test.js` fails) and surfaced in `ai-overview`; fact pack from `forecast.js`/`goals.js`; output posts to the home briefing. Dual-surface (admin + client self-service). See `SKILLS_BRIEF.md` §7.
2. **P2 — L2 suggest-and-confirm.** Wire a skill's proposed action into the existing `actions.js` approval flow (creates a pending campaign the human one-click approves). Mostly plumbing, no new approval machinery.
3. **P3 — `skill_runs` audit surface + token cost.** Show what each skill saw/said/did and what it cost; feeds API-cost-per-client (ROADMAP 5.3) and informs tier gating (5.2).
4. **P4 — Marketing skill.** Needs inbound connector ingestion first. **Big head start from Session A:** `server/socialMetrics.js` already pulls organic Meta/TikTok metrics into Pulse — check whether that (plus GA4) covers enough of a marketing skill's inputs before scoping any new connector.
5. **Optional — artifact-producing roles via Agent Skills.** When a role needs an Excel model or PDF report, reach for Messages-API Agent Skills (`xlsx`/`pdf`) rather than text-only insights.

### Open questions / blockers
- **Default autonomy ship setting** — leaning L1-advise, L2+ opt-in per client; needs Shai's nod.
- **Skill ownership default** — AM-configured vs client self-service (same open question as Engage §9.3).
- **Commercial packaging** — are skills a premium-tier feature (5.2)? Sizing needs `skill_runs` cost data (5.3). Decide before GA.
- **L3 auto-act and behavioural (vs cadence) triggers** are both gated on **Howler integration (4.1)** — out of our control; keep tracked together.
- **Connector reuse** — does Session A's `socialMetrics.js` already cover enough of the Marketing skill's inputs to skip a fresh build? Worth a look before P4.

### Pointers
- Files/areas touched: `docs/SKILLS_BRIEF.md` (new), `PROJECT_OVERVIEW.md` (companion-doc line), `docs/ROADMAP.md` §1.1 (pointer — now reconciled on main).
- Related docs: `docs/SKILLS_BRIEF.md`, `docs/ENGAGEMENT_ENGINE.md` (the Action layer a skill acts through), `docs/ROADMAP.md` §1.1 / 4.1 / 4.3 / 5.2 / 5.3.
- Key modules a skill builds on: `server/scheduler.js`, `server/insights.js` (+ `promptRegistry()`), `server/forecast.js`, `server/goals.js`, `server/actions.js`, `server/os.js`. New on main worth scanning for P4: `server/socialMetrics.js`, `server/slack.js`.
