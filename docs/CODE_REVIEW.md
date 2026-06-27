# Pulse — Code Review (June 2026)

> Read-only review of the live codebase on branch `claude/ecstatic-thompson-vUFsS`.
> Reviewed against the conventions in `CLAUDE.md` (mobile-first, dual-surface,
> disposable modules, write-only secrets, fails-closed multi-tenant scoping).
> Every finding cites `file:line`. Nothing here is "stop everything" — the
> codebase is well-built. These are the things worth hardening **before** there
> are many real clients and real money flowing.

**Headline:** The multi-tenant core is solid (forced server-side scoping that
fails closed), SQL is fully parameterized, secrets are write-only, outbound
calls fail safe, and the documented conventions are genuinely followed. The
risks are at the edges: a query-scoping bypass vector, a duplicate-send window
in the schedulers, content-serving XSS vectors, a self-approval gap, and the
absence of any rate limiting.

Priority order: **1 (cross-tenant) → 2 (double-send) → 3 (XSS) → 4 (self-approve) → 5 (rate limit)**.

---

## 🔴 Critical / High

### 1. Cross-tenant data leak vector via `filter_expression`
**`server/index.js:663` (`applyScope` / `/api/run-query`), `server/auth.js:353` (`scopeForQuery`), `server/looker.js:194` (`normalizeQuery`)**

The tenant boundary is enforced by merging the forced organiser value into the
query's `filters` map:
```js
query.filters = { ...(query.filters || {}), ...scope };   // index.js:666
```
But `/api/run-query` accepts the **entire** query object from the browser, and a
Looker query can also carry a separate `filter_expression` (a raw LookML filter
string) that is passed through untouched. Depending on the Looker version,
`filter_expression` can take precedence over the structured `filters` — in which
case a client could submit a query whose `filter_expression` omits their
organiser and read another tenant's rows.

- **Impact:** Silent cross-tenant data egress — the one thing a multi-tenant
  platform must never allow.
- **Fix:** Strip/reject `filter_expression` (and any organiser-field entries) from
  client-supplied query bodies server-side; only allow `filter_expression` on
  admin-built saved tiles, never on a raw `/api/run-query` body. Re-assert the
  organiser field is present in the final `filters` after merge and block if a
  conflicting `filter_expression` references it. Confirm empirically how the
  deployed Looker version combines the two, and add a regression test.
- **Status:** ⬜ Open — needs a Looker-behaviour check before locking down.

### 2. Schedulers can send a digest / drip step TWICE
**`server/scheduler.js:193` (`tick`), `server/actions.js:1090` (`processSequences`)**

Both background loops select due work, do the work (including a live Looker + AI
render the code itself notes "can take 30-60s", `scheduler.js:263`), and only
advance the `next_run_at` / `step_index` **after** the work finishes. If a run
outlasts the interval (60s for digests, 3 min for drips), the next `setInterval`
tick starts concurrently, re-selects the same not-yet-advanced rows, and sends
again to the **real recipient list**.

- **Impact:** A real customer gets the same digest or drip email twice.
- **Fix:** Re-entrancy guard so a slow run never overlaps the next tick. (The
  correct "claim before work" pattern already exists in this file at
  `actions.js:1018` and `actions.js:1149`, which stamp `last_check` *before*
  doing work.)
- **Status:** ✅ **Fixed in this branch** — see "Fixes applied" below.

### 3. Stored XSS via attachments and client logos
**`server/os.js:309` (attachment download), `server/index.js:922` (`/mail-assets/logo/:scope`)**

- Attachments are served from the app's own origin with the **client-supplied**
  MIME type and an **inline** disposition (`os.js:316`). A client uploads an
  `.html` "attachment" with `mime: text/html`; opening it runs scripts in the
  Pulse origin — against any staff member who views that thread.
- The logo endpoint is **unauthenticated** and serves bytes with a MIME parsed
  from a client-set data-URL (`index.js:932`). `data:text/html,<script>…` becomes
  executable HTML served from the app origin without login.
- **Fix:** Force `Content-Disposition: attachment` for all non-image types, add
  `X-Content-Type-Options: nosniff`, allowlist renderable MIME (images/pdf), and
  validate the logo data-URL MIME on write (`cleanBrandingPatch`, `index.js:912`).
- **Status:** ⬜ Open.

---

## 🟠 Medium

### 4. Campaign approval can be self-approved (no separation of duties)
**`server/actions.js:748` (approve handler), `:934` (submitter picks approvers), `:25` (off by default)**

When approval is on, the submitter chooses the approver list and can name **only
themselves**, then immediately approve — satisfying the gate while defeating its
"second pair of eyes" purpose. Also, `requireApprovalFor` defaults to `'0'`
(off) — most clients have no gate at all.

- **Fix:** Reject a sign-off where the approver is the creator (`req.user.email
  === a.createdBy`) when governance is on; require ≥1 independent approver.
  Consider defaulting governance on, or surfacing its state prominently.
- **Status:** ⬜ Open (product decision on the default).

### 5. No rate limiting anywhere (runaway AI cost + brute-force login)
**`server/index.js:88` (login), `:1047` (`/api/insight`), `:1075` (`/api/dashboard-insight`)**

No rate limiter exists in the stack. `/api/dashboard-insight` runs up to 24
Looker queries + a Claude call per request; settlement extraction is a 32k-token
call triggered by upload (`insights.js:416`). Login has no lockout, and a seeded
default admin exists (`auth.js:66`, `admin@howler.local` / `changeme123`).

- **Impact:** One user (or a refresh loop) can drive unbounded Claude spend;
  online password brute-force is unthrottled. Directly relevant to ROADMAP 5.3
  (per-client API cost visibility).
- **Fix:** Per-IP limit on login, per-user limit on the AI endpoints, and a daily
  AI spend cap per entity.
- **Status:** ✅ **Login + AI endpoints fixed in this branch** — see below. Daily
  per-entity spend cap still open.

### 6. Full backup export ships plaintext secrets + password hashes
**`server/index.js:163` (`/api/admin/export`), `server/db.js:976` (`exportAll`)**

The export includes the `settings` table (raw Looker / Anthropic / Resend /
Clickatell keys) and `users.password_hash` — contradicting the "secrets are
write-only" principle. Admin-only, but a leaked backup file = every credential in
cleartext.
- **Fix:** Redact secret settings + `password_hash` from the export, or encrypt it
  with a passphrase.
- **Status:** ⬜ Open.

### 7. Inbound-email webhook: non-constant-time compare + secret via query string
**`server/os.js:482`**

`given !== inboundSecret()` is not constant-time (timing side channel), and
accepting `?secret=` can leak the secret into proxy/access logs. Anyone with the
secret can inject messages into any client thread.
- **Fix:** `crypto.timingSafeEqual`; accept the secret via header only.
- **Status:** ⬜ Open.

### 8. Event/cashless scope is enforced client-side only
**`server/auth.js:107`, `:353`; `server/index.js:654`**

Only the **organiser** lock is forced server-side; suite-level event locks are
applied client-side. Safe **only if** `organiser` maps 1:1 to a tenant. Flagged
as a load-bearing architectural assumption with no server guard.
- **Fix:** Document/enforce the "organiser = tenant" invariant; force the event
  lock server-side if it can ever break.
- **Status:** ⬜ Open (verify invariant).

---

## 📱 Mobile-first

Mostly **excellent** — client home, inbox, settlements viewer, and navigation are
properly phone-first (swipe gestures, bottom-sheet nav, safe-area insets). PWA /
push service worker is clean (caches nothing, supports inline notification
actions). Two shared editors break the rule:

- **`client/src/components/MailTemplateEditor.jsx:77`** — forced two-column grid,
  never collapses; clients edit this on their phones. (Ironically the canonical
  dual-surface example.)
- **`client/src/components/DigestManager.jsx:119`** — same issue.

Both are **one-line fixes** copying the responsive pattern already in
`client/src/components/CampaignManager.jsx:520` (`isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)'`).

- **Status:** ⬜ Open (quick wins).

Minor: admin tables lack an `overflowX:auto` wrapper (`AdminPage.jsx:409`, `:516`)
— staff screens, lower priority.

---

## 🟢 Minor / nits

- Weak truncated HMAC tokens for unsubscribe/click (`actions.js:168`, `:265`).
- Public `/c/:token` lets anyone inflate click stats (`actions.js:1166`).
- `mailer` hardcodes a Render fallback base URL (`mailer.js:68`) — links break in
  a new env if `APP_URL` is unset.
- `node-fetch` in `messaging.js:11` vs global `fetch` in `mailer.js:93` —
  standardize on global `fetch` (Node 18+).
- N+1 `approvalSummary` query on campaign list (`actions.js:32`) — fine at scale.
- `/api/my/briefing-config/suite/:id` editable by any member incl. viewer
  (`index.js:2034`) — consider a permission gate.

---

## ✅ What's genuinely solid

- **SQL injection: clean.** Every query parameterized; dynamic `IN(...)` builds
  placeholders from array length; export/import uses a hardcoded table allowlist
  (`db.js:976`) + column validation against `PRAGMA table_info` (`db.js:982`).
- **Forced scoping fails closed.** `scopeForQuery` denies when no organiser lock
  (`auth.js:363`) or unresolved field (`auth.js:381`) → 403. Scope is spread
  **last** so the browser can't override it (`index.js:666`).
- **Permission middleware is the real boundary** and derives the entity from the
  route (`auth.js:237`); no "logged-in but not owner" IDOR found across the
  `/api/my/*` surface.
- **Write-only secrets** respected on all integration endpoints (`index.js:816`,
  `mailer.js:73`, `messaging.js:21`) — the lone exception is the bulk export (#6).
- **Outbound calls fail safe** — Resend/SMS/push all log-and-return on failure; a
  single bad recipient never kills a batch (`actions.js:491`); dead push subs are
  auto-pruned (`push.js:94`).
- **Disposable-module discipline is real** — each module owns its tables + routes,
  mounts in one line, deps injected; kill-switch settings throughout.
- **Cookie flags correct** — `httpOnly`, `sameSite:lax`, `secure` in prod
  (`auth.js:79`); per-request DB user reload gives instant de-provisioning.
- **Dual-surface convention followed** — `scope`-prop pattern applied cleanly
  across MailTemplateEditor, CampaignManager, DigestManager; no duplicated
  admin-vs-client UI.

---

## Fixes applied in this branch

| # | Fix | Files |
|---|-----|-------|
| 2 | Re-entrancy guards stop the digest scheduler and drip processor from overlapping a slow run and double-sending | `server/scheduler.js`, `server/actions.js` |
| 5 | Zero-dependency in-memory rate limiter; applied to login (per-IP) and the two AI endpoints (per-user) | `server/ratelimit.js` (new), `server/index.js` |

Still open from #5: a daily AI spend cap per entity (pairs with ROADMAP 5.3).

---

*Generated as a point-in-time review. Re-run after fixes land. Reviewers read the
files in full and cite verified line numbers; the only finding requiring live
verification is #1 (Looker's `filters` vs `filter_expression` precedence).*
