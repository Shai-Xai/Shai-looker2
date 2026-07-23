# How Pulse builds Pulse — the product development cycle

*The one-place summary of the product board, AI reporting, auto-building,
triage, and self-healing loop. Written 2026-07-23 (the day the autonomous
layer shipped); update as the cycle evolves. For the presentation version of
this story, start at "The loop in one picture" and end at "The numbers".*

---

## The loop in one picture

```
  A person reports it                      OR the system catches it itself
  ────────────────────                     ─────────────────────────────────
  💬 Report widget (any screen)            ⚠️ Production error (ops alert)
  🦉 Owl chat ("something's broken")       🔴 CI / workflow failure
                                           🩺 Daily code review finding
        │                                        │
        ▼                                        ▼
  📝 AI drafts the ticket —              🧠 Triage agent: fingerprints the
     reporter reviews & edits it            alert, reads the ACTUAL source
     BEFORE it sends                        code, classifies it
        │                                        │
        │                   bug ────────────────┤─────────── billing/capacity/
        │                    │                   │            config → action
        ▼                    ▼                   ▼            posted to Slack,
  🎟️ PRODUCT BOARD — every ticket lands here    🔇 noise →   no ticket
     with a structured spec + diagnosis            marked,
        │                                          silence
        ▼
  🤖 Dispatch to Claude (one tap — or automatic for
     high-confidence bugs): plan mode (comments a plan,
     waits for "go ahead") or build mode (opens a PR)
        │
        ▼
  🧪 STAGING — the PR merges to the staging branch, deploys
     to the staging site; the REPORTER tests and approves
     (for machine-filed tickets, any admin approves)
        │
        ▼
  🚀 PROMOTE — one release PR ships everything verified on
     staging to production. Blocked until every staged
     ticket is reporter-approved. Merged PR auto-updates
     every ticket; reporters get "it's live" notifications.
```

Two principles hold everywhere:

1. **AI does the toil, humans hold the gates.** Drafting, diagnosing,
   de-duplicating, planning, building, reviewing, resolving merge conflicts —
   automated. Accepting work, approving on staging, promoting to production —
   always a person.
2. **Everything is one funnel.** Human reports, production errors, CI
   failures and proactive review findings all end up in the same two places:
   the product board (things to build) and #pulse-monitoring (things to
   know). No more screenshotting alerts into chat.

---

## Part 1 — The foundation (built over the preceding weeks)

**The product board** (Pulse → Admin → Product → 🎟️ Tickets)
- Anyone logged in — client or staff — files a bug / improvement / idea from
  **any screen** via the 💬 Report widget. It captures the screen they're on
  and the specific dashboard tile; they can attach screenshots, record their
  screen in-app, or minimize the form to capture with their own recorder
  without losing what they typed. The Owl can also file tickets straight from
  a chat conversation.
- **AI structures every report**: a raw "it's broken when I click the thing"
  becomes a spec with summary, repro steps, expected vs actual, affected
  area and severity.
- Statuses flow Inbox → Triaged → Accepted → In progress → On staging →
  Shipped → Approved/Done (plus Rejected/Declined), and the board is the
  single source of truth.

**Auto-building with Claude**
- "Send to GitHub" turns a ticket into a GitHub issue whose body IS the build
  brief, with an @claude ask. The Claude Code GitHub Action picks it up and
  opens a pull request — **plan mode** (comment a plan, wait for approval)
  or **build mode** (write the code).
- **Two-environment deploy:** staging branch → staging site; main →
  production. Tickets build against staging by default.
- **The reporter is the QA gate:** when the PR merges to staging, the person
  who reported it gets a "ready for you to test 🧪" notification (push +
  branded email, deploy-aware — it waits until the staging site actually
  runs the new code). They approve or send it back with a reason; sent-back
  work re-dispatches to Claude on the same issue.
- **Promote to production is a release train:** one PR merges staging →
  main and ships everything verified at once — and it is *blocked* until
  every staged ticket is reporter-approved. Unverified work cannot reach
  production through Pulse.
- A GitHub webhook keeps the board live: PR opened → ticket "in progress";
  merged to staging → "on staging" + test ask; release merged → tickets
  flip to done/live and reporters are told.
- Around the board: stage-by-stage reporter emails (opt-out self-service),
  daily review re-nudges for tickets awaiting a verdict, a daily board
  digest for the team, and a rolling changelog + release notes.

---

## Part 2 — The autonomous layer (shipped 2026-07-23)

### 2.1 Reporters now see — and edit — the AI's ticket before it sends
Previously the AI redraft happened *after* submit; the reporter never saw
what the team worked from. Now: write the report → **Continue** → the AI
tidies it into the ticket → an editable review step (title + full spec) →
**Send**. What the reporter approves is *verbatim* what the board shows and
what Claude builds from. Fail-soft: if AI is unavailable the report submits
the old way — a report is never blocked on AI.

### 2.2 The ops-triage agent: production alerts become tickets by themselves
Every production alert (5xx errors, background job failures — the
#pulse-monitoring feed) now also lands in a **fingerprinted ledger**: IDs,
request refs and numbers are normalised away so 50 occurrences of one defect
are ONE row with a counter, not 50 pages.

Every 30 minutes an AI triage pass classifies each new fingerprint — and
here's the part that makes it accurate: **it greps the running server's own
source code** for the route or symbol named in the alert and reads the
actual code before deciding. Verdicts:
- **bug** → a ticket is auto-filed on the product board (reporter: "Pulse
  Ops Agent") with the raw alert, occurrence history, a code-grounded
  root-cause hypothesis, and acceptance criteria including a regression
  test. One ticket per fingerprint, forever.
- **billing / capacity / config** → no ticket; a concrete action line is
  posted to #pulse-monitoring ("top up X", "merge Y manually") — those need
  a human decision, not a PR.
- **noise** → marked and silent.

**And it can start the fix itself:** high-confidence bugs are auto-dispatched
to Claude in **plan mode** (diagnosis + plan posted on the issue, waits for a
human "go ahead"); an opt-in build tier lets high-severity + high-confidence
bugs go straight to a PR — **always against staging**, so the human
verification and promote gates are untouched. "Fixes itself" means *a fix
waiting on staging for sign-off*, never straight to production.

Rails: kill switch, 30-min cadence, max 5 auto-tickets/day, max 3
auto-dispatches/day, no automatic re-dispatch, its own alerts are never
ledgered (no loops), and the triage prompt is in the Admin → AI audit like
every other prompt.

### 2.3 CI failures feed the same funnel
The GitHub webhook now forwards **workflow failures on main/staging** into
the ledger (kind `github-ci`). Repeated red runs of the same workflow
collapse to one row; a sync-conflict is prescribed as a config action with
the recipe; a red CI on main is treated as a probable fresh defect with the
run URL in the hypothesis. First live catch: the day it shipped, it caught,
collapsed (3 runs → 1 row) and correctly prescribed the staging-sync
conflict — 23 minutes from first failure to posted diagnosis.

### 2.4 The proactive layer: find it before it breaks
- **🩺 Daily code-health review** — every morning at 05:15 an automated
  reviewer reads the last 24h of commits plus a rotating slice of the server
  and posts ranked findings (file:line, what breaks, suggested fix,
  confidence) — visible in **Pulse → Admin → Product → 🩺 Code health** (no
  GitHub login needed). Judgement bar: only findings a senior engineer would
  act on. **Its first-ever run found a real bug** (a state-machine gap that
  silently disabled review reminders on second-round reviews) — verified,
  fixed, regression-tested and shipped the same evening.
- **Require-contract guard in CI** — a deterministic check that every
  export a module *uses* actually *exists*. This is the exact class of bug
  that started today (a revert deleted a function; its call site survived;
  production 500'd for weeks unnoticed) — it can now never ship again.

### 2.5 Self-healing plumbing
- **Staging auto-sync** merges main into staging on every push. On a merge
  conflict it no longer just fails: Claude resolves it in the same run
  (keep-both doctrine, full test suite must pass before it may push), and
  the run only goes green if staging *provably* contains main. If even
  Claude can't resolve safely, it fails loudly into the triage funnel.
- Same-day hardening along the way: the CI lint gate un-broke (a parse
  error had been failing every push), the repo's default branch corrected
  to main (scheduled workflows never ran off the stale default), duplicate
  CI runs from a stale PR identified, GitHub failure emails made redundant.

---

## Where to see it all

| What | Where |
|---|---|
| Tickets (human + agent-filed) | https://howler-pulse-v2.onrender.com → Admin → Product → 🎟️ Tickets |
| Daily code-health reports | https://howler-pulse-v2.onrender.com → Admin → Product → 🩺 Code health |
| Live alerts + triage verdicts | #pulse-monitoring (Slack) |
| Raw triage ledger (JSON) | https://howler-pulse-v2.onrender.com/api/admin/ops-alerts |
| AI prompt audit (everything the AI is told) | Admin → AI |
| Repo / Actions / rolling review issue | https://github.com/Shai-Xai/Shai-looker2 · issue #77 |

## The numbers (as of 2026-07-23, one day of building the layer)

- **23 commits to main today** across the autonomous layer + fixes.
- Test suite grew **941 → 995** (54 new tests pinning the new behaviour).
- **2 production bugs** found in yesterday's alerts, fixed before 9am.
- **3 recurring alert streams** correctly triaged by hand as the proof of
  concept — then the agent reproduced the same verdicts autonomously.
- **First closed loop, same day:** reviewer found a bug at 20:35 → verified,
  fixed, tested and live by 21:45.
- Cost rails: ≤5 auto-tickets/day, ≤3 auto-dispatches/day, 1 review run/day,
  triage every 30 min only when there's something new.

## The story for the deck (suggested arc)

1. **The pain (yesterday):** alerts screenshotted from Slack at 8am; bugs
   living in production for weeks; every report hand-typed into a ticket;
   the founder as the routing layer.
2. **The foundation (already built):** a product board where anyone reports
   from any screen, AI writes the spec, Claude builds it, the reporter
   verifies on staging, and production ships as a gated release train.
3. **Today's leap:** the system now *reports to itself* — production
   errors and CI failures become diagnosed tickets on their own, high-
   confidence bugs arrive with a fix already planned on staging, a daily
   reviewer hunts bugs before users meet them, and the plumbing repairs
   itself.
4. **The proof:** it caught its own first incident, and its reviewer's
   first finding was fixed and live within an hour — with every human gate
   (accept, verify, promote) still human.
5. **What this means for the team:** report from the screen where it hurts,
   approve what you asked for on staging, and spend the reclaimed time on
   product judgement — the toil in between is now machinery.
