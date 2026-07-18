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
Social+ (see `docs/SOCIAL_PLATFORM_INVESTIGATION.md` for the full plan). Pulse
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

- Admin: `GET/POST/PUT/DELETE /api/admin/entities/:id/social/{communities,posts}` +
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
