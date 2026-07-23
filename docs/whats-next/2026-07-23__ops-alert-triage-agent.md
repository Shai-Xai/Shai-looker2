# What's next — 2026-07-23 · ops-alert-triage-agent

**Idea (Shai):** stop hand-reporting #pulse-monitoring alerts. An agent should
watch the alerts, decide which are legitimate bugs, file them on the product
board with a suggested fix, in some cases fix them itself — and, down the line,
review the code daily and flag bugs before they ever alert.

## Shipped this session (Phase 1 — LIVE)
- **`server/opsTriage.js`** — new disposable module: `ops_alerts` ledger table,
  fingerprinting (UUIDs/req-refs/numbers normalised → one row per defect), the
  AI triage pass grounded by grepping the server's OWN source for the
  route/symbol in the alert, auto-filing bug tickets on the product board
  (`source: 'ops'`, reporter "Pulse Ops Agent", pre-drafted title/summary),
  ops-action notifications for billing/capacity/config, silence for noise.
- **Rails, all live:** kill switch `ops_triage_enabled` (default on), cadence
  `ops_triage_cadence_min` (default 30), daily cap `ops_triage_daily_cap`
  (default 5 — extra bugs park as 'capped' and file next window without
  re-classifying), one ticket per fingerprint forever (recurrences bump the
  count), loop guard (its own alerts are never ledgered), failed
  classifications stay 'new' and retry.
- **`server/ops.js`** — `onAlert(fn)` listener hook (fires per occurrence,
  BEFORE Slack throttling, isolated so it can never break alerting) +
  `notify(text)` (unthrottled, un-⚠'d channel post for triage verdicts).
- **`server/tickets.js`** — `source: 'ops'` accepted alongside widget/owl.
- **Admin API** (board is the UI; these power a future ledger view):
  `GET /api/admin/ops-alerts`, `POST /api/admin/ops-alerts/run` (force a pass),
  `POST /api/admin/ops-alerts/:id/ignore` / `:id/reopen`.
- **Auditability:** `OPS_TRIAGE_SYSTEM` exposed via `promptRegistry()` →
  Admin → AI "Everything the AI is told".
- **Tests:** `test/opsTriage.test.js` (12) — fingerprint collapse on the real
  journeys-alert messages from 2026-07-22, ticket filing, no-duplicate
  recurrence, billing→action-not-ticket, noise silence, cap parking + no
  re-classify, kill switch, loop guard, code grounding.

## Shipped this session (Phase 2 — LIVE)
- **Auto-dispatch tier** (`ops_triage_dispatch`: off | plan | **build**, default
  `plan`): a HIGH-CONFIDENCE bug ticket is also sent straight to GitHub for
  Claude at filing time. Plan tier → Claude comments a diagnosis + plan and
  waits for a human "@claude go ahead". Build tier → high-severity AND
  high-confidence bugs go straight to a build; everything else still plans.
  Auto-dispatch ALWAYS targets `staging`; capped at `ops_triage_dispatch_cap`
  per day (default 3, 0 = never); fail-soft (a GitHub error leaves a normal
  inbox ticket); only ever fires at filing time — re-dispatch stays human.
- **The diagnosis IS the brief:** ops tickets' `ai_summary` now carries the
  full spec (raw alert, occurrence pattern, code-grounded hypothesis,
  acceptance criteria incl. "add a regression test") — `claudeBrief()` leads
  with it, so a dispatched build starts from the diagnosis, not the bare error.
- **`tickets.js`:** the GitHub-issue route's core extracted as
  `sendTicketToGitHub(ticketId, { mode, target, actorEmail })` (route + agent
  share one path); returned from `mount` alongside `createTicket`.
- **Ops tickets can't jam the release train:** the machine reporter can never
  log in, so on `source: 'ops'` tickets ANY admin may pass the staging/shipped
  verdict (human tickets keep the strict reporter-only rule); reporter
  notifications (push/email/inbox) are skipped for ops tickets — no mail to
  `ops-triage@pulse.internal`.
- **Bug fix caught by tests:** numeric settings now honour an explicit 0
  (`Number('0') || 5` was silently turning "cap 0 = never" into the default).
- **Tests:** +6 dispatch-tier tests in `test/opsTriage.test.js` (tier gating,
  confidence gate, build-vs-plan split, dispatch cap, fail-soft, parked rows
  ride the tier) and new `test/ticketsDispatch.test.js` (8: plan/build issue
  bodies, alreadyLinked rail, needsConfig, ops-verdict rules).

## Shipped this session (Phase 3 — LIVE)
- **Require-contract guard** (`test/requireContracts.test.js`): every property a
  server module uses on a `require()`d sibling must actually be exported by it —
  the deterministic net for the `listJourneys` class of bug (call site survives
  a revert/rename that removed the export). Loads each module's REAL export
  surface at runtime (spreads included), then statically scans all `binding.prop`
  accesses, destructured requires and inline `require('./x').prop` uses.
  Zero-false-positive by construction: comment-stripped source, shadowed
  bindings skipped, `?.` optional access respected, String/Array method names
  ignored. Includes a self-test that replays the exact listJourneys bug shape —
  and was verified against the real thing (removing the export fails the suite).
  Rides the existing CI test job; no new workflow.
- **Daily code-health review** (`.github/workflows/code-health.yml`): 05:15 SAST
  daily (+ manual dispatch), Claude reviews the last 24h of commits plus a
  deterministic rotating 4-module slice of `server/`, and posts ranked findings
  (file:line, failure mode, suggested fix, confidence) as one comment per day on
  the single rolling issue **"🩺 Code health — daily review"**. Read-only by
  design — no code, no PRs; accepted findings go to the product board by hand,
  then the normal dispatch flow applies. Guards: never writes the bot's
  at-mention (no recursive triggers), dedupes against earlier comments, "no
  findings" is a valid two-sentence report. Same ANTHROPIC_API_KEY secret as
  claude.yml.

## Shipped this session (CI failures → the ledger)
- The `/api/github/webhook` handler (production Pulse) now accepts
  **workflow_run** events: a run that completes with failure / timed_out /
  startup_failure **on main or staging** raises `ops.alert('github-ci', …)` —
  from there the normal triage machine takes over (fingerprint collapses
  repeated runs of the same workflow+branch to one row; classification knows
  the github-ci kind: sync-staging conflicts → config with the manual-merge
  recipe as the action, red CI on main → bug with the run URL in the
  hypothesis, capped confidence since logs aren't visible). claude/** and PR
  failures are deliberately excluded — the PR/ticket flow already surfaces
  those.
- **ONE manual step remains (repo settings, human-only):** GitHub →
  https://github.com/Shai-Xai/Shai-looker2/settings/hooks → edit the existing
  Pulse webhook → "Let me select individual events" → tick **Workflow runs**
  (keep Pull requests) → Save. Until then GitHub simply doesn't send the
  events; everything else is live and waiting.

## Why this is close, not far

The two ends of the loop already exist:

- **Every alert flows through ONE funnel** — `ops.alert(kind, message)` in
  `server/ops.js` (throttled Slack post to #pulse-monitoring). Nothing else to
  instrument; a hook there sees 100% of alerts.
- **The product board already automates the back half** — `server/tickets.js`:
  AI ticket drafting (`draftTicket`), dispatch to Claude via GitHub issue
  (`@claude` → PR against `staging`), reporter verification on staging, and the
  promote-to-production release train. A ticket filed by an agent rides the
  exact same rails as one filed by a human.

The missing piece is only the bridge: alert → classified → ticket.

**Proof of concept (yesterday, done by hand):** of 4 alert types on 2026-07-22,
2 were real bugs (journeys `listJourneys` regression; empty-content AI-JSON
repair call — both fixed in `9ea0f2c5`), 1 was billing (Anthropic credits), 1
was backpressure (Looker queue). Exactly the triage split this agent would make.

## Phase 1 — Alert ledger + auto-triage → ticket

New disposable module `server/opsTriage.js` (+ a small hook in `ops.js`):

1. **Ledger.** `ops.alert()` also inserts into an `ops_alerts` table:
   kind, message, `fingerprint`, count, first/last seen. Fingerprint =
   kind + message with volatile parts normalised (UUIDs, numeric ids,
   `req_...` refs, numbers → placeholders), so yesterday's three separate
   journeys alerts collapse to ONE signature. Slack behaviour unchanged.
2. **Triage pass.** On the scheduler tick (30–60 min cadence, kill switch
   setting `ops_triage_enabled`), take fingerprints not yet triaged and ask the
   AI to classify: `bug | capacity | billing | config | noise`, severity, and a
   root-cause hypothesis. **Grounding trick:** the deployed service has its own
   source on disk — grep `server/` for the error string / route named in the
   alert and include the surrounding code in the prompt, so classification
   reads the actual code, not just the message.
3. **File tickets.** Classification `bug` → `createTicket({ source: 'ops',
   type: 'bug', ... })` with the hypothesis in the body; ONE ticket per
   fingerprint (recurrences bump a counter / comment on the existing ticket,
   never duplicates). Non-bug classes (billing, capacity) never become tickets —
   they go into a short daily "ops actions" Slack summary instead (yesterday's
   credit-balance alert is an action for a human, not a ticket).
4. **Rails.** Cap auto-filed tickets/day, dedupe by fingerprint, kill switch,
   and tickets land in `inbox` for a human to triage — the agent files, it does
   not dispatch.

## Phase 2 — Suggest-a-fix / self-fix tier (flag-gated)

- The triage hypothesis flows into `claudeBrief()` so a dispatched build starts
  from the diagnosis, not the raw alert.
- **Auto-dispatch, opt-in per tier:** high-confidence bugs auto-Send-to-GitHub
  in **plan mode** first (Claude comments a plan, no code); a stricter
  allowlist (e.g. severity ≥ high AND confidence high) may go straight to
  build mode. The existing safety geometry is untouched: PRs target `staging`,
  the reporter must approve on staging, promotion to production stays a human
  release train. "Fixes itself" = fix waiting on staging for a verdict — never
  straight to prod.
- Budget rails: max N auto-dispatches/day; never for billing/capacity classes;
  no automatic redispatch loops — a sent-back ticket needs a human.

## Phase 3 — Daily proactive review (before it alerts)

- A scheduled daily run (natural home: a cron workflow in the repo next to the
  existing `@claude` Action) reviews the last 24h of commits + a rotating slice
  of the codebase and updates a single rolling "Code health — daily review"
  issue/ticket, findings ranked by risk. Accepted findings become tickets via
  the normal flow.
- Cheap deterministic complement worth doing regardless: a CI lint that checks
  every `require`d module property used actually exists — the `listJourneys`
  class of bug (call site survives a revert that removed the export) is
  statically catchable, no AI needed.

## Open decisions

- Triage cadence + who gets the daily ops-actions summary (Slack channel?).
- Phase 2 thresholds: what qualifies for plan-mode auto-dispatch vs build-mode.
- Whether ops tickets appear on the client-visible board or an internal-only
  lane (suggest: internal-only; `source: 'ops'` makes filtering trivial).
