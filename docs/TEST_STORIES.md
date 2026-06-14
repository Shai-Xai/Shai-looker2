# Test stories — campaign attribution, reports & filters

Covers the batch shipped on 2026-06-14: per-channel click attribution, the
Email vs SMS report split, the "Email open rate" relabel, the channel/state
filter popover, the master per-channel rollup, all-steps sequence preview, and
persisted master collapse.

Two sets: **manual acceptance** (run in the app) and **review** (code/behaviour
angle for Hermes). Tick the boxes as you go.

---

## Manual acceptance (Shai)

### Story 1 — Filter popover keeps the list clean
- [ ] Campaigns shows a single **⚲ Filter** button (top-right), not a pill row.
- [ ] Opening it shows a **Channel** group and a **State** group, each listing
      only buckets that have campaigns (no "Pending 0"), with counts and a ✓ on
      the active choice.
- [ ] Picking `SMS` + `Drafts` narrows the list and the button shows badge **2**.
- [ ] **Clear filters** resets the list and removes the badge.
- ✅ Pass: no clutter in the list area, empty buckets never show, badge reflects
  the active count.

### Story 2 — Per-channel attribution (Email & SMS campaign)
- [ ] Send an **Email & SMS** campaign to yourself.
- [ ] Click the link in **both** the email and the SMS.
- [ ] The **Report** shows the **Email vs SMS split card** (Sent · Clicks · CTR)
      with the email click under Email and the SMS click under SMS.
- ✅ Pass: clicks land in the right channel; each CTR = clicks ÷ that channel's
  sent.

### Story 3 — "Email open rate" is unambiguous
- [ ] On a both-channel campaign row and in its report, the open metric reads
      **"Email open rate" / "% email open"** (never bare "open").
- ✅ Pass: no bare "open rate" label survives on a both-channel campaign.

### Story 4 — Master rollup mixes channels
- [ ] A master containing a mix (or a `both` campaign) shows an **Email vs SMS
      rollup card** above "By segment".
- [ ] A single-channel master shows **no** rollup card (by design).
- ✅ Pass: rollup shows only for mixed masters and totals match the segment rows.

### Story 5 — All steps preview in a sequence report
- [ ] The **Report** of a drip sequence shows **one rendered block per step**,
      each labelled by delay (`Step 2 · +24h`); the header reads `· N steps`.
- ✅ Pass: every step renders, not just the first.

### Story 6 — Master collapse survives reload
- [ ] Expand a master group, reload → stays expanded.
- [ ] Collapse it, reload → stays collapsed.
- ✅ Pass: the choice persists per client across reloads.

---

## Review stories (Hermes)

### R1 — Click attribution correctness & legacy data
- [ ] Channel derives from the link suffix (`/e`→email, `/s`→sms).
- [ ] Legacy/untagged clicks (`''`) attribute to the only channel on a
      single-channel campaign, and stay *unattributed-by-channel* on `both`.
- [ ] Older both-channel campaigns degrade gracefully (no false split) —
      per-channel data only accrues post-deploy.
- 🔎 `/c/:token/:rtok?/:ch?` route + report endpoint `perChannel` in
  `server/actions.js`.

### R2 — Per-channel counters are honest
- [ ] `emailSent`/`smsSent` increment only on a successful send per channel in
      **both** `runCampaign` and the drip sender.
- [ ] `emailClicks`/`smsClicks` in `results` mirror the `action_clicks` table
      (no double counting).
- [ ] CTR = clicks ÷ that channel's delivered, never ÷ total sent.

### R3 — Rollup avoids extra queries
- [ ] Master rollup reads `results.*` counters (cheap) rather than fanning out a
      report query per campaign.
- [ ] Flag if the clicks table should be the source of truth instead of the
      cached counter.

### R4 — Persisted UI state
- [ ] `localStorage` master-collapse persistence is keyed per entity.
- [ ] No concern with stale keys for deleted masters, or private-mode/quota
      handling.

### R5 — Filter popover scope
- [ ] Filtering is purely client-side over already-loaded actions (no new
      endpoint).
- [ ] Empty-bucket hiding can't strand a user on an empty filtered view (there's
      a "Clear filters" empty state).
