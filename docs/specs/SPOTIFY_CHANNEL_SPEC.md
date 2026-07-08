# Spotify channel — tracked links + purchase attribution (spec)

> Scope for making "how many people clicked the Spotify listing and bought"
> answerable inside Pulse (https://howler-pulse-v2.onrender.com). Written
> 2026-07-07 after checking (a) the live curated data catalogue and (b) what
> Spotify's developer/partner platform actually provides. Companion research
> summary: see the dated note in `docs/whats-next/`.

## Context — what's true today

- Howler's ticketing side already lists events on Spotify artist pages
  (ticket-partner feed). **Spotify provides no partner-facing click or
  conversion reporting** — no dashboard, no API. Attribution is our job, on
  the destination URL. (Worth one ask: whoever owns the Howler↔Spotify
  relationship should confirm whether the contract includes private
  reporting.)
- The curated Looker catalogue Pulse queries (checked live 2026-07-07 via
  `pulse_list_data_sources`) has **no UTM / referrer / sales-channel
  dimension**. Closest existing proxies: `core_orders.discount_code` and
  `core_promo_codes_pdt.first_promo_code`.
- Pulse already owns a click-tracking engine (`server/actionTracking.js`:
  open pixel `/o`, tracked redirect `/c`, SMS short link `/k` backed by
  `action_short_links`) — but every path is keyed to a **campaign action**.
  There is no standalone "tracked link" a client can mint for an external
  channel like Spotify.
- `server/metaAds.js` is the template for a per-channel performance report
  (clicks + purchases + revenue per campaign, per client, with an Owl tool).

## Goal

Insight → action → results for the Spotify channel:

1. **Clicks** — count clicks on the Spotify listing link, per event, in Pulse.
2. **Purchases** — attribute ticket sales to the Spotify channel and show
   conversion (clicks → orders → revenue) alongside other channels.

Split into three parts because they have different owners and dependencies.

---

## Part A — Channel links (Pulse-only, buildable now) — Effort: M

A standalone **tracked short link** a client or AM mints per (event ×
channel): `https://howler-pulse-v2.onrender.com/x/:code` → counts the click →
302 to the destination (the Howler event page) with the channel's UTMs
appended. Give the `/x/...` URL to the channel (the Spotify feed, an
influencer bio, a poster QR) instead of the raw event URL.

### Module

`server/channelLinks.js` — self-contained, disposable, mounted in one line in
`server/index.js` (architecture rule: no new engine in `index.js`; new-file
line budget ≤ 1500, expect ~400).

Tables (owned by the module, created in its own migration):

```
channel_links       id, entity_id, suite_id (nullable), code (unique, 8-char),
                    label, channel ('spotify'|'instagram'|'poster'|'other'...),
                    destination, utm_json, created_by, created_at, archived
channel_link_clicks link_id, at, day (yyyy-mm-dd, for cheap grouping), ua_bot (0/1)
```

No PII stored — deliberately not logging IP/UA strings, just a bot flag
(HEAD requests + known-crawler UA prefixes) so counts stay honest.

### Routes

- Public: `GET /x/:code` — point lookup on `code` (indexed), insert click,
  302 to `destination` + UTMs (existing query keys win — same rule as `/c`).
  Never blocks the redirect; unknown code → redirect to `/`. Bot-flagged
  hits are stored but excluded from headline counts.
- Admin (dual-surface rule): `GET/POST/PATCH /api/admin/entities/:id/channel-links`
  (+ `/:linkId/stats`).
- Client self-service: `GET/POST/PATCH /api/my/channel-links` — entity
  ownership enforced server-side, same shape.
- Stats payload: total clicks, clicks by day (for a sparkline), last click,
  per-link UTM preview, the full short URL for copy.

### UI

One shared component `ChannelLinks.jsx` with a `scope` prop
(`admin-client` | `my`), mounted in Admin → client detail tabs and in the
client's own Settings / Integrations area (MailTemplateEditor pattern).
Mobile-first: single-column list of links (label, channel chip, copy button,
click count, 14-day sparkline), stacked create form, tap targets ≥ 40px.

### Acceptance

- Minting a link for an event and hitting `/x/:code` increments the count and
  lands on the destination with `utm_source=spotify&utm_medium=listing&utm_campaign=<event>`.
- Client sees/creates only their entity's links; admin can manage any.
- Tests: redirect + count, UTM merge, ownership enforcement, bot exclusion,
  architecture budget green.

### Caveat (honest)

Clicks measured this way are **upper-bound listing clicks**, not sessions:
if the Spotify feed can't carry a pulse-domain URL (feed validation may
require the ticketing domain — Howler-side question OQ1), Part A still works
for every channel we control (bios, posters, WhatsApp, press) but Spotify
clicks would instead come from Howler capturing the referrer (Part B).

---

## Part B — UTM capture into the ticketing data (Howler core + LookML) — the real unlock

Not Pulse code; a scoped ask to the Howler data/platform team, tracked here
because Parts A/C depend on it for **purchases**:

1. Checkout captures `utm_source`, `utm_medium`, `utm_campaign` (+ HTTP
   referrer as fallback) at order creation and stores them on the order.
2. The fields are exposed on the `core_orders` view in the explore Pulse
   reads.
3. Pulse side is then ~zero code: tick the new fields into the curated Owl
   catalogue (admin-managed) → instantly queryable via dashboards, goals,
   `pulse_query_data` and the Owl ("how many tickets came from Spotify?").
4. Howler's Spotify feed URLs carry `utm_source=spotify` (directly, or via a
   Part A link once OQ1 is answered).

**Stopgap until B lands:** a Spotify-only promo code per event —
`core_promo_codes_pdt.first_promo_code` is already a queryable dimension, so
"orders with code SPOTIFY-<event>" works today, but only measures buyers who
apply the code, so it undercounts.

## Part C — Spotify channel report (after A + B) — Effort: S–M

The metaAds pattern, minus the external API (both signals are already ours):

- A **Channels report** (start: Social page section, like Paid ads) showing
  per event: clicks (Part A) · orders + revenue where `utm_source=spotify`
  (Part B, via the existing scoped Looker readers) · conversion % · revenue
  per click. Rows per channel so Spotify, Instagram, poster QRs compare.
- Owl tool `getChannelPerformance` (mirrors `getPaidPerformance`) so clients
  can ask "did the Spotify listing sell tickets?".
- Goals: a `channel` progress adapter candidate — park unless asked.

## Sequencing

1. **A** now (no dependencies, useful for every channel immediately).
2. **B** in parallel — it's an external ask; start the conversation now.
3. **C** once B's fields exist (A alone can ship a clicks-only report row).

## Open questions

- **OQ1 (Howler):** can the ticket URL in the Spotify feed be changed — to a
  Pulse `/x/` link, or at least to carry `utm_source=spotify`? Who owns the
  feed?
- **OQ2 (Howler):** does checkout already receive/discard UTM params today?
  (Determines whether B is "store a field" or "thread it through".)
- **OQ3 (contract):** does the Spotify partner agreement include any private
  click/conversion reporting we're not using?

## On ship (house rules)

- Update `docs/PRODUCT_OVERVIEW_SALES.md` (new Channels section, status
  tags per part) + dated changelog line, same change.
- Setup wizard: not a required stand-up step; if AMs start minting links at
  onboarding, add an optional field to the relevant existing step + tour
  anchor rather than a new step.
- Spotify OAuth / fan music-taste features are **out of scope** here — see
  the research note: Spotify's Developer Policy forbids using listener data
  for marketing segmentation, so any future build is user-facing
  personalisation only.
