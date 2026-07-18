# Community Feed Contract — Pulse ⇄ Howler app

**Version:** 0 (`contractVersion: 0`) · **Status:** spike / beta · **Owner:** Pulse
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
- **Auth (v0):** none on reads; joins carry the numeric `howlerUserId`. This is
  spike-grade — the planned hardening is Howler-JWT verification before any
  sensitive content rides these routes. Rate limits apply per IP.

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
  "createdAt": "2026-07-18T09:00:00.000Z",
  "publishedAt": "2026-07-18T09:05:00.000Z"
}
```

Media `url` is absolute (bucket/CDN) or Pulse-relative
(`/api/app/social/media/<id>` — the disk-backed dev path); the app must resolve
relative URLs against the Pulse base URL. `kind` is `image` or `video`; `width`/
`height` are optional hints for layout pre-sizing.

## 3. Public app-facing endpoints

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/app/social/feed?limit=20&before=<iso>` | The Howler-wide global feed (posts with `global: true`, newest first) | `{ "contractVersion": 0, "posts": [...], "nextCursor": "<iso>\|null" }` |
| `GET /api/app/social/communities?eventId=19203` (or `entityId=`) | Community discovery | `{ "contractVersion": 0, "communities": [...] }` |
| `GET /api/app/social/communities/:id/feed?limit&before&howlerUserId=` | One community's feed | `{ "contractVersion": 0, "community": {...}, "posts": [...], "nextCursor": ... }` — `403` when `visibility=members` and the user isn't a member |
| `POST /api/app/social/communities/:id/join` `{ "howlerUserId": "661779" }` | Explicit join | `{ "ok": true, "memberCount": n }` |
| `POST /api/app/social/communities/:id/leave` | Leave | `{ "ok": true }` |
| `GET /api/app/social/media/:id` | Disk-stored media bytes | bytes, `Cache-Control: public, max-age=31536000, immutable` |

Pagination: pass the previous page's `nextCursor` as `before`. `nextCursor` is
`null` on the last page. `limit` caps at 50 (default 20).

## 4. Management surfaces (Pulse auth)

- Admin: `GET/POST/PUT/DELETE /api/admin/entities/:id/social/{communities,posts}` +
  `POST .../media` (base64 `{name,mime,data}`, ≤10 MB, `image/*`|`video/*`) +
  `POST .../media/presign` (`{name,mime}` → `{uploadUrl,method,headers,publicUrl,kind}`
  presigned PUT; needs `SOCIAL_S3_*` + `SOCIAL_MEDIA_BASE_URL` env).
- Client self-service: same shapes under `/api/my/social/...` with `entityId` in
  query/body; permissions `campaigns.view` (read) / `campaigns.approve` (write);
  route-gated by the `community` flag.
- Post create accepts `publish: true` for create-and-publish in one call.
- UI: Engage → Community (`CommunityFeedManager`, scope `admin` | `my`).

## 5. Planned (bumping contractVersion)

- **v1:** Howler-JWT on app requests (membership asserted server-side, not by a
  caller-supplied id); ticket-holder membership sync (`source: "ticket"`)
  repointing the Rails community-linking; reactions + comment counts; post push
  fan-out via FCM topics (`global` / `org_<entityId>` / `event_<eventId>`).
- **v2:** event chat channels (public/closed, broadcast/interactive) —
  ring-fenced like `members` communities.
- Media moves fully to R2 + image variants + HLS video per the investigation
  doc §5; the disk path remains dev-only.
