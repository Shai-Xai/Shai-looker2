# What's next — 2026-06-27 · client-setup-wizard

**Session focus:** Finish and harden the **setup-reminder (nudge) system** — fix
the deploy crash, add the missing in-app surface, make cadence + wording
configurable, personalise the copy with AI, and surface alerts in the client's
own "Getting started".

## Shipped this session
- **Fixed the Render deploy crash (TDZ).** `setupNudge` was mounted in the
  onboarding/installs block, *before* `const actionsApi` and `const resolveRecipe`
  exist → `ReferenceError: Cannot access 'resolveRecipe' before initialization`.
  Moved the mount below the segments block where both consts are defined.
  (`server/index.js`, commit 57485f1)
- **Client nudge now lands in-app, not just email.** Posts (or re-raises) one
  thread on the client's shared Pulse inbox via `os.announce({ channels: [] })`
  (inbox-only — no extra email/push, since the targeted email is sent
  separately). Stable subject (`setup-nudge`/`setup`) re-raises a single thread
  on repeat nudges. Either surface succeeding arms the weekly throttle.
  (`server/setupNudge.js`, `client/src/pages/AdminPage.jsx`, commit 9164e5c)
- **Editable cadence + wording.** Global "Reminder defaults" card in
  **Admin → 📋 Onboarding** (grace, repeat, send hour, kill switch + client copy:
  subject, in-app title, opening line, button, sign-off). Per-client **timing
  override** (grace/repeat, blank = inherit) in each client's Reminders panel.
  Copy is HTML-escaped; clearing a field falls back to the default.
  (`server/setupNudge.js`, `AdminPage.jsx` `NudgeGlobalSettings` + `SetupNudgeConfig`,
  `client/src/lib/api.js`, commit b039cb6)
- **"Send me a test" on the global card** — emails the logged-in admin a sample
  client nudge rendered with the current (saved) wording. (commit 600cc67)
- **AI-personalised subject + opening, tailored to the outstanding items.**
  `insights.nudgeCopy()` returns a `{subject, intro}` written from the client's
  current outstanding-item list (+ the live opportunity line). `resolveCopy()`
  uses it when on, **cached by a signature of the outstanding set** (regenerates
  only when the gaps change — no AI call per run), and falls back to the static
  copy on any failure. Global toggle (default on). Prompt registered in
  `promptRegistry()`. (`server/insights.js`, `server/setupNudge.js`, `AdminPage.jsx`,
  commit 71ba3b1)
- **"Set up an alert" in the client "Getting started" card.** New step in the
  "Stay in the loop" phase; auto-ticks once the client has any alert
  (`COUNT … FROM alerts WHERE entity_id=?`), links to `/alerts`, with a new
  `alerts` "Show me how" guide. (`server/onboarding.js`, `client/src/lib/guides.js`,
  commit a180fe7)

**Test status:** `npm test` 152/152 on every commit; client `vite build` clean;
`test/prompts.test.js` green after registering the new prompt; `insights.js`
kept under its 1150-line budget by compacting (not raising the budget).

## Decisions made (and why)
- **In-app via `os.announce({channels:[]})`, email sent separately.** An empty
  channels array creates the inbox thread *without* the entity-wide email/push
  fan-out (`announce` guards with `if (ch.length)`), so the only email is the
  targeted one. Corrected an earlier wrong assumption that `[]` couldn't suppress
  fan-out. The inbox is a **shared per-client** surface (all the client's users
  see the thread) — per-recipient targeting only applies to the email.
- **Cadence = global default + per-client override** (CLAUDE.md platform-default
  → client-override pattern). **Send hour stays global** — there's one daily
  batch run; a per-client send hour would mean per-client scheduling for little
  gain, especially for the bulked admin email.
- **AI touches only the subject + opening (and the opportunity line).** The
  outstanding-item list stays factual/auto-generated; the editable static copy is
  the fallback. Caching by the outstanding-set signature gives the behaviour Shai
  asked for ("each subsequent email may differ based on outstanding actions")
  while avoiding an AI call on every 20-min tick.
- **Did NOT touch the digest send path.** The second surface for the live metric
  (a digest "Opportunities" block) is deferred — the digest is the critical
  send path and a blind edit could break all digests. Built only the nudge
  surfaces this session.

## What's next (priority order)
1. **Verify the live metric + personalised copy against real data on the deploy.**
   Use per-client **"Test client nudge"** and the global **"Send me a test"**.
   Needs a real client whose `abandoned_cart` recipe resolves to a tile + an
   Anthropic key. *Done =* the test email shows a real abandoned-cart count and an
   on-brand, item-specific subject/opening (not the static fallback).
2. **Digest "Opportunities" block (surface 2 of 2).** Reuse
   `cartOpportunity`/`setupStatus` to add the live metric to the daily digest —
   carefully, behind the verified metric, with the digest path exercised first.
3. **Update `docs/PRODUCT_OVERVIEW_SALES.md`.** CLAUDE.md says the sales doc must
   be updated in the same change for client-relevant features. **This session did
   not** (reminders + alerts-in-Getting-started). Honest gap — add the status +
   dated changelog lines.
4. **Optional / offered, not yet requested:** make the admin summary wording
   editable; a per-channel toggle (in-app vs email) for the client nudge; per-user
   in-app notifications instead of the shared inbox thread.

## Open questions / blockers
- **Needs real client data** to validate the live abandoned-cart count and the
  AI copy — can't be confirmed from dev.
- **Deploy branch:** Render builds from `claude/ecstatic-thompson-vUFsS`, not
  `main`. All work this session was 3-way pushed (branch + `main` + deploy
  branch). Confirm that's still the deploy branch before relying on it.
- **Unverified-commit warnings** from the stop-hook persist (no signing key);
  not addressed — fixing would mean force-pushing shared history.
- Should the reminders cadence/wording be a `SetupWizard` step/tour anchor? It's
  admin onboarding *config*, not a per-client stand-up step, so probably no —
  worth a quick confirm.

## Pointers
- Files/areas touched: `server/setupNudge.js`, `server/insights.js`,
  `server/onboarding.js`, `server/index.js`,
  `client/src/pages/AdminPage.jsx`, `client/src/lib/api.js`,
  `client/src/lib/guides.js`.
- Related docs: `CLAUDE.md` (Reminders/onboarding + dual-surface + prompt-registry
  conventions). `docs/ROADMAP.md` is reconciled separately — left untouched.
