# Pulse — Full Technical Review (CTO assessment)

_Date: 2026-07-01 · Scope: server (~26k LOC), React client (~35k LOC), deploy/ops · Reviewed for stability, scalability, security, speed, and operational maturity._

## Verdict

Pulse is an **unusually disciplined codebase for its size and team**: fail-closed multi-tenant scoping enforced at one point, parameterized SQL throughout, write-only secrets, hashed API keys, HMAC-verified webhooks, self-enforcing architecture line-budget tests, an auditable AI prompt registry, a hermetic 297-test suite (all passing, 61s), and documentation that is actually kept current. The code quality is not the problem.

The real risks are **operational and single-instance**, in this order:
1. **No backup / disaster recovery** — one SQLite file on one disk. Loss = permanent, total.
2. **Crash-unsafe long-running sends** — the routine auto-deploy restart can double-send or strand campaigns/digests.
3. **One CPU-bound path (campaign audiences) can OOM the 512 MB instance and freeze the app for everyone.**
4. **Deploys are ungated by CI and there is no alerting** — untested code reaches clients, and failures are silent until a human looks.

None of the fixes require re-architecting. Postgres is *not* the next move; getting CPU-bound and scheduled work off the request process is.

---

## P0 — Do this week

### 1. Continuous off-box database backup (Critical)
Single 1 GB Render disk holds `howler.db`; `numInstances: 1`; no `VACUUM INTO`, no `.backup()`, no Litestream, no snapshots wired. `deploy.sh` backs up on the VM path but that path isn't used — production is Render. The in-app JSON export is admin-triggered, partial (missing goals/alerts/segments/eventops/billing/api-keys/etc.), and ships plaintext secrets. WAL is never checkpointed, so even a naive file copy misses committed data.
- **Fix:** Litestream streaming WAL → S3/R2 (~half a day, WAL already on). This removes the single scariest risk in the review.

### 2. Campaign audience path — OOM + open-storm freeze (Critical, perf)
`resolveAudience` pulls up to 500k Looker rows (default 50k), parses 25–100 MB JSON on the event loop, caches it in `qCache` (500-entry count bound, **no byte cap**), stores it in the `actions.audience` column forever, and **re-parses the whole thing on every email open** — the open pixel (`/o:token`) and click redirect do a full-table scan with per-row `json_extract` and no index (`actions.js:1795`). A 30k-recipient blast + an open storm can freeze all requests and OOM-restart the instance mid-blast.
- **Fix:** (a) indexed `click_token` column → point lookup; (b) make `rowToAction` parse `audience` lazily and select explicit columns, not `SELECT *`; (c) `noCache` flag for audience pulls + byte-budgeted `qCache` eviction.

### 3. Crash-safe sends (High, stability)
`autoDeploy: true` + no SIGTERM handler means any push to `main` mid-send kills the loop.
- Campaigns (`actions.js:784`) iterate the whole audience in-process with only aggregate counters (the billing source of truth) flushed every 20 recipients, no per-recipient ledger, no resume-on-boot → stranded `running` campaigns, under-counted billing, no safe finish.
- Digests (`scheduler.js:217`) and alerts (`alerts.js:359`) send **then** update `next_run_at`/state → a crash in that window re-sends the entire digest to all recipients on restart.
- **Fix:** per-recipient send ledger for campaigns; mark-before-send (stamp `started_at`/advance `next_run_at` before delivery) for digests/alerts; SIGTERM handler that drains ticks and pauses in-flight campaigns; pick one idempotency convention and document it (the codebase currently has both).

### 4. Gate deploys on CI + alerting on silent failures (High, ops)
`autoDeploy: true` fires on push immediately; GitHub Actions runs in parallel and its result is ignored — a red suite and a live deploy can coexist. Separately, when a nightly digest/alert/connector fails it writes `last_status='error…'` + `console.error` to stdout and **nothing else** — nobody is paged.
- **Fix:** disable autoDeploy, deploy via a Render deploy-hook job gated on `needs: [lint, test, build]`. Add a Slack webhook on scheduler/mailer/connector `error` events (the Slack module already exists — one-day win).

---

## P1 — Next 2–4 weeks

### Security (all verified against code; no Criticals found)
- **[HIGH] Authenticated SSRF via Owl "Google Sheet" upload** (`owlUploads.js:55`): user-supplied URL fetched with `redirect: 'follow'`, no host allow-list or private-IP block; response readable back through upload rows → read-SSRF against `169.254.169.254`/internal services. Restrict to `docs.google.com` (+intended hosts), block private IPs after DNS resolution, disable/re-validate redirects, cap size *before* buffering.
- **[MED] No security headers** — no helmet/CSP/X-Frame-Options/HSTS/nosniff. Add helmet with a tuned CSP.
- **[MED] WhatsApp webhook secret is optional** (`owlWhatsapp.js:585`) — when unset, anyone can spoof a sender MSISDN and drive a scoped Owl turn. Make the secret mandatory.
- **[MED] No session invalidation on password reset/logout** (`auth.js`) — stateless 7-day JWTs; a stolen cookie survives a password reset. Add per-user `tokenVersion` checked in `attachUser`, bumped on reset.
- **[MED] No rate limit on `/api/owl/chat`** — the most expensive endpoint (agentic LLM loop) is unthrottled. Add `rateLimit({ by:'user', max:~10/min })`.
- **[MED] `xlsx@0.18.5` (client)** — high-sev prototype pollution + ReDoS, no npm fix; parses user spreadsheets in-browser. Move to SheetJS CDN build or `exceljs`.
- **[LOW]** Pin JWT algorithm to HS256; add per-account login throttle (currently per-IP only); TextTile regex HTML sanitizer is bypassable — swap for DOMPurify.

### Stability
- **[HIGH] External calls lack timeouts:** Anthropic client built with no `timeout`/`maxRetries` (10-min SDK default) — one hung call blocks the *serial* scheduler tick for every client. web-push (`push.js:90`, `Promise.all`) and GitHub fetch (`github.js:57`) also uncapped. Set `timeout: 120_000, maxRetries: 1` on Anthropic; wrap push in `Promise.allSettled` + per-send timeout; add a timeout to the GitHub fetch.
- **[HIGH] `asyncHandler` discipline ~10% adopted:** 49 unwrapped async routes (hang risk on rejection) and 37 sites returning raw `err.message` to clients — including client-facing `/api/run-query`, `/api/drill`, `/api/my/briefing` leaking raw Looker/Anthropic bodies. Mechanical sweep to wrap handlers + throw `HttpError`; add an `architecture.test.js`-style test that fails on unwrapped `async (req,res)`.
- **[MED] Non-atomic multi-statement writes** in `os.js` (thread+message+receipts), `tickets.js` (hard delete), `goals.js` — wrap in `sql.transaction(...)` (cheap, all synchronous).
- **[MED] No schema versioning:** ~60 boot-time `ALTER TABLE`s, some crash-loop the deploy on failure, others silently swallow and then throw `no such column` at runtime. Adopt `PRAGMA user_version`-gated, transactional migration steps; make "skipped" catches fail loudly.

### Performance / scalability
- **[HIGH] Digest scheduler runs serially**, 30–60s each. Same 07:00 slot → last digest ~40 min late at 50 clients, >1 hr at 120. Add 2–3-job concurrency (Looker gate of 8 and Anthropic tolerate it) and/or jittered send times.
- **[HIGH] `user_views` grows forever**, scanned by time-range with no usable index; `adminActivityReport` + `lastViewForUsers` (runs on every `/api/admin/users`) do full-table GROUP BYs. Add `INDEX(at)`, prune to rolling 12 months, keep a tiny `user_last_view` table.
- **[MED] Synchronous resvg/echarts PNG rendering** on request + scheduler paths (`tileimg.js`, `owlChartImg.js`, `emailBanner.js`) — 10–20 PNGs back-to-back = 1–5s event-loop block. Move to a `worker_threads` pool; render at 1× by default.
- **[MED] Full dashboard-def `JSON.parse` on hot paths** (`listDashboards` parses every def for `tileCount`; `clientCatalogue` on every home load). Memoise parsed defs in an LRU keyed by `(id, updated_at)` — biggest steady-state CPU tax, ~20-line fix.
- **[MED] `listUsers()` is N+1** and runs in the digest loop, campaign list, and `teamMembers`. One `LEFT JOIN`; add `(entity_id)` index on `user_entities`.

### Frontend
- **[HIGH] `manualChunks` routes all node_modules into an eager `vendor` chunk**, defeating the deliberate dynamic imports of `xlsx`/`tesseract.js`/`html5-qrcode` — every client phone downloads ~430 kB of OCR/spreadsheet/scanner code. Return `undefined` for those packages (one line).
- **[HIGH] ~965 kB gzip at first paint**; full echarts loaded eagerly via `import * as echarts` in `ChartTile.jsx`. Switch to `echarts/core` + register only used charts (cuts 50–65%); optionally `React.lazy` ChartTile.
- **[MED]** `AdminPage.jsx` is a 5,604-line god-file (the server's own line-budget rule doesn't extend to the client — it should); stale-response races in `ViewPage.jsx` loaders (no AbortController/alive flag); duplicate 20s polling of `/api/os/inbox` from two components (one keeps polling in background tabs).

---

## P2 — This quarter (structural)

- **Worker process** owning schedulers, campaign sends, digest generation, and PNG rendering (same SQLite file via WAL multi-process, or a job table). This is the real architectural move — fixes the serial digest pile-up, PNG blocking, warmer burn, and de-risks deploys, **without touching the data layer.**
- **SIGTERM graceful shutdown + DB-touching `/health`** (currently returns ok without touching SQLite — a wedged DB reports healthy).
- **Sentry** in `errorMiddleware` + `unhandledRejection` (5xx history is stdout-only today).
- **`scheduler.test.js`** — the code that emails clients unattended at 07:00 has zero tests (hand-rolled timezone/DST math, reschedule semantics). Plus a minimal Playwright smoke (login → dashboard → admin) in CI.
- **Pre-plan extractions** from `index.js` (3046/3100), `actions.js` (1897/1900), `db.js` (1799/1800), `insights.js` (1149/1150) — all 1–3 lines from their architecture-test cap.
- **Fix `EXPORT_TABLES` drift** (partial "backup") and stop shipping plaintext secrets in the export; migrate settlement PDFs to disk (mirror `os_attachments`).
- **Ops runbook + working local-dev quickstart** — bus factor is ≈1; ops knowledge lives in one head.

### When Postgres?
Not next. Write volumes are modest, data fits SQLite, sync reads are microseconds — the pain is CPU-bound work and singleton schedulers, which Postgres doesn't fix. Migrate when you need >1 web instance (sustained >~80–100 concurrent users), zero-downtime deploys become contractual, or the worker split makes cross-process coordination awkward — roughly the ~100-client mark.

---

## Strengths worth preserving

Fail-closed tenant scope engine (`query.js applyScope`, single enforcement point) with HTTP-level proof tests; the Looker client (timeouts, concurrency gate of 8, race-safe token cache, SWR result cache — the load-bearing scalability feature); write-only secrets with masking; hashed single-use API keys pinned to one entity; HMAC webhooks; re-entrancy guards + kill switches on every background tick; bounded logs everywhere; the architecture line-budget ratchet with its anti-gaming guard; the prompt registry + test; the declarative audit allowlist; genuinely current docs. These habits are exactly what make the operational fixes above cheap.
