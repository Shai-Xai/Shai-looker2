# What's next — per-session notes

> **Why this folder exists.** Claude Code session *conversations* don't travel
> between workspaces (only the repo + git history do — see
> `docs/SESSION_HANDOFF.md`). So at the end of each session we drop a short,
> structured "what's next" note here. Later, one session can read the whole
> folder and give Shai a single consolidated "where am I / what's next" view —
> without anyone having to re-open old chats.

## How it works

1. **At the end of a working session**, paste the prompt below. The session
   writes its own dated file into this folder.
2. **Per-session files, not one shared file** — because many parallel
   `claude/*` branches all merge to `main`, a single `WHATS_NEXT.md` would
   conflict constantly. One file per session = zero merge conflicts.
3. **To take stock**, ask any session: *"Review docs/whats-next and give me a
   consolidated what's-next."* It reads every note (newest first) and
   synthesises themes, priorities, blockers, and duplicates.

## File naming

```
docs/whats-next/YYYY-MM-DD__<branch-slug>.md
```

e.g. `docs/whats-next/2026-06-27__account-sessions-review.md`. If a file for
today's date + branch already exists, append a new dated section to it rather
than overwriting.

## The prompt to paste at the end of a session

> Based on everything we discussed and did this session, write a "what's next"
> note to `docs/whats-next/<today's date in YYYY-MM-DD>__<current git branch,
> with the `claude/` prefix and any random suffix stripped>.md` using the
> template in `docs/whats-next/README.md`. Be concrete and honest: capture what
> we actually shipped, the decisions we made (and why), what's genuinely next in
> priority order, and any open questions or blockers. If a file for today +
> this branch already exists, append a new dated section instead of overwriting.
> Then commit and push it per the CLAUDE.md git rules.

## Template for each note

```markdown
# What's next — <YYYY-MM-DD> · <branch>

**Session focus:** <one line — what this session was about>

## Shipped this session
- <concrete change> (`path/to/file`, commit <sha> if known)
- ...

## Decisions made (and why)
- <decision> — <rationale / what it rules out>
- ...

## What's next (priority order)
1. <most important next step — concrete enough to start>
2. ...

## Open questions / blockers
- <question needing Shai's input, or external dependency>
- ...

## Pointers
- Files/areas touched: <list>
- Related docs: <e.g. docs/ROADMAP.md section, PR #N>
```
