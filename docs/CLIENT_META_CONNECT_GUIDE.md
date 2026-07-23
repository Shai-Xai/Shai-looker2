# Connect your Meta ads & social analytics to Pulse

> A shareable, non-technical guide. Send this to the person who manages your
> Facebook/Instagram — the whole client side takes about **3 minutes** and
> involves **no tokens, no apps, no developer tools**. Howler handles the rest.
>
> What you get in Pulse (https://howler-pulse-v2.onrender.com): your **paid-ads
> performance** (spend, clicks, results per campaign), **ad audiences** built
> from your own ticket data (emails/phones are hashed before they ever leave
> Pulse), and your **organic social stats** (followers, reach, post engagement)
> — all next to your sales data, with the Owl able to answer questions across
> the lot.

---

## Part 1 — What the client does (±3 minutes, once)

You need **Admin access** to your Meta Business portfolio (the account that
owns your ad account and Facebook Page). If your ads are run by an agency,
forward them this page — it's a standard partner share they'll recognise.

1. Sign in at **https://business.facebook.com/settings** with the account that
   manages your ads.
2. In the left menu, open **Users → Partners** → **Add** → choose
   **"Give a partner access to your assets"**.
3. Enter **Howler's Business ID** (your Howler contact gives you this — it's
   also shown inside Pulse → Settings → Integrations → Meta, in the
   "Let Howler connect for you" guide).
4. Choose what to share — tick everything you want in Pulse:
   - **Ad account** → enable **Manage campaigns** *(paid-ads reporting +
     ad audiences)*
   - **Facebook Page** → enable **insights/analyze** access *(organic Facebook
     stats)*
   - **Instagram account** *(organic Instagram stats)*
5. Save, then tell your Howler contact **which ad account / Page / Instagram**
   you shared.
6. *(Only if we'll push ad audiences for you, one-time)*: accept Meta's Custom
   Audience terms at
   https://business.facebook.com/ads/manage/customaudiences/tos

That's it. Nothing else, ever — no tokens to copy, nothing expires, and you
can revoke the share at any time from the same Partners screen.

**If your ad account isn't in a Business portfolio** (personal ad account):
partner sharing isn't available — instead add your Howler contact's Facebook
user to the ad account (Ad account settings → Ad account roles), and we'll use
the "Continue with Facebook" connect in Pulse.

---

## Part 2 — What Howler does

### One-time platform setup (~15 min, already done once — skip if the house
### connection shows "Set" in Admin → Integrations)

1. In **Howler's** Business portfolio (https://business.facebook.com/settings):
   - Make sure the business has an **app**: Accounts → Apps. If empty, create a
     **Business**-type app at https://developers.facebook.com/apps (it's just a
     container Meta requires — nothing gets built).
   - Create the system user: **Users → System users → Add** → name `pulse`,
     role **Admin**.
2. On the system user → **Generate new token** → pick the app → expiration
   **Never** → tick ALL of:
   - `ads_read`, `ads_management`, `business_management` *(ads + audiences)*
   - `pages_read_engagement`, `read_insights`, `instagram_basic`,
     `instagram_manage_insights` *(organic social analytics)*
   → **Generate** and copy it immediately (shown once).
3. In Pulse → **Admin → Integrations → ◇ Meta — house connection (agency)**
   (unlock the section first): paste the token and Howler's **Business ID**
   (Business settings → Business info). The Business ID then appears
   automatically in every client's partner-share guide.

### Per client (~2 min, after their share is approved)

1. In Howler's Business settings → the `pulse` system user → **Add assets**:
   - their **Ad account** → enable **Manage campaigns**
   - their **Page** (and **Instagram account**) → enable insights access
2. In Pulse → Admin → the client → **Integrations → Meta**:
   - **Ad account ID** — the `act_…` number (visible in the partner share, or
     in their Ads Manager URL after `act=`)
   - **Facebook Page ID** and/or **Instagram account ID** — for organic stats
     (Page ID: their Page → About, or Business settings → Accounts → Pages;
     IG user ID: Business settings → Accounts → Instagram accounts)
   - Leave the **Access token field BLANK** — a blank token automatically uses
     Howler's house connection, for ads *and* social analytics. (If a client
     insists on their own token, paste it and it wins over the house one.)
3. Hit **verify** on the connection, **↻ Sync ads** on the Social page's
   💸 Paid ads section, and check the organic stats appear under **Social**.
4. If they'll receive ad audiences: confirm they accepted the Custom Audience
   ToS (Part 1, step 6).

### Troubleshooting quick hits

| Symptom | Fix |
|---|---|
| Verify fails with a permission error | The asset isn't assigned to the `pulse` system user yet (Per client, step 1) |
| Ads fine, audience push fails | Custom Audience ToS not accepted (Part 1, step 6) |
| Organic stats missing | Page/IG not shared or not assigned, or Page/IG ID not filled in, or the house token was generated without the page scopes (regenerate — it's instant) |
| Client's card says "expires in X days" | They connected via their own Facebook login instead of the house path — fine, but reconnect is needed ~every 60 days until app verification is done |

*Full ops detail: `docs/DRIVE_META_SETUP.md` §0c (agency path), §2 (manual path).*
