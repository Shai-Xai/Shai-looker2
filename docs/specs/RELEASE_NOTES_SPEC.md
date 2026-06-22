# Spec — Release Notes 2.0 (daily internal · client What's New + weekly email · shared how-to)

> Status: **draft for review** · Owner: (tbd) · North Star:
> `docs/EXPERIENCE_OS_BRIEF.md` (insight → action → results → efficiency). This
> upgrades the existing **admin-only, manual** release-notes feature into a
> pipeline that reaches everyone: a **daily internal** changelog for the Howler
> team, and **two client surfaces** — an in-app **What's New** and a **weekly
> branded email** — both carrying a **how-to** so the work we ship gets used. No
> new delivery plumbing.

## 1. Problem & goal
Today release notes barely earn their keep:

- **Generation is manual** — an admin must click "Generate from commits"
  (`POST /api/admin/release-notes/generate`, `server/index.js:307`). Nothing runs
  "after each day".
- **One audience, one body** — a single `body` field
  (`release_notes`, `server/db.js:466`). No **how-to**, no separate **technical**
  view, no **client-pitched** summary.
- **Nobody acts on them** — no schedule, no email, no client surface beyond the
  admin list. What we ship stays invisible to the team supporting clients *and* to
  the clients themselves.

**Goal:** turn each day's commits, automatically, into a reviewed **daily internal
note** — what shipped, a **how-to**, and a **technical** view for devs — then surface
the client-relevant part to clients in **two places**: an in-app **What's New**
panel they see when they log in, and a **weekly branded email** digest.

**The how-to is the through-line.** It's written for the end user ("go to Settings →
Branding, click…") and **serves both audiences**: clients read it (in What's New and
the email) to self-serve, and the team reads the same steps to demo and support.
Only the **dev/technical** lens is internal-only — it's never rendered on a client
surface.

**Two audiences, split by cadence:**
- **Internal (Howler team)** → **daily**: what shipped + how-to + dev detail. So the
  people talking to clients always know what just landed and how to use it.
- **Clients (external)** → **in-app What's New** (live, as notes are published) **+ a
  weekly email** digest. Both include the **how-to**.

**Non-goal (v1):** auto-sending unreviewed AI text to clients (human publish gate
stays), per-client relevance targeting (designed for, deferred — §6), and Slack
delivery of the dev lens.

## 2. The reframe (why this is cheap)
We are **not** building delivery. Every rail already exists:

- **Generation** — `summariseReleaseNotes()` + `RELEASE_NOTES_SYSTEM`
  (`server/insights.js:410–438`) already reads commits grouped by day
  (`recentCommitsByDay`, `server/index.js:285`) and writes benefit-led bullets.
  We extend its output shape and run it on a schedule.
- **Scheduling** — `server/scheduler.js` already ticks due jobs (`scheduled_jobs`)
  and the digest pipeline already proves "cron → AI → branded email per entity".
- **Email** — `server/mailer.js` already resolves three-tier per-client branding
  (`resolveBranding`) and ships `notificationEmail` / `digestEmail`. A
  `releaseNotesEmail` builder slots straight in.
- **In-app surfacing + unseen badge** — `client/src/components/InboxNotifier.jsx`
  already polls + toasts + tracks unread; we clone the pattern for a "What's New"
  bell. The client shell (`ClientLayout.jsx`, `App.jsx`) already has the header and
  routing to hang it on.
- **Admin UI** — `ProductReleaseNotes()` (`client/src/pages/AdminPage.jsx:489`)
  already does the draft → review → publish loop; we add lens fields and a "this
  week's client email" preview.

So this slice is mostly **schema columns + a richer daily prompt + a weekly roll-up
prompt + one email builder + a thin client read surface**, riding existing modules.

## 3. The model: daily internal → client What's New + weekly email
One daily AI pass feeds the team. **Publishing** a note reveals its client-safe part
(summary + how-to) to clients in **What's New** immediately; a weekly pass distils the
week's published notes into the **email**. The how-to travels with each change to
every surface. The **dev lens never leaves the internal surface.**

```
            commits (1 day)
                  │
   DAILY pass ──► { date, title, summary, howTo, deepLink, dev }   → internal draft row
                  │                                                   (Admin → Product, daily)
   admin reviews / edits / publishes
                  │
        published=1 ──► CLIENT What's New (summary + how-to + deep link)   ← live, in-app
                  │
                  ▼  (once a week, over the week's PUBLISHED notes)
   WEEKLY pass ─► { subject, intro, items:[{title,benefit,howTo,deepLink}] }
                  │
            admin approves ─► branded email to opted-in clients
```

- **summary** — plain-language list of the day's user-noticeable changes (stored in
  the existing `body`).
- **how-to** — **shared by every surface**: 1–3 end-user steps + a deep link.
- **dev** — internal only; rendered on Admin → Product, never on a client surface.
- **What's New** — the published summary + how-to, in-app, entity-scoped, with an
  unseen badge.
- **client email** — weekly digest of the week's published changes, each with its
  how-to.

## 4. Users (dual-surface rule)
- **Howler admin / dev** — the **primary** authors. Review + edit the daily notes
  (summary · how-to · dev), publish them (which reveals the client part in What's
  New), and once a week review the AI-drafted **client email** before it sends.
  Admin → Product.
- **Other internal staff (AM / support / ops)** — *read* the daily summary + how-to
  to support and demo. (v1 = admins; widen to a staff read role later if needed.)
- **Organiser (client)** — sees **What's New** (published summary + how-to) in-app
  when they log in, and receives the **weekly branded email** (opt-in). Never sees
  drafts or the dev lens. Scoped to their entity via `/api/my/...`. Email opt-in
  lives in their own Settings, with the admin equivalent per entity (mirrors the
  existing `notifyEmail` shape).

## 5. In scope (v1)
- **Daily auto-generation** of internal drafts (cron): summary + how-to + dev, never
  clobbering days already covered (keep the guard, `server/index.js:313`).
- **Schema**: extend `release_notes` with the lens columns, a per-user "seen"
  marker, and a weekly-send table (§7).
- **Two prompts** — a richer daily prompt returning `{ summary, howTo, deepLink, dev }`,
  and a weekly roll-up prompt that turns a week of notes into one client email with
  per-feature how-tos. Both registered in `promptRegistry()` (build fails otherwise
  — CLAUDE.md / `test/prompts.test.js`).
- **Admin review UI**: per-entry **Summary · How-to · Dev** fields (editable);
  draft/publish; a **"This week's client email"** preview an admin approves.
- **Client What's New**: `GET /api/my/release-notes` (published summary + how-to +
  deep link, entity-scoped) + a header **bell with unseen count** (clone
  `InboxNotifier`) + a **mobile-first drawer**; opening it stamps the per-user seen
  marker.
- **Weekly client email**: one branded roundup per opted-in entity — each change with
  its how-to; opt-in toggle (client self-service + admin per entity).

## 6. Out of scope (later slices)
- **Per-client relevance targeting** — show a change only to clients who use the
  touched module. Schema is designed for it (`modules` tag, §7); v1 shows the same
  published notes / weekly summary to all clients.
- **Slack** delivery of the dev lens.
- **Grounded how-tos from a knowledge base** — v1 grounds how-tos from commit
  `how-to:` trailers + a small curated feature→screen map; mining the
  `CLIENT_KNOWLEDGE_SPEC` corpus is later.
- **Adoption analytics** (did clients open the how-to / click through).
- **Per-feature dismiss / "mark all read"** beyond the single seen marker.

## 7. Data model (v1)
Extend the existing table — same `addColumn()` ALTER pattern the codebase uses
(`server/db.js:475`). One row per day still; `body` stays the **summary** so old
rows keep working.

```
release_notes  (add columns)
  how_to      TEXT NOT NULL DEFAULT ''   -- markdown: end-user steps (serves clients AND the team)
  body_dev    TEXT NOT NULL DEFAULT ''   -- technical lens (internal only; never sent client-side)
  deep_link   TEXT NOT NULL DEFAULT ''   -- primary path for the day's headline feature
  modules     TEXT NOT NULL DEFAULT ''   -- comma list for future relevance filtering (unused in v1)
  -- existing: id,date,title,body(=summary),published,source('manual'|'auto'),last_sha,created_at,updated_at
```

**Per-user "unseen" marker** (for the What's New badge): one timestamp per user,
compared against the newest *published* note date; set when the drawer opens. Store
as a per-user setting / column `release_seen_at` — no new table.

**Weekly client email** (its own small record so we can preview, approve, not
double-send):

```
release_emails  (new table)
  id          TEXT PRIMARY KEY
  week_start  TEXT NOT NULL            -- YYYY-MM-DD (Monday of the covered week)
  entity_id   TEXT NOT NULL DEFAULT '' -- '' = the shared draft; per-entity rows track sends
  subject     TEXT NOT NULL DEFAULT ''
  body        TEXT NOT NULL DEFAULT '' -- AI-drafted, admin-approved client copy (benefit + how-tos)
  status      TEXT NOT NULL DEFAULT 'draft'  -- draft | approved | sent
  sent_at     TEXT NOT NULL DEFAULT ''
  created_at  TEXT NOT NULL
```

The weekly tick drafts one shared email (entity_id `''`), an admin approves it, then
it sends per opted-in entity (branded) and stamps `status='sent'` / `sent_at`.
Per-entity send success is already logged in `mail_log` by the mailer.

## 8. AI generation
**Daily prompt** — extend `RELEASE_NOTES_SYSTEM` (`server/insights.js:410`):

```json
{ "days": [ {
  "date": "YYYY-MM-DD",
  "title": "short headline, <8 words",
  "summary": "markdown bullets — what shipped, plain language, benefit-led",
  "howTo": "1–3 numbered END-USER steps to use it; omit if nothing user-actionable",
  "deepLink": "/path/in/app or '' ",
  "dev": "technical bullets: what changed, SHAs, breaking/migration notes"
} ] }
```

**Weekly roll-up prompt** (new, registered) — input is the week's **published**
summaries + how-tos; output keeps the how-to per item:

```json
{ "subject": "friendly subject line",
  "intro": "1–2 line opener",
  "items": [ { "title": "...", "benefit": "what's better for you", "howTo": "1–3 steps", "deepLink": "/path" } ] }
```

Rules to add:
- **summary** keeps the existing benefit-led, non-technical, drop-noise rules.
- **howTo** is written for the **end user** (name the screen, concrete steps); only
  when something is user-actionable; use a `how-to:` commit trailer verbatim if
  present. The same field serves What's New, the email, and the team's demo/support.
- **dev** may keep jargon, SHAs, migration/flag notes; honest, no invention.
- **weekly** merges the week, drops internal-only items, **carries each item's
  how-to**, never invents.

Grounding the how-to: feed the daily model (a) any `how-to:` / `link:` trailers in
the day's commits, and (b) a short curated `feature → screen/path` map kept beside
the prompt — cheap, and keeps it from inventing UI.

### 8a. Production note — authored seed (commits aren't readable in prod)
Runtime "summarise from git" needs the repo's history at runtime, which the
deployed server **does not have** (Render does a shallow clone), so the daily git
tick and the "Generate from commits" button only work in **dev**. In production,
notes are instead **authored at source**: a version-controlled seed
(`server/releaseNotesSeed.js`) holds note objects (all three lenses), and
`applySeed(db)` upserts them **once on boot**. Each entry has a stable `key`
recorded in the `release_seed_applied` setting, so re-deploys never duplicate a
note nor resurrect one an admin has edited/deleted. To ship a note, append an
entry in the same PR as the change it describes — higher quality than summarising
terse commits, and no runtime git or GitHub token. (A GitHub-API commit source is
the alternative if a fully hands-off daily robot is ever wanted — deferred.)

## 9. Surfaces
- **Admin → Product → Release notes** (extend `ProductReleaseNotes`,
  `AdminPage.jsx:489`): each daily entry shows **Summary · How-to · Dev** fields, all
  editable; draft/`AUTO` badges stay; publish/unpublish (publish = client-visible in
  What's New). "Generate" stays for backfill.
- **Admin → Product → Weekly client email**: a preview of the AI-drafted roll-up
  (subject + per-item benefit + how-to), editable, with **Approve & send** and the
  opted-in recipient count.
- **Client What's New** (new): `GET /api/my/release-notes` returns published
  `{date,title,summary,howTo,deepLink}` for the user's entity. A **header bell**
  (clone `InboxNotifier`) shows the count newer than `release_seen_at`; clicking
  opens a **mobile-first drawer** (single column, ≥40px taps per CLAUDE.md) listing
  each change with its how-to and a deep-link button. Opening stamps `release_seen_at`.
- **Client self-service** (`/api/my/...`) + admin equivalent
  (`/api/admin/entities/:id/...`): the "email me product updates" opt-in, same
  component both scopes (the `scope` prop pattern, like `MailTemplateEditor`).
- **Weekly email**: new `releaseNotesEmail({ branding, entityId, subject, intro, items, … })`
  in `server/mailer.js`, branded per entity, rendering each item's benefit + how-to +
  deep-link button; the weekly scheduler tick drafts it, then (after approval) sends
  one roundup per opted-in entity.

## 10. Governance — never auto-send / auto-reveal unreviewed
**AI drafts, a human ships.** Two gates: the per-note **publish** gate (controls
What's New + email eligibility) and the weekly **approve** gate (controls the send).

```
nightly cron ─► daily internal drafts (published=0)      ← team-only, not in What's New
                      │
                 admin reviews / edits / publishes
                      │
        published=1 ──► visible in client What's New (summary + how-to; dev lens stripped)
                      │
weekly cron  ─► client email draft (status='draft')      ← never sends on its own
                      │
                 admin approves (status='approved')
                      │
                 send per opted-in entity (status='sent')
```

No path makes an unreviewed draft reach a client, and the dev lens is never included
in a client payload.

## 11. Build order (now / next / later)
1. **Schema + daily prompt** — add the columns + `release_seen_at` (§7); upgrade
   `RELEASE_NOTES_SYSTEM` + `summariseReleaseNotes()` to
   `{ summary, howTo, deepLink, dev }`; register; keep backfill generate working.
2. **Admin review UI** — Summary · How-to · Dev fields in `ProductReleaseNotes`.
3. **Daily cron** — schedule end-of-day draft generation (reuse `scheduler.js`).
4. **Client What's New** — `GET /api/my/release-notes`, header bell badge, mobile-first
   drawer, `release_seen_at`.
5. **Weekly roll-up** — `release_emails` table + weekly prompt + the "Weekly client
   email" preview/approve UI (per-item how-tos).
6. **Weekly email send** — `releaseNotesEmail` builder + per-entity send + opt-in
   toggle (client + admin). Update `PRODUCT_OVERVIEW_SALES.md` in the same change
   (CLAUDE.md rule) once the client surfaces are live.
7. **Later** — per-client relevance (`modules`), Slack dev feed, knowledge-grounded
   how-tos, analytics.

## 12. Open threads
1. **How-to grounding** — commit `how-to:` trailers + curated map (v1) vs. mining
   the `CLIENT_KNOWLEDGE_SPEC` corpus (later). Recommend trailers+map now.
2. **Weekly send timing** — fixed day/time (e.g. Tue 09:00) vs. per-entity setting.
   Recommend a sensible default, configurable later.
3. **Weekly approval** — require admin approval each week (recommended, safer) vs.
   auto-send the AI draft. Recommend approval in v1.
4. **What's New depth** — show everything since `release_seen_at` (recommended,
   capped) vs. a fixed last-N list.
5. **Empty weeks** — skip the email when nothing client-worthy shipped (recommend
   skip) vs. send a "no changes" note (don't).
6. **Internal read access** — admins-only in v1, or a wider staff/AM read role for
   the daily summary + how-to? Admins-only first.
7. **Backfill** — run the new daily generator once over recent history so What's New
   and the first weekly email have material?
