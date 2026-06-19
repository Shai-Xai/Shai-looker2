# Test stories — audience sync (Meta · TikTok), connector monitoring & digest dates

Covers the batch shipped 2026-06-16: per-client **Meta** + **TikTok** audience-sync
connectors (segment → Custom Audience, hashed match), Meta **mirror** + daily
**auto-mirror**, TikTok **true mirror via diffing**, the **segment-level connector
view**, the three-phase **connector monitoring** (health grid · live verify + deep
links · platform read-back + change log), and the **digest/briefing date-anchor fix**.

Two sets: **manual acceptance** (run in the app) and **review** (code/behaviour
angle for Hermes). Tick the boxes as you go.

> ⚠️ **Live-credential note.** The actual Graph/Marketing API calls (sync, verify,
> size read-back, deep links) were **not** exercised against real Meta/TikTok
> accounts in development. Stories tagged **[live]** need a real pasted token +
> ad-account/advertiser ID. Stories tagged **[offline]** work with no credentials.
> When live, sanity-check the exact Meta/TikTok **endpoint field names and the
> deep-link URL formats** — they drift between API versions.

---

## Manual acceptance (Shai)

### Story 1 — Connect a client to Meta / TikTok [offline]
- [ ] Admin → a client → **Integrations**: a **◇ Meta** section (access token,
      ad account ID, business ID) and a **♪ TikTok** section (access token,
      advertiser ID) appear.
- [ ] Tokens are **write-only**: after saving, the field shows "Set (••••) — leave
      blank to keep", never the value; a **Remove this token** checkbox clears it.
- [ ] The same sections appear in **client self-service** (Settings → Integrations
      & branding) scoped to that client only.
- [ ] The platform-level **Admin → Integrations → Accounts** form does **not** show
      Meta/TikTok (they're per-client).
- ✅ Pass: dual-surface present, secrets never returned, non-secret IDs editable.

### Story 2 — "Sync to Meta" mirrors a segment [live]
- [ ] With Meta connected, open **Engage → Segments**; a connected segment shows a
      **◇ Sync to Meta** button.
- [ ] Click it → message reads **"✓ N mirrored to Meta — matching runs on Meta's
      side"**; the segment line then shows **"◇ Meta: N mirrored · <date> · audience
      <id>"** with an **open ↗** link.
- [ ] In Meta Ads Manager, a Custom Audience named **"<segment> (Pulse)"** exists.
- [ ] Change the segment so someone drops out, sync again → they're **removed** from
      the Meta audience (membership mirrors, not just grows).
- ✅ Pass: one click creates/updates the audience; repeat syncs reflect the current
  segment exactly; the count shown is *sent*, not a fabricated "matched" figure.

### Story 3 — Meta audience survives a rename [live]
- [ ] Sync a segment to Meta, then **rename** the segment, then sync again.
- [ ] Only **one** audience is updated (the same id) — no orphaned duplicate.
- ✅ Pass: the mapped audience id is reused across renames.

### Story 4 — Daily auto-mirror to Meta [live]
- [ ] On a segment, toggle **◇ Auto: off → on** (button highlights).
- [ ] The audience re-mirrors on the background tick (~daily; throttled — won't
      re-push if synced in the last ~20h).
- [ ] Toggle back to **off** → no further auto-syncs.
- ✅ Pass: auto state persists; unattended syncs use the client's own data scope.

### Story 5 — "Sync to TikTok" true mirror [live]
- [ ] With TikTok connected, a segment shows **♪ Sync to TikTok**.
- [ ] First sync → **"✓ N mirrored to TikTok (+N −0)"**; a Custom Audience exists
      in TikTok.
- [ ] Remove someone from the segment + add someone, sync again → message shows the
      **(+added −removed)** deltas; the departed person is **removed** in TikTok.
- ✅ Pass: TikTok membership tracks the segment (adds *and* removes) on a stable
  audience id.

### Story 6 — Segment-level connector view [offline]
- [ ] Under each segment, every connected channel shows a line: synced audiences read
      "**N mirrored · date · audience <id> · open ↗**"; connected-but-unsynced reads
      "**connected · not synced yet**".
- [ ] A channel that isn't connected shows **no** line for that segment.
- ✅ Pass: per-segment you can see which platforms it's on, the audience id, last
  sync, and jump out — in both admin and client self-service.

### Story 7 — Connector health overview [offline + live]
- [ ] Admin → Integrations → **◇ Audience sync — connector health**: a per-client
      list with status pills (**not connected / connected / N ok / N failing**),
      failing/most-recent clients first. [offline]
- [ ] Expand a client → per channel: connection state, last activity, last error,
      and each segment's audience (✓/✗, count, id). [offline]
- [ ] **Verify now** on a channel → ✓ "Token valid — <account>" or ✗ with a reason
      (token_invalid / forbidden / error). [live]
- [ ] **Open in Meta/TikTok ↗** opens that ad account's audiences. [live]
- [ ] **size?** on an audience → "~N on platform" or "still processing" (Meta/TikTok
      compute size asynchronously). [live]
- [ ] **Recent activity** timeline lists recent syncs (✓/✗, channel, count, +/−,
      who, when). [offline once syncs exist]
- ✅ Pass: health is visible without opening each client; failures and token death
  are distinguishable; the timeline shows what changed.

### Story 8 — Digest references the send date, not the data [offline]
- [ ] Refresh a client's **scheduled digest** (and the **home briefing**).
- [ ] Headline/narrative anchor "today / yesterday / month-to-date" to **today's
      date**, not the latest day in the data.
- [ ] When the data lags (latest day < today), it says e.g. **"data to the 12th"**
      rather than implying the month stopped there.
- ✅ Pass: no more "month-to-date (through day 12)" on the 16th; relative dates
  track the send date for every role/profile, not just the management report.

### Story 9 — Graceful when a connector isn't set up [offline]
- [ ] A client with **no** Meta/TikTok connection shows **no** sync buttons and is
      **absent** from (or "not connected" in) the health view — nothing errors.
- [ ] Clicking sync on a half-configured client returns a clear "isn't connected —
      add a token + account/advertiser in Integrations" message, not a crash.
- ✅ Pass: unconfigured = clean no-op + clear guidance.

---

## Review stories (Hermes)

### R1 — PII is hashed correctly and identically across channels
- [ ] Email is **lowercased + trimmed**, phone normalised to **E.164 digits**
      (default ZA `27`, handles `0…`, `+…`, `00…`) before SHA-256; junk → `''`.
- [ ] **Meta and TikTok hash the same identity to the same hash** (no per-recipient
      raw PII ever leaves the server).
- 🔎 `hashEmail`/`hashPhone` in `server/meta.js` + `server/tiktok.js`;
  `test/connectors.test.js` locks this.

### R2 — Server-side scope can't leak another client's people
- [ ] The sync routes resolve the segment through `resolveDefinition` →
      `resolveAudience`, scoped by the **route's `entityId`**, before any hashing.
- [ ] The auto-mirror tick uses a **synthetic system user** scoped to the segment's
      own entity — never widens scope.
- 🔎 `/sync/meta`, `/sync/tiktok`, `autoMirrorTick` in `server/segments.js`.

### R3 — Meta mirror semantics
- [ ] Default sync uses `usersreplace` **sessions** (full replace), batched ≤5k with
      correct `batch_seq` / `last_batch_flag` / `estimated_num_total`.
- [ ] The audience id is **persisted per (entity, segment)** (`meta_audiences`) and
      reused (survives rename); a deleted audience is **recreated then retried** once.
- [ ] Empty resolve is **blocked** (won't accidentally clear an audience).
- 🔎 `uploadUsers`, `findOrCreateAudience`, `syncAudience` in `server/meta.js`.

### R4 — TikTok true-mirror diffing is correct & crash-safe
- [ ] Baseline membership (`tiktok_audience_members`, per kind) is diffed → APPEND
      adds, DELETE removes, on a **stable** audience id.
- [ ] The baseline is committed **only after** the platform calls succeed (a failed
      sync doesn't corrupt the diff state); a vanished audience recreates fresh.
- [ ] No one-call "replace" is assumed (TikTok has none); first sync creates.
- 🔎 `syncAudience`, `applyDelta`, `replaceMemberSet` in `server/tiktok.js`.

### R5 — Write-only secrets & dual-surface
- [ ] `entityIntegrationsView` returns only `tokenSet`/hint + non-secret IDs; the
      patch only writes a token when a new value is supplied, and clears on flag.
- [ ] Admin (`/api/admin/entities/:id/integrations`) and client self-service
      (`/api/my/integrations/:entityId`) share `applyIntegrationsPatch`; the `my`
      route enforces entity ownership.
- 🔎 `entityIntegrationsView`, `applyIntegrationsPatch` in `server/index.js`;
  `showMeta`/`showTikTok` gating in `client/src/components/IntegrationsForm.jsx`.

### R6 — Monitoring reads are cheap; logging never breaks a sync
- [ ] `summary()` and `/integrations/health` read **stored** sync records (no live
      API calls); only **verify** and **audience-status** hit the network, on demand.
- [ ] `audience_sync_log` writes are wrapped so a logging failure can't fail a sync;
      the log endpoint is admin-only and capped (`limit ≤ 200`).
- [ ] `verify`/`audienceStatus` are best-effort and **never throw**; status codes map
      sensibly (token_invalid vs forbidden vs error).
- 🔎 `summary`/`verify`/`audienceStatus`/`logSync` in the connectors; health, verify,
  audience-status, log endpoints in `server/index.js`.

### R7 — Digest/briefing date anchoring
- [ ] `today` (send date in `Africa/Johannesburg`) is passed into `digestBrief` +
      `briefHome`; the system prompts instruct anchoring to TODAY and "data to the
      Nth" framing when the data lags.
- [ ] Applies to **all** roles/profiles + the home briefing (shared code path), not
      just one report; `today` is optional (no crash if omitted).
- 🔎 `todayLabel` + the two call sites in `server/index.js`; `DIGEST_SYSTEM`,
  `HOME_SYSTEM`, `digestBrief`, `briefHome` in `server/insights.js`.

### R8 — Known limits to confirm, not fix
- [ ] Connectors are **untested against live APIs**; field names / deep-link URLs /
      verify error codes are best-effort pending a real account.
- [ ] **OAuth** is deferred — connection is a pasted long-lived/system-user token.
- [ ] **Auto-mirror is Meta-only**; TikTok mirror is manual (flag if symmetry wanted).
- [ ] Platform **size read-back** is async on their side (reads "processing" right
      after a push) — by design, not a bug.
