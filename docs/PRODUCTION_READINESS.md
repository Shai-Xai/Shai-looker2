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

- [ ] **Off-box backups**: set `BACKUP_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY`
  (Cloudflare R2 works) in Render → Environment, run
  `POST /api/admin/backups/run`, confirm `uploaded: true` in
  `GET /api/admin/backups`. Until then the nightly snapshots live on the SAME
  disk as the database — disk loss is total data loss, and the run still
  reports "ok".
- [ ] **Escrow `MASTER_KEY` + `SESSION_SECRET`** from Render into a password
  manager. A restore into a fresh service regenerates `MASTER_KEY`, which
  makes every encrypted integration secret in the backup undecryptable.
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

- [ ] Drip sequences: advance `next_at` BEFORE sending (claim-first, like the
  digest scheduler) so a deploy mid-batch can't re-send a step; enforce the
  SMS cap on sequence runs; ledger drip sends per step.
- [ ] HTML-escape merge-field values in `html`/`blocks` email modes (recipient
  name containing markup currently renders live in the branded email).
- [ ] `/u` unsubscribe fires on bare GET — corporate link scanners prefetch it
  and silently unsubscribe people. Render a confirm button that POSTs (the
  RFC 8058 one-click POST is already supported). Also: the "has an unsub
  link" check is `/unsubscrib/i` on the copy — detect an actual `/u/` href
  instead.
- [ ] Dry-render the first recipient at approve time and reject if any
  `{{token}}` survives (typo'd merge tags currently ship literally).
- [ ] Minimum password length in `db.createUser` (only the reset flow enforces
  ≥8 today; admin/team creation accepts anything).
- [ ] Real Content-Security-Policy (`default-src 'self'; script-src 'self'`)
  — currently only `frame-ancestors`; React escaping is the sole XSS defence.
- [ ] Inbound-email webhook: drop `req.query.secret` (leaks into logs), accept
  header/body only, compare with `timingSafeEqual` (`server/os.js:648`).
- [ ] Pin `{ algorithms: ['HS256'] }` on the embed-token `jwt.verify`
  (`server/auth.js:153`) — the session path already does.
- [ ] bcrypt cost 10 → 12 (rehash on login); dummy-compare for unknown users
  to equalise login timing.
- [ ] Stop parsing campaign `config` (which can hold 2MB base64 hero images)
  on every open-pixel hit (`server/actionTracking.js` trackedAction) and stop
  shipping image blobs in the campaign list; move images to the existing
  `/mail-assets` storage.
- [ ] Ticket upload body limit 150MB → ~25MB (`server/tickets.js:134`) — two
  concurrent big uploads can OOM the 512MB instance.
- [ ] Looker queue: cap depth + add a wait deadline (~15s interactive) so a
  Looker outage fails fast instead of stacking minute-long spinners
  (`server/looker.js` requestQueue).
- [ ] Sweep unwrapped `async (req, res)` handlers into `asyncHandler`
  (goals.js, digests.js, owlUploads.js, fanOwl.js) — an escaped rejection
  hangs the request.
- [ ] `assignPromo` check-then-write: make the UPDATE conditional
  (`AND email=''`) so a future `await` between check and write can't hand two
  people one promo code.
- [ ] Backup cadence: nightly = up to 24h data loss. Cheap: second
  `BACKUP_HOUR_UTC` run. Better: Litestream → R2 for continuous replication.
- [ ] Boot sweep for jobs stuck in `last_status LIKE 'started:%'` older than
  ~15 min (a crash mid-digest currently leaves no trace anyone acts on).
- [ ] Second dedupe pass on `both`-channel sends: the same human appearing
  once email-only and once phone-only is still contacted twice.
- [ ] Retention/pruning for the unbounded growers: `ai_usage`,
  `usage_events`, `os_attachments` (files on disk), settlement PDFs
  (base64 in-DB), `action_opens`/`action_clicks` (the 5GB disk +
  watchdog buys time; pruning closes it).

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
