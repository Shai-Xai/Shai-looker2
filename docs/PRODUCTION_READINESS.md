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

- [ ] **Sender-reputation protection** (all clients share one Resend domain —
  one bad list poisons everyone): add `List-Unsubscribe` +
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers to campaign
  sends (`server/mailer.js`), and a Resend bounce/complaint webhook that
  writes into `action_suppressions`. Gmail/Yahoo require one-click unsub
  above ~5k/day.
- [ ] **Self-approval loophole**: `submit` accepts any approvers list — a
  marketer can nominate themself and approve their own blast
  (`server/actions.js`, submit route). Reject a list where every approver is
  the submitter.
- [ ] **Approved automations stay editable**: a live `auto` sequence can be
  rewritten (copy, audience, `ignoreConsent`) with no re-approval
  (`server/actions.js` PUT allows status `auto`). Force pause → draft →
  resubmit on material change for approval-required clients.
- [ ] **Raw error leakage on core routes**: `/api/run-query` and `/api/drill`
  return Looker's raw error body (internal URLs, model names) to clients
  (`server/dashboards.js:342,361`); same pattern in ~15 other handlers.
  Mechanical sweep: `res.status(500).json({ error: err.message })` →
  `next(err)` so `errorMiddleware` sanitises.
- [ ] **Send pacing vs Resend limits**: blasts run ~8/sec with no 429
  retry/backoff — failures are counted, never retried, campaign still ends
  "done", nobody alerted (`server/actions.js` runCampaign). Treat 429/5xx as
  retryable (the ledger makes retry safe) and ops-alert when
  `failed/total` is high.
- [ ] **Approval blindness**: the approval summary shows neither the resolved
  recipient count nor a warning when `ignoreConsent` is set; the audience is
  re-resolved live after sign-off. Add count + a loud consent-bypass line to
  `campaignSummaryLines`.
- [ ] **Disk**: bump `sizeGB` 1 → 5 in `render.yaml`; add a 10-min
  `statfs(DATA_DIR)` watchdog (ops-alert >80%, fail `/health` >95% — a full
  disk currently fails silently because `/health` only reads). Unbounded
  growers to prune: `ai_usage`, `usage_events`, `os_attachments`,
  settlement PDFs (base64 in-DB), `action_opens`/`action_clicks`.
- [ ] **5xx → ops alert**: one line in `server/http.js` errorMiddleware so
  client-visible 500s page Slack (the per-kind throttle already exists).

## 🟡 Hardening (schedule, don't rush)

- [ ] Drip sequences: advance `next_at` BEFORE sending (claim-first, like the
  digest scheduler) so a deploy mid-batch can't re-send a step; enforce the
  SMS cap on sequence runs; ledger drip sends per step.
- [ ] HTML-escape merge-field values in `html`/`blocks` email modes (recipient
  name containing markup currently renders live in the branded email).
- [ ] `/u` unsubscribe fires on bare GET — corporate link scanners prefetch it
  and silently unsubscribe people. Render a confirm button that POSTs; keep
  GET only for the one-click header flow. Also: the "has an unsub link" check
  is `/unsubscrib/i` on the copy — detect an actual `/u/` href instead.
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
