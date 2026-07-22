# Building Our Own Social — Investigation & Recommendation

**Status:** Investigation (no code yet) · **Date:** 2026-07-18 · **Author:** Claude session for Shai
**Question:** Can we replace Social+ (social.plus / Amity) with our own social layer — communities, feed,
event chat channels, Instagram/TikTok content import — managed from Pulse
(https://howler-pulse-v2.onrender.com), with media that is cheap to store and fast on the phone?

**Short answer: Yes — and the codebase is unusually well set up for it.** The Flutter app already hides
every Social+ call behind a single `SocialRepository` interface (the swap seam), and Pulse already has the
organiser/event data model, a threaded-messaging engine, per-client Meta/TikTok API tokens, and the
module conventions a `server/social.js` would slot into. The recommended path is **build, phased**:
feed + communities first (that's mostly a CMS problem — Pulse's home turf), event chat channels second,
notifications + UGC after. Off-the-shelf open-source platforms (Rocket.Chat, Matrix, etc.) are a poor fit
and are **not** recommended as the core; targeted third-party infrastructure (object storage + a video
CDN) **is** recommended for media.

---

## 1. Why move off Social+ (the problem)

Social+ / Amity Social Cloud (https://www.social.plus/pricing) charges **per monthly active user** —
any user who *creates or consumes* content in a month counts. Published entry pricing starts around
**$0.06/MAU on annual license terms**, with add-on fees for video minutes viewed, file storage,
concurrent connections beyond quota (~$0.05/connection/day), image moderation, and even an
"inactive user" overcharge when inactive users exceed 10× MAU. Because the Howler global feed makes
**every app user** a consumer of content, our MAU count is effectively our whole active app base — the
worst possible shape for per-MAU pricing. Illustratively: 50k active app users ≈ $3k+/month,
100k ≈ $6k+/month, before video/storage/connection add-ons — and it scales linearly with growth forever.

Fit problems found in the code audit (HowlerApp repo):

- **Feed video is effectively broken today**: the Amity post mapper never populates
  `videoUrl`/`videoThumbnailUrl` (`post_mapper.dart:105-113` — the SDK path creates an `AmityFile`,
  not an `AmityVideo`, and the video branch is commented out). So the thing we most want (rich
  image/video posts) is the thing the current integration does worst.
- **Single EU region** (`https://api.eu.amity.co`, hardcoded for staging *and* production) — every feed
  read and chat message from a South African phone round-trips to Europe.
- **Stories had to bypass the SDK** and use raw REST with ~30-second session tokens because of SDK
  database-timing bugs (`amity_social_repository_impl_io.dart` ~2440-2620).
- **Duplicate-notification workarounds**: Amity's own post notifications are suppressed in the app and
  replaced by our backend's FCM topic broadcast (`backend_post`) — i.e. we already built half our own
  post-notification pipeline to route around Social+.
- **A 1,793-line caching decorator** exists purely to make Amity's reads tolerable offline/slow —
  effort we'd rather spend on our own backend.

## 2. What we already have (the two-repo audit)

### 2.1 The Flutter app (howler/HowlerApp_Standalone_Shai)

The entire social layer runs on `amity_sdk ^7.7.2`, but behind a **clean abstraction**:

- **`lib/domain/repositories/social_repository.dart`** (~500 lines) is the *single* contract for
  everything social: communities, feed/posts, comments, reactions, chat channels/messages/media,
  stories, realtime streams. Three implementations already exist (Amity, caching decorator, mock),
  selected in `injection_container.dart:529`. **Replacing Social+ = writing one more implementation
  of this interface.** Cubits (`FeedCubit`, `ChatCubit`, `CommunitiesCubit`), screens, and routes are
  already vendor-agnostic and would largely not change.
- **The backend owns no social data.** The Rails/GraphQL API only stores the event↔Amity-community
  *mapping* (`event.socialPlusCommunities`, `userSocialPlusCommunityCreate/Destroy`) and FCM tokens.
  Community membership is already **synced from the Howler backend as source of truth** — the exact
  hook we need for "ticket holders get the event community automatically".
- **Push is already ours where it matters**: post announcements go out via our backend on FCM topics
  (`backend_post` type), routed by `notification_router.dart`. Only chat/comment/mention pushes still
  come from Amity.
- **Media rendering is standard**: `cached_network_image` for images, `video_player` + an S3 URL
  resolver for event videos. Nothing Amity-specific in the rendering layer.
- **Chat already tolerates polling**: `ChatCubit` runs a 5-second polling fallback alongside Amity's
  realtime — evidence that a WhatsApp-channels-style experience does not require heavyweight
  realtime infrastructure on day one.

### 2.2 Pulse (Shai-Xai/Shai-looker2 → https://github.com/Shai-Xai/Shai-looker2)

- **The tenancy model is exactly the community model we want**: `entities` = organiser,
  `suites` = event (with `suites.entity_id` → organiser). "An event community can live inside an
  organiser one" is literally the existing schema shape. `os_threads` already anchors on
  `entity_id + suite_id`.
- **`server/os.js` is a working threaded-messaging engine** — threads, messages, read/ack receipts,
  attachments, author types, priorities, programmatic `announce()`. It targets organiser↔Howler
  comms today, but it is the closest existing primitive to event chat channels.
- **Meta & TikTok credentials already live on each entity** (`metaAccessToken`, `metaIgUserId`,
  `tiktokAccessToken`), used by `server/socialMetrics.js` (pulls FB/IG/TikTok post metrics) and the
  ad-audience sync (`server/meta.js`, `server/tiktok.js`). The Instagram/TikTok **content import**
  feature starts from OAuth plumbing we already own.
- **Module conventions make this a clean add**: a self-contained `server/social.js` owning `social_*`
  tables, mounted in one line, `social_enabled` kill switch, dual surface
  (`/api/admin/entities/:id/social/*` for Howler staff + `/api/my/social/*` for organiser
  self-service), same React editor component with a `scope` prop.
- **Web push + email/SMS** (`server/push.js`, `mailer.js`, `messaging.js`) cover organiser-side
  notifications out of the box.

### 2.3 The honest gaps

1. **Media pipeline** — Pulse stores attachments as base64→local disk; no object storage, no
   resizing, no transcoding. Entirely new infrastructure (§5). This is the biggest *new* build.
2. **Consumer-scale serving** — Pulse is a single-instance SQLite app on Render
   (https://dashboard.render.com). Fine as the *management plane*; the *app-facing read path* needs
   CDN caching and, at scale, the planned Postgres migration (`docs/POSTGRES_MIGRATION_SCOPE.md`).
3. **Ticket-holder identity** — Pulse knows ticket holders only via Looker/BigQuery (batch), and has
   no live Howler-platform integration (roadmap §4.1) and no channel to push to app users (§4.5).
   Mitigation: the *app + Rails backend* already know event membership — keep membership resolution
   where it lives today (Rails tells the app which communities a user belongs to; the app presents a
   Howler JWT to the social API). Pulse doesn't need live ticket data to ship phase 1.
4. **App review obligations for UGC/chat** — once users can post/message, Apple/Google require
   block/report/moderation flows. Amity handled some of this; we take it on (Phase 2/3 scope).

## 3. Requirements → what each takes

| Requirement (Shai's brief) | Verdict | Notes |
|---|---|---|
| Custom communities: organiser-led or event-led, event nested in organiser | **Easy** | Mirrors `entity`/`suite`. One `social_communities` table with `type` (global/organiser/event) + `parent_id`. |
| Global feed (all app users) vs ring-fenced organiser/event feeds (ticket holders or explicit joiners) | **Easy–moderate** | Membership = ticket-holder sync (existing Rails mechanism) ∪ explicit join. Global feed is public-read → aggressively CDN-cacheable. |
| Organiser/admin posts with images & video | **Moderate** | CRUD is trivial; the work is the media pipeline (§5). Organiser-only authoring means low write volume — it's a CMS, not Twitter. |
| Import content from Instagram / TikTok to repurpose | **Moderate, with a TikTok caveat** | IG: Graph API `GET /{ig-user-id}/media` returns downloadable `media_url` for the organiser's own Business/Creator account (Basic Display API is dead since Dec 2024 — Business/Creator account + app review required). TikTok: Display API `video.list` (scope `video.list`) returns titles, **cover images, share/embed links — not raw MP4s**; so TikTok import = cover image + caption + embed/link, or the organiser re-uploads the original file. Pulse already holds both platforms' tokens. TikTok production access needs a ~1–2 week audit with demo video. |
| Event chat: multi-channel, public/closed, ring-fenced, "mini WhatsApp channels" | **Moderate** | Broadcast channels (organiser posts, users read/react) are near-trivial — same engine as feed. Open group chat needs a realtime path: start with the app's proven 5s polling, add SSE/WebSockets (or self-hosted Centrifugo, https://centrifugal.dev) when volume justifies. `server/os.js` is the schema template. |
| Posts with push notifications | **Mostly already built** | The `backend_post` FCM-topic pipeline exists in the app; the social service just needs to publish to FCM topics (`event_{id}`, `org_{id}`, `global`). Next phase as requested. |
| Media optimized: cheap storage, fast on phone | **Solved with the right pipeline** | §5: client-side compression → direct-to-storage upload → CDN variants (images) / HLS (video). Costs pennies per GB vs per-MAU. |
| Pulse as the management backend | **Natural fit** | Authoring, scheduling, import library, moderation queue, analytics — dual-surface admin + `/api/my`. |
| UGC later | **Deferred by design** | Schema allows `author_type` user from day 1; enable per-community later with moderation tooling. |

## 4. Build vs open-source vs stay

**Off-the-shelf open-source social/chat platforms — not recommended as the core.** The plausible
candidates (Rocket.Chat https://www.rocket.chat, Matrix/Synapse https://matrix.org, Tinode
https://github.com/tinode/chat, Mattermost, and "social network engines" like OSSN/SocialEngine) are all
standalone products with their own user systems, admin consoles, and UX assumptions. Embedding any of
them means running a second identity system synced to Howler users, operating a chat server 24/7,
and bending team-chat/forum semantics into an events app — the same "not 100% suited to our purpose"
problem we have with Social+, minus the invoice but plus the ops burden. Their Flutter support is also
thin (Rocket.Chat's Flutter SDK is minimal; Matrix's Dart SDK is solid but drags in federation/E2EE
complexity we don't need for event channels).

**Targeted third-party infrastructure — yes.** Use boring, cheap, replaceable pieces:
object storage with zero egress fees (Cloudflare R2 https://developers.cloudflare.com/r2/),
an image-variant CDN (Cloudflare Images https://developers.cloudflare.com/images/ or self-hosted
imgproxy https://imgproxy.net), and a video pipeline that gives us upload→transcode→HLS for a flat
per-minute/per-GB price — Cloudflare Stream (https://www.cloudflare.com/developer-platform/products/cloudflare-stream/,
~$5/1k min stored + $1/1k min delivered, transcoding included) or Bunny Stream
(https://bunny.net/stream/, roughly half that; storage from ~$0.01/GB). Either is orders of magnitude
cheaper than per-MAU social pricing and removes the hardest engineering (transcoding, adaptive
bitrate) without ceding the product.

**Why build the core ourselves is credible here (it usually isn't):**
1. Phase 1 is organiser-publishes / users-read — a low-write CMS + cached read API, not a
   general-purpose social network. The hard social problems (fan-out at write, spam, symmetric
   social graphs) don't apply yet.
2. The app-side abstraction (`SocialRepository`) means no UI rewrite — we swap the data source.
3. Membership/ring-fencing rides on machinery the Rails backend already runs for Amity community
   linking today.
4. Pulse gives the organiser-facing management surface nearly for free (dual-surface conventions,
   auth, branding, campaign engine adjacency — a post can later become "post + email + SMS" in one
   composer).

**Stay on Social+?** Only worth it if engineering capacity is zero. The per-MAU model taxes our
growth, and we've already routed around it for post-notifications and stories. A phased exit also
de-risks: keep Amity running for *chat only* while our feed ships, then cut chat over — MAU billing
should drop substantially as feed traffic (the global-feed "everyone is active" driver) leaves their
platform first. Verify with Social+ how MAU is counted per product before banking on interim savings.

## 5. Media pipeline (the "optimized, quick and fluid" requirement)

Three stages, each cheap and standard:

1. **On device (before upload)** — resize images to ≤1440px long edge, re-encode to WebP/JPEG ~80
   (`flutter_image_compress`); compress video to 1080p H.264 with `video_compress` before upload.
   Typical result: photos 0.3–1 MB, a 30s clip ~10–25 MB. Faster uploads on event-venue networks and
   smaller storage forever.
2. **Upload** — presigned direct-to-R2/storage upload from the phone (Pulse only mints the URL —
   media bytes never transit the Node process, which also sidesteps Pulse's base64 limitation).
3. **Serve** —
   - **Images**: store one original; serve size variants (thumb/feed/full) via Cloudflare Images or
     imgproxy, cached at the CDN edge. The app keeps using `cached_network_image` unchanged.
   - **Video**: push uploads to Cloudflare Stream or Bunny Stream → automatic transcode to
     adaptive HLS + thumbnail. The app plays HLS with `video_player`/`better_player`. Feed autoplay
     uses the thumbnail + first HLS rendition — this is what makes video feel instant on mobile.
   - Feed JSON responses carry pre-built variant URLs so the client never negotiates sizes.

Cost sketch at meaningful scale (500 organiser posts/mo, 40% video, ~2 TB/mo delivery):
object storage ≈ $10–20/mo, image serving ≈ $5–20/mo, video (Stream/Bunny) ≈ $50–200/mo.
Compare per-MAU: this doesn't grow with app installs, only with content and viewing.

## 6. Proposed architecture

```
Flutter app ──(Howler JWT)──▶ Social API (feed read, join, reactions, chat)
     │                              │
     │                              ├── social_* tables (communities, members, posts, media,
     │                              │   channels, messages)  — Pulse module server/social.js
     │                              ├── R2/S3 originals ── CF Images (variants) / Stream (HLS)
     │                              └── FCM topics (global / org_{id} / event_{id}) → push
     │
Rails/GraphQL ── membership source of truth (ticket → event community), as it is for Amity today
     │
Pulse admin & /api/my ── authoring, scheduling, IG/TikTok import library, moderation, analytics
```

- **Communities**: `type` global | organiser | event; event communities carry `parent_community_id`
  → the organiser community (posts can optionally cascade org→event feeds).
- **Ring-fencing**: membership rows written by (a) explicit join from the app, (b) ticket-holder sync
  via the existing Rails linking mutations (repointed from Amity IDs to our community IDs).
- **Auth**: the app calls the social API with its Howler JWT; the API verifies it (shared
  secret/JWKS with the Rails backend). Admin/organiser surfaces use Pulse's existing auth.
- **Serving scale**: global + event feeds are public-or-membership reads with organiser-only writes —
  cache feed pages at the CDN (30–60s TTL) and this serves large audiences from a small origin. The
  social module should be written **Postgres-ready** (plain SQL, no SQLite-isms) so it rides the
  planned Postgres migration; if app traffic outgrows Pulse's instance, the same module lifts out
  into its own service without schema change.
- **Chat channels** (phase 2): channels table per event (public/closed), broadcast channels are
  feed-like; interactive channels start on short-poll (the app already does 5s polls) and upgrade to
  SSE/WebSockets or Centrifugo when needed. Chat media reuses the same pipeline.
- **App integration**: new `HowlerSocialRepository` implementing the existing `SocialRepository`
  (feed methods first, chat later), behind a Firebase Remote Config flag for staged rollout —
  Amity code stays until cutover completes, then `amity_sdk` is deleted.

## 7. Phasing & rough effort

| Phase | Scope | Rough effort |
|---|---|---|
| **1 — Feed & communities** (priority) | `server/social.js` (communities, members, posts, feed API, JWT verify) · media pipeline (R2 + Images + Stream/Bunny, presigned uploads) · Pulse composer UI (admin + `/api/my`) with scheduling · IG import (Graph API media picker) + TikTok import (cover/link, re-upload flow) · app `HowlerSocialRepository` feed methods + membership repoint · flagged rollout | ~6–9 dev-weeks |
| **2 — Event chat channels** | Channels (public/closed, broadcast/interactive) · polling→SSE realtime · membership/mute/report · app chat methods · retire Amity chat → **fully off Social+** | ~4–6 dev-weeks |
| **3 — Notifications & engagement** | FCM-topic pushes from the social module (pattern exists in-app) · post→email/SMS cross-posting via the campaign engine · reactions/comments at scale | ~2–3 dev-weeks |
| **4 — UGC** | Per-community user posting, moderation queue in Pulse, block/report (App Store requirement), rate limits, optional AI pre-screen via existing Claude integration | scope later |

Cutover order deliberately matches the priority in the brief (posts/feed first, channels after) *and*
maximises interim savings, since the global feed is what makes every app user a billable Social+ MAU.

## 8. Key risks

1. **Ticket-holder gating depends on the Rails backend** repointing its community-linking from Amity
   IDs to ours — small change, but it's in the platform team's codebase, not ours. Engage early.
2. **Realtime chat at scale** is the one genuinely hard infra piece — mitigated by starting with
   broadcast channels + polling, which the current app already proves acceptable.
3. **TikTok reuse limits** — Display API doesn't hand over raw video files; set organiser
   expectations (import = cover + caption + link, or re-upload the original).
4. **Meta app review** — IG import requires the organiser's IG to be Business/Creator and our Meta
   app to pass review for content scopes; Pulse's existing Meta integration shortens but doesn't
   eliminate this.
5. **Moderation liability** transfers to us the moment UGC/chat ships — budget block/report/takedown
   tooling in phase 2, not phase 4.
6. **Pulse single-instance ceiling** — mitigate with CDN caching from day 1, Postgres-ready SQL, and
   a lift-out-ready module boundary.

## 9. Recommendation

**Build it, phased, with Pulse as the management plane** and cheap commodity infrastructure
(R2 + Cloudflare Images + Stream/Bunny) as the media plane. Start with Phase 1 (feed + communities +
IG/TikTok import), keep Social+ for chat only during the transition, and cut chat over in Phase 2.
This replaces a per-MAU cost that scales with our success with flat infra costs that scale only with
content, gives us the event-native feature shape Social+ can't (ticket-gated communities nested under
organisers, feed↔campaign integration), and does it against the cleanest possible seam — one Dart
interface and one new Pulse module.

**Suggested next step:** a 1–2 week Phase-1 spike — `social_communities`/`social_posts` tables +
presigned R2 upload + one organiser image post rendered in a debug build of the app via a prototype
`HowlerSocialRepository` — to validate the end-to-end path before committing the full build.

---

*Sources: code audits of both repos (this session); social.plus pricing (https://www.social.plus/pricing,
https://www.trustradius.com/products/amityeko/pricing); Instagram API status 2026
(https://zernio.com/blog/instagram-api, https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/);
TikTok Display API (https://developers.tiktok.com/doc/tiktok-api-v2-video-list,
https://developers.tiktok.com/doc/scopes-overview); video pricing comparison
(https://www.pkgpulse.com/guides/mux-vs-cloudflare-stream-vs-bunny-stream-video-cdn-2026,
https://www.buildmvpfast.com/api-costs/video).*
