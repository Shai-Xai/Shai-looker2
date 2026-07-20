# Production readiness — punch list

The consolidated result of a five-track technical review (security & auth ·
multi-tenant isolation · data durability & ops · runtime stability · campaign
engine) run on 2026-07-08, ahead of onboarding the first real clients. Every
item was verified in code, not speculated. Work the list top-down; tick items
off (and date them) as they land, and delete sections that stop being true.

**Overall verdict:** the platform's foundations are sound — no cross-tenant
leak, no SQL injection, no leaked secrets, fail-closed scoping, crash-safe
send ledgers, timeouts on external calls, green CI (525+ tests). The items
below are the gap between "well-built" and "safe to put in clients' hands."

Severity key: 🔴 blocker before onboarding · 🟠 first weeks · 🟡 hardening ·
⚪ accepted limit (know it, don't fix yet).

---

## 🔴 Blockers — code

- [x] **Concurrent approvals could double-send an entire campaign** — the
  approve route checked `status === 'draft'`, then did a slow Looker audience
  pull, then flipped to `running` unconditionally; two overlapping approvals
  (or a double-tap) both passed and each blasted the full audience.
  **Fixed 2026-07-08:** status + audience now written in one atomic
  conditional claim (`… WHERE status='draft'`, loser gets 409), the
  pending→draft flip is conditional, sequence activation claims atomically,
  and `runCampaign` has an in-process re-entrancy guard so the boot-resume
  sweep can never overlap a live run. Regression test:
  `test/campaigns.test.js` ("two concurrent approvals…").
- [x] **SMS opt-outs were recorded but not enforced for phone-only
  recipients** — the `/u` token for a phone-only recipient carries their
  phone, but every suppression check compared emails only, so they saw
  "You're unsubscribed" and still got the next campaign (POPIA/GDPR
  violation). **Fixed 2026-07-08:** suppression is contact-aware
  (`isSuppressed` in `server/audienceMap.js` checks email AND raw/normalised
  phone), `/u` stores contacts canonicalised, the suppression set expands
  legacy phone rows to normalised msisdn form, and audience dedupe/combine
  now keys on the normalised phone (no more double-SMS to `+27 82…` vs
  `082…`). Regression test: `test/campaigns.test.js` ("a phone-only SMS
  opt-out…").

## 🔴 Blockers — configuration (verify in Render, ~1 afternoon)

- [x] **Off-box backups** — **Done 2026-07-20** (configured by Shai per
  `docs/BACKUP_SETUP_RUNBOOK.md`): `BACKUP_S3_*` set in Render pointing at the
  Cloudflare R2 bucket `pulse-backups`; nightly snapshots now upload off-box.
  Ongoing guardrails (shipped same day): any automatic local-only run raises an
  ops Slack alert, and Admin → Backup shows the live off-box status with a
  Run-snapshot-now button — if the card ever turns red again, treat it as an
  incident, not a nag.
- [x] **Escrow `MASTER_KEY` + `SESSION_SECRET`** — **Done 2026-07-20:** both
  values copied from Render into the company password manager (labelled
  "Pulse production — needed for any restore"). A restore into a fresh service
  regenerates `MASTER_KEY`, which makes every encrypted integration secret in
  the backup undecryptable — the escrowed copy is what prevents that.
- [ ] **Rehearse a restore once** (on staging): fetch a snapshot from R2,
  gunzip to `$DATA_DIR/howler.db` (remove `-wal`/`-shm`), boot with the OLD
  `MASTER_KEY`, log in. Write the timings into DEPLOY.md.
- [ ] **Ops alerting**: confirm `OPS_SLACK_WEBHOOK_URL` is set (it is the whole
  "would I know it's broken" spine) + add an external uptime ping on
  `https://howler-pulse-v2.onrender.com/health` (UptimeRobot or similar).
- [ ] **CI-gated deploys**: do DEPLOY.md §7 (Render deploy hook secret +
  Auto-Deploy OFF). Today a red test suite on `main` still deploys instantly.

## 🟠 First weeks after onboarding starts

- [x] **Sender-reputation protection** — **Done 2026-07-08:** campaign emails
  now carry `List-Unsubscribe` + `List-Unsubscribe-Post` one-click headers
  (`mailer.send({ unsubUrl })`), `/u/:token` accepts the RFC 8058 POST, and a
  new signed Resend webhook (`server/mailWebhooks.js`,
  `POST /api/webhooks/resend`) turns `email.bounced` / `email.complained`
  into a GLOBAL suppression tier enforced inside `mailer.send` (bounced =
  blocked everywhere; complained = blocked for marketing kinds). Admin can
  view/un-suppress via `/api/admin/mail-suppressions` and set the webhook
  secret in Admin → Integrations → Email.
  **⚙️ Needs one-time setup:** in [Resend](https://resend.com) → Webhooks add
  `https://howler-pulse-v2.onrender.com/api/webhooks/resend` with events
  `email.bounced` + `email.complained`, and paste the signing secret into
  Admin → Integrations → Email.
- [x] **Self-approval loophole** — **Done 2026-07-08:** submit rejects an
  approvers list with nobody other than the submitter (test-pinned).
- [x] **Approved automations stay editable** — **Done 2026-07-08:** for
  approval-required clients, a live `auto` campaign refuses edits (pause →
  draft → resubmit); clients without the approval gate keep in-place editing.
- [x] **Raw error leakage on core routes** — **Done 2026-07-08:** all ~40
  `res.status(500).json({ error: err.message })` sites swept onto a shared
  sanitizing `serverError()` helper (`server/http.js`) — full detail logged +
  ops-paged, generic message to clients. `/api/run-query` + `/api/drill` keep
  raw Looker detail for ADMIN sessions only (tile editors need it).
- [x] **Send pacing vs Resend limits** — **Done 2026-07-08:** `deliver()`
  retries 429s (twice, honouring Retry-After — a rate-limited request was
  never accepted, so retry can't double-send; 5xx deliberately NOT retried),
  and a campaign finishing with ≥20% failures raises an ops alert.
- [x] **Approval blindness** — **Done 2026-07-08:** submit resolves the
  audience and the approval summary now shows the recipient reach (email/SMS
  split, flagged as re-resolved at send) plus a loud `⚠ CONSENT BYPASS` line
  when `ignoreConsent` is set (`server/actionApprovals.js`).
- [x] **Disk** — **Done 2026-07-08:** `render.yaml` disk 1 → 5GB (applies on
  next Blueprint sync — or grow it in the Render dashboard), plus
  `server/diskGuard.js`: 10-min `statfs` watchdog, ops alert ≥80%, `/health`
  fails ≥95% so Render surfaces it. Retention/pruning for `ai_usage`,
  `usage_events`, `os_attachments`, in-DB settlement PDFs and
  `action_opens`/`action_clicks` is still open (moved to 🟡).
- [x] **5xx → ops alert** — **Done 2026-07-08:** `errorMiddleware` (and
  `serverError`) page ops on every 500-class response, throttled per kind.

## 🟡 Hardening (schedule, don't rush)

- [x] Drip sequences claim-first — **Done 2026-07-08:** `next_at`/`step_index`
  advance atomically BEFORE the send (a deploy mid-batch now misses a step,
  never duplicates one — same trade the digest scheduler makes), and the
  per-client SMS cap is enforced on sequence runs (campaign-lifetime count).
- [x] HTML-escape merge fields in `html`/`blocks` modes — **Done 2026-07-08:**
  substituted recipient values are escaped (and use function replacers, so
  `$&`-style values can't expand); template mode already escaped downstream.
- [x] `/u` unsubscribe on bare GET — **Done 2026-07-08:** GET renders a
  confirm page whose button POSTs; suppression only happens on POST (human
  confirm or the RFC 8058 one-click), so scanner prefetches are harmless. The
  custom-HTML "has an unsub link" check now looks for the recipient's actual
  `/u/` URL, not the word "unsubscribe".
- [x] Approve-time dry render — **Done 2026-07-08:** the first recipient is
  rendered before the send claims; any surviving `{{token}}` blocks with a
  clear error. (One-off blasts; drip steps still rely on preview.)
- [x] Password policy + bcrypt — **Done 2026-07-08:** ≥8 chars enforced in
  `db.createUser`/`updateUser` (every path); bcrypt cost 10→12 with lazy
  rehash on login; unknown-email logins burn a dummy compare so timing can't
  enumerate accounts.
- [x] CSP — **Done 2026-07-08:** `script-src 'self' https://apis.google.com
  https://www.gstatic.com; object-src 'none'; base-uri 'self'` app-wide
  (Google hosts = Drive picker). No `default-src` on purpose (data-URL logos,
  inline styles, ECharts stay open). The few server-rendered pages with their
  own inline scripts (digest feedback, sales/docs pages) relax per-response
  via `allowInlineScripts`.
- [x] Inbound-email webhook secret — **Done 2026-07-08:** header/body only
  (no more `?secret=` in logs), `timingSafeEqual` compare, fails closed when
  unconfigured.
- [x] Embed-token HS256 pin — **Done 2026-07-08** (verify + sign).
- [x] Tracking hot path — **Done 2026-07-08:** `/o` and `/c` no longer parse
  the full campaign `config` (which can hold MB of base64 imagery) per hit —
  only the small fields via `json_extract`. (Moving images out of `config`
  into `/mail-assets` storage remains a nice-to-have.)
- [x] Ticket upload cap — **Done 2026-07-08:** server 150MB→60MB, client
  20MB/file + 40MB total (was 30MB/file, no total).
- [x] Looker queue — **Done 2026-07-08:** bounded queue (100 waiters) + 20s
  wait deadline; beyond either, a friendly retryable "data engine is busy"
  error instead of minute-long spinners. Tune via `LOOKER_QUEUE_MAX` /
  `LOOKER_QUEUE_WAIT_MS`.
- [x] asyncHandler sweep — **Done 2026-07-08:** the unwrapped async handlers
  in goals.js (6), digests.js, owlUploads.js (2) and fanOwl.js wrapped.
- [x] `assignPromo` conditional claim — **Done 2026-07-08** (`AND email=''`,
  retries the next free code on a lost race).
- [x] Stuck-job sweep — **Done 2026-07-08:** boot + daily sweep pages ops for
  scheduled jobs stuck in `started:…` older than 15 min
  (`server/retention.js`).
- [x] Retention pruning — **Done 2026-07-08:** daily prune (`ai_usage` +
  `usage_events` > 13 months, `action_opens`/`clicks` > 12 months —
  campaign headline counters live on the action row and survive).
  Deliberately NOT pruned: `os_attachments` + settlement PDFs — client
  business data; deleting it is a product decision.
- [ ] Backup cadence: nightly = up to 24h data loss. Cheap: second
  `BACKUP_HOUR_UTC` run. Better: Litestream → R2 for continuous replication.
- [ ] Second dedupe pass on `both`-channel sends: the same human appearing
  once email-only and once phone-only is still contacted twice. (Needs a
  shared identity across the two rows — a data-model question, not a quick
  fix; formats of the SAME contact do dedupe since the normalised-phone key.)
- [ ] Move campaign hero/block images out of the `config` JSON into
  `/mail-assets` storage so the campaign LIST stops shipping image blobs.

## ⚪ Accepted limits (revisit as client count grows)

- Single instance + SQLite: every deploy drops traffic ~30–90s; horizontal
  scaling needs the Postgres migration (`docs/POSTGRES_MIGRATION_SCOPE.md`).
- Serial digest scheduler: many same-hour digests queue behind each other.
- In-memory rate limiter: resets on restart; per-instance only (fine at 1).
- 512MB starter instance: watch memory for the first weeks; move to
  `standard` if p95 >70%.

## What the review confirmed is genuinely solid

Fail-closed tenant scoping through one chokepoint (`query.js` + `auth.js`) with
`requireAdmin` on all 74 admin routes and ownership re-checks on every shared
resource; parameterized SQL throughout; write-only secrets encrypted at rest
(AES-256-GCM); TOTP 2FA with token-version session eviction; SSRF-safe
outbound fetch (`safeFetch.js`); per-recipient crash-safe send ledger with
boot resume; claim-before-send digest scheduler; kill switches on every
channel plus staging's `OUTBOUND_DISABLED=1`; correct SQLite pragmas + online
backup API; timeouts on essentially every external call; honest docs.
