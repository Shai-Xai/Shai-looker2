# 2026-07-02 — Full stocktake: where every theme stands + what's next up

> A "where am I" consolidation (the kind the whats-next README asks for once
> notes accumulate). Compiled from: `docs/ROADMAP.md` (last reconciled 06-27),
> all six 06-27 whats-next notes, every spec in `docs/specs/`, the briefs
> (`EXPERIENCE_OS_BRIEF`, `SKILLS_BRIEF`, `ENGAGEMENT_ENGINE`, `GOALS_*`), and
> the code + git evidence on `main` as of 2026-07-02. Statuses below were
> verified against actual tables/routes/components, not just docs.
>
> Companion change: `docs/ROADMAP.md` re-reconciled in the same commit.

---

## 1. AI — the Owl & agents

**Where we are: the flagship sprinted.** Since 06-27 the native Owl went from
"answer/analyse" to a real agent behind a flag: native Claude tool-use loop
(`owlChat.js`), `askData` over a curated catalogue (scope-gated, fails closed),
and **12 registered tools** including the first act-tools — `createAlert`,
`createSegment`, `draftCampaign` (draft → confirm, never silent writes) — plus
`getGoals`/`getAlerts`/`getCampaigns`/`getDashboard`/`queryDashboard`,
`eventOps`, `askUpload`, `draftReport`. Around it: chat history/share, pins to
dashboards, memory, guidance editor, uploads, per-client extra explores
(catalogue Slices 1–3), auto-charts, citation chips, WhatsApp interface,
prompt-starter pills, heartbeat + Stop button. Owl designs full themed block
emails. Gated by `owlNativeChat` + allowlist (dogfood-only today).

**Next up (in rough order):**
1. **Rollout / Inventive cutover (P1 plan M5).** Widen the allowlist, A/B a
   first real client, parity-check, then retire `inventive.js` +
   `AnalystDrawer.jsx`. The build is ahead of its distribution.
2. **`createTask` + `announce` act-tools** — blocked on the event-task layer
   (theme 6); `announce` can ride the existing OS spine now.
3. **Skills runtime (SKILLS_BRIEF P1)** — `server/skills.js` + `skills`/
   `skill_runs` tables; Ticketing Manager at L1 (advise into the briefing).
   The Owl loop IS the shared brain; only the scheduler "door" is missing.
4. **Owl Extraction (brief layer 6b)** — commitments/questions in ingested
   mail → suggested tasks/replies with confirm. Only settlement-PDF extraction
   exists today.
5. **Owl Recall over the corpus (6c)** — grounded Q&A over ingested `os.js`
   messages with source citations (today the Owl grounds on live data only).
6. Deferred segment drivers once curated in: top spenders, new-vs-returning,
   reps. Campaign-from-saved-segment by name; goal-gap cohort proposals; A/B
   copy variants.
7. Voice (1.2) — after cutover.

## 2. Onboarding & client UX

**Where we are.** Setup wizard shipped (`setupWizard.js` + guided tours) — the
06-27 🏗️ is done and stale **PR #2 is superseded (close it; PR #1 "Main" is
also mis-based and should be closed)**. Onboarding checklist, setup nudges
(AI-personalised, editable cadence), Admin → Users section with full audit log
— all live. Release notes: the internal half is done (3-lens daily
auto-drafts, publish gate, admin UI).

**Next up:**
1. **Client-facing "What's new" (RELEASE_NOTES items 4–6):** `GET
   /api/my/release-notes` + `release_seen_at` + a header bell/drawer (clone
   `InboxNotifier`), then the weekly branded email (`release_emails` +
   `releaseNotesEmail` in `mailer.js`). The roadmap's 2.1 ✅ overstated this —
   clients still can't see release notes.
2. **Digest personalisation phases 3–5** (`DIGEST_PERSONALISATION.md`):
   per-user digest generation (`personalise` job flag, shared base +
   per-recipient delta), feedback routed per-user vs AM-promoted shared,
   background precompute.
3. Digest "Opportunities" block (abandoned-cart metric) — from the 06-27 nudge
   session, still open.
4. Client background colour/image (2.3) — quick S win, still unbuilt.
5. `docs/PRODUCT_OVERVIEW_SALES.md` is badly behind (nothing since 06-17):
   needs Owl chat, email builder, Event Ops, API/MCP, wizard, release notes.

## 3. Data & dashboards

**Where we are.** Days-before relative filter ✅; combined-field OR on locked
filters + drills shipped this week; briefing precompute ✅.

**Next up:**
1. **Portfolio view (3.1)** — still zero code (`entity_groups`, `groups.js`,
   `portfolioScope`: all absent). Spec ready. The single biggest data-layer
   gap; XL, slice-able (group primitive → portfolio query mode → home surface
   → portfolio segments).
2. **Dashboard prefetch (3.3)** — warm top-N most-viewed dashboards per client
   on login/idle. M, high perceived-speed payoff.
3. Social metrics as dashboard tiles — the connector ingests account/post
   metrics but nothing surfaces them in the 24-col grid yet (06-27 note item).

## 4. Engage — campaigns, channels & journeys

**Where we are.** Email builder went from zero to Tier-2 in a week:
Mailchimp-style blocks, multi-column, drag-reorder, visual themes, AI banners,
Owl-designed full emails. Segments/resolver/consent + Meta & TikTok audience
sync solid. Social-metrics ingestion (`socialMetrics.js`) live. Campaign costs
(billing) live.

**Next up:**
1. **Journey builder (J2–J3)** — the branching-journey prototype lives ONLY on
   the unmerged `claude/journey-builder-sandbox` branch (drafter, 4 recipes,
   read-only tree). Promote/rebuild J1, then persist the tree
   (`journey_nodes`), then evaluate decision nodes off existing open/click
   signals. This is the biggest Engage gap and the spec is ready.
2. **WhatsApp as an outbound campaign channel** — `messaging.js` reserved the
   slot; `owlWhatsapp.js` is the Owl bot, not a campaign channel.
3. **Multi ad-accounts per channel (4.6)** — still flat single-account fields;
   `ad_connections` table + per-brand grouping in AudienceHub.
4. ROI via promo-code attribution (standing offer from June) — campaigns
   already inject unique promo codes; pull matched sales → ROI on reports.
5. X/Twitter + post/ad publishing — as demand dictates.
6. Google Customer Match — optional, spec'd.

## 5. Platform surface & integrations

**Where we are: 4.2 went from spec to shipped in two days.** Per-entity API
keys, `/api/v1` read API (row-level data behind `read_rows` scope), remote MCP
server, OAuth one-click connect (Claude + hand-typed trusted clients), per-
client access switch (off by default), client/developer guide, and this
morning the ChatGPT/OpenAI connector (search + fetch tools).

**Next up:**
1. Adoption + hardening: first external consumer, rate-limit/usage visibility
   per key (pairs with theme 6's cost work).
2. **Howler core integration (4.1)** — still the biggest unbuilt integration;
   unblocks Playbook auto-verification, purchase-signal journeys, attendee
   app-push (4.5). Needs a scoping conversation with the Howler platform team
   more than code right now.
3. Slack **inbound** (`/api/inbound/slack` + HMAC) so replies land in inbox
   threads — outbound is done; ingestion isn't. Slack module unit tests.
4. Status notices follow-ups: standalone `/status` page + history, real SMS
   recipient source, per-update throttling.
5. Chotu Links — still unscoped, needs confirmation.

## 6. Ops, roles & monetisation

**Where we are.** Roles ✅, Admin Users + audit log ✅, campaign billing/rate
cards ✅, Owl per-turn token/cost logging already in `owl_messages`.

**Next up:**
1. **Event task system / Playbook (5.1, EVENT_TASKS_SPEC)** — **the single
   biggest gap vs the North Star.** Zero code (`event_tasks`, `tasks.js`,
   TASKS_* permissions: all absent). It is brief layer 4, the readiness
   backbone, the AM cockpit, and the prerequisite for the Owl's `createTask`
   and the Ticketing-Manager skill. Spec has milestones M1–M4 ready.
2. **AI/API costs per client (5.3)** — most of the raw data now exists
   (`owl_messages` tokens/cost, `billing.js` rate machinery); needs
   per-entity aggregation across `insights.js` call sites + an admin report.
   ~1 day.
3. **Packages/tiers with feature gating (5.2)** — per-entity plan +
   `can(feature)`; unlocks commercial packaging. Pairs with 5.3.

## 7. Event Ops (new theme — didn't exist on 06-27)

**Where we are.** A whole module in five days: scanner (QR + OCR via live
camera), device pairing, per-staff permissions, checkpoints with mandatory
photos, coverage, map with drawer/resize/rotate, batch moves, date reports,
live chart, ops-only role, Owl can answer Event Ops questions.

**Next up:** driven by live-event usage feedback rather than a spec backlog —
capture next-ups after its first real event. (Candidates: offline resilience,
multi-event templates, alerts into the inbox on coverage gaps.)

## 8. Product board & the dev loop (new theme)

**Where we are.** Report → AI ticket → board (with Approved lane) → GitHub
issue → auto-dispatch to Claude → PR webhook auto-ships the ticket. Owl
`/report` conversational capture. This replaced the Jira-shaped bottleneck.

**Next up:**
1. Close the loop's leftovers: **GitHub issues #6 (em dashes — fixed in
   `649a5a7`) and #7 (ticketing system — shipped) can be closed.**
2. Ticket → release-note linkage (shipped ticket auto-feeds the daily release
   note; the pieces exist on both sides).
3. This is also where the **Ticketing-Manager Skill** (theme 1, item 3) would
   watch the board and chase stale tickets.

## 9. Goals & forecast

**Where we are.** P1 fully live (North Star, pace/result bands, resolver,
personal goals, templates, forecast blend, YoY compare, audit). Schema is
P2/P3-ready but dormant (`scope`, `rolls_up_to`, `conversion_ref` parsed,
unused).

**Next up (per GOALS_P2_P3_SPEC — "nothing here is built yet"):**
1. **P2 — campaign goals + contribution:** `scope='campaign'` linked to
   actions, generalised conversion checking, per-campaign contribution on
   reports. The attribution payoff, and the natural partner to the promo-code
   ROI thread (theme 4, item 4).
2. P3 — role goals + cascade into digests/briefings.
3. P4 — third-party sources (`social_paid` adapter) + sponsorship pipeline.

## 10. Experience OS spine (the North Star audit)

**Where we are.** Brief layers 1–3, 5, 6a: built and solid (spine, inbox,
must-ack announcements, email ingestion — ahead of "collect-only" with
settlement auto-reconcile — nudges, briefings).

**Still unbuilt, thinnest-first:**
1. **Layer 4 — Playbook/event tasks** (= theme 6 item 1).
2. **6b — Extraction-as-suggestions** (= theme 1 item 4).
3. **6c — Recall over the corpus** (= theme 1 item 5).
4. **Layer 7 — true channel ingestion** (Slack/WhatsApp conversations into
   the event corpus; today's modules are Owl chat surfaces, not ingestion).

---

## The shape of it

Two of the brief's three pillars — **Owl** and **Spine** — are substantially
real. The third, **Playbook** (event tasks + AM cockpit), is the one still at
zero, and it's the piece that three other threads are queued behind (Owl
`createTask`, Ticketing-Manager skill, Howler auto-verification). The other
recurring pattern: several features shipped their engine but not their
client-facing surface (release notes → What's New; social metrics → tiles;
journeys → stuck on a sandbox branch). Cheap, visible wins live there.

Hygiene: close PRs #1/#2 and issues #6/#7; update
`PRODUCT_OVERVIEW_SALES.md`; keep the wizard in step with new integrations.
