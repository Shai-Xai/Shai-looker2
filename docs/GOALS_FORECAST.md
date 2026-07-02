# GOALS_FORECAST.md — forecast-led goal tracking

Working spec for the next iteration of the Results pillar: replace the confusing
"pace / expected-by-now / checkpoints" read with a **forecast** — *"you're tracking
to finish ~X; your target is Y; here's how you compare to last year."* Companion to
`docs/GOALS_BRIEF.md` (the model) and `docs/GOALS_MERGED.md` (canonical spec).

> **Status:** built (server/forecast.js + goals.computeProgress). **Last updated:** 2026-07-02.

## 1. Why
Today a goal shows current vs target, a pace line ("expected ≈ 56,419 by now"), and
a list of checkpoints. It's accurate but **hard to read**, and it carries two truths
at once that confuse ("**behind** the target pace" *and* "**+1% vs last year**"). The
fix is to lead with the one thing people actually want: **will I hit the target, and
how am I doing vs last time.** A forecast answers both in a sentence.

## 2. Non-negotiable (carried from the pillar)
**The forecast number is COMPUTED by a deterministic model. The AI only phrases it.**
No LLM-invented figures — keeps it reproducible, auditable, and fast (no model call
on the goals load). The Owl narrates the computed result and (later) flags *why*.

## 3. The model — two signals
### 3a. Shape-scaled projection (the core) — DECIDED
Use last time's cumulative curve (already resolved via `resolveTileSeries`, the
linked `curveRef` tile). Find the fraction of its final total reached **by this point
in the cycle**, `f_now`, then:

```
ratio   = currentValue / (lastTotal × f_now)          # vs last time, at this point
believe = √f_now                                      # observed share of the cycle
projectedFinal_shape = lastTotal × (1 + (ratio − 1) × believe)
```

The raw `currentValue / f_now` says "keep outperforming by today's ratio for the WHOLE
cycle" — explosive early on (5% observed × 5× ahead reads as 5× last time's total). So
the outperform ratio is only **partially believed**, shrunk toward 1 by √f (early data
counts some, never fully); it converges to the exact ratio as the cycle completes.

e.g. 41,029 ÷ 0.68 ≈ **60,300**. Because it rides the historical *shape*, it inherently
knows ticket sales are back-loaded (accelerate near the event) — so it won't
under-forecast the way a flat run-rate would. "This point in the cycle" =
`(now − trackFrom) / (deadline − trackFrom)` mapped onto the curve (the same window
anchor we added as `start_date`).

### 3b. Last-30-day momentum (the calibrator)
Pull **this year's** recent daily series for the same tile (the current-period column,
e.g. the `26` pivot). Compute the recent run-rate and compare it to what last year's
shape predicts for the same window:

```
momentum = recentActualRate / recentShapeImpliedRate    (>1 = running hot)
projectedFinal_momentum = currentValue + recentDailyRate × daysLeft
```

Momentum catches a campaign spike / slump the pure shape can't see. It's a
**calibrator**, not the headline — spiky sales make a raw run-rate unreliable near
the event, which is why 3a leads.

### 3c. Blend + range — DECIDED (range)
Report a **band**, not false precision:

```
forecast = clamp blend, weighting momentum more as the event nears
range = [ shape-only , momentum-adjusted ]   (ordered low→high)
```

Headline shows the blended point; the band conveys honesty. **Built weighting:** the
momentum weight rides the EVENT CYCLE (position along the sell-curve's own countdown
axis, the same anchor pace uses), clamped to **[0.25, 0.6]** — floored so the recent-
14-day trading always tempers the projection, capped so the seasonal shape (which
knows the late surge) stays the primary signal. Non-countdown curves fall back to the
goal-window position, capped at 0.5.

## 4. What the card becomes (the simplification)
Replace the pace block with a **forecast headline**:

```
41 029 / 60 000 tickets
Forecast: ~60 300 by 2 Jul — on track to hit your target ✅   (range 58k–62k)
Tracking +1% vs last year at this point.
```

- **Status from the forecast vs target**, not raw pace:
  `will hit ✅` (proj ≥ target) · `borderline ⚠️` (within ~5%) · `short ⛔` (proj < target − 5%).
- **vs last year at this point** stays (we already compute `lastAtNow`).
- **Checkpoints + the curve/pace detail move behind a "details" expander** — present
  for the curious, out of the way for the glance.

## 5. Where the AI fits
- **Narrate** (Owl summary + card subtitle, optional): turn the computed forecast into
  a sentence — *"Sales mirror last year's shape, but you're aiming 39% higher; the last
  30 days have picked up, so you're tracking to just hit 60k."* Grounded in the model's
  numbers; never invents them.
- **Anomaly flags (P2):** explain *why* — "early-bird sold out 2 weeks faster than last
  year." Annotates, doesn't compute.

## 6. Data + implementation sketch
- **Inputs:** last year's curve (have it — `curveRef` + `resolveTileSeries`); this
  year's recent series (new — same tile, current-period column / last ~30 days);
  `trackFrom`, `deadline`, `target`, `currentValue` (have them).
- **Server:** a deterministic `forecast(goal, lastCurve, recentSeries) → { projected,
  range:[lo,hi], status, basis, confidence }` in `server/goals.js`; surfaced on
  `progress` from `GET /api/goals/suites/:id` (reuse the per-request curve cache; add
  a recent-series read, also cached per tile).
- **Confidence / fallback:** require enough history + a comparable curve; when thin,
  **don't fake it** — show "not enough history to forecast yet" and fall back to the
  current pace read. Confidence from curve length + how closely recent actuals track
  the shape.
- **Client:** forecast headline on `GoalDetail` (and a compact form on `GoalCard`);
  move checkpoints/pace under a details expander.
- **Cost:** one extra recent-series Looker read per goal-with-curve per load, cached
  per (tile,suite) per request, in parallel — bounded, same pattern as the curve.

## 7. Phasing
- **F1 — shape-scaled forecast + range, forecast-led card.** The big readability win.
- **F2 — 30-day momentum calibrator + confidence.** Sharper, honest band.
- **F3 — Owl narration of the forecast** (card subtitle + goals brief).
- **F4 — anomaly flags** ("why" the trend shifted).

## 8. Open decisions
1. **Headline = forecast vs target**, pace/checkpoints demoted to a details view —
   confirm (leaning yes).
2. **Range vs single number** — leaning range.
3. **Momentum window** — 30 days default? Per-goal override later?
4. **Blend weighting** — fixed shape-leaning, or shift toward momentum as the event
   nears (leaning the shift)?
5. **Confidence thresholds** — min curve points / max shape-deviation before we show a
   forecast at all.

## 9. Non-goals (for now)
- Multi-year / seasonality models (one comparable prior curve is enough for v1).
- AI computing the number (it phrases only).
- Forecasting non-tiled / manual goals (no curve → keep the simple current-vs-target read).
