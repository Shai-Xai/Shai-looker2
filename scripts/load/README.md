# Social load testing

Two tools, two jobs:

## bench-local.js — fast A/B micro-benchmark (no network)

Boots ONLY the social module on a local port with stubbed auth, seeds a
realistic feed (60 posts × 30 reactions × 10 comments), and hammers
`GET /api/app/social/feed` with autocannon. Use it to prove a performance
change before/after:

```bash
node scripts/load/bench-local.js                                  # after (working tree)
git stash && node scripts/load/bench-local.js && git stash pop    # before
```

**Baseline (2026-07-23, sandbox hardware — compare ratios, not absolutes):**

| | req/s | p50 | max |
|---|---|---|---|
| before (per-post count queries, per-row impression commits) | 105 | 219 ms | 800 ms |
| after (batched counts + one impressions tx + ETag/304) | **198 (+88%)** | **120 ms** | **341 ms** |

Unchanged polls with `If-None-Match` now return empty **304**s.

## social-load.k6.js — staged storm against STAGING (never production)

Realistic fan mix: feed + chat polls (with ETags, like the app), rail,
occasional community opens. Thresholds fail the run when p95 > 800ms or
errors > 1% — ramp `VUS` until thresholds fail; that's the capacity knee.

```bash
k6 run -e BASE=https://<staging-pulse> -e TOKEN=<howler-jwt> \
  -e EVENT=19203 -e CHANNEL=<chan-id> -e VUS=200 -e DURATION=2m \
  scripts/load/social-load.k6.js
```

Record each measured knee (date, VUS, p95) here:

| date | commit | VUS at knee | p95 at knee | notes |
|---|---|---|---|---|
| _to be measured_ | | | | first staging run pending |
