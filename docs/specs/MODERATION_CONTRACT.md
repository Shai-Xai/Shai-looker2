# Moderation Contract — Pulse Social (posts · comments · chat · reactions)

**Version:** 1 · **Status:** phase 1 **LIVE in Pulse** (2026-07-20 — rule
engine, content states, queue/rules API, post report, and the console UI on
all three surfaces; app-side 422/202 handling pending; plan:
`docs/specs/MODERATION_P1_PLAN.md`) · **Owner:** Pulse
(`server/moderation.js`) · **Consumers:** the Howler app fork
(`howler_app/lib/data/repositories/pulse_social_repository_impl.dart`) + the
Pulse dashboard (Engage → Community) · **Extends:**
`docs/specs/SOCIAL_CONTRACT.md` (this document owns every moderation-related
wire shape; the social contract owns everything else)

Source scope: `docs/ai-social-moderation-scope.md` in the app repo
(`howler/HowlerApp_Standalone_Shai`, branch
`claude/ai-social-moderation-scope-owjb9o`) — reviewed with Shai 2026-07-20,
all open questions resolved (its §11). This spec is that document's §10
expanded against the actual Pulse codebase.

## 1. Principles

- **Server-side, at write time.** Every piece of fan-generated content passes
  the moderation pipeline inside the Pulse write endpoint before it is visible
  to anyone else. There is no client-side filter to bypass.
- **Hold until approved** (decision Q1): content flagged for review is never
  publicly visible before a moderator approves it. Only its author sees it,
  marked pending.
- **Never teach evasion:** blocked/held responses never echo *which* rule or
  term matched. Rule evidence lives only in the moderator-facing audit trail.
- **Platform ∪ client rules:** the platform (Howler-managed) list applies to
  every client; a client's own list adds to it and can never subtract from it.
- **Fail-open by default:** if the moderation subsystem errors, the write
  publishes and is re-checked asynchronously — a moderation outage must not
  kill live-event chat. (Configurable to fail-closed per client later; the
  phase-1 rule engine is in-process and has no meaningful outage mode.)
- **Organiser content is exempt in v1.** Everything written through the
  Pulse-authenticated management surfaces (admin + `/api/my`) — organiser
  posts, organiser replies, organiser chat messages, broadcasts, Instagram
  imports — is trusted and skips the pipeline. Only the app-facing
  (Howler-JWT) write surface is moderated.

## 2. Covered write surface (verified against the code)

All fan/UGC writes flow through exactly these `server/social.js` /
`server/chat.js` routes — there is no other code path that inserts app-user
content into `social_feed_posts`, `social_feed_comments` or
`social_chat_messages`. The pipeline hooks each of them:

| # | Endpoint (module) | Content checked | Outcomes |
|---|---|---|---|
| 1 | `POST /api/app/social/posts` (`social.js`) — registered app posters | post text (+ media, phase 2) | block · hold · publish |
| 2 | `POST /api/app/social/posts/:id/comments` (`social.js`) | comment text (+ `imageData` photo, phase 2) + fallback `displayName` | block · hold · publish |
| 3 | `POST /api/app/social/chat/channels/:id/messages` (`chat.js`) | message text + fallback `displayName` | block · hold · publish |
| 4 | `POST /api/app/social/chat/messages/:id/react` (`chat.js`) | the emoji (arbitrary, ≤8 chars today) | block · allow (no hold — see §6) |
| 5 | `POST /api/app/social/chat/channels` (`chat.js`) — fan group create | group `name` + `emoji` | block · allow (no hold — see §7) |
| 6 | `POST /api/app/social/chat/channels/:id/rename` (`chat.js`) | new group `name` | block · allow |
| 7 | `POST /api/app/social/posts/:id/report` — **NEW**, closes the parity gap | n/a (feeds the queue) | queued |

**Deliberately outside the pipeline** (verified — none of these can carry
fan-authored content past the checks):

- **Organiser/management writes** (`/api/admin/entities/:id/social|chat/...`,
  `/api/my/social|chat/...`: `createPost`, `organiserReply`,
  `organiserMessage`, `broadcast`, Instagram import) — Pulse-authenticated,
  trusted, exempt in v1 (§1).
- **Post like/unlike** (`POST/DELETE .../posts/:id/react`) — a fixed "like",
  carries no content (unlike chat reactions, which carry an arbitrary emoji).
- **Pins, impressions, reads, seen, join/leave** — ids only, no content.
- **`POST /api/app/social/presign`** — hands back a presigned R2 PUT; no
  content transits Pulse and nothing becomes visible from the upload alone.
  It stays poster-gated (403 for non-posters). The uploaded object only ever
  surfaces through endpoint #1, where its `{url}` reference is validated
  (`validMediaItem`) and — phase 2 — its bytes are fetched and pHash-checked
  at post-create time. Direct-to-bucket upload is therefore **not** a bypass:
  media that never gets referenced in a post is never served in any feed.
- **`GET /api/app/social/media/:id`** — read-only byte serving.

## 3. Pipeline (summary — full detail in scope §4)

```
content in ──► [1] Normalize ──► [2] Exact-match rules ──► BLOCK (422)
                                   │ no hit
                                   ▼
                              [3] Similarity rules ──► HOLD (202)
                                   │ no hit
                                   ▼
                              [4] AI classification ──► BLOCK / HOLD / PASS   (phase 2)
                                   │ pass
                                   ▼
                               PUBLISH (200/201)
```

- **Normalize:** lowercase + NFKC fold, strip zero-width chars, collapse
  repeats (`fuuuck`→`fuck`), fold diacritics, map leetspeak (`f@ck`, `sh1t`),
  tokenize emoji as first-class entries.
- **Exact** (→ block): normalized whole-word/phrase match, word-boundary aware
  (`class` must not trip on `ass`); emoji by codepoint sequence including
  skin-tone/ZWJ variants of a banned base; images by pHash distance 0
  (phase 2).
- **Similar** (→ hold): edit distance ≤ 1–2 (length-scaled), spaced-out
  variants (`f u c k`), embedded-substring hits; near-duplicate images by
  pHash Hamming threshold (phase 2).
- **AI** (phase 2): Haiku-class classification (decision Q6 — Anthropic API,
  pending POPIA sign-off). Synchronous for posts/comments (≤1.5 s p95,
  timeout → fail-open + async re-check); **asynchronous for chat** (rule
  engine stays sync/sub-10 ms; an async AI hit retro-holds the message —
  it may be visible ~1–3 s).
- Phase 1 ships steps 1–3 only, synchronous on every covered endpoint.

## 4. Write-endpoint responses

Unchanged on pass: `200/201` with the existing shapes. Two new outcomes on
endpoints #1–3 (§2):

**`202 Accepted` — held for review.** The content IS persisted, with
`moderation_status='held'`, visible only to its author:

```json
{
  "id": "cmt_ab12cd34ef56",
  "…": "the normal created-object shape, plus:",
  "moderation": { "status": "held", "reason": "similar_match" }
}
```

`reason`: `"similar_match"` (rule engine) | `"ai_review"` (phase 2). The rest
of the body is the same object the endpoint returns today, so optimistic UI
can render it directly with a "Pending review" badge.

**`422 Unprocessable Entity` — blocked.** Nothing is persisted in the content
tables; the attempt is snapshotted to the audit trail (§8):

```json
{
  "error": "content_blocked",
  "moderation": { "status": "blocked", "reason": "banned_term" }
}
```

`reason`: `"banned_term"` | `"banned_emoji"` | `"banned_image"` (phase 2) |
`"ai_policy"` (phase 2). Never any hint of which entry matched.

Implementation note: these two responses are sent directly by the moderation
hook (`res.status(...).json(...)`), NOT via `HttpError` — the shared
`errorMiddleware` (`server/http.js`) only carries `{ error: message }` and
can't ride the structured `moderation` object.

Old app builds: `202` is a 2xx, so a pre-moderation build treats a held item
as posted — harmless, because that's exactly the author's-eye view, and reads
hide it from everyone else server-side. `422` surfaces as a generic send
failure. `contractVersion` is unchanged — every moderation field is additive.

## 5. Read-endpoint changes

A `moderation_status` column (`visible` | `held` | `removed`, default
`visible`) is added to `social_feed_posts`, `social_feed_comments` and
`social_chat_messages`. (The scope's §5 also listed a `blocked` content state;
refined here — blocked content is **never written to the content tables**, it
exists only as a snapshot in `moderation_items`. Same observable behaviour,
no dead rows in hot tables.)

Every app-facing read filters it: rows with `held` are returned **only to
their author** (matched on the verified JWT id) carrying
`"moderation": {"status": "held"}`; rows with `removed` are returned only to
their author as a placeholder (chat reuses the existing `deleted:true`
placeholder shape plus `"moderation": {"status": "removed"}`; comments/posts
likewise return a stub with the moderation object) so the app can render
"Removed by moderators" (decision Q3 — in-app status only, no push/email).

Affected read surfaces (all must filter): global feed + community feeds +
both pinned strips, `GET .../posts/:id`, the `/p/:id` share page, comment
lists + `commentCount`, chat message pages + the channel aggregates
(`unread`, `messageCount`, `chatterCount`, `lastMsg`, pinned banners), the
story rail's `lastPostAt`/`unseen`, and post `stats` impressions. Moderator
dashboards (§8) are the only surface that sees other people's `held`/
`removed` content.

## 6. Emoji reactions (decision Q5 — in v1)

`POST /api/app/social/chat/messages/:id/react` validates the submitted emoji
against the merged **emoji rules only** — the cheap exact path: normalize,
fold skin-tone/ZWJ modifiers to the base sequence, match banned codepoint
sequences. On hit → `422` per §4 with `reason:"banned_emoji"`. No hold state
for reactions (a reaction is not reviewable content; it either lands or it
doesn't), no AI call, no fuzzy pass. Same check on the emoji field of fan
group create (#5).

## 7. Group names (create + rename)

Fan-chosen channel names (#5, #6) run the full text rule engine but with
**block-only semantics**: exact *or* similar hit → `422` (there is no
author-only pending state for a shared channel name). AI classification of
names is phase 2, async, feeding the queue.

## 8. New endpoints

### 8.1 App-facing

`POST /api/app/social/posts/:id/report` (Howler JWT, comment-limit rate
bucket) — parity with the existing comment/message report routes. Body
`{ "reason"?: string }` (free text, ≤200 chars, optional). Creates a
`moderation_items` row (`trigger='user_report'`, content stays **visible**
until declined — scope §4.5) and returns `{ "ok": true }`. Idempotent per
user+post. The two existing report endpoints (`.../comments/:id/report`,
`.../chat/messages/:id/report`) keep their wire shape but additionally file
the same queue item (their `reported=1` flag stays for back-compat with the
current inbox UI).

### 8.2 Dashboard (Pulse auth, dual-surface per CLAUDE.md)

Same JSON shapes on every surface; scope is the only difference.

| Surface | Prefix | Who |
|---|---|---|
| Platform | `/api/admin/moderation/...` | Howler staff (platform rules + platform queue) |
| Admin-on-behalf | `/api/admin/entities/:id/moderation/...` | Howler staff acting for a client |
| Client self-service | `/api/my/moderation/...` (+ `entityId`) | client logins with `moderation.manage` |

Routes (each prefix):

- `GET /rules` · `POST /rules` · `PATCH /rules/:id` · `DELETE /rules/:id` —
  banned-list CRUD. `POST /rules/import` — bulk (CSV/paste, one entry per
  line). `POST /rules/test` `{ "text": "…" }` → `{ "outcome": "block" |
  "hold" | "pass", "matches": [ruleIds] }` (the "would this be caught?" box —
  moderator-facing, so match evidence IS returned here).
- `GET /queue?status=pending&type=&communityId=&channelId=` — review queue,
  each item: content snapshot, surface, author (+ strike history, phase 3),
  trigger + evidence (rule hit highlighted / AI category+confidence /
  report reason), timestamps. Pending count + oldest-item age ride the
  response header row for the badge.
- `POST /queue/:id/approve` — held content → `visible` (or dismisses a
  user report, content stays visible). `POST /queue/:id/decline` — content →
  `removed`. Both record `reviewed_by`/`reviewed_at`; bulk via
  `{ "ids": [...] }`.
- `GET /audit?limit&before` — full trail including `auto_blocked` attempts.

Client rules always get `scope='client'` + their entity id; the platform
prefix manages `scope='platform'` rows. A client hit by a *platform* rule
lands in the **platform** queue when the client's moderation console is
flagged off (Howler-managed moderation), in the client's queue when on.

## 9. Data model (SQLite, `server/moderation.js` owns these)

```
moderation_rules
  id            TEXT PRIMARY KEY            -- rul_<uuid12>
  scope         TEXT  'platform' | 'client'
  entity_id     TEXT  ''                    -- '' for platform rows
  kind          TEXT  'word' | 'phrase' | 'emoji' | 'image'(p2)
  value         TEXT                        -- raw, as entered
  value_normalized TEXT                     -- §3 normalization, match key
  image_hash    TEXT  ''                    -- pHash hex (kind=image, p2)
  match_action  TEXT  ''                    -- per-entry override: 'block'|'hold'
                                            -- '' = default (block on exact, hold on similar)
  active        INTEGER 1
  created_by    TEXT                        -- Pulse user email
  created_at / updated_at TEXT

moderation_items                            -- review queue + audit trail
  id            TEXT PRIMARY KEY            -- mod_<uuid12>
  content_type  TEXT  'post'|'comment'|'chat_message'|'reaction'|'channel_name'
  content_id    TEXT                        -- '' for blocked attempts (nothing persisted)
  snapshot      TEXT                        -- JSON: text + media refs at decision time
                                            -- (survives edits/deletes; redacted after N days, default 90)
  author_user_id TEXT                       -- verified Howler user id
  community_id / channel_id TEXT ''
  entity_id     TEXT
  trigger       TEXT  'exact_rule'|'similar_rule'|'ai'(p2)|'user_report'
  evidence      TEXT                        -- JSON: {ruleId}|{aiCategory,aiConfidence}|{reportReason,reporterId}
  status        TEXT  'pending'|'approved'|'declined'|'auto_blocked'
  reviewed_by / reviewed_at TEXT ''
  created_at    TEXT

-- added to existing tables (addColumn migration pattern):
social_feed_posts.moderation_status     TEXT 'visible'   -- visible|held|removed
social_feed_comments.moderation_status  TEXT 'visible'
social_chat_messages.moderation_status  TEXT 'visible'

-- phase 3: moderation_strikes (per-user offence tallies)
```

**Rule resolution at check time:** platform rules ∪ the owning entity's client
rules, resolved from the content's `entity_id` (already on every post,
comment and chat message row). Cached in-process with a short TTL (~30 s) so
the synchronous path stays ≤10 ms; cache busts on any rule write.

## 10. Roles (decision Q2) & flags

- **Client moderator** — new atomic permission `moderation.manage` in
  `server/roles.js`, granted to the `owner` and `manager` bundles plus a new
  dedicated `moderator` role (moderation.manage only — for trust-&-safety
  hires who shouldn't see campaigns or finance). Gates `/api/my/moderation/*`.
  As everywhere, enforcement checks the permission key, never the role name.
- **Platform moderator (Howler staff)** — a global `platform_moderator` tag in
  `users.roles` (the `SUPER_ADMIN` pattern, `roles.js`). Any Howler admin can
  *view* the platform queue and lists; **writes** (platform rule CRUD,
  platform-queue approve/decline) require the tag. The platform queue covers
  the Howler-global feed (house entity) plus every item caught by a
  *platform* rule for clients whose own console is off (§8.2).
- **Feature flag** (`server/flags.js`): new kid `community.moderation`
  (default OFF, beta — repo convention) gating the **client console** routes
  (`/api/my/moderation`) and UI only. **Enforcement is never flag-gated**:
  platform rules run for every flag-on-`community` client regardless; the
  flag only decides whether the client self-serves their queue + list or
  Howler handles it from the platform surface.

## 11. Non-functional (contract-level)

- Rule engine ≤ 10 ms in-process, synchronous on every covered write.
- Snapshots in `moderation_items` are redacted after a configurable retention
  (default 90 days); moderation data never leaves Pulse.
- Every automated decision records its evidence; every human decision records
  who/when. Blocked attempts are silent to other users; the author gets the
  friendly 422.
- Kill switches: the existing `social_feed_enabled` / `social_chat_enabled`
  keys already 404 the whole surface; moderation adds no new global switch in
  phase 1 (the pipeline is deterministic code on the write path — disabling it
  is a deploy, not a toggle). The app-side `feature-moderation` PostHog flag
  (scope §7) only controls app UI states, never server enforcement.

## 12. Phasing (scope §9)

| Phase | This contract's parts |
|---|---|
| **1 — rule engine + console** | §2 #1–7, §3 steps 1–3, §4–§10 in full (text + emoji only) |
| **2 — AI + image hashing** | §3 step 4, `banned_image`/`ai_policy` reasons, `ai_review` holds, image rules (pHash), AI thresholds config |
| **3 — vision, strikes, escalation** | `moderation_strikes`, sampled video frames, auto-mute/temp-ban, analytics |
