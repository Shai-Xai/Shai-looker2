# Community Feed Contract — Pulse ⇄ Howler app

**Version:** 1 (`contractVersion: 1`) · **Status:** spike / beta — v0 **validated
end-to-end 2026-07-18** (image post composed in staging Pulse rendered in the
Dev Fork - Shai app build, verified by Shai); v1 adds Howler-JWT auth · **Owner:** Pulse
(`server/social.js`) · **Consumer:** Howler app prototype
(`howler_app/lib/data/repositories/pulse_social_repository_impl.dart` + debug feed screen)

> **Testing is STAGING-FIRST** (Shai, 2026-07-18): exercise this feature on the
> staging service https://howler-pulse-staging.onrender.com (branch `staging`)
> — the app's debug screen defaults there. Production carries the code too but
> keep test content off it; the `community` flag stays off in production until
> the feature graduates.

This is the wire contract for the Howler-native social layer that replaces
Social+ (see `docs/SOCIAL_PLATFORM_INVESTIGATION.md` for the full plan).
Moderation (banned lists, held/blocked states, review queue) is specified
separately in **`docs/specs/MODERATION_CONTRACT.md`** — see §18. Pulse
owns communities and posts; the app reads them over the public app-facing API.
v0 is deliberately small: organiser-authored posts, image/video media by URL,
explicit joins. Reactions, comments, ticket-holder sync, chat channels and
Howler-JWT auth arrive in later versions — each bumps `contractVersion`.

## 1. Principles

- **Pulse owns the data.** The app never stores posts; it renders what these
  endpoints return.
- **Only `published` posts ever leave Pulse.** Drafts/archived are invisible to
  the app surface, always.
- **Per-client flag:** the `community` feature flag (Admin → Product → Flags)
  controls each organiser. Flag off → that client's communities and posts drop
  out of every app response (including already-cached global-feed entries on
  next fetch).
- **Kill switch:** settings key `social_feed_enabled = '0'` 404s the entire
  public surface.
- **Auth (v1):** identity-bearing requests carry the app's Howler login JWT as
  `Authorization: Bearer <token>`. Pulse verifies it by **introspection** — it
  asks the Howler GraphQL backend (`{ user { id } }`, production then staging;
  override list via `HOWLER_GRAPHQL_URLS`) and caches verdicts (10 min positive
  / 60 s negative). The verified user id is the ONLY identity used — any
  `howlerUserId` param is ignored. Required on: join, leave, members-only
  community feeds. Anonymous by design: global feed, discovery,
  public-community feeds, media (public content, CDN-cacheable). Errors: `401`
  = missing/expired token (re-login); `503` = Howler backend unreachable
  (retry — never treated as invalid). Rate limits apply per IP.

## 2. Objects

### Community
```json
{
  "id": "com_ab12cd34ef56",
  "entityId": "e1",
  "type": "organiser",            // "organiser" | "event"
  "name": "Social Org HQ",
  "description": "All our events",
  "visibility": "public",          // "public" | "members"
  "status": "active",              // "active" | "archived"
  "parentId": null,                // event community → its organiser community id
  "eventId": null,                 // Howler eventId (string) when type = "event"
  "suiteId": null,
  "memberCount": 128,
  "createdAt": "2026-07-18T09:00:00.000Z"
}
```

### Post
```json
{
  "id": "post_ab12cd34ef56",
  "communityId": "com_ab12cd34ef56",
  "community": { "id": "com_ab12cd34ef56", "name": "Social Org HQ", "type": "organiser" },
  "body": "Gates open 12:00 — see you there 🎉",
  "media": [
    { "id": "…", "kind": "image", "url": "https://…/social/e1/….jpg", "mime": "image/jpeg", "width": 1080, "height": 1350 }
  ],
  "linkUrl": null,
  "source": "pulse",               // "pulse" | "instagram" | "tiktok" (import provenance)
  "status": "published",
  "global": true,                   // also syndicated to the app-wide feed
  "author": { "name": "Social Org" },
  "reactionCount": 12,
  "hasReacted": true,
  "createdAt": "2026-07-18T09:00:00.000Z",
  "publishedAt": "2026-07-18T09:05:00.000Z"
}
```

`reactionCount` is always present. `hasReacted` appears ONLY when the request
carried a verified Howler JWT (feeds accept an optional Bearer token for this);
anonymous reads simply omit it. Liking a members-only, non-global post requires
membership — you can only like what you can see.

Media `url` is absolute (bucket/CDN) or Pulse-relative
(`/api/app/social/media/<id>` — the disk-backed dev path); the app must resolve
relative URLs against the Pulse base URL. `kind` is `image` or `video`; `width`/
`height` are optional hints for layout pre-sizing.

## 3. Public app-facing endpoints

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/app/social/feed?limit=20&before=<iso>` | The Howler-wide global feed (posts with `global: true`, newest first) | `{ "contractVersion": 0, "posts": [...], "nextCursor": "<iso>\|null" }` |
| `GET /api/app/social/communities?eventId=19203` (or `entityId=`) | Community discovery | `{ "contractVersion": 0, "communities": [...] }` |
| `GET /api/app/social/communities/:id/feed?limit&before` | One community's feed (Bearer JWT required when `visibility=members`) | `{ "contractVersion": 1, "community": {...}, "posts": [...], "nextCursor": ... }` — `401` no/expired token · `403` verified but not a member |
| `POST /api/app/social/communities/:id/join` (Bearer JWT) | Explicit join — identity from the verified token | `{ "ok": true, "memberCount": n }` |
| `POST /api/app/social/communities/:id/leave` (Bearer JWT) | Leave | `{ "ok": true }` |
| `POST /api/app/social/posts/:id/react` (Bearer JWT) | Like a post (idempotent) | `{ "ok": true, "reactionCount": n, "hasReacted": true }` |
| `DELETE /api/app/social/posts/:id/react` (Bearer JWT) | Unlike (idempotent) | `{ "ok": true, "reactionCount": n, "hasReacted": false }` |

**Comment settings (per community, organiser-controlled, default OFF):**
`allowCommentImages` / `allowCommentLinks` ride the community shape and the
comments-list response (`allowImages`/`allowLinks`) so the app knows which
buttons to show. Links off → comments containing URLs are refused; images off →
`imageData` is refused. Comment create accepts optional `imageData` (base64) +
`imageMime` (image/*, normal media caps) and optional `parentCommentId` — fan
replies thread ONE level deep (replying to a reply attaches to its top-level
parent). Organiser replies (`authorType: "organiser"`, authored as the brand
name) are posted from the management surfaces: `POST .../comments/:id/reply`.
The moderation inbox `GET .../comments` (admin + /api/my) lists EVERY comment
across the client's posts — reported first, each with post context. Deleting a
top-level comment removes its thread.

**Comments** (first UGC): readable by whoever can see the post (anonymous for
public/global posts, verified members otherwise); writing always needs a
verified JWT. `POST /api/app/social/posts/:id/comments` `{ "text": "…", "displayName": "…" }`
(display name is a fallback — the verified Howler name wins when resolvable);
`GET .../posts/:id/comments?limit&before` → `{ commentCount, comments: [{ id,
postId, author: {id,name}, text, reported, isOwner?, createdAt }], nextCursor }`;
`DELETE /api/app/social/comments/:id` (author only);
`POST /api/app/social/comments/:id/report` (any verified user — flags it for
the organiser). `commentCount` rides every post shape. Moderation: organisers
list + delete any comment from the composer (reported ones flagged);
management endpoints `GET .../posts/:id/comments` + `DELETE .../comments/:id`
on both admin and /api/my surfaces.

Posts may carry a **CTA button**: `ctaLabel` + `ctaDestination` (the app's
existing screen-keyword vocabulary, e.g. `explore_tickets:19203`,
`explore_lineup:19203`, `open_url:https://…`) plus `eventId` (from the post's
event community) — rendered and routed by the app's existing PostCtaResolver
unchanged.
| `GET /api/app/social/media/:id` | Disk-stored media bytes | bytes, `Cache-Control: public, max-age=31536000, immutable` |

Pagination: pass the previous page's `nextCursor` as `before`. `nextCursor` is
`null` on the last page. `limit` caps at 50 (default 20).

## 4. Management surfaces (Pulse auth)

- Admin: `GET/POST/PUT/DELETE /api/admin/entities/:id/social/{communities,posts}`
  (community DELETE hard-deletes the community with its posts, comments, likes,
  pins, members and seen marks; an organiser community with nested event
  communities refuses with 400 until the children are deleted first) +
  `POST .../media` (base64 `{name,mime,data}`, ≤10 MB, `image/*`|`video/*`) +
  `POST .../media/presign` (`{name,mime}` → `{uploadUrl,method,headers,publicUrl,kind}`
  presigned PUT; needs `SOCIAL_S3_*` + `SOCIAL_MEDIA_BASE_URL` env) +
  `GET .../media/config` (`{direct}` — whether presigned direct-to-bucket uploads
  are configured; the composer probes this and prefers the direct path, falling
  back to base64→Pulse on failure). The bucket needs a CORS rule allowing `PUT`
  from the Pulse origins for browser presigned uploads to work.
- Client self-service: same shapes under `/api/my/social/...` with `entityId` in
  query/body; permissions `campaigns.view` (read) / `campaigns.approve` (write);
  route-gated by the `community` flag.
- Post create accepts `publish: true` for create-and-publish in one call.
- UI: Engage → Community (`CommunityFeedManager`, scope `admin` | `my`).

## 5. Planned (bumping contractVersion)

- ~~v1: Howler-JWT on app requests~~ — **shipped** (this version).
- **v2:** ticket-holder membership sync (`source: "ticket"`) repointing the
  Rails community-linking; reactions + comment counts; post push fan-out via
  FCM topics (`global` / `org_<entityId>` / `event_<eventId>`).
- **v3:** event chat channels (public/closed, broadcast/interactive) —
  ring-fenced like `members` communities.
- Media moves fully to R2 + image variants + HLS video per the investigation
  doc §5; the disk path remains dev-only.

## 6. Event chat (phase 2 — mockup approved 2026-07-18)

Owner: `server/chat.js` · flag `community.chat` (kid of `community`) · kill
switch `social_chat_enabled` · every route requires the verified Howler JWT.

**Channels** belong to an entity + Howler event. `kind` official|group;
`access` public | **tickets** (gated LIVE against the viewer's VERIFIED
holdings — same mechanism as targeted posts, no sync, no member rows: channel
carries `ticketTypes: [...]` matched case-insensitively against ticket names,
`[]` = any ticket holder for the event; the Pulse UI offers the event's real
ticket types as tap-chips via the Howler/Looker event lookup) | segment
(Pulse segment — legacy/advanced, members via sync or admin-add) | manual
(admin-added) | invite (fan groups); locked responses say
`lockedReason: "tickets"` so the app shows a GET-TICKETS CTA; `mode` chat |
broadcast (organiser posts, fans react/reply — `canPost:false` in the
messages response).

**Fan groups**: `POST /api/app/social/chat/channels {eventId,name}` → creator
becomes owner, gets `inviteCode`. `POST /api/app/social/chat/join {code}` joins
THAT GROUP ONLY (Shai's rule — other channels still check their own access).
Owner: `remove-member`, `revoke-link` (regenerates the code, killing old
copies). Organiser can `close` any group from the management surfaces.

**Messages**: `GET /channels/:id/messages?after=<iso>` (poll; strictly
monotonic timestamps), `POST` `{text, parentId?}` (one-level replies),
`DELETE /messages/:id` (author, soft — `deleted:true` placeholder),
`react`/`unreact` `{emoji}` (multi-emoji, aggregated `{emoji,count,mine}`),
`report`, `POST /channels/:id/read` (clears `unread`, which rides the channel
list). Organiser messages carry `authorType:"organiser"` and may carry a CTA
(`ctaLabel` + `ctaDestination`, same vocabulary as posts) → clickable button
in chat.

**Management** (admin + /api/my, campaign perms): channel CRUD + `close`,
per-channel messages (moderation: `pin/unpin/delete`), `members` add,
`sync-segment` (resolver injectable; reports `pending` until segments×appMatch
wiring lands), `broadcast {eventId,text,pin,push,ctaLabel?,ctaDestination?}` →
one organiser message into every active OFFICIAL channel (fan groups
excluded). `push` is a PER-MESSAGE flag — recorded now, delivery activates
with the Firebase key.

## 7. Pins (feed + chat, added 2026-07-19)

Two pin layers everywhere, never mixed:
- **Organiser pin** — global, everyone sees it. On posts: `pinned` on the
  post + a `pinned: [...]` strip (≤10, organiser-pinned posts) on the FIRST
  page of both feeds (`before=` pages never carry strips, so cursor paging
  stays exact). Toggled from the management surfaces:
  `POST .../posts/:id/pin {pinned}`. On chat messages: the existing
  `pin/unpin` moderation actions → `channel.pinnedMessage`.
- **Personal pin** — private bookmark, only the pinner sees it.
  Posts: `POST /api/app/social/posts/:id/pin {pinned}` (JWT; same
  ring-fencing as likes) → `pinnedByMe` on posts + a `myPins: [...]` strip
  (≤10) on first feed pages. Chat: `POST /api/app/social/chat/messages/:id/pin
  {pinned}` → `pinnedByMe` on messages + `channel.myPinnedMessage`.
- **Fan groups are the exception (WhatsApp parity)**: in a `kind:"group"`
  channel the same fan endpoint toggles the SHARED pin (any member, everyone
  sees it; response says `shared:true`). Official channels always fall back
  to the personal pin (`shared:false`).

## 8. Posting from the app (added 2026-07-19)

Authorised **app posters** publish for a client without a Pulse login.
- Registry: per-entity list of verified Howler user ids, managed from BOTH
  Pulse surfaces (`GET/POST .../posters`, `DELETE .../posters/:userId`;
  `{howlerUserId, name}` — blank `name` = post in the brand's voice, the
  community name shows as author).
- Discovery: `canPost` rides the app's community payloads (communities list +
  community feed `community`) for the verified viewer.
- Publish: `POST /api/app/social/posts {communityId, text, global?, images?}`
  (JWT required; 403 unless the id is in that entity's poster list). `images`
  items are either inline base64 `{data, mime}` (app pre-scales to JPEG, same
  as comment photos; HEIC refused; ≤10 MB) or an already-uploaded reference
  `{url, kind, mime, posterUrl?}` from the direct-upload path below. Either
  form may carry a reframe focus `{focusX?, focusY?}` (-1..1 per axis, 0 =
  centre — the composer's IG-style drag choosing which part of the image
  survives when a feed card crops); it rides the media item back out in feeds.
  The post goes live immediately with `source:"app"`.
- Direct-to-bucket upload (big videos): `POST /api/app/social/presign
  {name, mime, communityId?}` (JWT; registered posters only, 403 otherwise) →
  `{contractVersion, uploadUrl, method, headers, publicUrl, kind}` — the same
  presigned-PUT contract as the Pulse composer (§4). The app PUTs the raw bytes
  to `uploadUrl` with the returned `Content-Type`, then references `publicUrl`
  in the post's `images`. 400 when `SOCIAL_S3_*` isn't configured — the app
  falls back to inline base64 (and its ~9 MB cap) in that case.
Fan/UGC posting later rides the same endpoint with a different authorisation
policy (e.g. per-community "fans may post" setting) — the wire shape is ready.

## 9. Instagram import (added 2026-07-19)

One-click repost of content already on the client's Instagram.
- Connection: reuses the social-metrics fields (entity integrations
  `metaAccessToken` + `metaIgUserId`, an IG Business/Creator account) — no new
  OAuth. Not connected → `{connected:false}`, a hint not an error.
- `GET .../social/instagram/media` (both management surfaces) → picker grid
  shape `{id, type IMAGE|VIDEO|CAROUSEL_ALBUM, caption, thumbnailUrl,
  permalink, timestamp, childCount}` (30 most recent).
- `POST .../social/instagram/import {mediaId, communityId, global?, caption?,
  publish?=true}` → Pulse downloads the media server-side and RE-HOSTS it
  through the normal media store (IG CDN urls expire — never hotlink),
  carousels land as one multi-image post, caption prefills (custom caption
  wins), post publishes with `source:"instagram"`.
- App one-click surface (poster-gated, same helpers) is the next phase.

## 10. Targeted posts — ticket types (added 2026-07-19)

Event-community posts can target holders, enforced SERVER-SIDE (a fan who
shouldn't see a post never receives it; no app changes needed).
- `audience` on a post: absent/null = everyone · `{type:"holders"}` = anyone
  with a (non-expired) ticket for the community's event ·
  `{type:"ticketTypes", ticketTypes:[names]}` = holders of those ticket types
  (name match, case-insensitive). Event communities only; a targeted post is
  forced OFF the Howler-wide feed.
- Holdings come from JWT introspection (appAuth `fetchAppTickets`: the same
  GraphQL backends answer `{ user { tickets { nodes { name event { id } } } } }`;
  cached ~5 min; unknown → fail CLOSED). Fetched lazily — only when a
  response's candidate rows actually carry an audience.
- Enforced on: community feed pages + pinned strips, comment reads, and all
  interactions (like/comment/personal-pin via the shared guard). Cursor
  pagination stays exact (cursor computed from raw rows before filtering).
- Full segment-based audiences (Pulse segments) are the later phase — same
  `audience` field, new type.

## 11. Event → organiser roll-up (added 2026-07-19)

Per-post opt-in, the same mechanic as `global`: `toParent:true` on an event
post ALSO surfaces it in the parent organiser community's feed (labelled with
its home event community). Only meaningful on nested event communities —
ignored elsewhere. Rolled posts are readable/interactable by whoever can see
the organiser feed (like global syndication), EXCEPT ticket-targeted ones,
which stay ticket-checked against the home event wherever they appear.
So the hierarchy reads: event feed → (toParent) organiser feed → (global)
Howler-wide feed, with targeting always enforced at every level.

## 12. Personalised global feed + the Howler house (added 2026-07-19)

The Howler-wide feed is NOT a public firehose:
- **House posts** — a designated house entity (Howler's own voice; platform
  admin sets it via `GET/PUT /api/admin/social/house {entityId}`) reaches
  EVERYONE, including anonymous/pre-login readers.
- **Organiser posts** shared to global only reach viewers CONNECTED to that
  organiser: they joined any of its communities ("follow"), or hold a ticket
  to any of its events (JWT ticket introspection; entity matched via its
  event communities' event ids).
- Anonymous viewers see house posts only. No house configured → legacy
  behaviour (all global posts public) so nothing breaks before setup.
Enforced server-side on the feed pages and both pinned strips; cursor stays
exact (computed from raw rows).

## 13. Story rail (added 2026-07-19)

The quick-door row of community circles (mockup frame 7).
- `GET /api/app/social/rail` (optional JWT): active, flag-on communities that
  have published at least once. `?parentId=` scopes to one organiser's event
  circles (the rail on an organiser feed). Items: `{communityId, name, type,
  entityId, eventId, parentId, lastPostAt, joined, hasTicket, unseen}` —
  joined counts membership of the circle or (organiser circles) any child;
  hasTicket via JWT ticket introspection; organiser circles glow on child
  activity. Sorted joined → house (Howler's designated entity — its circles
  anchor the rail for every viewer, anonymous included) → ticket-held →
  recency, capped at 20.
- `POST /api/app/social/communities/:id/seen` (JWT) marks the feed opened —
  clears that circle's `unseen` ring (the app fires it on every community
  feed load).
- In the app the rail rides the feed tab's existing story row (StoryTarget
  mapping); tapping an event circle opens `/event/:id/feed`.

## 13b. Views & impressions (added 2026-07-20)

- Server logs a **delivered** impression for every post a feed response
  returns (global + community feeds), keyed per viewer per day — works for
  every app build with no client change.
- `POST /api/app/social/impressions {seen?: [postIds], views?: [postIds]}`
  (optional JWT, batched, best-effort, ≤100 ids per list) — the app reports
  cards actually **seen** on screen and videos **view**ed (inline play /
  reel open). Anonymous reports count toward totals but not unique reach.
- Management surfaces: each post in `GET .../social/posts` carries
  `stats: {delivered, reach, seen, views}` (reach = unique signed-in
  viewers delivered). Shown on the Pulse post card (👁 line).

## 14. Shareable post links (added 2026-07-19)

- `GET /api/app/social/posts/:id` — a single published post as JSON (same
  visibility as the feed: flag-on; members-only needs membership; targeted
  posts need the matching ticket). Groundwork for a single-post screen.
- `GET /p/:id` — a public HTML share page (the link fans send). Open Graph
  tags so it unfurls with a thumbnail + caption in WhatsApp/iMessage; renders
  the post for anyone (no app needed); buttons to open/get the app. PRIVATE
  posts (members-only / ticket-targeted) never leak their content — the page
  falls back to a generic get-the-app gate.
- The share page detects the visitor's device from the User-Agent: iOS shows a
  single App Store button, Android a single Play Store button, desktop/unknown
  shows both. Each media tile carries a Howler watermark overlay, and the header
  shows the community avatar.
- Phase 2 (device-tested): true auto-open-to-the-post via a `howler.chottu.link`
  deep link (Pulse already integrates ChottuLink) → the app's universal-link
  handler → a single-post screen using `GET .../posts/:id`.

## 15. Community avatar (added 2026-07-19)

- A community carries an optional `avatarUrl` (profile image). Set it on any
  management surface (`PUT .../social/communities/:id` with `{ avatarUrl }`) or
  clear it with `''`. Blank falls back to the organiser's entity logo, so a
  community shows a brand image by default without any extra setup.
- `avatarUrl` rides on the community object everywhere it appears — community
  lists, the story rail, each post's `community`, and the share page header —
  so feed cards and circles render the brand mark.

## 16. Brand colours (added 2026-07-19)

- Communities, each post's `community`, story-rail items and chat channels all
  carry `brandColor` + `secondaryColor` — the organiser's Pulse branding,
  resolved server-side (platform ← client ← event(suite)) via the mailer's
  `resolveBranding`. Unset tiers inherit the one below; the platform default is
  returned when a client hasn't set its own.
- Communities carry an explicit `suite_id`, so their (and their posts') colours
  pick up the per-event override directly. Chat channels store the Howler
  `event_id` instead, so they resolve the event's suite by matching
  `suites.howler_event_id` — giving chat the SAME per-event branding as the
  feed (blank/unmatched → the client-level colour).
- Clients tint their accents to `brandColor` (feed-card avatar rings / CTAs,
  chat chips + bubbles, story rings) and fall back to the app brand when it's
  null/unusable. The `/p/:id` share page tints its buttons, avatar ring and
  watermark to the community's `brandColor` (sanitised to a hex literal before
  it reaches the inline `<style>`), falling back to Howler red `#EC0B62`.
- Presentation only (non-secret), so it rides to the browser/app freely.

## 16b. Video posters + range streaming (added 2026-07-20)

- A video media item may carry `posterUrl` — a first-frame JPEG the Pulse
  composer captures client-side at upload (canvas). Feed cards show it
  instantly instead of a black box while (or if ever) the video loads; the
  app falls back to the post's first image when a video has no poster.
- `GET /api/app/social/media/:id` supports HTTP Range requests (206 partial
  content) — iOS AVPlayer refuses to stream from servers without it, so
  Pulse-hosted (fallback-uploaded) videos need this to play at all.

## 16c. Share page CTA + attribution (added 2026-07-20)

- A post's CTA rides its `/p/:id` share page: `open_url:` destinations link
  straight out; in-app destinations route to the store for the visitor's
  device. The store buttons drop to the quiet style when the post's own CTA
  leads. The page uses the real Howler mark (`/email-howler.png`, the same
  asset branded emails use) for the watermark + footer.
- Share attribution: the app appends `?s=<verified howlerUserId>` to every
  shared link; every `/p/:id` hit is logged (`social_feed_share_clicks`) with
  sharer + device. Link-unfurl crawlers (WhatsApp/Slack/…) are tagged
  `preview-bot` and reported as REACH, not clicks. Rollup at
  `GET .../social/share-stats` (both management surfaces): total clicks,
  preview fetches, top sharers (id + best-known name) and top posts — the
  "who are our organic promoters" leaderboard, shown in the Pulse Community
  tab as 📣 Share links.

## 17. Whoami + poster suggestions (added 2026-07-20)

- `GET /api/app/social/whoami` (JWT required) — echoes the VERIFIED identity
  behind the token (`{ id, name }`): the exact id poster/membership checks
  use. The app's debug feed screen shows it via a 👤 badge button so a tester
  can register themselves as an app poster without an Active Admin id hunt.
- Poster suggestions — "recently active app users" (id + best-known name from
  chat messages/members, feed comments and community joins), newest first:
  `GET .../social/posters-suggestions` on both management surfaces. Admins see
  platform-wide activity (the house entity has no fans of its own); clients
  only see users active on THEIR OWN communities/chats. The App posters UI
  renders them as one-click "＋ name #id" chips.

## 18. Moderation (server-side enforcement LIVE 2026-07-20; console UI next)

All fan-generated content on this surface (app posts, comments, chat
messages, emoji reactions, fan-group names) gets server-side moderation at
write time: banned lists (platform + per-client), exact hits **blocked**
(`422 { error: "content_blocked", moderation: {...} }`), fuzzy hits **held
for review** (`202` + `moderation: { status: "held" }`, author-only until a
moderator approves), a Pulse review queue fed by rule holds and user reports
(including the new `POST /api/app/social/posts/:id/report`), and a
`moderation_status` filter on every read. Full wire contract:
**`docs/specs/MODERATION_CONTRACT.md`** · phase-1 build plan:
`docs/specs/MODERATION_P1_PLAN.md` · scope + decisions: the app repo's
`docs/ai-social-moderation-scope.md`. Existing report endpoints (§3) and the
chat `reported` flag keep their shapes and feed the same queue. Every
moderation field is additive — `contractVersion` unchanged.
