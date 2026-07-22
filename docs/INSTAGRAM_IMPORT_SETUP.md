# Instagram import — dev-mode setup (the interim before Meta App Review)

The 📸 Instagram import (Community tab → recent-posts grid → "⤵ Post on
Howler") needs a Meta access token with Instagram permissions plus the IG
account id. Full Meta App Review is only required to serve *arbitrary*
clients; in **development mode** any account added as a tester on the Meta
app works immediately — that's the interim path. One-time setup ~20 minutes.

_Last updated: 2026-07-19_

## 0. Prerequisites (per Instagram account)

- The Instagram account must be a **Business or Creator** account
  (Instagram app → Settings → Account type). Personal accounts are invisible
  to the API.
- It must be **linked to a Facebook Page** (Instagram → Settings → Sharing to
  other apps / Page linking, or from the Page: Settings → Linked accounts).

## 1. The Meta app (once, for Howler)

1. https://developers.facebook.com → My Apps → Create App → type **Business**.
   (If Pulse's ads "Continue with Facebook" app already exists, REUSE it —
   one app for everything.)
2. In the app dashboard, note the **App ID** and **App Secret** — these are
   the same `meta_app_id` / `meta_app_secret` Pulse's Meta connect uses.
3. Keep the app in **Development mode** (default). No review needed yet.
4. App Roles → Roles → add the people whose Instagram accounts you'll import
   from as **Testers** (they accept the invite at
   https://developers.facebook.com/settings/developer/requests/). Accounts
   held by app admins/developers work without an invite.

## 2. Get a token (per account, ~2 min in Graph API Explorer)

1. https://developers.facebook.com/tools/explorer/ → pick the app (top
   right).
2. Under Permissions add: `instagram_basic`, `pages_show_list`,
   `pages_read_engagement`, `business_management`.
3. Generate Access Token → log in as the account that admins the Facebook
   Page → approve.
4. That token is short-lived (~1h). Exchange it for a **long-lived (~60 day)
   token**:
   ```
   curl "https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_TOKEN>"
   ```
   The `access_token` in the response is what goes into Pulse.

## 3. Find the Instagram user id

With the long-lived token:
```
curl "https://graph.facebook.com/v19.0/me/accounts?fields=name,instagram_business_account&access_token=<TOKEN>"
```
Each Facebook Page row that has an `instagram_business_account` shows its
`{ "id": "1784…" }` — that number is the **IG user id**.

## 4. Paste into Pulse

Admin → the client → **Integrations** (or the client's own Settings →
Integrations) → Meta section:
- **Access token** → the long-lived token from step 2
- **IG Business/Creator user id** → the id from step 3

Save, then open the client's **Community** tab — the 📸 Instagram section
should now show their recent posts. Click **⤵ Post on Howler** on any of
them: media is downloaded and re-hosted by Pulse, the caption prefills, and
it publishes to the selected community (optionally the Howler-wide feed).

## Gotchas

- **Tokens expire (~60 days)** in this interim mode — the same limitation the
  ads connect has. Symptom: the grid shows "Instagram said: Error validating
  access token". Fix: repeat step 2. (Advanced Access after App Review mints
  non-expiring business tokens with no code changes.)
- **Wrong account type**: an empty grid or an OAuth error usually means the
  IG account isn't Business/Creator or isn't linked to the Page the token
  can see.
- **Only tester/admin accounts work in dev mode** — a random client's IG will
  fail until they're added as a tester (fine for pilots) or App Review is
  done (`instagram_basic` Advanced Access + Business Verification, the
  scale-out path — start it in parallel, it's a one-time process).
- Videos over ~10MB fail to re-host until Cloudflare R2 is configured on the
  Pulse service (`SOCIAL_S3_*` env vars) — images are unaffected.
