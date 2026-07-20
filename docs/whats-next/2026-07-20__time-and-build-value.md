# 2026-07-20 — Time spent vs build value (refresh)

> Refresh of `2026-07-09__time-and-build-value.md`, 11 days on. Same method
> (git commit timestamps as a time proxy; `update_tracker.py` for build value).
> Read both with their caveats — neither is a precise instrument. Always
> `git fetch --unshallow` before trusting the history (a shallow clone hides
> everything before its cut point).

## Method (unchanged)

- **Time:** committer timestamps across all refs. Commits cluster into
  sessions; a gap > 90 min starts a new one. Engaged time = session span +
  20 min lead per session. Parallel/autonomous commits collapse into the
  elapsed clock (not double-counted), but unattended long runs are still
  counted, so totals are an **upper bound** on hands-on attention.
- **Build value:** raw LOC discounted per file type (SVG/JSON ~0.30, HTML
  ~0.55, CSS/MD ~0.60, app logic 1.0) → equiv LOC → engineer-days at a
  Net LOC/day band → hours → rand.

## Headline

| Window | Commits | Active days | Sessions | Engaged time |
|---|---|---|---|---|
| All-time (7 Mar → 20 Jul) | 2,498 | 46 | 122 | **~444 h** |
| Last 30 days | 1,826 | 31 | 84 | ~298 h |
| Last 7 days | 154 | 8 | 23 | ~51 h |

Still ~10 h/day. The last week added ~51 h and roughly +51k equiv LOC of net
growth — the codebase nearly doubled since the 09-Jul snapshot.

## Build value (current tree)

**597 source files · 156,390 raw LOC · 128,196 code LOC · ~116,576 equiv LOC**
(up from ~65,200 on 09 Jul).

| | R650/hr | R800/hr |
|---|---|---|
| Build only (writing the code) | ~R4.04M | ~R4.97M |
| Full delivery (×2: design/test/QA/UAT/PM) | ~R8.08M | ~R9.95M |

Band at R800/hr (Net LOC/day 100 / 150 / 250): **R7.46M / R4.97M / R2.98M**
build-only; double each for full delivery. Quote the band, not a single
figure — the LOC/day assumption moves the answer more than the rate.

## Compression

~444 h of directed AI development produced a codebase that would cost
**~R5M–R10M** to commission conventionally at R800/hr — an effective
**~R11,200/hr** of engaged time (build-only) to **~R22,400/hr** (full
delivery). Equivalently ~116,600 equiv LOC ÷ a conventional 100–250 net
LOC/day is **~3,700–7,500 engineer-hours** of output, compressed into the
~444 h actually spent.

> One-liner: *"In ~4.5 months, ~444 hours of directed AI development produced a
> build worth ~R5M–R10M to commission conventionally."*

## Trend vs 09-Jul snapshot

| Metric | 09 Jul | 20 Jul | Δ |
|---|---|---|---|
| Equiv LOC | ~65,200 | ~116,576 | +79% |
| All-time engaged hours | ~364 h | ~444 h | +80 h |
| Build-only @ R800 | ~R2.78M | ~R4.97M | +R2.19M |
| Full delivery @ R800 | ~R5.56M | ~R9.95M | +R4.39M |
