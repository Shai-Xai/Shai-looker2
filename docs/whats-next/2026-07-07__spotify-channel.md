# 2026-07-07 — Spotify: what the platform offers + the channel-attribution gap

Session: answered "what does Spotify's developer platform offer us" after the
Howler-side ticketing integration (buy-from-artist-page) went live, then scoped
the Pulse build. Full scope: `docs/specs/SPOTIFY_CHANNEL_SPEC.md` · roadmap
item **4.10**.

## Findings (research, July 2026)

- **Listings**: Spotify artist-page ticket listings come only from ticketing
  partner feeds (Howler-side, live). No public partner program/application —
  BD-negotiated. Alt route for individual artists: Bandsintown for Artists
  syncs listings (with any ticket URL) to Spotify.
- **Attribution**: Spotify provides **no** partner click/conversion reporting
  (aggregate PR stats only). Everyone tracks via UTMs/referrer on the
  destination URL. → OQ: does Howler's contract include private reporting?
- **Web API for artist metadata** (event-page enrichment): heavily locked
  down for NEW apps — Nov 2024 killed related-artists/audio-features/recs;
  May 2025 restricted extended quota to registered businesses ≥250k MAU;
  Feb 2026 stripped dev-mode (5 users, Premium required, no bulk artist
  endpoints, popularity/followers fields removed). **Reuse Howler's existing
  approved Spotify app if one exists** — grandfathered access beats anything
  a new app can get.
- **Fan OAuth data** (top artists/tracks, follows, library, recently played):
  readable with consent, BUT the Developer Policy **forbids building user
  profiles for advertising/marketing targeting — even with consent** — and
  requires deletion on disconnect; email field removed from /me (Feb 2026).
  → Fan Spotify-connect is only viable as user-facing personalisation
  ("shows for your taste"), never campaign segmentation. Filed as a
  constraint in the spec's out-of-scope note.
- **Fans First / Reserved**: Spotify-run superfan emails (no API; offer via
  artist/label teams) · Reserved superfan ticketing is Live Nation-exclusive.

## Pulse-side gap (checked live 2026-07-07)

`pulse_list_data_sources`: no UTM / referrer / sales-channel dimension in the
curated catalogue. Promo code + discount code exist (stopgap proxy). Campaign
tracking (`actionTracking.js`) is action-keyed — no standalone mintable
tracked link.

## Next

1. Build **Part A** (channel links module) per the spec.
2. Raise **Part B** with Howler core (UTM capture at checkout → LookML).
3. Answer OQ1–OQ3 (feed URL ownership, checkout UTM handling, contract
   reporting).
