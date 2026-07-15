# 2026-07-09 — Time spent vs build value

> A record of how much directed-development time has gone into Pulse and what
> that time is worth as a replacement-cost estimate. Time figures are derived
> from git commit timestamps (a proxy, not a keystroke log); build value comes
> from `update_tracker.py` / `Build_Value_Tracker.xlsx`. Read both with their
> caveats — neither is a precise instrument.

## Method (so the numbers are reproducible)

- **Source:** committer timestamps across all refs of the *full* repo (the
  earlier shallow clone hid everything before 29 Jun — always unshallow first:
  `git fetch --unshallow`).
- **Session model:** commits are clustered into work sessions; a gap > 90 min
  starts a new session. Engaged time per session = (last − first commit span)
  + 20 min lead before the first commit. Parallel/autonomous commits collapse
  into the elapsed clock, so they are *not* double-counted — but any stretch
  where a long autonomous run was kicked off and left unattended is still
  counted, so the total is an **upper bound** on hands-on attention.

## Headline

| Window | Commits | Active days | Sessions | Engaged time |
|---|---|---|---|---|
| All-time (7 Mar → 9 Jul) | 2,173 | 35 | 91 | ~364 h |
| **Last 30 days (10 Jun → 9 Jul)** | 1,979 | 30 | 83 | **~334 h** |

The last 30 days hold ~334 of the ~364 total hours — the project began in
March but went into a near-continuous sprint over the past month
(**~11.1 h/day, every one of 30 days, no day off**).

## Last 30 days, day by day

| Date | Commits | Sessions | Hours |
|---|---|---|---|
| Wed 06-10 | 48 | 2 | 13.1 |
| Thu 06-11 | 34 | 3 | 12.0 |
| Fri 06-12 | 42 | 2 | 13.0 |
| Sat 06-13 | 63 | 2 | 10.3 |
| Sun 06-14 | 63 | 3 | 10.6 |
| Mon 06-15 | 54 | 3 | 13.6 |
| Tue 06-16 | 53 | 2 | 10.4 |
| Wed 06-17 | 34 | 5 | 7.1 |
| Thu 06-18 | 23 | 2 | 8.1 |
| Fri 06-19 | 31 | 3 | 9.1 |
| Sat 06-20 | 44 | 4 | 10.4 |
| Sun 06-21 | 37 | 1 | 7.8 |
| Mon 06-22 | 66 | 2 | 9.1 |
| Tue 06-23 | 62 | 4 | 12.3 |
| Wed 06-24 | 75 | 3 | 11.6 |
| Thu 06-25 | 54 | 5 | 9.7 |
| Fri 06-26 | 11 | 3 | 3.4 |
| Sat 06-27 | 28 | 2 | 6.9 |
| Sun 06-28 | 32 | 2 | 8.6 |
| Mon 06-29 | 84 | 2 | 17.6 |
| Tue 06-30 | 78 | 2 | 15.3 |
| Wed 07-01 | 51 | 3 | 13.0 |
| Thu 07-02 | 146 | 1 | 18.0 |
| Fri 07-03 | 265 | 1 | 16.8 |
| Sat 07-04 | 205 | 2 | 15.1 |
| Sun 07-05 | 86 | 3 | 10.8 |
| Mon 07-06 | 36 | 4 | 7.8 |
| Tue 07-07 | 70 | 3 | 12.2 |
| Wed 07-08 | 50 | 5 | 9.3 |
| Thu 07-09 | 54 | 5 | 10.7 |
| **TOTAL** | **1,979** | — | **333.6 h** |

**Sanity flags:** 07-02 → 07-04 (18.0 / 16.8 / 15.1 h in 1–2 sessions, 146–265
commits/day) run far above a hands-on commit rate — those days almost
certainly ran heavy parallel/autonomous dispatch (auto-ticket → Claude → PR),
so attended time was lower. Discounting those three days to a realistic
attended ~8–10 h each lands the month closer to **~310 h** of genuinely
engaged time. The steady 10–13 h/day band (06-10 → 06-25) is the most
trustworthy.

## What the time produced (replacement-cost estimate)

From `update_tracker.py` on the current tree: **~65,200 equiv LOC** (raw LOC
discounted for generated/repetitive content — SVG/JSON ~0.30, HTML ~0.55,
CSS/MD ~0.60, app logic 1.0).

| | R650/hr | R800/hr |
|---|---|---|
| Build only (writing the code) | ~R2.25M | ~R2.78M |
| Full delivery (×2: design/test/QA/UAT/PM) | ~R4.50M | ~R5.56M |

Quote the **band**, not a single figure — the Net LOC/day assumption
(100 / 150 / 250) moves the answer more than the rate does. Build-only is the
defensible core; full delivery compounds uncertainty.

## The compression story

~334 h of directed AI development (upper bound; ~310 h realistic) produced a
codebase that would cost **~R2.8M–R5.6M** to commission conventionally at
R800/hr — an effective **~R8,400/hr of engaged time** (build-only) to
**~R16,700/hr** (full delivery). Equivalently, ~65,200 equiv LOC ÷ a
conventional 100–250 net LOC/day is **~1,500–3,000 engineer-hours** of output,
compressed into the ~310–334 h actually spent.

> One-liner for a value story: *"In its first month, ~330 hours of directed AI
> development produced a build worth ~R2.8M–R5.6M to commission conventionally."*
