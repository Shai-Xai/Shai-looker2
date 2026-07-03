# Setup guide — Google Drive (the Owl reads files) & Meta connection

> Operational guide for AMs/admins. Covers the two connectors shipped
> 2026-07-02: the Google Drive integration (`server/googleDrive.js`, roadmap
> 4.8) and the Meta connection that powers audience-sync (`server/meta.js`) +
> paid-performance ingestion (`server/metaAds.js`, roadmap 4.9 P1).
> Pulse: https://howler-pulse-v2.onrender.com · Render: https://dashboard.render.com

---

## 1. Google Drive — setup (~5 minutes)

### 1a. Create the service account (once)
1. Google Cloud Console: https://console.cloud.google.com — create/select a
   project (e.g. "Howler Pulse").
2. Enable the Drive API:
   https://console.cloud.google.com/apis/library/drive.googleapis.com → Enable.
3. https://console.cloud.google.com/iam-admin/serviceaccounts → Create service
   account → name `pulse-owl` → skip the optional role/access steps → Done.
4. Open the account → **Keys** → Add key → Create new key → **JSON** → a
   `.json` file downloads. That file is the credential — treat it like a
   password.

### 1b. Connect it in Pulse (two options)
- **Platform-wide (recommended):** Render → the Pulse service → Environment →
  add `GOOGLE_SERVICE_ACCOUNT_KEY` = the ENTIRE JSON file contents. Every
  client can then use Drive without their own key.
- **Per client:** Settings → Integrations → **Google Drive** (client
  self-service) or Admin → client → Integrations (same card) → Connect →
  paste the JSON → Save key. Write-only; never displayed again.

### 1c. Share + add files
1. The card shows the service-account email (Copy button).
2. In Google Drive, share a file or a whole folder with that email (Viewer).
3. Paste the link into the card → Add → expect **✓ synced**. Folders list
   their files underneath, are watched by default and re-sync hourly
   (kill switch: setting `drive_sync_enabled = 0`).

What each format becomes: Sheets/CSV → live tables (`askUpload`);
Docs/Slides/text → searchable text; PDF → AI-transcribed text (needs the
Anthropic key; metered per client as `drive_ingest`). XLSX is not supported —
convert to Google Sheets/CSV.

### 1d. Test with the Owl
- "What's in my attached data?" → the Sheet appears as a source.
- "What's the total cost in the budget sheet?" → grounded on the table.
- "What does the marketing plan say about launch week?" → quotes + cites the
  doc by name.
- Folder watch: drop a new file in the shared folder → picked up within the
  hour (or hit ↻ on the folder source).

---

## 2. Meta — the connection (token + ad account)

Pulse needs two fields (Settings → Integrations → Meta, or Admin → client →
Integrations): `metaAccessToken` + `metaAdAccountId`. The reliable token is a
**system-user token** — a Graph API Explorer token expires after ~1–2 hours
(if a connection "worked then stopped", that's almost always why).

### 2a. Prereqs (once per business)
- The ad account lives in a Meta **Business portfolio**:
  https://business.facebook.com
- One Meta **app** of type Business linked to that business:
  https://developers.facebook.com/apps (no app review needed — you only
  access your own assets).

### 2b. Create the system user + token
1. Business settings: https://business.facebook.com/settings → Users →
   **System users** → Add → name `pulse`, role Admin.
2. On the system user → **Add assets → Ad accounts** → pick the client's ad
   account → enable **Manage campaigns** (covers reading insights AND pushing
   Custom Audiences).
3. **Generate new token** → select the app → expiration **Never** →
   permissions **`ads_read`** + **`ads_management`** (+ `business_management`
   if listed) → Generate → copy immediately (shown once).
4. Ad account ID: the digits after `act=` in the Ads Manager URL
   (https://adsmanager.facebook.com). Pulse accepts bare digits or
   `act_123…`.
5. Paste both into Pulse → Save. Admin can hit **verify** on the connection
   to confirm it reaches the account.

### 2c. Common blockers (in order of likelihood)
| Symptom | Cause → fix |
|---|---|
| Worked, then 401/"session expired" after a few hours | Graph Explorer token → use the system-user token (2b) |
| "Unsupported get request" / permission error | Ad account not assigned to the system user (2b step 2) |
| Insights sync fails | Missing `ads_read` on the token |
| Audience sync fails, insights fine | Missing `ads_management`, or Custom Audience ToS not accepted → https://business.facebook.com/ads/manage/customaudiences/tos |
| ROAS shows “—” | Expected until the client's Meta pixel tracks purchases; spend/clicks still flow |

### 2d. Test paid performance
1. Pulse → **Social** page → the **💸 Paid ads** section appears once Meta is
   configured → **↻ Sync ads** → spend/clicks per campaign appear.
2. Ask the Owl: "How are my Meta ads doing — spend and ROAS?"
3. It refreshes automatically once a day (kill switch:
   `meta_ads_sync_enabled = 0`).
