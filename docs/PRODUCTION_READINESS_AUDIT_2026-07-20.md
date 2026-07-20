# Production-Readiness Audit — Howler Pulse
### Run under the Platform45 Production-Readiness Audit Framework v1.0

**Date:** 2026-07-20 · **Auditor:** Claude (automated multi-agent audit, read-only) · **Repo:** https://github.com/Shai-Xai/Shai-looker2 · **Deployed:** https://howler-pulse-v2.onrender.com

---

## 1. Verdict

> ## Production-ready with follow-ups — 71% weighted score, critical gate **passed** —
> ## conditional on closing a short Phase-0 list that is configuration, not code.

- **Critical-gate rule:** no dimension scored 0 on Security, Data integrity, or Compliance → the gate does **not** fail the audit.
- **Weighted score:** 56.5 / 80 = **70.6%**, which lands in the framework's **66–85% "Production-ready with follow-ups"** band.
- **However**, the severity model overrides the number: one Critical-severity finding (off-box backups / key escrow unverified — F1) and a cluster of High findings (CI-gated deploys off, no POPIA privacy wrapper, no data-subject deletion) must be treated as launch-gating. Since the system is **already live in production**, read that as: *close Phase 0 this week*.
- Context note: this system dramatically outperforms the typical "vibe-coded" profile the framework targets. It has 892 passing server tests run in CI, a central sanitizing error layer, encrypted secrets, fail-closed tenant scoping, tested backup/restore code, and unusually honest self-documentation (`docs/PRODUCTION_READINESS.md` is its own punch list). The remaining risk is concentrated in **unverified operational configuration** and the **legal/privacy wrapper**, not in the code.

---

## 2. Calibration (framework §2/§3)

Intended use assessed against: multi-tenant SaaS for Howler's event clients and internal teams; holds **attendee/contact PII** (emails, phones, names, ticket data — campaign audiences up to a 500k hard cap), **financial documents** (settlement PDFs), messaging inboxes, and drives outbound **email/SMS/WhatsApp campaigns**. South African operator → **POPIA** applies (esp. §18 notification, §69 direct marketing). No payment-card data is touched anywhere (verified — `server/billing.js` is an internal rate card only). Because regulated personal data is held and processed through third-party AI/messaging processors, the **Compliance weight is raised to 3×** per the framework's rule.

Inputs available: full source repo, git history, tests, CI config, `render.yaml` (IaC), extensive docs. Not available: the live Render dashboard, so dashboard-only configuration (`sync: false` env vars — backup S3 credentials, ops webhook, deploy hook) **cannot be verified from the repo**; the repo's own dated punch list (`docs/PRODUCTION_READINESS.md`, 2026-07-08) records those items as unchecked. Findings are marked accordingly.

Method: automated sweep (dependency audit, secret scan over working tree + history, full test run, lint) followed by a six-track parallel manual deep-dive covering all ten dimensions, including a dedicated IDOR sweep of every route module with two-perspective ownership checks.

---

## 3. Scorecard (framework §5)

Rubric: 0 Critical · 1 Poor · 2 Basic · 3 Good · 4 Strong. Half-points used where a dimension genuinely straddles two bands (noted).

| # | Dimension | Score | Weight | Weighted | One-line rationale |
|---|---|---|---|---|---|
| 1 | Security & authentication | **3** | 3× | 9 | Hand-rolled but genuinely well-engineered: HS256-pinned JWT with token-version revocation, bcrypt-12, 2FA on every sign-in path, fail-closed tenant scoping, **no IDOR / no unauthenticated data exposure found**, AES-256-GCM write-only secrets, HSTS + real CSP. Held off 4 by a regex HTML sanitizer, SameSite-only CSRF posture, and a fail-open in-memory rate limiter. |
| 2 | Data integrity & database | **3** | 3× | 9 | Correct WAL/pragma setup, FK-cascaded core spine, parameterised SQL throughout, crash-safe send ledger with atomic claims, tested backup + full-export code. Held off 4 by no versioned migration system (failed ALTERs swallowed), app-layer-only referential integrity on feature tables, and ad-hoc validation. **Drops to 2 if off-box backups are in fact still unconfigured (F1).** |
| 3 | Error handling & resilience | **3** | 2× | 6 | Central sanitizing `errorMiddleware` + `asyncHandler`, every external call time-bounded (Anthropic/Resend/Slack/TikTok/push/Looker), SSRF-hardened fetch, re-entrancy-guarded background loops, claim-before-send crash safety, excellent React error boundaries. Minor error-text leak seams; convention enforced by discipline, not lint. |
| 4 | Testing & QA | **3** | 2× | 6 | 892/892 tests green in ~145s: real HTTP against real SQLite with production auth middleware; regression pins on money paths (double-send race, consent-at-send, bounce suppression); self-policing architecture + prompt-registry meta-tests; CI runs lint+test+build on every push/PR. Zero client-side tests, no e2e, no coverage tooling. |
| 5 | Observability & operations | **2.5** | 2× | 5 | Slack ops-paging on 5xx/backup/disk with throttling, DB-touching `/health`, disk watchdog that fails health at 95%, rich admin health panels, AI usage metering. But the substrate is bare `console.log` — no structured logs, no request/correlation IDs, no client-side error tracking, no external uptime probe in repo. |
| 6 | Performance & scalability | **3** | 1× | 3 | Performance-literate: SWR query cache with OOM cap, streamed AI, tree-shaken/lazy client bundle, indexed hot paths, guarded loops. Not survivable at its own advertised 500k-contact cap: single-JSON-blob audiences (~100–200MB, most likely OOM), ~8 msg/sec single-process send loop (~17h max blast), sync chart→PNG rendering on the shared event loop. |
| 7 | Infrastructure & deployment | **3** | 2× | 6 | `render.yaml` is real IaC for prod + a properly isolated staging (own disk/secrets + code-level `OUTBOUND_DISABLED` kill-switch); persistent disk; documented restore; secrets never in git. But deploys are **not** CI-gated (red main still auto-deploys), no rollback doc, single-instance = 30–90s downtime per deploy, and `deploy.sh` documents a dead VM path. |
| 8 | Compliance, privacy & legal | **2** | **3×** (regulated data) | 6 | Engineering controls are strong (signed one-click unsubscribe, per-channel consent enforced at send, bounce/complaint suppression, SHA-256-hashed ad-audience sync, consent-first fan capture). The legal wrapper is essentially absent: **no privacy policy/terms anywhere**, no DSAR delete/export, consent assumed when no consent column is mapped, AI/messaging processors undisclosed, retention partial and undocumented, pixel fires without consent by default. |
| 9 | Code quality & maintainability | **3.5** | 1× | 3.5 | Disciplined, self-enforcing server (ratcheting line budgets with anti-gaming guard, consistent module pattern, 12 runtime deps, 0 lint errors). Client has god-files (`AdminPage.jsx` 6,288 lines) and no budget equivalent; several server files sit 1–8 lines under their caps. |
| 10 | Documentation & continuity | **3** | 1× | 3 | Best-in-class living docs (dated punch lists, candid technical review, `SESSION_HANDOFF.md`, step-by-step restore/CI-gate instructions). Bus factor ≈ 1, all 51 commits by "Claude" over 3 days (squashed history), ownership/vendor custody register absent, and the five ops blockers in its own punch list are still unchecked. |
| | **Total** | | **Σw = 20** | **56.5 / 80** | **= 70.6%** |

---

## 4. Findings register (framework §6)

Consolidated and deduplicated across all audit tracks. Effort: S ≤ 1 day · M = days · L = week+.

### Critical — fix now, no exceptions

| ID | Finding | Evidence | Business impact | Remediation | Effort |
|---|---|---|---|---|---|
| F1 | **Off-box backups, `MASTER_KEY`/`SESSION_SECRET` escrow, and a restore rehearsal are all unverified** — nightly snapshots currently live on the *same* Render disk as the database, and a restore without the exact `MASTER_KEY` renders every encrypted client secret unreadable. The backup run reports "ok" either way. | `docs/PRODUCTION_READINESS.md:45-56` (unchecked, dated 2026-07-08); `server/backup.js:181-188`; `render.yaml` (`BACKUP_S3_*` `sync:false`); `DEPLOY.md` §9 | Loss of the one disk = **total, unrecoverable loss of every client's data** including settlements and campaign history. This is the single existential risk in the system. | Set `BACKUP_S3_*` (R2) in Render, run `POST /api/admin/backups/run`, confirm `uploaded:true`; escrow `MASTER_KEY`/`SESSION_SECRET` in a password manager; rehearse the documented restore on staging once and record timings. Make backup status warn loudly when `offBoxConfigured:false`. | **S** |

### High — fix before relying further on production, or formally accept in writing

| ID | Finding | Evidence | Business impact | Remediation | Effort |
|---|---|---|---|---|---|
| F2 | **Deploys are not gated on CI** — `autoDeploy: true` on `main`; the CI deploy job self-documents that it skips until `RENDER_DEPLOY_HOOK` is set and auto-deploy turned off. A commit that fails the 892-test suite still goes live in minutes. | `render.yaml`; `.github/workflows/ci.yml` deploy job; `docs/PRODUCTION_READINESS.md` (unchecked 🔴) | The entire test investment doesn't protect production. | Already scripted in the docs: set the deploy-hook secret, flip `autoDeploy: false`, re-sync blueprint. | **S** |
| F3 | **No privacy policy or terms anywhere**, and the tracking pixel's consent mode defaults to firing without consent. Fans/attendees whose PII flows through Anthropic, Resend, Clickatell, Meta and TikTok are never notified. | `client/src` grep (no policy page); `server/fanOwl.js`; `server/surveyWeb.js:91`; `server/pixel.js:60-64` | POPIA §18 notification duty unmet; regulatory + reputational exposure for Howler *and* its clients. | Publish a privacy notice (login, fan chat, surveys, campaign footers); name all processors; make pixel consent-gated by default. Confirm specifics with a qualified professional — this audit flags legal risk, it doesn't give legal advice. | S–M |
| F4 | **No data-subject deletion or export (DSAR)**, and `deleteEntity` removes only the `entities` row — audiences, fan profiles, surveys, inbox, mail logs and settlement rows are orphaned forever across ~40 feature tables (no FKs). | `server/db.js:660`; `server/index.js:437`; feature tables lack `REFERENCES` (e.g. `server/actions.js:59`) | Cannot honour a POPIA/GDPR erasure or access request without hand-written SQL on prod; offboarded clients' PII persists indefinitely. | Build an admin "forget contact" sweep (keep the suppression row) and a `purgeEntityData(entityId)` called from entity delete (`server/transfer.js` proves table enumeration works). | M |
| F5 | **Looker API3 secret rotation still unchecked** — the deploy checklist itself says the secret "was shared in chat during dev". (Related past incident: a real session JWT was once committed as `c.txt`; verified no longer present anywhere in history.) | `DEPLOY.md:163`; `.gitignore` note | A credential known to have left secure channels may still be live. | Rotate the Looker secret; tick the box. | **S** |
| F6 | **No versioned migration system; failed ALTERs are swallowed** — per-module `try/catch → "migration skipped"` continues boot, leaving schema silently behind the code until runtime 500s. | `server/db.js:131,134-137`; `server/actions.js:205`; `server/mailer.js:42` | Silent schema drift; no record of what version a DB is at; no rollback story (forward-only DDL-on-boot). | Ops-alert (or fail boot) on migration errors; add a `schema_version` marker; consolidate ad-hoc ALTER blocks into one ordered, logged runner. | M |
| F7 | **Audience snapshots are single JSON blobs** — up to 500k contacts ≈ 100–200MB TEXT per campaign; one synchronous `JSON.parse` per access; the Looker layer has already brushed V8's string-length ceiling. Most likely OOM at the system's own advertised scale. | `server/actions.js:63-64,224-226`; `server/audienceQuery.js:70`; `server/looker.js:146` | A single large approve can take down the (only) production process mid-campaign. | Normalise audience members into a table; page the Looker fetch; iterate sends by cursor. | L |
| F8 | **Bus factor ≈ 1 with squashed history** — all 51 commits authored by "Claude" spanning 3 days; build narrative lives in AI-session transcripts and docs; account/vendor custody (Render, Resend domain, R2, GitHub secrets) undocumented. | `git shortlog -sne`; `docs/TECHNICAL_REVIEW_2026-07.md`; `render.yaml` `sync:false` values | The business-continuity risk the framework's §4.10 exists to catch: the break-glass knowledge is exactly what isn't escrowed. | Keep `SESSION_HANDOFF.md` current; second human walks the restore drill; add an ownership/custody register (who owns which dashboard — no secret values). | M |

### Medium — schedule soon after Phase 0

| ID | Finding | Evidence | Remediation | Effort |
|---|---|---|---|---|
| F9 | Consent is assumed when no consent column is mapped (`emailOk = ignoreConsent \|\| !emailConsentField \|\| isYes(...)`), and the `ignoreConsent` "transactional" bypass is available to clients whose approval gate is off. | `server/audienceMap.js:58-59`; `server/actions.js:349` | Require a recorded "this list is consented" attestation when unmapped; restrict `ignoreConsent` to admin-only or force approval. | S |
| F10 | No structured logging, no request/correlation IDs, no client-side error tracking — Render log stream is grep-only; browser crashes are invisible to the team. | `server/http.js:36` et al.; no pino/morgan/Sentry in `package.json` | Request-ID middleware (S) + minimal structured logger + Sentry (server + React boundary). | S–M |
| F11 | Campaign send throughput hard-capped ~8 msg/sec in-process (120ms sleep per recipient; one Resend POST per recipient — batch API unused); chart→PNG digest rendering (`echarts` SSR + `Resvg`) is fully synchronous on the shared event loop. | `server/actions.js:889`; `server/mailer.js:175-197`; `server/tileimg.js:154-159` | Resend batch endpoint (~50× lift) or worker process; move rendering to `worker_threads`. | M |
| F12 | Retention is partial and undocumented as policy — pruning exists for usage/opens/clicks/pixel/mail-log, but audience snapshots, fan profiles, survey responses, attachments and settlement PDFs are kept forever ("a product decision" per `server/retention.js:11-12`). | `server/retention.js` | Decide + document per-table retention; purge completed-campaign snapshots after N months. | M |
| F13 | AI/messaging processor disclosure missing — fan chat/lead/Owl data flows through Anthropic with no DPA record or processor list (engineering control is good: contact fields are filter-only, never enumerable by the model — `server/owlTools.js:81-118`). | `server/owlTools.js:117-118` | Fold into F3's privacy notice + a records-of-processing doc. | S |
| F14 | Regex-based HTML sanitizer on tile HTML (author-flagged); mitigated by app-wide `script-src 'self'` CSP. | `client/src/components/tiles/TextTile.jsx:95-102`; `server/index.js:74` | Replace with DOMPurify. | S |
| F15 | `asyncHandler`/try-catch discipline is unenforced convention across 24 files of hand-rolled handlers (all currently safe — verified); a future unwrapped handler hangs its request. | grep of `async (req,res)` across `server/` | ESLint rule or architecture test asserting wrapped handlers. | M |
| F16 | No rollback procedure documented (Render rollback × forward-only boot migrations interaction). | `DEPLOY.md` (absent section) | One-page rollback doc; keep migrations additive. | S |
| F17 | Client: zero tests, no e2e, god-files (`AdminPage.jsx` 6,288 lines) with no line-budget ratchet equivalent. | `client/package.json`; `wc -l` | Vitest + testing-library on flag/nav/editor logic; one Playwright smoke on staging; extend the architecture budget to `client/src`. | M |
| F18 | `xlsx` client dependency has a high-severity advisory (prototype pollution + ReDoS) with **no fix available**. | `npm audit` (client); `docs/TECHNICAL_REVIEW_2026-07.md:34` | It's already lazy-loaded (never in first-paint bundle); replace with `exceljs`/`sheetjs-ce` fork or isolate to admin-only import paths. | M |
| F19 | Large binaries (settlement PDFs, attachments, mail assets) stored base64 in SQLite TEXT — +33% size, multiplied into every backup on a 5GB shared disk. | `server/db.js:555,572`; `server/tickets.js:98-106`; `server/os.js:65-74` | Move blobs to R2 with DB metadata rows; attachment prune policy. | L |
| F20 | Nightly backup cadence = up to 24h data-loss window (RPO). | `server/backup.js:209-216` | Second daily run (S) or Litestream→R2 continuous replication (M). | S–M |

### Low — backlog

| ID | Finding | Evidence |
|---|---|---|
| F21 | No CSRF tokens — posture rests solely on `SameSite=Lax`; add an Origin-allowlist check on mutating routes as belt-and-braces. | `server/auth.js:115` |
| F22 | In-memory rate limiter is single-instance and fails open; fine today, breaks on horizontal scale. | `server/ratelimit.js:21,67-70` |
| F23 | Anonymous client-roster enumeration: `/px-test?e=<entityId>` returns the client's name for any valid id; `/px.js` leaks per-client ad-pixel ids; `POST /px` allows anonymous event poisoning (rate-limited 300/min/IP). | `server/pixel.js:103-143` |
| F24 | Error-text leak seams: raw `err.message` to admins on query/drill 500s and inside 200-status payloads (goals, settlements SSE, surveyWeb 502). | `server/dashboards.js:452,471`; `server/goals.js:860+`; `server/settlements.js:158,196` |
| F25 | Public unsubscribe/click-tracking integrity rests entirely on `clickToken`/`parseUnsubToken` unforgeability — forgery would allow attribution poisoning and arbitrary unsubscribes. Confirm HMAC-signed. | `server/actionTracking.js:28,47,122-136` |
| F26 | Fully-silent outer `.catch(() => {})` on some background ticks — a structural failure vanishes every interval. | `server/actions.js:1326`; `server/alerts.js:408` |
| F27 | Alert throttle keyed by kind only — a second concurrently-failing route is suppressed for 15 min. | `server/ops.js:37` |
| F28 | Hard-coded prod URL fallback in mail links; set `APP_URL` per environment. | `server/mailer.js:127` |
| F29 | Money as binary floats in billing rollups; fine for internal reporting, unsafe if ever invoiced from. | `server/billing.js:19,68-76` |
| F30 | `SESSION_SECRET`/`MASTER_KEY` may fall back to disk-persisted generated keys; require env vars in prod (fail boot if absent). | `server/auth.js:28-34`; `server/secretbox.js:39-49` |
| F31 | Repo hygiene: `deploy.sh` documents a dead VM/systemd path; sales collateral + tracker artifacts in repo root; 93 ESLint warnings; duplicated `audience_sync_log` DDL owned by two modules; stale test counts in docs. | repo root; `server/meta.js:46` + `server/tiktok.js:56` |
| F32 | Non-transactional create flows (user+memberships, set+members) — crash window leaves fail-closed orphans; mixed timestamp conventions. | `server/db.js:998-1000,1168-1172,847` |
| F33 | Ops Slack webhook is optional config that degrades silently to console; no external uptime probe in repo. | `server/ops.js:22-26` |
| F34 | Fixed-LIMIT lists (inbox 200, tickets 500, comments 500) without cursors — UX cap, not a perf risk; social feed already does cursors right. | `server/os.js:263`; `server/tickets.js:390` |

---

## 5. Notable strengths (framework: credit what works)

- **No IDOR found.** A dedicated sweep of every route module confirmed `/api/my/*` surfaces verify entity membership before acting and by-id handlers re-check ownership; public surfaces are token-gated or serve only published data.
- **No secrets in the repo or its history** (working tree + `git log -p` sweep; the one historical `c.txt` JWT incident is confirmed purged).
- **Auth engineering above its weight class:** token-version epoch revocation, HS256 pinning, bcrypt-12 with timing-equalized compares, 2FA gating every sign-in path (password, reset, magic link), constrained impersonation, super-admin escalation guards.
- **The money path is crash-safe:** per-recipient send ledger with composite PK, atomic conditional status claims (concurrent approve → 409, regression-tested), claim-before-send drips, boot-resume sweep.
- **Consent/suppression engineering is genuinely strong:** signed one-click unsubscribe (RFC 8058), guaranteed-working footer injection, per-channel consent enforced at send and re-checked mid-journey, bounce/complaint suppression from signed webhooks.
- **A real test culture:** 892 tests driving real HTTP against real SQLite with production middleware, plus self-policing meta-tests (ratcheting line budgets with anti-gaming guards, prompt-registry completeness, mounts-must-exist).
- **Staging done right:** separate service/disk/secrets plus a *code-level* `OUTBOUND_DISABLED` kill-switch so staging can never message real customers.
- **Honest self-documentation:** the repo's own `docs/PRODUCTION_READINESS.md` already names most of what this audit found — the gap is execution of its unchecked boxes, not awareness.

---

## 6. Remediation roadmap

**Phase 0 — this week (all S-effort, mostly Render dashboard; the highest-value afternoon available):**
1. F1 — activate off-box backups to R2, verify `uploaded:true`; escrow `MASTER_KEY`/`SESSION_SECRET`; run the restore drill on staging.
2. F2 — flip deploys to CI-gated (deploy hook + `autoDeploy: false`).
3. F5 — rotate the Looker API3 secret.
4. F33 — verify the ops Slack webhook is actually configured in prod; add an external uptime probe on `/health`.

**Phase 1 — next 30 days (compliance wrapper + diagnosability):**
5. F3/F13 — publish the POPIA privacy notice naming all processors; consent-gate the pixel; confirm with a legal professional.
6. F4 — contact-level forget/export + `purgeEntityData` on entity delete.
7. F9 — consent attestation when no consent column is mapped; restrict `ignoreConsent`.
8. F10 — request IDs + structured logging + Sentry.
9. F6 — migration runner with loud failures + `schema_version`.
10. F12 — write down the retention policy and implement the missing prunes.

**Phase 2 — next quarter (scale + quality):**
11. F7/F11 — normalise audience storage, batch sends, worker-thread rendering (prerequisite to honestly advertising the 500k cap).
12. F17 — client test harness + one e2e smoke on staging; extend line budgets to `client/src`.
13. F14/F15/F16/F18 — DOMPurify, handler-wrap lint rule, rollback doc, replace `xlsx`.
14. F19/F20 — blobs to R2; tighten RPO (second daily backup or Litestream).
15. Execute `docs/POSTGRES_MIGRATION_SCOPE.md` when multi-instance/HA is required (F22 rides along).

---

## 7. Scope notes & deliberate exclusions

Per framework §8: this was a read-and-assess audit — nothing was fixed, and it is **not** a formal penetration test, legal/compliance certification, or load test. Items warranting specialist follow-up: a focused pen test of the public surfaces (tracking, pixel, fan chat, MCP/OAuth), a POPIA review by a qualified professional, and a load test of campaign sending at target volume. Dashboard-only configuration could not be verified from the repo; Phase 0 items F1/F2/F33 should be verified in the Render dashboard (https://dashboard.render.com) before this report is treated as closed.

*Produced with the Platform45 Production-Readiness Audit Framework v1.0. Pair with the client report template for external readouts.*
