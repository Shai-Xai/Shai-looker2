# What's next — 2026-06-27 · account-sessions-review

**Session focus:** Can we go through all past session chats to take stock of
where things are? Conclusion: chats aren't recoverable from a fresh cloud
workspace — so we set up a repeatable per-session "what's next" mechanism instead.

## Shipped this session
- `docs/whats-next/` folder with a `README.md` defining the convention + the
  copy-paste end-of-session prompt and note template.
- This first note (dogfooding the format).

## Decisions made (and why)
- **Per-session files, not one shared `WHATS_NEXT.md`** — many parallel
  `claude/*` branches merge to `main`, so a single file would conflict
  constantly. One dated file per session = zero conflicts, full history.
- **Reconstruct "where am I" from git + GitHub, not chat logs** — past session
  conversations don't travel into a fresh ephemeral workspace; commits, branches
  and PRs are the durable record.

## What's next (priority order)
1. **Adopt the habit:** paste the end-of-session prompt (in
   `docs/whats-next/README.md`) at the close of each session.
2. **Triage stale PRs:** open PRs #1 ("Main") and #2 ("Client onboarding
   wizard") both target the old `claude/looker-dashboard-recreation-aeG4A` base,
   not `main`. Decide: rebase onto `main`, repoint base, or close.
3. **After a few notes accumulate,** ask a session to consolidate
   `docs/whats-next/` into one "where am I" summary.

## Open questions / blockers
- Do you want the consolidation to also fold in `docs/ROADMAP.md` and
  `docs/SESSION_HANDOFF.md`, or stay purely the session notes?

## Pointers
- Files/areas touched: `docs/whats-next/README.md`, this file.
- Related docs: `docs/SESSION_HANDOFF.md` (cross-workspace context),
  `docs/ROADMAP.md`. Open PRs: #1, #2.

---

# What's next — 2026-06-27 (later) · account-sessions-review

**Session focus:** Close the loop — wire the what's-next notes into the roadmap
and do a first, conservative reconciliation of `docs/ROADMAP.md` against reality.

## Shipped this session
- **Reconcile loop wired:** `docs/ROADMAP.md` gained a status key
  (💡 idea · 🏗️ in progress · ✅ shipped · ⏸️ parked); `docs/whats-next/README.md`
  gained the loop diagram + a **reconcile prompt** (notes → roadmap).
- **First conservative roadmap reconciliation** (evidence: code + git, gathered
  via an Explore sweep). Status changes:
  - ✅ shipped: **1.3** background briefing (`briefingCache.js`), **2.1** what's-new
    on sign-in (`releaseNotes.js`), **3.2** days-before filter (`query.js`).
  - 🏗️ in progress: **1.1** Owl (answer/analyse via `AnalystDrawer`; agentic "act"
    pending), **2.2** client wizard (onboarding checklist shipped; guided wizard =
    open PR #2), **4.3** social (Meta+TikTok audience-sync live; X + publishing
    pending), **5.1** roles+tasks (roles live; event-tasks spec-only).
  - Left 💡 (flagged *confirm*): 1.2, 2.3, 3.1 (spec exists), 3.3, 4.1,
    4.2 (spec exists), 4.4, 4.5, 4.6, 5.2, 5.3.
  - Added **§6 "Already shipped (was not on the roadmap)"**: Goals/forecast,
    Status Notices, Settlements, Inbox, Digests, Alerts, SMS/WhatsApp, Slack,
    Web Push, Activity auditing, Setup nudges, Campaign templates.
  - Re-sequenced "Suggested sequencing" around finishing started work first.

## Decisions made (and why)
- **Conservative status calls** (Shai's choice): only ✅/🏗️ where code evidence is
  unambiguous; everything uncertain stays 💡 with a *confirm* note. Avoids the
  roadmap over-claiming.
- **Don't delete ideas, park them** — roadmap keeps every original note verbatim.

## What's next (priority order)
1. **Spread the convention to main, then have sessions pull it.** The
   folder+README now live on `main`; other branches that predate the push don't
   see it and will reinvent a divergent template (the `slack-integration-
   capabilities` session hit exactly this — it created its own README/folder).
   Mitigation: sessions should `git pull origin main` before running the
   end-of-session prompt.
2. **Confirm the 💡 *confirm*-flagged items** with Shai (esp. 2.3 backgrounds,
   3.1/4.2 where only specs exist) so their status is accurate.
3. **Triage stale PRs #1 / #2** (still based on `looker-dashboard-recreation`).
4. Once a few session notes accumulate, re-run the reconcile prompt.

## Open questions / blockers
- **Cross-session template divergence (blocker-ish):** if two sessions each
  create `docs/whats-next/README.md` independently, the READMEs (not the dated
  notes) will merge-conflict. Per-session *notes* are safe (unique filenames);
  the *README* is the shared file to keep singular. Worth a short note in
  SESSION_HANDOFF telling sessions to pull main first.
- Should §6 "already shipped" items each become first-class roadmap entries, or
  stay a flat list until one needs shaping?

## Pointers
- Files/areas touched: `docs/ROADMAP.md`, `docs/whats-next/README.md`, this file.
- Evidence sweep covered `client/src/`, `server/`, git log.
