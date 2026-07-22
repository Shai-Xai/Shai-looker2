# Setup guide — Google Drive (the Owl reads files) & Meta connection

> Operational guide for AMs/admins. Covers the two connectors shipped
> 2026-07-02: the Google Drive integration (`server/googleDrive.js`, roadmap
> 4.8) and the Meta connection that powers audience-sync (`server/meta.js`) +
> paid-performance ingestion (`server/metaAds.js`, roadmap 4.9 P1).
> Pulse: https://howler-pulse-v2.onrender.com · Render: https://dashboard.render.com

---

## 0. The EASY paths — one-click connect (shipped 2026-07-02, later the same day)

Once Howler does a **one-time platform app registration** per platform (0a/0b),
clients never see keys or tokens again — the cards in Settings → Integrations
show **"Connect with Google"** and **"Continue with Facebook"** buttons. The
manual paths in §1–2 below still work and remain the fallback. For Meta,
**§0c (agency path: house token + partner share) is the recommended default** —
it needs no per-client OAuth, no app review and no client-side technical steps.

### 0a. One-time platform setup — Google (≈10 min, no verification ordeal)
1. In the Google Cloud project (https://console.cloud.google.com):
   - Enable **Google Drive API** and **Google Picker API**
     (https://console.cloud.google.com/apis/library).
   - **OAuth consent screen** (https://console.cloud.google.com/apis/credentials/consent):
     External → fill the basics → **Publish**. We only use the `drive.file`
     scope, which is **non-sensitive** — no Google review/assessment needed.
   - **Credentials** (https://console.cloud.google.com/apis/credentials):
     Create **OAuth client ID** → Web application → Authorized redirect URI
     `https://howler-pulse-v2.onrender.com/api/drive/oauth/callback`.
     Also create an **API key** (restrict it to the Picker API).
2. In Render (https://dashboard.render.com) set:
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_API_KEY`.
   (Settings `google_oauth_client_id` / `google_oauth_client_secret` /
   `google_api_key` work too.)
3. Client experience: Settings → Integrations → Google Drive →
   **Connect with Google** → sign in → **Pick files or folders** (a native
   Google picker). The app can only EVER see what they pick — better privacy
   than the share-with-email path, and zero setup for the client.

### 0b. One-time platform setup — Meta (≈10 min + the verification long pole)
1. https://developers.facebook.com/apps → create/select the Business app →
   add the **Facebook Login** product → Settings → **Valid OAuth Redirect
   URIs**: `https://howler-pulse-v2.onrender.com/api/meta/oauth/callback`.
2. In Render set `META_APP_ID` + `META_APP_SECRET` (or settings
   `meta_app_id` / `meta_app_secret`).
3. Client experience: Settings → Integrations → **Continue with Facebook** →
   approve → if they manage several ad accounts, pick the right one in the
   card → done. Works for audience-sync AND paid-ads reporting (same fields).
4. **Interim caveat:** without **Advanced Access** (Meta Business
   Verification + App Review — start it at the app's App Review tab), tokens
   last ~60 days (the card shows the renewal date and flags reconnect at ≤7
   days) and Standard Access limits who can connect (users with a role on the
   app/business). Kick off verification once; after approval the same button
   mints durable tokens for any client, no code change.

### 0c. The AGENCY path — house token + partner share (RECOMMENDED, shipped 2026-07-18)

The lowest-friction route of all, and the one to lead with: **clients never
touch tokens, apps or system users** — they approve ONE partner share, and
Howler's own credentials do the rest.

**Howler side, once ever (~15 min):**
1. In HOWLER's Business portfolio (https://business.facebook.com/settings):
   make sure an app exists (Accounts → Apps; create a Business-type app at
   https://developers.facebook.com/apps if empty), then create system user
   `pulse` (Users → System users, role Admin) and generate a **never-expiring**
   token with `ads_read` + `ads_management` + `business_management`.
2. Paste it in Pulse → Admin → Integrations → **◇ Meta — house connection
   (agency)**, together with Howler's Business ID (Business settings →
   Business info). The Business ID is shown to clients inside their
   partner-share guide.

**Per client (~2 min their side, ~2 min ours):**
1. Client: Business settings → Users → **Partners** → Add → *Give a partner
   access to your assets* → enter Howler's Business ID → pick their ad account
   → enable **Manage campaigns**. (The client Meta card's first guide walks
   them through it, with Copy/Share buttons to forward to whoever runs their
   ads. Flipped variant: we *request* access to their ad account ID from our
   Business settings and they just approve.)
2. Howler: assign the newly shared ad account to the `pulse` system user
   (system user → Add assets → Ad accounts → Manage campaigns), then set the
   client's **Ad account ID** on their entity — leave their token field
   BLANK. Blank token = inherits the house token automatically (their own
   token, when set, always wins).
3. Verify on the connection, and remind the client to accept the Custom
   Audience ToS once (https://business.facebook.com/ads/manage/customaudiences/tos)
   if audience sync is in play.

Caveats: partner sharing needs the client's ad account to live in a Business
portfolio (for personal ad accounts, have them add a Howler user by email to
the ad account and use the OAuth path instead). The house token is ads-scoped —
organic social metrics (Page/IG) still need the client's own token/IDs.

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
  access your own assets). **This is the #1 blocker for new businesses** —
  without an app in the portfolio, Meta greys out **Generate token** with
  *"an app must be part of this business portfolio. Please add an app."*
  To fix: https://developers.facebook.com/apps → **Create app** → type
  **Business** → name it (e.g. "Pulse") → link it to the business portfolio
  when prompted. If the app already exists but isn't linked: Business
  settings → **Accounts → Apps** → Add → Connect an app ID.

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
| **Generate token** greyed out — "an app must be part of this business portfolio" | No Business app linked to the portfolio → create/link one (2a) |
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
