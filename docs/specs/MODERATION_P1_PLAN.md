# Build plan — Social Moderation **Phase 1**: rule engine + console

> Status: **PR 1 SHIPPED** (2026-07-20 — §1–§4, §5's routes, §6 roles/flags,
> report endpoints, tests: the whole server side). Remaining: the Moderation
> tab UI (PR 2) and the app repo work (PR 3). · Contract:
> `docs/specs/MODERATION_CONTRACT.md` (read
> first) · Scope source: `docs/ai-social-moderation-scope.md` in the app repo
> (decisions resolved 2026-07-20). This plan covers **phase 1 only** — the
> deterministic rule engine, held/blocked content states, banned-lists +
> review-queue dashboard, emoji-reaction validation and the post-report gap.
> AI classification, image pHash and strikes are phases 2–3 and live in the
> contract/scope.

## 0. What phase 1 ships (one paragraph)

Every fan-authored write on the Pulse social surface — app posts, comments,
chat messages, emoji reactions, fan-group names — passes a synchronous,
in-process rule engine (normalize → exact → fuzzy) before anyone else can see
it. Exact hits on the merged banned list (platform ∪ client) are rejected
with a friendly 422 and audited; fuzzy hits persist as **held**, visible only
to their author, until a moderator in Pulse approves or declines them.
Moderators work in a new Moderation area of Engage → Community: banned-lists
manager (platform + per-client) and a review queue fed by rule holds and user
reports — including the previously missing post-report path.

## 1. New module: `server/moderation.js`

One self-contained, disposable module (repo convention; architecture budget
1500 lines — split a `server/moderationRules.js` engine library out if the
dashboard routes push past it):

- Owns tables `moderation_rules` + `moderation_items` (created in `mount()`,
  like `social.js`), and the `addColumn` migrations for
  `moderation_status` on `social_feed_posts` / `social_feed_comments` /
  `social_chat_messages`.
- Exports the check API used by the other modules:
  - `screenText(entityId, text) → { outcome: 'pass'|'hold'|'block', matches }`
  - `screenEmoji(entityId, emoji) → { outcome: 'pass'|'block', matches }`
  - `recordItem({...})` / `recordBlockedAttempt({...})` — queue/audit writers
  - `moderationGate(res, screenResult, { persistHeld })` — the shared
    "respond 422 / mark held + respond 202 / fall through" helper so the
    wiring in social.js/chat.js stays 3–4 lines per endpoint.
- Mounts the dashboard routes (§5) from `index.js` with one line:
  `require('./moderation').mount(app, { db, auth, rateLimit })`.
- In-process rule cache keyed by entity id (platform ∪ client, ~30 s TTL,
  busted on rule writes) so the sync path stays ≤10 ms.

## 2. Normalizer + rule engine (pure functions, heavily unit-tested)

`normalize(text)`: lowercase → Unicode NFKC → strip zero-width chars →
diacritic fold (`String.normalize('NFD')` + combining-mark strip) → leetspeak
map (`@→a 0→o 1→i/l 3→e 4→a 5→s 7→t $→s !→i`) → repeated-char collapse
(3+ → 1, so `fuuuck`→`fuck` but `class` keeps its `ss`) → emoji tokenized as
standalone entries (skin-tone/ZWJ modifiers folded to the base sequence).

Matching:
- **Exact → block:** whole-word/phrase match on the normalized text against
  `value_normalized` (word-boundary aware — `class` must not trip on `ass`);
  emoji by folded codepoint sequence.
- **Fuzzy → hold:** (a) bounded edit distance — none for entries under 4
  chars (too noisy), 1 for 4–6, 2 for 7+; (b) spaced-out variants (runs of
  single-char tokens joined and re-matched exactly — "f u c k"); (c)
  normalized-substring hits inside longer tokens for entries ≥ 5 chars
  (boundary rule waived, length floor avoids Scunthorpe).
- Per-entry `match_action` override respected (`block`|`hold`).

No JS deps needed — plain string ops + a small Levenshtein. Golden-case tests
in `test/moderation.test.js` (Scunthorpe words, leet variants, emoji ZWJ/skin
tones, af/zu/xh sample entries, clean text passes).

## 3. Enforcement wiring (exact integration points)

All in the app-facing routes; organiser surfaces untouched (contract §1).

| Route (current location) | Change |
|---|---|
| `POST /api/app/social/posts/:id/comments` — `server/social.js` (~line 1131) | after text/link/image validation, before the INSERT: screen `text` (+ fallback `displayName`); block → 422; hold → INSERT with `moderation_status='held'` + respond 202 |
| `POST /api/app/social/posts` — `social.js` (~1197) | screen `text` before `createPost`; hold → pass a `moderationStatus:'held'` through `createPost` (new opt, default `visible` so organiser callers are untouched) + 202 |
| `POST /api/app/social/chat/channels/:id/messages` — `server/chat.js` (~404) | screen `text` (+ `displayName`); block → 422; hold → INSERT `held` + 202 |
| `POST /api/app/social/chat/messages/:id/react` — `chat.js` (~441) | `screenEmoji` before the INSERT; block → 422 (`banned_emoji`); no hold path |
| `POST /api/app/social/chat/channels` (create, ~339) + `/rename` (~326) — `chat.js` | screen `name` (+ create's `emoji`) block-only: exact **or** fuzzy hit → 422 |
| `POST /api/app/social/posts/:id/report` — **new**, `social.js` | contract §8.1: file `moderation_items` (`user_report`, content stays visible), idempotent per user+post |
| `.../comments/:id/report` (~1174) + `.../chat/messages/:id/report` (~483) | keep `reported=1`, additionally file the same queue item |

Blocked attempts on every route call `recordBlockedAttempt` (snapshot →
`moderation_items` with `status='auto_blocked'`, `content_id=''`).

The 422/202 bodies are sent directly (`res.status(...).json(...)`), not via
`HttpError` — the shared error middleware can't carry the `moderation` object.

## 4. Read filtering (`moderation_status`)

Default `'visible'` keeps every existing row and query behaviour identical.
Then, surface by surface, add the filter with the author carve-out
(`moderation_status='visible' OR (moderation_status IN ('held','removed') AND
howler_user_id=<viewer>)` — held/removed rows serialize with the
`moderation` object; `removed` chat/comment rows render as the existing
deleted-style placeholder + `moderation.status`):

- `social.js`: global feed + community feed + pinned strips + `myPins`,
  `GET .../posts/:id`, `/p/:id` share page (no viewer → visible only),
  comment list + `nestComments` + `commentCount`, post `stats`.
- `chat.js`: message pages, and the channel aggregates that count/preview
  messages — `unread`, `messageCount`, `chatterCount`, `lastMsg`, shared +
  personal pin banners (visible rows only).
- Story rail `lastPostAt`/`unseen` (visible posts/messages only).

Moderator surfaces read unfiltered via the queue (§5), not via these routes.

## 5. Dashboard — routes + UI

Routes per contract §8.2 (three prefixes, same shapes): rules CRUD + import +
`rules/test`, queue list, approve/decline (single + bulk `{ids}`), audit.
Approve → content `visible` (report-triggered items: just close the item);
decline → `removed` (chat rows also clear pins, mirroring the existing
moderator-delete behaviour).

UI (mobile-first, `useIsMobile()` stack):
- New **Moderation** tab in Engage → Community (`client/src/pages/
  EngageAppPage.jsx`), components `ModerationRulesManager` +
  `ModerationQueue` with the standard `scope` prop
  (`platform` | `admin-client` | `my`) — one component, three surfaces, like
  `MailTemplateEditor`.
- Rules manager: list with kind/action/active toggles, add word/phrase/emoji,
  bulk paste import, the "would this be caught?" test box. Platform scope
  clearly labelled; client scope labelled "applies to your communities &
  channels only".
- Queue: pending list (content snapshot, surface, author, trigger evidence
  with the matched span highlighted, age), approve/decline + bulk, pending
  badge on the tab, audit view behind a sub-tab.
- Platform scope lives in the Admin area (house/global moderation), gated per
  §6.

## 6. Roles + flags (same change, per repo rules)

- `server/roles.js`: add `MODERATION_MANAGE: 'moderation.manage'`; grant to
  `owner` + `manager`; add the dedicated `moderator` role
  (`[P.MODERATION_MANAGE]`, lens `exec`).
- `roles.js`: add `PLATFORM_MODERATOR = 'platform_moderator'` +
  `isPlatformModerator(user)` (mirrors `SUPER_ADMIN` — admin-only tag).
  Admin viewing is open; platform rule writes + platform queue actions check
  the tag.
- `server/flags.js`: register kid `community.moderation` (def `false`, beta)
  under `community`; add gate `['/api/my/moderation', 'community.moderation']`.
  Enforcement is NOT flag-gated — flag-off clients get platform-rule
  enforcement with holds routed to the platform queue (contract §10).

## 7. Tests + docs (definition of done)

- `test/moderation.test.js`: normalizer/matcher golden cases; endpoint tests —
  422 shape (no term echo), 202 + held persistence, author-only visibility of
  held/removed on feed/comments/chat reads, aggregate counts exclude held,
  reaction 422, group-name 422, report-post idempotency, approve/decline
  transitions, platform∪client resolution, flag-off → platform queue routing,
  permission gates (`moderation.manage`, `platform_moderator`).
- `test/architecture.test.js`: budget entry for `server/moderation.js`.
- `docs/specs/SOCIAL_CONTRACT.md` §18 already points here; bump its note from
  "approved scope" to "live" when this ships.
- `docs/PRODUCT_OVERVIEW_SALES.md`: add Moderation under Community (🧪 beta)
  + changelog line, same change as the ship (repo rule).

## 8. Rollout (staging-first, per the social contract's testing rule)

1. Land on `staging` → https://howler-pulse-staging.onrender.com with the
   flag off everywhere; seed a small platform list; verify with the app
   fork's debug build (422 in composer, held badge, moderator
   approve/decline round-trip).
2. Flip `community.moderation` on for the pilot client; client-moderator
   walkthrough.
3. Promote to production with the standard release train; flag stays
   per-client.

## 9. Suggested PR slicing

| PR | Contents |
|---|---|
| 1 | `server/moderation.js` engine + tables + status columns + enforcement wiring + read filtering + report-post endpoint + tests (server-complete: everything enforced, moderatable via API) |
| 2 | Dashboard routes + Moderation tab UI (rules manager + queue), roles + flag + gates |
| 3 | App repo (separate plan there): 422/202 handling, pending/removed states, `reportPost` wiring, l10n, `feature-moderation` PostHog flag |

PR 1 and 2 could merge as one if review prefers; the cut line keeps PR 1
UI-free and fully testable headless.

## 10. Explicitly deferred (do not build in P1)

AI classification (sync or async), image/pHash rules and banned-image
uploads, video poster checks, strikes/escalation, per-category thresholds,
fail-open/fail-closed config (P1's engine is in-process deterministic code —
there is nothing to fail open *from*), appeal flows (decision Q4: none in
v1), Amity parity (decision Q8: none).
