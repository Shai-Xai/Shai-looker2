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
