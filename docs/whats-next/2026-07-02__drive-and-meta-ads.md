# 2026-07-02 — Google Drive for the Owl (4.8 P1–P3) + Meta paid performance (4.9 P1)

> Session: roadmap review + stocktake (see `2026-07-02__stocktake.md`), then the
> two gaps Shai flagged were built end-to-end. Both pushed to the branch + main.

## Shipped

### Google Drive — the Owl reads the client's files (roadmap 4.8 → ✅)
`server/googleDrive.js` (disposable, ~430 lines) + `DriveSourcesCard.jsx`:
- **Connection:** per-client Google **service-account JSON key** (write-only,
  sealed at rest as `googleServiceAccountSecret`) with a platform-wide
  `GOOGLE_SERVICE_ACCOUNT_KEY` env fallback. No OAuth app needed — the client
  shares files/folders with the SA email (shown + copyable in the UI) and
  pastes the link. Dependency-free RS256 JWT auth, token cached.
- **P1 Sheets/CSV** → rows in `owl_uploads` (source `drive`) so `askUpload`
  queries them like any attachment; re-syncs short-circuit on `modifiedTime`.
- **P2 Docs/Slides/text → searchable text; PDFs → AI-transcribed** (prompt
  `driveDocText`, registered in the AI audit; metered per client as
  `drive_ingest`). New Owl tools **`searchDriveDocs` + `readDriveDoc`**
  (entity-scoped, chunked reads, cite-by-name), routed in `OWL_CHAT_SYSTEM`,
  and the chat context lists connected doc names.
- **P3 folders** → all supported children synced, removals mirrored, watched
  folders re-synced hourly by a self-guarded tick (`drive_sync_enabled` kill
  switch); other sources refresh 6-hourly.
- Dual-surface routes (`/api/admin/entities/:id/drive*`, `/api/my/drive/:id*`)
  and the card in Settings → Integrations + Admin → client → Integrations.
- 12 tests (`test/googleDrive.test.js`).

### Meta paid performance (roadmap 4.9 P1 → ✅, item now 🏗️)
`server/metaAds.js` (disposable, ~170 lines):
- Pulls per-campaign **daily** Graph insights — spend, impressions, clicks
  (inline link clicks preferred), reach, **purchases + purchase value**
  (omni_purchase → pixel fallback), account currency — using the SAME
  per-client `metaAccessToken`/`metaAdAccountId` as audience-sync.
- `meta_ad_insights` table; report view computes **CPC, cost-per-purchase,
  ROAS** (totals, per-campaign, daily series; ROAS never invented when no
  purchase value). Once-a-day tick across configured clients
  (`meta_ads_sync_enabled` kill switch) + Sync-now on both surfaces.
- **Paid ads section on the Social page** (mobile-first, scrollable table) and
  the **`getPaidPerformance` Owl tool** ("how are my ads doing / what's my
  ROAS"), with an honesty note: Meta-attributed conversions ≠ Howler sales.
- 6 tests (`test/metaAds.test.js`).

Full suite green throughout; client build green; server smoke-booted clean.
Sales overview updated (new "Owl reads your Google Drive" + "5f Paid ads"
sections + changelog); roadmap 4.8/4.9 statuses updated.

## Addendum (later same day): one-click OAuth shipped for both

- **Google:** `Connect with Google` — OAuth (`drive.file`, non-sensitive → no
  Google review) + the **Google Picker** in `DriveSourcesCard`; refresh token
  sealed per entity; `invalid_grant` → Reconnect state; SA path kept as
  fallback. New shared `server/oauthState.js` (signed, TTL'd state).
- **Meta:** `server/metaConnect.js` + `MetaConnectCard` — "Continue with
  Facebook" → short→long token exchange (~60 days interim), ad-account picker
  (auto-pick when one), writes the SAME `metaAccessToken`/`metaAdAccountId`
  fields so meta.js + metaAds.js work unchanged; expiry + reconnect surfaced.
- Platform setup steps documented in `docs/DRIVE_META_SETUP.md` §0 (Google
  OAuth client + API key; Meta app redirect URI + id/secret env vars).
- 5 new tests (`test/oauthConnect.test.js`); suite 432 green.
- **Verify-live checklist for the picker flow:** confirm folder children sync
  under `drive.file` when a FOLDER is picked (Google's per-file grant model —
  if children 404, fall back to picking files individually or the SA path);
  confirm the Picker loads with the restricted API key.

## What's next (this thread)

1. **Live verification (the gating step for both):**
   - Create a Google Cloud service account, set `GOOGLE_SERVICE_ACCOUNT_KEY`
     (or paste per client), share a real Sheet/Doc/PDF/folder, and dogfood
     "what does the budget say?" end-to-end.
   - Hit Sync ads for a client with a real Meta ad account; confirm purchase
     values flow (needs the client's pixel tracking purchases).
2. **Meta P2 — OAuth connect** (replace pasted tokens; token refresh) and do
   **4.6 multi ad-accounts** (`ad_connections`) in the same change.
3. **Meta P3–P5:** lookalikes from synced audiences → Conversions API
   (promo-code/tracked-link signals first) → publishing (act-layer).
4. **Drive follow-ons:** per-file include/exclude inside a watched folder;
   Docs into the future Recall corpus (brief 6c) — the extraction pipeline is
   now in place; XLSX support if demand (needs a parser lib).
5. **Paid → goals:** feed `meta_ad_insights` into the Goals `social_paid`
   adapter (GOALS P4) and surface spend/ROAS as dashboard tiles (joins the
   social-tiles item in 4.3).
