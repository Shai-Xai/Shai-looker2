# Pulse — Product Overview (Sales & Account Managers)

> **Audience:** Howler sales & account-management teams. Plain-language guide to
> what Pulse does and the value to pitch. For the technical/architecture view see
> `PROJECT_OVERVIEW.md`; for the vision see `docs/EXPERIENCE_OS_BRIEF.md`.
>
> **Last updated:** 2026-07-08 (🚀 Client onboarding journey: four layered phases with auto-detected progress + welcome pack & phase-milestone emails) · **Maintained:** updated as features ship (see the
> Changelog at the bottom). If a date here is stale, check the Changelog for the
> latest entry.
>
> **Status key:** ✅ Live · 🟡 Live, needs setup/connection · 🧪 Beta/limited ·
> 🔜 Coming soon (on the roadmap, not yet usable)

---

## The one-liner
**Pulse is Howler's Experience OS** — a white-label platform that turns an
organiser's data into **insight → action → results**: live dashboards, AI reads,
scheduled digests, a client↔Howler inbox, settlements, and a full email/SMS
**campaign engine** with audiences, automations and ad-platform sync. It's
**mobile-first**, **installable (PWA)**, and every client sees **only their own
data** (enforced server-side).

**Why it's different from Mailchimp/Klaviyo/Looker:** the audiences and campaigns
are powered by the **same governed data that drives the dashboards** — clients go
from *seeing* a cohort to *acting* on it in one place, scoped and branded to them.

---

## The continuous comms loop  ✅ (one-tap "Owl auto-pilot" ✅)
Pulse isn't a pile of separate tools — it's **one loop that never stops turning.**
Every part feeds the next, so insight becomes action and results become the next
insight:

1. **Live data lands** — ticketing, cashless and GA4 flow in continuously.
2. **The Owl reads it** — the home **briefing** and scheduled **digests** push the
   key updates *and* **what to do about them** (suggested actions, "worth a look"
   cards), tailored to each reader and role.
3. **You act** — turn a suggested action into a branded **email/SMS campaign** or
   an automated **drip** to the exact segment, in a click.
4. **Results come back as data** — opens, clicks, conversions and revenue are
   tracked per recipient and per journey step, and flow right back into the
   dashboards.
5. **The loop tightens** — those results shape the **next** briefing, digest and
   message, and the next suggested action. Every cycle is sharper than the last.

So there's a **constant flow of comms**: key updates pushed through digests, seen
on the briefing, acted on through campaigns, measured — and fed straight back into
the next read and the next action. **Insight → action → results → improvement, on
repeat.** And because it's an **installable web app (PWA) that receives push
notifications even when it's closed**, that flow reaches people on their phone
without them having to log in — a nudge lands, they tap, they're in the right
place to act.

> Pulse **surfaces** the insight + suggested action, **measures** the result —
> and now closes the loop with a single tap: the **agentic Owl auto-pilot** ✅
> drafts the campaign straight from a suggestion. The draft still rides the
> normal review + approval gates before anything sends.

**Pitch:** "It's not dashboards *and* email *and* reports — it's one living loop.
Your data tells you what to do, you do it in the same place, the result makes the
next call smarter — and it pings the client's phone to keep the loop moving. The
longer they use Pulse, the better it gets."

---

## 1. Dashboards & insight  ✅
- **Live dashboards** — KPIs, tables and charts built on the client's real
  ticketing/GA4 data. Howler builds the metrics; Pulse owns the whole interface
  (no clunky Looker embeds). Drill-through into detail.
- **One-tap LIVE button** ✅ — set any dashboard as an event's "live" report and a
  red **LIVE** button appears right on that event's sidebar row, jumping straight
  to live ticket sales with no drill-down. Great for event day. Configured per
  event in Admin → the client's Suites (also in the setup wizard).
- **Double-tap a chart to full-screen it** ✅ (mobile) — and carousels give charts
  a proper full-width, readable card on phones.
- **Per-tile AI insight** ✅ — tap any tile and the Owl explains what the numbers
  mean in plain English, and answers follow-up questions, grounded in that data.
- **Share an insight or a tile** ✅ — a Share button on any tile and on the Owl's
  insight/summary panels hands the finding off to **email, WhatsApp or Slack** in
  one tap, with room to add a personal note and a link back to the view.
- **Personalised home briefing** ✅ — each client lands on an AI-written summary of
  what matters right now (leads with ticketing/revenue), tailored to what they
  follow and view. **Tune** lets a reader point the Owl at exact dashboards/tiles,
  optionally scoped to a **lifecycle phase** (e.g. the gates board on Event Day —
  needs the event's key dates set so Pulse knows the phase); picked tiles always
  feed the briefing, and admins can **Diagnose** exactly why a pick did or didn't
  make a given briefing.
- **Mobile-first + installable** ✅ — works great on a phone, installs as an app.
- **Shared templates + per-client versions** ✅ — most dashboards are shared
  templates we maintain once for everyone. When a client needs something bespoke,
  staff can "Save as new" from that client's view to spin off a **client-owned
  version** (choosing its folder + set) that only they see — and edit it freely
  without touching anyone else. One click reverts it back to the template.

**Pitch:** "Your data, read for you — no digging. Open the app and you already
know what changed and what to do."

## Ask — your AI Data Analyst  🧪
A conversational **Data Analyst** (the Owl) clients open from anywhere in Pulse —
the floating **owl** (bottom-right) or the **Owl Data Analyst** button in the top
bar. Ask about your data in plain language ("what's on sale right now?", "how does
this compare to last year?") and get answers scoped to the client's own data.
- **Opens in-app** as a slide-in panel — **docked beside your dashboards** by
  default, or as an **overlay** (a toggle lets us A/B both with clients). Animated
  AI border, **text-size** control, full-screen, and "keep-warm" so re-opens are
  instant and the conversation persists.
- **Per-user / per-workspace** — each user maps to its Inventive workspace (set in
  **Admin → Users**); the workspace name + reference are configurable per client.
- **Status 🧪:** powered by **Inventive** — needs the API key + a per-client
  workspace set up. It's an embedded third-party tool, so in-app speed depends on
  Inventive's side (cookie/storage handling); we've optimised everything on ours.

**Pitch:** "Ask your data anything, in plain language — your own analyst, in-app."

### The Owl on WhatsApp  🧪
The same Owl, reachable from a customer's own **WhatsApp**. They message Howler's
WhatsApp number and chat to the Owl in plain language; it recognises the phone
number → its client and answers **only that client's data** (the same scope gate as
in-app). Replies are free-form (inside WhatsApp's 24-hour window) — no template
approval needed.
- **Charts as images** — ask to "show the trend" or "break it down by ticket type"
  and the Owl renders the chart and sends it as an **image** in the chat.
- **Tappable follow-ups** — each answer offers 2–3 suggested next questions as
  **reply buttons** (or a numbered list to reply to), so customers can drill in
  without typing.
- **Scheduled updates (digest / goals / alerts)** — a customer can be subscribed
  to a daily WhatsApp update. The **digest** reuses the client’s **configured email
  digest** (same role lens / focus / source) when one is set up, condensed for a chat
  bubble — and falls back to a lightweight Owl summary when there’s no digest yet.
  To respect WhatsApp’s rules, it’s sent free-form only while the customer is inside
  their **24-hour window** (they messaged the Owl in the last day); reaching everyone
  on a fixed schedule regardless will use an approved WhatsApp template (next step).
- **Team broadcast lists** — subscribe a **list of team numbers** to one client’s daily
  update (the numbers don’t need Pulse accounts). WhatsApp groups aren’t possible via the
  API, so this fans the same update out 1-to-1 to everyone on the list — same 24-hour-window
  rule per number. Managed in Admin → WhatsApp Owl.
- **Take action by reply button** — the Owl can **set up an alert** ("tell me when
  tickets hit 1000"), **save a segment**, or **draft an email/SMS campaign** straight
  from WhatsApp. It works like a campaign manager (asks the few setup questions it needs,
  same as in-app), drafts it, then sends a **✅ Confirm** button (event-choice buttons
  for an alert that could watch several events). Tapping commits through the same
  permission checks as the app. A drafted campaign is a **draft only** — the customer
  still reviews, approves and **sends it in the Pulse app (Engage)**; the Owl never sends
  to buyers from WhatsApp.
- **Status 🧪:** pilot. Howler links each phone number to its client in **Admin →
  WhatsApp Owl**, where a live activity log shows inbound messages end-to-end.

### The Owl in the Howler organizer portal  🧪
The same Owl, embedded **inside Howler's own organizer portal** — organizers ask
about their ticket sales without leaving the back end they already use every day.
- **No extra login** — the portal signs the organizer in behind the scenes
  (server-to-server handshake); their first question auto-creates their Pulse
  identity, so saved chats and Owl memory carry across sessions.
- **Same answers, same safety** — it's the identical Owl brain and the identical
  server-side scope gate: an organizer sees **only their own organization's data**,
  with charts, follow-up chips and saved threads, in a panel that works great on
  mobile.
- **Status 🧪:** pilot. Works today for organizations that exist as Pulse clients —
  Howler links each Howler organization to its Pulse client in **Admin → AI →
  Organizer portal Owl** and hands the portal team a one-iframe embed
  (`docs/OWL_EMBED.md`). When the Howler→Pulse data integration ships, the same
  embed lights up for every self-service organizer automatically.

**Pitch:** "The analyst comes to where organizers already work — Howler's portal
gets an AI data analyst pane, powered by Pulse."

### The Owl reads your Google Drive  🟡 (needs connection)
Share the files your event actually runs on — **budgets, marketing plans, sponsor
decks, contracts, settlement sheets** — and the Owl answers questions from them
alongside your live ticketing data ("what does the budget allow for stage hire, and
what have we sold so far?").
- **Explicit and safe:** you share specific files or folders with a dedicated
  Google account (like sharing with a colleague) and paste the link into
  **Settings → Integrations → Google Drive**. The Owl sees exactly those files —
  never your whole Drive — and only your own team can ask about them.
- **Every format does the right thing:** Google **Sheets and CSVs** become live
  tables the Owl can filter and total; **Docs, Slides and PDFs** become searchable
  text it quotes **by document name** (PDFs are transcribed by AI).
- **Folders stay in sync:** share a folder and new or updated files are picked up
  automatically every hour; remove a file from the folder and the Owl forgets it.
- Manageable by the client (Settings → Integrations) **and** by Howler on their
  behalf (Admin → client → Integrations) — the dual-surface rule.
- **Status 🟡:** needs a one-time Google service-account key (platform-wide or
  per client), then it's self-service.

**Pitch:** "The Owl doesn't just know your ticket sales — share your budget or
marketing plan and it reads those too."

### The Fan Owl — a booking guide on the event's own website  🧪
The Owl's first **consumer-facing** surface: a widget the promoter drops onto their
public event website with **one script tag**, where it guides fans to the right
ticket like a well-informed friend who's already going.
- **Knows the page the fan is on** — on an artist page it leads with the ticket
  that gets you to that artist; on the tickets page, the best options; plus a
  no-AI "ribbon" teaser (offer + live availability tag) on every page.
- **Answers like the organiser would** — FAQs, refund policy, what's included:
  answered ONLY from the knowledge base the promoter writes (never invented), with
  prices only ever from the configured catalogue. Urgency only from real
  availability tags — no fake scarcity, ever.
- **Sells with a buy button** — the Owl hands out the promoter's own Howler
  checkout links (with tracking added), so every recommendation is one tap from
  the official store. Purchases stay on Howler.
- **Builds the promoter's fan base** — fans can opt in ("keep me posted") with an
  explicit consent checkbox; captured names/emails/interests appear under the Fan
  Owl config, ready for remarketing via Engage. Plus a live funnel (ribbon views →
  chats → buy clicks) and a list of what fans asked that the FAQ couldn't answer.
- **Self-service** — clients manage everything themselves under **Settings → Fan
  Owl** (sites, catalogue, knowledge, page mappings); Howler can do it for them in
  Admin → client → Fan Owl.
- **Status 🧪:** beta. Deep-link checkout (in-widget checkout is on the roadmap);
  catalogue and links are entered manually for now. Pilots: Retreat Yourself,
  then Kappa Futur Festival (`docs/specs/FAN_OWL_SPEC.md`).

**Pitch:** "Your website stays the story; the Owl turns it into the shop — every
page gets a personal ticket guide that answers, recommends and sells."

### Skills — autonomous specialists (Ticketing Manager · Chief of Operations)  🧪
Self-running specialists that review a client's event on a schedule and write
grounded advice — the Owl's "push" door. Two hires so far: the **Chief of
Operations 🎪** debriefs how the event day *ran* — gates & entry flow, bars &
cashless spend, devices & stations — from whatever operational sources are
connected, and says what to change for the next one. The **Ticketing
Manager 🎟️**: every morning it checks the event's goals, pace and forecast,
digs into per-tier sales for the *why*, and writes a short review (headline →
status → flags → concrete recommendations) into the run log.
- **Advise-only by design** — a skill reads through the same scoped, fail-closed
  data gate as everything else and **cannot send, change prices or touch money**;
  every recommendation is for a human. Instances start **paused** (shadow mode).
- **Trainable** — each skill has a playbook (platform default + per-client
  additions, all visible in the Admin → AI audit), and every run can be graded
  👍/👎 with a note by the AM: the induction loop from `docs/SKILLS_BRIEF.md`.
- **Backtestable** — freeze a *finished* event at N days out and let the skill
  write the advice it *would* have given (it physically cannot read data past
  the freeze date), then mark its homework against what actually happened.
- **Status 🧪:** internal/dogfood — the runtime, backtest + grading loop shipped;
  admin UI, briefing delivery and client surfaces are next. Not client-visible yet.

**Pitch (when it graduates):** "Pulse stops being a dashboard you check and
becomes a team of specialists that check it for you — and tap you on the
shoulder when it's worth your time."

## 2. Scheduled digests  ✅
- Automated **email digests** (e.g. morning briefing) written for a **named role**
  (exec / marketing / finance / ops), with headline KPIs, a short narrative and
  suggested actions.
- Configurable cadence and focus; dates are anchored to the **send day**.
- **Content modes:** *AI-led* (the analyst picks the story) or *curated* (pick the
  exact tiles). Either way you can also **include saved tiles** — the tiles a client
  has 📌 pinned or ⭐ followed, chosen from a checklist — and optionally render them
  right in the email: **chart tiles as a graph image, single-value tiles as a
  metric chip**.
- **Dual-surface:** Howler can set these up for a client, and clients can manage
  their own.

**Pitch:** "A sharp, role-specific briefing in their inbox on schedule — they stay
on top of the event without logging in."

## 2b. Ask the Owl about Pulse itself (product help)  🧪
- The **same Owl chat** now also answers questions about **Pulse itself** — *how
  do I do this*, *what's new*, *what can I do with my access* — alongside its
  usual data answers. One door for everything; the Owl routes the question.
- **Only released features, ever:** answers are grounded strictly in Howler's
  curated help knowledge plus **published release notes** — drafts and unshipped
  work can never surface. If it isn't published, the Owl doesn't know it.
- **Tailored to the user:** answers respect their **role** (won't walk a Viewer
  through something only an Owner can do), their **tenant setup** and their
  **current event** — e.g. it won't pitch cashless features to a non-cashless
  event.
- **"What's new"** pulls the latest, correctly-dated published release notes; a
  ✨ starter pill on the Owl chat asks it in one tap.
- **Deep-links** the user straight to the right screen ("open Engage →
  Campaigns"), and **declines gracefully** when the answer isn't in its knowledge
  — it never invents behaviour.
- **Curated & versioned:** Howler staff maintain the knowledge in **Admin →
  Product → 💬 Help knowledge** (add/edit/publish articles, tag them by role +
  required feature, set deep-links, toggle product help on/off) — **no deploy
  needed**. The Owl chat itself is the client's self-service surface.

**Pitch:** "Ask the Owl anything — your numbers or the product. It already knows
who you are and what your account can do, and it only ever describes features
that have actually shipped."

## 3. Messaging inbox (client ↔ Howler)  ✅
- A two-way **inbox** anchored to the client: threads, read/unread, attachments,
  and **must-acknowledge** messages for things that need sign-off.
- **Notifications** via in-app toast, **web push** (even when Pulse is closed) and
  email.

**Pitch:** "Stop chasing over WhatsApp/email — important notes, approvals and
receipts live in one place with a clear read/ack trail."

## 4. Settlements & documents  ✅
- Upload a **settlement PDF** → Pulse extracts it into a clean, interactive
  statement the client can read; plus an event **documents** area.
- **Owl auto-ingest** 🧪 — **CC the Owl** on the settlement/invoice email you
  already send the client, and Pulse files it for you: it reads the PDF, checks
  the totals add up, and **publishes the settlement to the client automatically**
  (from trusted Howler senders). If the numbers don't reconcile it's held as a
  draft for a quick human review — never published unchecked. No manual upload.

**Pitch:** "Settlements clients can actually read, not a PDF buried in email —
and now they file themselves: just CC the Owl."

## 5. Engage — the campaign engine
The "action" half of Pulse. Turn any audience into branded email/SMS outreach,
with approvals and full tracking.

### 5a. Segments (reusable audiences)  ✅
- Build a **named, always-live audience** from: a **dashboard tile** (+ filters),
  an **uploaded CSV/Excel**, a **pasted list**, or a **linked Google Sheet** (read
  live each time).
- **Column matching** ✅ — pin which column is email / name / mobile (auto-detect
  by default).
- **Target on any column** ✅ — filter by ticket type, city, age, gender, status,
  etc. (with each column's values).
- **Multi-source combine** ✅ — **Union** (anyone in any source), **Intersect**
  (in all), or **Exclude** (in A but not B — e.g. "abandoned cart **minus** an
  uploaded 'already called' list"). Each source keeps its own filters.
- **Always-live** — segments re-resolve at use/send time, so a linked Sheet stays
  current; counts and email/SMS reach show up front.
- **Organise + scope to an event** ✅ — **link a segment to an event** and/or **file
  it in a folder**, then filter the list by either. Keeps a long list tidy as it grows
  (e.g. all the audiences for one festival together). Linking to an event also **scopes
  the audience to that event** — the cohort resolves to that event only, every time
  (reach checks *and* when a campaign sends from it), never silently widening across all
  your events.

**Pitch:** "Build the exact audience from your own data or a spreadsheet — combine
lists, subtract a suppression list, and it stays live."

### 5b. Campaigns — email & SMS  ✅
- Send **email, SMS, or both** to a segment, tile or pasted list.
- **AI-drafted copy** you can edit; branded template, **drag-to-order block builder**, or custom HTML; hero image.
- **Email block builder** ✅ (🧪 new) — a Mailchimp-style content builder: stack **heading, text, list, quote, image, button, video, social, menu-links, HTML and spacer/divider** blocks plus **multi-column layouts (up to 4, side-by-side on desktop, auto-stacking on mobile)**. **Drag to reorder** (↑/↓ on touch), edit inline, delete. Everything is wrapped in the client's branding (logo, colours, unsubscribe) automatically; button/image/menu links are tracked; merge tokens work in text. Built emails can be **saved as reusable templates**.
- **AI email design** ✅ (🧪 new) — the Owl helps *design*, not just write:
  **(1) Full designed emails** — when the Owl drafts a campaign it now builds a complete
  **themed, multi-block layout** (heading, copy, list/quote, columns, a button) — the same
  building blocks a human uses — and lands it in the builder to tweak. **(2) Themes** —
  pick a look (Clean / Bold / Warm / Minimal) with optional accent, font and button shape;
  the whole email restyles instantly (accent defaults to the client's brand colour).
  **(3) AI banners** — on any image block, tap **✨ Design with AI**, describe the banner
  ("sunset festival, headline *Last chance*"), and the Owl draws an on-brand banner that
  drops straight in. All stay fully editable and brand-safe.
- **Merge fields** ✅ — personalise with `{{name}}`, `{{ticketType}}`, and **any
  column** from the audience (`{{City}}`, `{{Ticket Type}}`…). Preview renders with
  a real sample recipient.
- **Promo / discount codes** ✅ — generic or unique-per-person codes; a promo code
  rides the buy link (`?promo=CODE`, placed before UTM params); discount codes
  shown for manual entry.
- **UTM tracking** ✅ and per-recipient **click + open tracking** ✅.
- **Consent-aware (POPIA)** ✅ — per-channel marketing consent is surfaced at
  preview and enforced at send; one-click unsubscribe; a transactional override
  for genuinely non-marketing messages.
- **Approval workflow** ✅ — nothing sends without explicit approval; route to
  named client approvers, a **specific Howler team member on the account**, or the
  generic "Howler" slot (any Howler member linked to the client) — notified via
  inbox/push/email.
- **Send caps (cost safety)** ✅ — a per-client **audience cap** limits how many
  recipients one campaign can reach, and a tighter **SMS sub-cap** stops a large
  email send from accidentally firing an equally-large (costly) SMS blast (set it
  to **0** to switch SMS off for a client entirely). Howler-admin only — the
  capped SMS number is shown honestly in the audience preview and to the Owl.

**Pitch:** "Personalised, on-brand email + SMS to a precise audience — with
approval gates and real tracking, all from the same data."

### 5c. Drip sequences (automations)  ✅
- Multi-step **journeys** (e.g. abandoned-cart recovery): timed steps with their
  own copy, promo and delays.
- **Two timing modes** ✅ (a setup toggle):
  - **From abandonment · fresh only** — times each step from the person's
    abandonment moment; only enrols people who abandoned within a window (e.g.
    48h). True real-time abandoned-cart.
  - **Forward from send · whole list** — runs the drip forward from enrolment
    (step 1 now, then 2h, 4h…); ideal for an existing/old list.
- **Auto-stop** ✅ — anyone who buys (leaves the audience) or unsubscribes drops
  out of the journey automatically.
- **Journey waterfall** ✅ — per-step **received, opened %, clicked %, converted**,
  plus a **drop-off** indicator between steps.

**Pitch:** "Set up an automated recovery sequence once — it catches new abandoners
in real time (or works an old list), stops when they buy, and shows you exactly
where people open, click and convert."

### 5d. Audience sync to ad platforms  🟡 (needs connection)
- Push a **segment to Meta (Facebook/Instagram)** or **TikTok** as a **Custom
  Audience** for ad targeting or exclusion.
- **Mirrors membership** (people who leave the segment are removed on next sync),
  with optional **daily auto-sync**.
- **Privacy-safe** — emails/phones are **hashed before they leave Pulse**.
- **Ad audiences hub** (Engage → Ad audiences) ✅ — a client-facing, self-service
  view of **every audience Pulse mirrors out**: connection health, **live match
  size / availability** read back from the platform, last-sync detail, and a link
  straight into Meta/TikTok. (The same roll-up exists for Howler staff in Admin →
  connector health.)
- Requires connecting the client's ad account (access token + ad account) in
  Integrations. *TikTok push verified end-to-end against a live ad account; Meta
  push pending the same live check.*

**Pitch:** "Turn a Pulse audience into a Meta/TikTok ad audience in a click — keep
it auto-synced, exclude people who already bought, and see exactly what's live on
each platform without leaving Pulse."

### 5e. Social metrics — organic performance  🟡 (needs connection) · 🧪
- Pulls a client's **organic social stats into Pulse** — the read direction, the
  opposite of audience sync. Covers **Facebook Pages, Instagram (Business/Creator)
  and TikTok**.
- **Two grains:** account-level (followers, reach, impressions, profile views) as
  a **daily trend**, and **per-post** stats (reach, likes, comments, shares, saves,
  video views) ranked by engagement.
- **Social page** (client self-service + admin, mobile-first) ✅ — connected
  accounts at a glance, a 30-day trend with a metric switcher, and **top posts**;
  one-tap **Refresh now**, otherwise it syncs **daily** in the background.
- Reuses the client's existing **Meta / TikTok connection** — just add the
  **Facebook Page ID** / **Instagram account ID** in Integrations (TikTok needs the
  token's user scopes). Secrets stay write-only.
- *Connectors are built and unit-tested, but the live Graph / Display API calls are
  pending an end-to-end check against real accounts (no test credentials yet).*
- 🔜 **Next:** surface these metrics as **dashboard tiles** alongside Looker data.

**Pitch:** "See how a client's Facebook, Instagram and TikTok are really doing —
followers, reach and the posts that landed — next to their ticketing numbers, all
in one place that updates itself."

### 5f. Paid ads performance — Meta  🟡 (needs connection)
Your Meta (Facebook/Instagram) **ad spend and results, inside Pulse** — pulled
daily from the same ad account you already connected for audience sync (nothing
new to set up).
- **What you see** (Social page → Paid ads): spend, clicks, purchases and purchase
  value per campaign, with **CPC, cost-per-purchase and ROAS** worked out for you —
  plus a Sync-now button; it also refreshes automatically once a day.
- **Ask the Owl:** "how are my ads doing?", "what did we spend this month?",
  "which campaign converts best?" — the Owl reads the same numbers and answers in
  plain language, honest about what's Meta-attributed vs actual ticket sales.
- **Closes the loop:** push a segment to Meta as a Custom Audience (5d), run the
  ads, and see what they returned — all in one place.
- **Status 🟡:** needs the Meta token + ad account (the audience-sync connection);
  purchase value requires the client's Meta pixel to track purchases.

**Pitch:** "Your ad account and your ticket data finally in one place — see the
spend, the return, and ask the Owl which campaign is worth more budget."

### 5g. Deep links into the Howler app  🟡 (needs connection)
Short, branded **`howler.chottu.link` URLs** that open the right place in the
Howler app (tickets, lineup, map, chat…) — created **from Pulse** instead of
one-by-one in the ChottuLink dashboard.
- **Engage → Links** — clients create and manage their own links: name it, pick
  the event, paste the destination, done. Each link is **tied to a Pulse event**
  and shows its **click counts** (total / 7 / 30 days).
- **Grouped by category** ✅ — the Links landing shows **category tiles** (link +
  click counts per tile); tap one to drill into just that category's links, with a
  clear **← All categories** back link. Every link starts in the **App** category
  (they open the Howler app); file links under your own categories ("Socials",
  "Website"…) from the link editor. Mobile-first: big tap targets, stacking tiles.
- **UTM tags & app behaviour** built in — every link can carry campaign tags and
  choose app-vs-browser opening per platform.
- **Import (pick & choose)** — the import screen lists everything on the
  ChottuLink account, flagged new / already in Pulse / previously deleted; tick
  the ones to bring in and optionally attach them to an event in the same step.
- **Delete** — removing a link takes it out of Pulse *and* switches it off in
  ChottuLink (their API has no true delete), so the short URL stops redirecting;
  re-imports won't resurrect it unless you pick it on purpose.
- **Admin surface** — same tools per client under Admin → client → 🔗 Deep links;
  the connection (API key + domain) layers platform-default → per-client override.
- **⚡ Templates — every link in one click** ✅ — pick a template, pick the event,
  paste the event page URL, done: the whole standard set (main + ticket wallet +
  lineup + map + event feed + chat) is created in one go, named and tagged per
  event automatically. Preview first (untick / tweak paths inline, collisions
  flagged); anything that fails can be retried individually. A Howler-managed
  starter template ships built in; clients can save their own sets too.
- **📈 Click trends & source split** ✅ — Pulse snapshots every link's clicks
  nightly and charts **clicks per day** per event, plus a **by-source** split
  (instagram vs whatsapp vs email…) from the links' UTM tags — history
  ChottuLink's own API doesn't offer. Tap 📈 on any event's link card.
- **🦉 Owl does links too** ✅ — ask the Owl "make me a tickets link for the
  Instagram bio" or "set up the standard links for this event"; it drafts the
  link(s) with tags + preview and you confirm with one tap. Draft-only, same
  permissions as doing it by hand.
- **✨ AI autofill** ✅ — one tap fills a link's UTM tags and social share
  preview from its name, destination and event, matching the client's existing
  tag conventions.
- **Status 🟡:** needs the ChottuLink API key + domain (Howler's platform account
  covers all clients by default).

**Pitch:** "Every link your event needs — created in one click from Pulse, tracked
per event, and ready to drop into posts, bios, emails and QR codes."
### 5h. Pulse Pixel — website retargeting  🧪 (new)
- **One snippet, all pixels.** Install a single Pulse script tag on the client's
  website or ticket shop and it loads their **Meta Pixel, Google tag and TikTok
  Pixel** for them — configured (and changeable later) entirely inside Pulse, so
  the site never needs touching again.
- **Remarketing lists build automatically** in each ad platform from its own
  pixel: all visitors, ticket-page viewers, checkout abandoners, purchasers.
- **One-click standard audiences** — Pulse creates the standard retargeting
  audience pack (visitors 180d/30d · viewed tickets 30d · checkout abandoners 14d
  · purchasers 180d) directly in the client's **Meta** and **TikTok** ad accounts
  via their connected APIs. (Google's audience definitions are a guided one-time
  manual step — no self-serve API — the tag itself is fully automatic.)
- **Install check built in** — every event also beacons back to Pulse, so admin
  and the client can see "✓ receiving events" the moment the snippet is live
  (and Pulse builds a first-party behaviour log for future segments).
- **Consent-aware** — a GDPR mode holds all pixels off until the site's cookie
  banner grants consent.
- Dual-surface: Howler configures it in Admin → client → Integrations; clients
  self-serve in Settings → Integrations. *Meta/TikTok audience-pack API calls not
  yet exercised against live ad accounts (same caveat as audience sync).*

**Pitch:** "Add one line to your website and your retargeting is done — every ad
pixel managed from Pulse, and the standard remarketing audiences created in your
Meta and TikTok accounts in one click. Change pixels any time without a developer."

## 6. White-label branding & integrations  ✅ / 🟡
- **Per-client branding** ✅ — logo, colours, email sender display name and
  wording. Emails look like the client — sent from Howler's verified domain by
  default, or from the client's OWN domain once verified (✅ custom sending
  domain: set it in Admin → client → Settings or the client's Settings → Email;
  add the DNS records, verify, done — sends fall back safely until verified).
  Every logo/icon/image upload now shows **clear spec guidance** (format, size,
  transparency) right under the picker, on both the admin and client surfaces —
  so the assets we get back are the right shape first time.
- **Vanity login page** ✅ — give a client their own white-labelled sign-in URL
  (e.g. `…/kunye`) with their logo, colours and a full-screen background image, so
  signing in feels like *their* product. Set by Howler in **Admin → the client →
  Settings** (a unique slug + background); an unknown URL just shows the standard
  login. Only non-secret branding is exposed publicly.
- **Reporting currency** ✅ — Howler sets the currency a client reports in (ZAR by
  default), in **Admin → the client → Settings**. It flows to every Pulse-written
  touch point: AI **insights**, the home **briefing**, **goals**, **alerts** and
  **digests** all show and talk about money in that currency. *(Set by Howler, not the
  client; dashboard tile values keep the format from their data source; this is not the
  messaging-cost/billing currency, which stays separate.)*
- **AI copy language** ✅ — Howler sets the language the **AI writes in** for a
  client (English by default), in **Admin → the client → Settings**. Every
  Pulse-written touch point then speaks it: AI **insights**, the home **briefing**,
  **goals** & **alert** reads, **digests**, **campaign copy**, and the **Owl** (in-app
  + WhatsApp). Pick from English, Afrikaans, the SA official languages, and the common
  international ones. **Per-campaign override:** any single email/SMS campaign (and the
  Owl when it drafts one) can pick its **own** language, overriding the client default —
  so a multi-language client can send one audience in French and another in English from
  the same client. *(Steers AI-generated wording only — the app's own buttons and labels
  stay in English; a full UI translation is a separate, larger project. Set by Howler,
  not the client.)*
- **Dark-mode logo** ✅ (dual-surface) — an optional second logo for dark mode.
  If a client's logo is a dark/black mark it can vanish on the dark header, so
  they (or we) can upload a light version that's used automatically in dark mode.
  Leave it blank and Pulse shows the normal logo on a subtle light chip so it
  always stays legible. Emails always use the main logo.
- **Integrations** (dual-surface: Howler-managed *and* client self-service):
  - **Looker** / **Anthropic (AI)** keys ✅ (fall back to Howler defaults)
  - **Email (Resend)** ✅, **SMS (Clickatell)** ✅
  - **Meta / TikTok** ad accounts 🟡
  - **Slack** 🟡 — mirror inbox notifications into a client's Slack channel
    (outbound; connect with an Incoming Webhook or a bot token + channel)
  - **Inventive** — the embedded AI **Data Analyst** 🧪 (see "Ask" above)
- **Secrets are write-only** — Pulse shows only whether a value is set, never the
  value.
- **Each integration is locked by default** ✅ — a 🔒 guard so a working connection
  can't be changed by accident; an admin or the account **Owner** unlocks to edit,
  then re-locks. Setup steps ("How to get your Meta/TikTok details") stay readable
  even while locked.
- **One-tap connect** ✅ — when an ad platform isn't linked, the **Ad audiences** hub
  shows a **Connect Meta/TikTok →** button that drops the client straight into the
  right Settings page.
- **Your Howler Support** ✅ — every client sees their Howler contact(s) — name, job
  title and an email link — under **Settings → Team**. Howler assigns/repoints them
  per client.

**Pitch:** "It's their brand, their accounts, their data — Howler just powers it."

## 7. Admin console (Howler internal)  ✅
- Manage **clients**, their **dashboards/sets/suites**, the **tile library**, **AI
  instructions**, **integrations**, **settlements**, **logins/roles**, backups.
- **Per-client suite control** — pick which **sets** (grouped by folder) and which
  **individual dashboards** a client gets, and **lock filters per dashboard** for that
  client (e.g. pin one dashboard to a specific event) on top of the suite-wide locks.
- **Preview as a client** to see exactly what they see.
- **AI audit** — every system prompt the AI is given is viewable ("Everything the
  AI is told").
- **Product collateral you control** ✅ — Admin → Product holds the living **feature
  matrix** and this overview, plus a shareable public **sales site** (`/sales`) built
  from them. Every matrix section/feature and every section of this page has a
  **Shown / Hidden toggle**, so anything still in the works (or not ready for
  internal announcement) stays off the public pages until it's ready — admins
  always see the full picture, dimmed.

## 8. Trust, security & scope  ✅
- **Multi-tenant, server-side scoping** — every data query is force-filtered to
  the client's organiser/events on the server; it **can't be bypassed** and **fails
  closed** if no scope is set. One client can never see another's data or audiences.
- **POPIA-minded** — per-channel consent, unsubscribe, hashed identities for ad
  sync, no cross-client data pooling.
- **Roles & permissions** — granular control over who can view/approve/send.

---

## 9. Goals — track the results that matter  🧪
The **Results** half of Pulse: set a target on the numbers that matter for an
event and track them live. Each event has a **North Star** (the one headline
goal) plus secondary goals, shown on the client's home with a **progress bar and
a pace read** — *ahead / on track / behind* — not just "are we there yet."
- **Set a goal in two taps** — pick a number you already see on a **dashboard
  tile** (it then tracks **live**, always matching the dashboard), or **enter it
  yourself** for things not on a dashboard yet (sponsorship secured, a cash target).
- **Pace, not just percent** — with a deadline, each goal reads ahead/on-track/
  behind; at event close it lands a **result band** (smashed / hit / just missed /
  missed). Pace is read off **last event's real sell-curve** (days-before-event), so a
  back-loaded goal isn't cried "behind" too early.
- **vs last time + forecast on the card** — each goal shows **how it's tracking vs the
  same point last event** (e.g. +35%) and a **projected final landing** (on track to
  hit / how far short), both from the linked curve.
- **Sell-curve & forecast chart** — open a curve-linked goal to see **last time, your
  actual to date, and a forecast line you can follow** — the forecast hugs last event's
  remaining shape (not a flat guess) to where it'll land, with the target and a "you are
  here" marker.
- **Weekly goal nudge** — one calm **"your goals this week"** push (not per-event spam),
  summarising what **needs attention** (behind pace · forecast short · checkpoint missed)
  plus **wins** (reached). Howler staff can fire a **test nudge** to preview it.
- **Goal types** — *hit a target* (≥), *stay under a cap* (≤), a **healthy range** (a
  band like *returning 30–38%*): in-band reads **On target**, drifting **above the band is
  flagged** (⚠ Above range) rather than falsely "reached" — for ratio metrics where too
  far over is also wrong; or a **mix / split** goal.
- **Mix / split goals (compositions)** — track shares of a 100% whole that move together:
  **New vs Returning**, **age bands**, local/international, ticket tiers, channels. Source the
  slices from **one breakdown tile** *or* **a separate tile per slice** (with the live tile
  number shown as you pick), set each slice's target share, and the goal shows the actual
  split as a **stacked bar, donut or dial** (with target-boundary markers) — **✓ Balanced**
  when every slice sits in its band, **⚠ Mix drifting** when one slips (e.g. Returning
  creeping up while New starves). Add an optional **last-year tile per slice** to show the
  **movement** (▲/▼ pp vs last year), and mark a **focus slice** to grow.
- **Range goals read the real %** — when a healthy-range goal drifts above its band, the
  dial/ring shows how far over (e.g. **105%**) instead of a flat 100%, so over-shooting is
  obvious at a glance.
- **Compare to last time, your way** — baseline from a past event, a **picked dashboard
  tile** (e.g. a last-year total, remembered + re-read live), or a typed number; one-tap
  **Match / +10% / +15% / +20%** target helpers.
- **Checkpoints from last time's shape** — suggest weekly/monthly checkpoints scaled to
  your target, on the same days-before-event math as the live pace.
- **Reusable goal templates** — save a goal's whole setup (metric/curve tile, target, unit,
  comparison year, cadence) as a template, then start new goals from it in one tap — ideal
  for recurring monthly/quarterly targets. Set the fresh dates and go. Templates carry the
  **dashboard name + tile** (the key components). **Howler can also publish 🌐 global
  templates** to **every client** — they re-link to each client's matching dashboard/tile
  **by name**, so standardised dashboards wire up automatically.
- **Tag goals by area** — tag a goal with an operational area (**Ticketing, Cashless,
  Access control, Audience, Marketing…** or your own), and the Goals page groups them into
  **one row per tag** so a busy event reads as tidy sections instead of one long grid.
  **Create your own categories** too — type a new one and save it; it's remembered and
  reusable across **both goals and alerts** for that client.
- **Drag to reorder** — arrange goal tiles on the Goals page; the order carries to the
  home dashboard.
- **Dual-surface** — clients set their own goals; Howler can set them on a client's
  behalf. Edits are lightly logged.

**Pitch:** "Tell Pulse what success looks like, and every screen shows how you're
tracking against it, how it compares to last time, and where you'll land."
*Coming next: the North Star leads the morning briefing in one line.*

---

## 10. Alerts — get told the moment a number matters  🧪
The **Action** trigger of Pulse: instead of checking dashboards, a client sets an
**alert on a metric** and Pulse watches it for them, pinging the team the second it
crosses — a sell-out, a revenue milestone, stock running low. Built on the same
governed, per-client data as the dashboards, so an alert can only ever watch *that
client's* numbers.
- **Point it at a number you already see** — pick a single-value (KPI) tile (tickets
  sold, revenue, tickets remaining, a category total) and the alert watches that
  **live** number, always matching the dashboard.
- **Or build a metric, no tile needed** 🆕 — pick a **measure** (tickets sold, revenue)
  and **filter it** by a dimension like **Ticket Type** or **Category** (e.g. "tickets
  sold where Ticket Type = VIP"), choosing the value from a real list. Great for slices
  that aren't on a dashboard. It only offers data sources the client already uses, and
  every read stays scoped to that client + event.
- **Three ready-made types** — **🎉 Sold out** (hits zero), **⚠️ Low stock** (drops
  below a number you set), and **📈 Crosses a number** (rises to / drops to a value),
  with a **template gallery** so setup is a tap and one number.
- **Choose how you're told** — it always lands in the **Pulse inbox**; add **📱 push**,
  **✉️ email** and **💬 SMS** on top. Important alerts can be flagged to **always reach
  you**.
- **No spam, by design** — fires on the **cross** (not every check), with a **cooldown**
  so a busy on-sale can't buzz a phone repeatedly, **quiet hours** that hold non-urgent
  alerts overnight, and a **once / every-time** choice. Each alert keeps a **history** of
  when it fired and at what value.
- **Plain-English** — every rule reads back as a sentence ("When VIP remaining drops
  below 100, notify me via inbox, push and SMS — once"), and a **Test** button shows
  exactly what will land.
- **Tag alerts by area** 🆕 — tag an alert with an operational area (**Ticketing, Cashless,
  Access control, Audience…** or your own); the Alerts page groups them into **one row per
  tag**, so a long watch-list reads as tidy sections. **Custom categories you create are
  shared with goals** — make one once, use it in both.
- **Dual-surface** — clients set their own alerts; Howler can set them on a client's
  behalf during onboarding so the first week already feels proactive.
- **Live Pulse strip** 🧪 — a glanceable, colour-coded **beat in the top header**
  (desktop) that streams what's happening right now: **alert fires** *and* **live
  momentum** off the client's key tiles ("+142 Tickets sold in the last hour", "+R8 500
  Gross revenue"). Rotates one at a time, newest first, and taps through to Alerts. The
  product, literally beating. *(Desktop for now; urgent alerts already reach the phone
  via push. Momentum auto-picks key tiles today; hand-picking comes later.)*

- **⚡ Live updates (event-day mini report)** 🧪 — a second tab on the Alerts page for
  **during the event**: instead of one threshold, Pulse sends the team a **compact
  multi-metric snapshot every 15–120 minutes while the event runs** — people through
  the gates with the **+change since the last update** and the **pace per hour**, bar
  revenue, a **top-3 bars/vendors** list read off any breakdown tile, and (for Event
  Ops clients) **device health** (deployed devices + open issues). A block can also
  show **"% of last year — by this point"**: a true **like-for-like** comparison that
  cuts the past event to the **same day of the event at the same clock time** (fair
  whether the event is one day or five; a "final number" mode is there too). Press
  **Go live** when doors
  open (or set a start/end window and it runs itself); it lands in the **inbox** (the
  whole night in one thread) plus **app push, email, SMS** and **WhatsApp** — WhatsApp
  reaches anyone who's messaged the Owl in the last 24h (WhatsApp's own service-window
  rule; others are skipped, the rest still deliver). The **Owl can set one up from
  chat** ("update me every 30 minutes on event night") with the usual confirm-before-
  create card.

**Pitch:** "Stop watching dashboards — tell Pulse the number that matters and it taps
you on the shoulder the moment it happens, on whatever screen you're on. And on event
night, it becomes your control room in your pocket — a mini report every half hour."
*Checked every few minutes (data refreshes on the ~30-min pipeline). Coming next:
sales-surge/stall detection, AI-written alert messages, and one-tap actions from the
alert itself.*

> **Not to be confused with Status notices (below).** Alerts watch *data* and fire
> automatically; Status notices are *Howler telling clients about a platform issue*.

---

## 11. Status notices — keep clients in the loop on platform issues  ✅
When something's up with the platform — dashboards loading slowly, a planned
maintenance window, an outage — Howler can **post a status notice** and every
affected client sees it in their app, no support tickets needed. It's a proper
status-page-style incident: post it, **update it** as you learn more, and **mark it
resolved**.
- **Company-wide or specific clients** — set a notice **across all clients** (a
  platform-wide issue) or aim it at **one or several specific clients** (only those
  on a given integration, say).
- **A living timeline** — the opening post, every update ("we've identified the
  cause", "a fix is rolling out") and the resolution stack into one **timeline** the
  client can expand, so they always see the latest without chasing.
- **Severity sets how loud it is** — **ℹ️ Info / 🛠️ Maintenance** notify by **email**,
  **🟠 Degraded** adds **push**, **🔴 Outage** adds **SMS** on top — plus an always-on
  **in-app banner**. Architected so the fan-out per severity is a single dial.
- **Resolves cleanly** — once resolved, the banner clears automatically; the notice
  lingers in the client's status feed briefly so anyone returning sees it was handled.
- **Dual-surface** — Howler staff author and manage notices in **Admin → 🚨 Status**;
  clients simply see them. Read-only for clients ("just see it" — no acknowledgement
  to chase).

**Pitch:** "If anything ever goes wrong, you'll know before you have to ask — and
you'll see exactly when it's fixed."

---

## 12. Event Ops — know where every device is, live  🧪
The on-the-ground layer for a live event: track the **physical kit** (handheld payment
devices, scanners, radios, printers) and the **stations** (bars, gates, booths, top-up
points) they're deployed to — so at any moment you can see **where every device is** and
**what's wrong with any of them**. Replaces the clipboard, the spreadsheet and the
WhatsApp thread with one phone-first console.
- **Add your inventory** 🧪 — create devices one at a time or **bulk auto-number** a
  whole batch (e.g. SL001…SL050) with a type and scannable code.
- **Set up your stations** 🧪 — name the bars/gates/booths for the event; each shows a
  **live count** of the devices deployed there.
- **Scan to move** 🧪 — scan a device's QR/barcode (or type the code) and send it from
  the **Hive** (your store) out to a station, station-to-station, or back again. Every
  move is written to an **append-only audit trail** — nothing is ever lost to memory.
- **Liaison checks & issues** 🧪 — scan a device, log an issue from a quick list
  (damaged, battery, connectivity…) and record **how it was resolved**. Open issues
  surface on the live overview.
- **Device support calls** 🧪 — the person at a bar/booth taps **one button on the
  device's saved link** (Stock · Manager · Help · Security · Medical) and it lands with
  dispatch as a live **call** — pre-tagged with **which station and which device**, so
  they never pick where they are. No app to install; the link works from any phone, so a
  frozen device never blocks a call for help. Dispatch **acknowledges (with an ETA)** and
  **resolves** from the Hive → **Calls** queue. Ships in test mode (calls reach your test
  inbox only) until you go live.
- **Live overview** 🧪 — device counts by state, per-station counts, open issues and a
  recent-activity feed — the "where is everything right now" board.
- **Dual-surface + per-client pilot** — Howler staff run it in **Admin → a client →
  Event Ops**; the client can run it themselves from their own **Event Ops** area. It's
  a **per-client opt-in** (off by default) so we switch it on only for pilot clients.

**Pitch:** "Every device accounted for at event close — no 'missing' unknowns, no
spreadsheet, and a full history of where each one went."

**Status 🧪:** pilot. Camera scanning needs a phone with a camera on HTTPS (manual code
entry always works as a fallback). v1 is device + station tracking; staffing, shifts and
budgets are on the roadmap.

### 📶 Data health — is your event's data flowing? 🧪
A live monitor of the **data pipe itself**: is data from every station (check-in
scanners, bars, vendors) actually arriving in the platform — and from **every device**?
- **Per-station stream watch** 🧪 — minutes since the last record per station, with
  warn/stale thresholds and alerting when a stream goes quiet.
- **Device roster** 🧪 — how many devices are linked since doors opened, how many are
  online, and **which ones are offline** and for how long. Optional fleet alert when a
  set % of devices drop off.
- **Day timeline** 🧪 — every device's activity and scan counts through the day in
  5–60-min blocks: spot the device that died at 18:00, the flapper, the late joiner.
- **🩺 AI Diagnose** 🧪 — one tap per station: an AI verdict with the flow numbers,
  ranked concerns and a suggested action for each.
- **📝 Event report** 🧪 — an AI-drafted **Data health & diagnostics report** across
  all the event's stations — for the ops debrief, and with a neutral connectivity
  section clean enough to **forward to the network provider**.
- **Everywhere** — clients see it read-only in their **Event Ops → 📶 Data health**
  tab; Howler runs the full console in Admin; and the **Owl can answer questions on
  all of it** (in-app, WhatsApp, and Claude/ChatGPT via the MCP connector).

**Pitch:** "You'll know a scanner has stopped sending data before the queue does —
and you'll have the evidence report if it was the network."

---

## 13. Pulse API & AI-agent access (MCP)  🧪
**The pitch:** "Your Pulse data isn't locked in — read it from your own tools,
or point an AI agent (like Claude) at it and ask questions in plain language."

- **Read-only API keys, per client.** A key is scoped to exactly one client and
  can never see another client's data — the same security boundary the app
  itself enforces. Keys are named, revocable, and the secret is shown once.
- **REST API (`/api/v1`)** — dashboards, live tile metrics, segments (with
  contactable reach), campaign results and goals, as JSON.
- **Row-level data, opt-in per key** — a key can additionally be granted access
  to the table behind a tile (customer & ticketing records) for clients who
  need to pull that into their own systems. Explicitly enabled per key, never
  included by default, and every pull is audited.
- **MCP server (`/mcp`)** — the same data as curated tools any MCP-capable AI
  agent can use: "what does Total Tickets Sold show right now?", "how big is the
  VIP segment?", "how did the launch campaign do?". Works with **Claude** *and*
  **ChatGPT / OpenAI** (it exposes the `search` + `fetch` tools ChatGPT needs,
  so it also works with ChatGPT Deep Research).
- **Off by default, on per client** — Howler enables API access per client with
  one switch (Admin → client → Integrations); flipping it off instantly cuts
  every key that client has.
- **Self-service** — once enabled, clients create and revoke their own keys in
  **Settings → Integrations**; Howler can manage them per client in Admin.
  Every external call is rate-limited and audited.
- **Shareable guide** — send clients/developers to `<pulse-domain>/api-guide`
  (a living page rendered from `docs/CLIENT_API_GUIDE.md`).
- Writes (draft a segment/campaign via the API) are on the roadmap and will ride
  the existing approval + consent gates — nothing will ever send without a human.

---

## 14. Client onboarding journey — layered, guided activation  🧪
**The pitch:** "New clients don't get dumped into a tool — Pulse walks them (and
your account team) through it in layers, from first login to full automation,
and celebrates each milestone on the way."

- **Four phases, one journey.** The "Getting started" card on the client's home
  page is a layered path: **1 · The fundamentals** (dashboards, the installed
  app, notifications, asking the Owl, the weekly digest, branding, team) →
  **2 · Goals & first sends** (goals, alerts, a first audience, a first simple
  email) → **3 · The Owl everywhere** (WhatsApp, Claude & ChatGPT connectors) →
  **4 · Automate & amplify** (journeys, Meta/TikTok ad accounts, the Pulse
  Pixel). The current phase is open and actionable; what's next stays visible.
- **Progress ticks itself.** Almost every step auto-detects from real usage —
  a dashboard opened, the app installed, a question asked, a connector used, a
  journey drafted — so the journey reflects reality, not homework.
- **A branded welcome pack email** goes out automatically when the client's
  first login exists (in their branding, introducing Phase 1), and a
  **"phase complete — here's what's next" email + inbox message** lands as each
  layer finishes. The **account team gets a heads-up on every milestone**, so
  the AM knows exactly when to start the next conversation.
- **Every step has a "Show me how"** walkthrough, written for a phone screen.
- **Dual-surface:** the AM sees the same journey per client (Admin → client →
  Setup checklist → **Client onboarding journey**) with live progress, can tick
  manual steps on the client's behalf, re-send the welcome pack, or opt a
  client out of the emails. Wording is editable in Admin → Onboarding →
  **Journey emails**.

---

## On the horizon (🔜 — not yet usable; for roadmap conversations only)
Use these to set direction, **not** to promise dates. *(The conversational/agentic
Owl graduated off this list — the Owl chat is 🧪 and the one-tap auto-pilot is ✅,
see "The continuous comms loop" above.)*
- **Campaigns — conditional sequencing** — branch a journey on behaviour (opened /
  clicked / purchased → a different next step), on top of today's linear drips.
- **Portfolio / "all events" view** — roll up KPIs and audiences across a client's
  many events/profiles (today everything is per-event).
- **Automations · Connections** tabs (shown as "SOON" in Engage). *(Templates is now live — see §5.)*
- **Event tasks + AM cockpit** — owners, due dates, readiness % across clients.
- **Packages/tiers with feature gating**, **API-cost visibility per client**.
- **WhatsApp** and **Howler app push** as message channels.

(See `docs/ROADMAP.md` for the full backlog.)

---

## How to position Pulse (quick cheat-sheet)
- **For organisers:** "See what's happening, act on it, and prove the results —
  on your phone, in your brand, without exporting to five tools."
- **vs. a BI tool (Looker/Tableau):** Pulse *acts* on the data (campaigns,
  approvals, sync), not just charts.
- **vs. an email tool (Mailchimp/Klaviyo):** Pulse's audiences come from the
  client's live ticketing data and are governed/scoped — no CSV gymnastics.
- **The continuous loop:** "Updates flow through digests, land on the briefing,
  get acted on as campaigns, and the results feed the next call — and it pings
  their phone (installable app + push) to keep it moving."
- **The hook:** "insight → action → results → improvement, on a loop, in one
  governed place."

---

## Changelog (newest first)
> Keep this current — add a dated line whenever a client-relevant feature ships.

- **2026-07-08** — **🚀 Client onboarding journey** 🧪 (new): the "Getting started"
  checklist became a **four-phase layered journey** (fundamentals → goals & first
  sends → the Owl everywhere → automate & amplify) with almost every step
  **auto-detected from real usage** (dashboard opened, app installed, Owl asked,
  WhatsApp linked, Claude/ChatGPT connector used, journey built…). A **branded
  welcome pack email** sends automatically when the client's first login exists,
  and each completed phase triggers a **congratulations + "here's what's next"
  email & inbox message**, with a factual milestone heads-up to the account team.
  Dual-surface: AMs see the same journey per client (Setup checklist → Client
  onboarding journey), can tick manual steps, re-send the welcome pack, or opt a
  client out; wording is editable in Admin → Onboarding → Journey emails.
- **2026-07-07** — **🎯 Pulse Pixel — website retargeting** 🧪 (new): one snippet on
  the client's website/ticket shop loads their **Meta / Google / TikTok pixels**
  (managed from Pulse — changeable without touching the site), fires the standard
  events, and beacons to Pulse for a built-in "✓ receiving events" install check.
  **One click creates the standard retargeting audience pack** (visitors 180/30d,
  viewed tickets 30d, checkout abandoners 14d, purchasers 180d) in the connected
  Meta + TikTok ad accounts; Google audiences are a guided one-time manual step.
  GDPR consent mode included. Dual-surface (Admin → Integrations + client
  self-service); platform API calls not yet verified against live ad accounts.
- **2026-07-03** — **⚡ Live updates (event-day mini report)** 🧪 (new): the Alerts
  page gains a **Live updates** tab — while the event runs, Pulse sends the team a
  compact multi-metric snapshot every 15–120 min (gates in with **+change** and
  **pace/hr**, bar revenue, **top-3 bars/vendors**, Event Ops device health, optional
  **"% of last year"** vs a chosen past event). Manual **Go live** switch or a
  scheduled window; delivered to the inbox (one thread for the whole night) + app
  push, email, SMS and **WhatsApp** (24h service-window rule respected). The **Owl
  can set one up from chat** with a confirm card. Dual-surface, same `alerts.manage`
  permission as Alerts.
- **2026-07-03** — **Briefing focus tiles made dependable** ✅: tiles picked in
- **2026-07-07** — **🔗 Links grouped into categories** ✅ (Engage → Links): the Links
  landing now opens on **category tiles** — tap one (e.g. **App**, home of every
  Chotulink/Howler-app link) to see just that category's links, with a clear
  **← All categories** back link. File links under your own categories from the
  link editor (existing list or type a new one). Mobile-first; dual-surface (same
  grouping in Admin → client → 🔗 Deep links).
- **2026-07-07** — **Test-first releases on the product board** ✅: reports you send us
  can now be built to a **staging** environment first, checked there, then **promoted to
  production** — so changes are verified before they hit the live app. In your **My reports**
  view a new **Testing** step appears in the journey (Building → Testing → Ready for you).
  **You're the tester**: when your request lands on staging you get a link to try it and an
  **Approve / Send back** choice — nothing goes live until you (and every other reporter with
  work on staging) approve it, and you're notified the moment it's in production.
- **2026-07-07 (night)** — **🦉 Ask the Owl about Pulse itself** 🧪 (new): the Owl now
  answers product questions — *how do I…*, *what's new*, *what can I do* — right in
  Owl chat, grounded in a curated, **versioned knowledge base** (editable with no
  deploy) plus **published release notes only** (nothing unreleased can surface),
  and **tailored to the user's role, tenant and event** (e.g. omits cashless help
  for non-cashless events). Deep-links to the right screen and **declines** rather
  than inventing. Dual-surface: Howler curates + publishes the knowledge in
  **Admin → Product → 💬 Help knowledge**; the Owl chat (with a ✨ What's-new starter
  pill) is the client's self-service surface.
- **2026-07-07 (evening)** — **Deep links: click trends, Owl link tools & ✨ autofill** ✅:
  nightly click snapshots now power a per-event **clicks-per-day chart + by-source
  split** (📈 on the Links tab); the **Owl** drafts single links or the whole
  template set from chat (confirm-button, draft-only); and **✨ Autofill with AI**
  fills a link's UTM tags + social share preview (rich link previews now editable
  in Pulse, with a live share-card preview). Completes Phase 3 of the ChottuLink
  integration.
- **2026-07-07 (later)** — **Deep links: pick-and-choose import + delete** ✅: the
  import screen now lists the whole ChottuLink account (new / in Pulse / previously
  deleted) so you tick exactly what comes in, optionally attached to an event in the
  same step; links can be deleted (removed from Pulse + switched off in ChottuLink,
  tombstoned so re-imports don't resurrect them).
- **2026-07-07 (late)** — **Deep-link templates: every link in one click** ✅: apply a
  template to an event and Pulse creates the whole link set (main + ticket wallet +
  lineup + map + feed + chat) against ChottuLink in one go — placeholders fill the
  event's name/slug into names, paths and UTMs; preview with per-link tick/tweak and
  collision warnings; per-link retry on failure. Howler starter template built in;
  clients can save their own sets (Engage → Links → ⚡ Templates).
- **2026-07-07** — **Deep links into the Howler app (ChottuLink)** 🟡: short branded
  `howler.chottu.link` URLs created **from Pulse** (Engage → Links + Admin → 🔗 Deep
  links) instead of one-by-one in the ChottuLink dashboard — tied to events, with UTM
  tags, app-vs-browser behaviour, click counts and one-tap import of existing links.
  Needs the ChottuLink API key + domain (platform default, per-client override).
  Templates (one click = the whole standard link set for an event) are next.
- **2026-07-05 (late)** — **Flow board: 🔥 transaction heatmap** 🧪: a new 🔥 Heat mode on
  the venue map turns each station into a heat bloom sized by how much it's *transacting*,
  colour-coded by category so **bars and gates read at the same time**. A **▶ play-the-day**
  scrubber time-lapses the night — watch check-ins blaze at the gates at doors, then the heat
  migrate to the bars at peak and the food court flare late. Toggle **Absolute** (each area vs
  its own busiest all day) or **Relative** (vs right now), and the **window** (5 / 10 / 20 / 30
  min / 1 hour) — the number on each station is the transactions in that window. Reads the
  per-station transaction line we already fetch (no new Looker load); works on light or dark
  maps. Also: the seven Flow-board views now live BOTH as an expanding pill in the header and
  as a left-nav dropdown.
- **2026-07-05 (eve)** — **Signal board: 📅 Day picker · 🛰️ satellite maps · past-event
  ghost guard** 🧪: multi-day events can now flip Stations/Rhythm (and every deep-dive)
  between festival days — a day runs daily-start → +24h so the after-midnight tail stays
  with its party. The venue map can fetch **real aerial imagery** (Esri, licence-safe)
  for typed coordinates as an alternative to uploading a site plan, fits the screen
  without scrolling, and Operator mode now lays devices out in tidy rows. Monitors
  ignore stations silent >30 days, so recycled station names from LAST YEAR's edition
  can never appear as live streams. The Owl/API can read one festival day too
  (hours="day:YYYY-MM-DD").
- **2026-07-05 (pm)** — **Signal board: 🕸️ Network view + one-button view switcher** 🧪:
  the Network view draws the whole event as a river delta — every OPERATOR pours into
  their station, stations merge into their type (bars/vendors/gates), types merge into
  Pulse, with live sparks travelling the full chain and dark operators flashing at the
  exact tier the blockage lives in. The board's six views now sit behind ONE control
  that opens a slide-in drawer (Apple-style). Also: the Map gained a Stations/Operators
  toggle (every device fanned around its station's pin), and the device support-call
  page now offers the event's device issue categories as tap-to-send reasons.
- **2026-07-05** — **Signal board: 🗺️ Venue map + 🌊 Flow river** 🧪: upload the event's
  site plan and drag each station's pin onto it once — the map then goes LIVE: healthy
  pins ripple green, a dark station's pin flashes red, and when several stations in the
  same corner degrade together a red **"⚠ AREA" halo** blooms over that part of the venue
  (network failures are usually by area — now you see WHERE, instantly). Tap a pin for
  that station's devices & operators. The 🌊 River view shows transactions as moving
  sparks streaming into Pulse — a choking station's stream stutters red. Both self-service
  (clients manage their own map) and admin-managed.
- **2026-07-04 (night)** — **Signal board: Stations view + provider report** 🧪: a new
  📶 Stations view puts every station's online/offline-through-the-day strip on one
  screen, grouped by zone, with an average-transactions line overlaid (see throughput
  track connectivity per station), closed stations greyed, and Online/Offline/Txns/Closed
  layer toggles + a station filter. Plus a **shareable device-health report** — a
  print-to-PDF page (📤 on the board) you can send to your **network / operations
  provider**, and an **ops digest** that emails them the headline numbers + the link on a
  schedule *and* the moment signal drops below target. Signal flow (all / per category /
  per station) and device online/offline are also blocks you can add to a Live update.
- **2026-07-04 (night)** — **One-tap LIVE button** ✅: pick an event's live-ticketing
  dashboard in Admin → Suites (or the setup wizard) and a red **LIVE** pill shows
  on that event's sidebar row — clients jump straight to live sales, no drill-down.
  Also: **double-tap a chart to full-screen** it on mobile, carousels give charts a
  readable full-width card on phones, and setting up a **live update** now shows the
  actual numbers each block pulls (+ a "send to me" phone preview) before you go live.
- **2026-07-04 (night)** — **Device support calls** 🧪 (Event Ops §12): the person at a
  bar/booth taps one button on the device's saved link (Stock · Manager · Help · Security
  · Medical) and it reaches dispatch as a live call, **pre-tagged with the station and
  device** so nothing is filled in but the reason (+ their name, an optional note, and
  what they've already tried). No app install; the link works from any phone, so a frozen
  device never blocks a call. Dispatch acknowledges (ETA) + resolves from the new Hive →
  **Calls** queue. Test mode until go-live (calls reach the test inbox only).
- **2026-07-04 (night)** — **Alerts reach the person on the ground** 🧪: staff can
  now opt their own phone into station alerts straight from the public staff
  portal (🔔 Alerts — web push, no app install, no account), and once an event is
  live a dark station pushes the assigned crew directly, not just the manager.
  Hive → Alerts shows a 🔔 next to reachable staff, a **Pause alerts** switch per
  event, a settable dark **threshold**, status/name **filters**, and a storm
  guard that folds a site-wide pipe wobble into one note. (WhatsApp session
  channel + Ops Owl are the next phase.)
- **2026-07-04 (evening)** — **The board learns to time-travel — and to call for help** 🧪:
  📶 Signal flow meter with a settable per-event target (default 95% of devices
  online; green/amber/red); dragging the Event pulse replays the WHOLE board at
  that moment (tiles, zones, dials); a 30-min status journal (who came back, who
  went dark, window by window); the last-60-min verdict now follows the dark
  count (150→51 dark reads "Big improvement"); station on/off follows the device
  roster's lag truth so a data-pipe stall can no longer paint a trading site
  black; and 🚨 **staff alerts phase 1**: Hive → Alerts bridges board stations to
  Event Ops stations (auto name-match + manual mapping) and, when half a
  station's devices go dark, alerts the staff assigned to it — 🧪 test-mode only
  (emails the test address with the would-be recipients; staff aren't contacted
  until Go live). Push/SMS/WhatsApp escalation is the next phase.
- **2026-07-04 (later)** — **Event Signal grows up in a day** 🧪: station family
  filter chips (Bars / Vendors / Check-in); tap a station for a centred pop-up
  deep dive — per-device day timeline with the 🚦 three-colour robot view
  (online+data / offline-but-synced-later / offline+no data) and a stacked
  online-vs-offline day graph; 🦉 Owl summary and ↗ Share on both the board and
  the client Data health tab; gates now count real check-in scans; Event Ops nav
  tidied into a 🐝 Hive drawer (Live, Devices, Stations, Map, Staff, Checks,
  Issues, Activity) with Data health and the Signal board alongside.
- **2026-07-04** — **🎛️ Event Signal — the event as a live site board** 🧪: a map-style
  view of the whole event in Event Ops: stations grouped into their real venue
  zones, every device a countable tick (green = sending, red = dark), this hour's
  scans/transactions per station with a mini trend. Runs off the Data health
  checks already in place — no extra load — and admins get the same board per
  event on the Data health page. Floorplan overlay and day-replay are next.- **2026-07-03** — **Briefing focus tiles made dependable** ✅: tiles picked in
  Tune now always feed the briefing — a phase-scoped pick (e.g. "gates board on
  Event Day") whose event has **no dates/phase set** feeds anyway instead of
  silently vanishing, and the Tune modal warns to set the key dates. A
  whole-dashboard pick no longer crowds out the reader's other picks, and admins
  get a **🔍 Diagnose focus tiles** panel on the home briefing showing why each
  pick did or didn't make that briefing.

- **2026-07-03** — **📶 Data health: per-station drill-down & truer metrics** 🧪: the
  live day timeline now filters to one station (or groups all stations under
  headers), every device row is labelled with its station + operator, and clicking
  a tile's offline count opens the live offline list split by station. Bar/vendor
  monitors report **transactions** and check-in monitors **scans** — separate
  metrics, never summed — and closed stations keep their day totals. Roster and
  count reads are aggregation-backed so busy sales days no longer under-count.
- **2026-07-03** — **Pinpoint the tile + record your screen when reporting** 🧪: filing a
  bug from a dashboard now lets you say **exactly which tile** is affected (a "which tile
  is this about?" picker listing that dashboard's tiles) — the tile flows into the ticket,
  the AI draft, the Copy-for-Claude brief and the triage board, so nobody has to guess.
  You can also **record your screen** (desktop) as an alternative to a screenshot — perfect
  for intermittent or interaction bugs — alongside the existing screenshot/video upload
  (on a phone, attach a video recorded with your camera). Mobile-first, self-service.
- **2026-07-03** — **📶 Data health goes client-facing + AI** 🧪: live stream health
  per station now has a read-only client tab in Event Ops (streams, device roster,
  day timeline), a 🩺 one-tap AI station diagnose, an AI-drafted **event-level Data
  health & diagnostics report** (ops + network-provider shareable), an optional
  fleet alert (≥ X% of devices offline), and full Owl/MCP query access
  (`pulse_data_health`).
- **2026-07-03** — **Reliable check-in numbers from the Owl** 🧪: the Owl now answers
  check-in/scanning questions with the **same recipe Inventive uses** — the dedicated
  check-in count grouped by station, keyed on the cashless data's own event field (enabled
  automatically) — with an explicit steer never to count sales transactions at check-in
  stations as "check-ins". Per-gate numbers now match the source reports.
- **2026-07-03** — **Custom sending domain** ✅ (Admin → client → Settings + client Settings →
  Email): clients can send campaigns/digests from their own domain (e.g. events@mail.brand.com).
  Register the domain, hand the DNS records to IT, verify — until verified, sends safely use the
  platform address. Display-name branding unchanged.

- **2026-07-03** — **Cashless "today" now reads correctly** ✅ (fix): the Owl's
  data/cashless queries now resolve relative date filters ("today", "this week")
  on the **client's local calendar day**, not the server's — so `today` returns
  today's real sales instead of zero. Layered like everything else: a platform
  default (GMT+2) with an optional **per-client reporting timezone** override,
  manageable by Howler staff and by the client themselves (dual-surface API).
- **2026-07-03** — **Skills — autonomous specialists** 🧪 (internal): the Skills
  runtime landed with the first specialist, the **Ticketing Manager** — scheduled,
  advise-only reviews of an event's sales/pace/tiers, a trainable playbook, AM
  grading (👍/👎 + note) and a **backtest** mode that freezes a finished event at
  N days out. Dogfood-only; no client surface yet.
- **2026-07-02** — **One-click connects** 🟡: "Connect with Google" (pick the
  exact files in a native Google picker — the app can only ever see what you
  pick) and "Continue with Facebook" (login + choose the ad account, no tokens
  to paste) replace manual keys for Drive and Meta. Needs a one-time platform
  app registration by Howler per platform.
- **2026-07-02** — **Meta paid-ads performance in Pulse** 🟡: per-campaign spend,
  clicks, purchases and ROAS pulled daily from the connected ad account — a Paid
  ads section on the Social page, and the Owl answers "how are my ads doing?".
- **2026-07-02** — **The Owl reads your Google Drive** 🟡: share budgets, plans,
  decks or contracts (files or whole folders) with the Owl's Google account, paste
  the link in Settings → Integrations, and ask questions across those files AND
  live ticket data. Sheets become queryable tables; Docs/Slides/PDFs become
  searchable, quotable text; watched folders re-sync hourly.
- **2026-07-02** — **Pick a specific Howler approver** ✅ (Engage → campaigns): the
  approval picker now lists the Howler team members linked to the client account
  individually (name + role), alongside the generic "Howler (any of the account team)"
  slot — so a sign-off can go to your AM instead of pinging every Howler admin.
- **2026-07-02** — **Move a whole subfolder in one action** ✅ (Dashboard Console): admins
  can now reparent a subfolder — with **all** its nested subfolders and dashboards — in a
  single move, instead of relocating dashboards one by one. Use the **↗ Move** button on any
  folder (a mobile-friendly "Move to…" picker) or **drag a folder onto another** on desktop.
  Moving a folder into itself or one of its own subfolders is blocked with a clear message,
  and the reparent is **atomic** (one transaction) so a failure can't leave a half-moved
  tree. Folders are an admin-only organising layer — clients navigate via suites/sets — so
  there's no separate client surface to update.
- **2026-07-02** — **Rename dashboards in the sidebar per Set** ✅: admins can now give
  any dashboard a custom display name within a Set (in Admin → Sets, and in a client's
  custom sets) without editing the underlying dashboard. The label shows in the client's
  sidebar and top-nav; leave it blank to use the dashboard's native name, and clearing it
  reverts. Because the override lives on the Set, the same dashboard can read differently
  in different Sets — presentation is decoupled from source naming.
- **2026-07-02** — **Event-scoped segments stay scoped** ✅ (fix): a segment linked to an
  event now resolves to **that event only** on every live re-resolution — reach checks and
  when a campaign sends from it — not just at creation. Previously an event-scoped cohort
  (e.g. VIPs for one festival) could silently widen to *all* your events at send time, risking
  an over-send. The AI-draft/segment tools also now return the **resolved event scope** so a
  mismatch is visible before anyone approves a send.
- **2026-07-02** — **Agentic Owl auto-pilot is live** ✅: the one-tap close of the loop —
  the Owl drafts the campaign straight from an insight/suggested action. Drafts still
  ride the normal review + approval gates; nothing sends without a human. (Roadmap's
  flagship item, now shipped; the feature matrix Owl section also now separates the
  **native Pulse Owl**, the **Owl in Claude / ChatGPT**, and the third-party
  **Inventive "Ask"** analyst.)
- **2026-07-02** — **Pulse sales site + admin-curated feature matrix** ✅: a shareable
  public **sales website at `/sales`** built from the (freshly updated) feature matrix,
  and the matrix itself moved server-side with **Shown / Hidden toggles** on every
  section, feature and overview section (Admin → Product → Feature matrix). Hide
  anything still being built or not ready for internal announcement and it vanishes
  from the sales site and the public overview page; admins still see it, dimmed.
- **2026-07-02** — **The Fan Owl: a booking guide on the event's own website** 🧪: the
  Owl's first **consumer-facing** surface — promoters drop one script tag on their public
  event site and every page gets a personal ticket guide: a no-AI ribbon (right offer for
  the page + live availability tag), a chat that answers ONLY from the promoter's own
  knowledge base and catalogue (no invented prices/policies, no fake scarcity), buy buttons
  on the promoter's own Howler checkout links (tracked), consent-first "keep me posted"
  lead capture, and a promoter-facing funnel + FAQ-gap report. Self-service under
  Settings → Fan Owl; admin twin in the client's detail tab. Deep-link checkout v1;
  pilots: Retreat Yourself → Kappa Futur Festival (`docs/specs/FAN_OWL_SPEC.md`).
- **2026-07-02** — **The Owl inside the Howler organizer portal** 🧪: the Owl can now be
  **embedded in Howler's own organizer portal** — the portal's backend does a secure
  server-to-server handshake with Pulse and drops a one-iframe Owl panel into its UI.
  Organizers get the full chat analyst (charts, follow-ups, saved threads, mobile-first)
  with no extra login, always scoped to **their own organization's data**. Pilot: works for
  organizations linked to a Pulse client (Admin → AI → Organizer portal Owl); widens to all
  self-service organizers when the Howler→Pulse data integration ships.
- **2026-07-01** — **Owl chat: download one answer's data, table or chart** 🧪: each data
  answer already had ⬇ CSV / ⬇ Image — now the **CSV is the RAW query data** (when the preview
  is capped at 50 rows, the download re-runs the query live and fetches **all** rows, same
  privacy/scope gates), every **table in an answer** gets its own tiny ⬇ Table CSV, and
  cashless/extra-explore answers now carry their **chart, CSV and "Beneath the hood"** query
  view just like ticketing ones (they'd silently lost all three).
- **2026-07-01** — **Owl chat: ⏹ Stop button + no more silent stalls** 🧪: while the Owl is
  working you can now **tap Stop** to cancel the answer (the server abandons the work too, so
  nothing keeps burning in the background). And long data pulls no longer look frozen — the
  thinking line keeps refreshing every few seconds and the connection is kept alive, so a heavy
  query (e.g. a big cashless breakdown) shows progress instead of hanging on "Thinking…".
- **2026-07-02** — **Grok (xAI) can connect too** 🧪: paid Grok users can add Pulse as a
  custom connector (grok.com/connectors → New → Custom → our MCP URL) — same approval
  page, keys and guarantees as Claude/ChatGPT/Gemini Enterprise. One server, four AI
  platforms.
- **2026-07-02** — **Google Gemini Enterprise can connect too** 🧪: organisations on
  Google's **Gemini Enterprise** can add Pulse as a Custom MCP connector (same approval
  page, same per-client keys and guarantees as Claude/ChatGPT). Honest limit: the
  regular **Gemini app and Gems can't connect yet** — Google hasn't opened custom
  connectors there; the moment they do, Pulse's existing flow slots in.
- **2026-07-02** — **Provenance badges: see WHERE things were made** 🧪: segments,
  campaigns and alerts created through an AI door now carry a badge in their lists —
  **🦉 via Owl** (in-app chat), **💬 via WhatsApp**, **✨ via Claude**, **✨ via ChatGPT**,
  **🔌 via API** — so a human reviewing a draft always knows which channel produced it.
  Hand-made items stay unbadged.
- **2026-07-02** — **The connected Owl can now DO things (drafts only)** 🧪: with the
  "creating drafts" permission on a connection/key, the Owl in Claude or ChatGPT can
  **build audience segments** and **draft campaigns** ("draft a win-back email to last
  year's VIP buyers") — Pulse's own AI writes/designs the content, and everything lands
  as a **draft in Engage awaiting human review and approval**. The connected Owl can
  never send. It also now receives the client's stored AI context (same grounding as
  in-app), so answers are business-aware.
- **2026-07-02** — **API: Event Ops data (row-level keys)** 🧪: connected tools and AI
  agents with the row-level scope can now pull **live Event Ops** per event — device
  totals per station, locate a device by code, open issues, staff, checkpoints
  (`GET /api/v1/event-ops` / the `pulse_event_ops` MCP tool). Honours the per-client
  Event Ops switch; per-event only; same audit trail.
- **2026-07-02** — **Connected AI assistants speak as the Owl** 🧪: connect Claude (or
  ChatGPT) and it presents itself as **the Owl 🦉** — Pulse's data analyst — same persona
  as in-app: warm, numbers-first, grounded in tool results, read-only. The connection
  approval page and guide are Owl-branded; name the connector "The Owl" for the full effect.
- **2026-07-02** — **API: query your data directly (no dashboard needed)** 🧪: connected
  tools and AI agents can now run **their own breakdowns** — any curated measure by any
  curated dimension, with filters and date ranges (`POST /api/v1/query` / the
  `pulse_query_data` MCP tool) — e.g. "revenue by ticket type, last 30 days". Same engine
  the Owl uses: admin-curated fields only, personal fields are filter-only, every query
  forced to the client's own scope. Dashboards are no longer the only door; the curated
  catalogue and the client boundary still are.
- **2026-07-01** — **Works with ChatGPT / OpenAI too** 🧪: the MCP server now exposes the
  standard `search` + `fetch` tools OpenAI requires, so Pulse connects as a **ChatGPT
  custom connector** (Developer mode) and works with **ChatGPT Deep Research**, as well as
  the **OpenAI Responses API** for developers — same URL, same per-client keys, same
  scope/audit guarantees as the Claude connection.
- **2026-07-01** — **Claude connects with one click (MCP OAuth)** 🧪: connecting an AI
  assistant no longer involves copying keys. Add the connector URL in Claude, click
  **Connect**, and a Pulse approval page opens — pick which client, optionally allow
  row-level data, Approve. Pulse mints a named API key behind the scenes (visible &
  revocable in Settings → Integrations like any other). Standard MCP auth (OAuth 2.1 +
  PKCE + dynamic client registration), so other agent platforms get the same one-click flow.
- **2026-07-01** — **API: per-client access switch + shareable developer guide** 🧪: API
  access is now **off by default** and enabled per client by Howler (Admin → client →
  Integrations — one toggle; off cuts all of that client's keys instantly, REST and MCP).
  And there's a **client/developer guide at `<pulse-domain>/api-guide`** — a living page
  (rendered from `docs/CLIENT_API_GUIDE.md`) covering keys, endpoints, connecting Claude
  via MCP, row-level data responsibilities and troubleshooting. Share the link directly.
- **2026-07-01** — **API: row-level tile data (opt-in scope)** 🧪: an API key can now be
  granted **row-level access** — the table behind a dashboard tile (customer & ticketing
  records) via `GET /api/v1/tiles/rows` or the `pulse_get_tile_rows` MCP tool — for clients
  pulling data into their own systems. Explicit per-key opt-in (never default), same
  client-scoping gate, capped at 10k rows per pull, fully audited; AI agents on a plain
  read key are never even offered the tool.
- **2026-07-01** — **Pulse API & AI-agent access (MCP)** 🧪: per-client, read-only **API keys**
  (client self-service in Settings → Integrations, or managed by Howler in Admin) unlock a
  **REST API** (`/api/v1` — dashboards, live tile metrics, segments + reach, campaign results,
  goals) and a **remote MCP server** (`/mcp`) so AI agents like Claude can query a client's
  Pulse data conversationally. One key = one client, read-only, rate-limited, fully audited —
  external callers ride the exact same scope boundary as the app. (See `docs/PUBLIC_API.md`.)
- **2026-07-01** — **Email block builder** 🧪: campaigns get a Mailchimp-style content
  builder alongside the built template + custom HTML modes. Stack **heading, text, image,
  button, video, social, divider and spacer** blocks (each with alignment/size/link
  options), reorder or delete them, and it renders to email-safe HTML wrapped in the
  client's branding (logo, colours, unsubscribe) — button/image links tracked, merge
  tokens in text, and the whole thing can be saved as a reusable template. Server render
  is `server/emailBlocks.js` (unit-tested); the live email preview shows it as you build.
- **2026-07-01** — **Extra explores: per-client on/off** 🧪: each added explore now has a
  **Client access** control — a platform default (on/off for everyone) plus **per-client
  overrides** (inherit / on / off), so e.g. Cashless can be live for one client and hidden for
  another. Checked on every answer, so a flip applies immediately; a client with an explore off
  is never even told it exists.
- **2026-07-01** — **Owl can read more than ticketing (extra Looker explores)** 🧪: in **Admin →
  Owl data catalogue** you can now **add other Looker explores** (e.g. **Cashless**) from a live
  list and tick their fields — and the Owl gets a dedicated tool per explore, so it can answer
  cashless/top-up questions too. It combines an explore with ticketing by pulling both and
  aligning on a shared key (event/date). Every query runs through the same client-scoping gate,
  and an explore that can't be scoped to a client is safely declined.
- **2026-07-01** — **Report a bug or idea, from anywhere** 🧪: a **💬 Report button** now sits on
  every screen (for Howler staff *and* clients). Tap it to flag a **bug**, suggest an
  **improvement**, or float an **idea** — it automatically captures which screen you were on and
  who you are. The **AI turns a rough note into a clear, structured ticket**, and everything lands
  on a live **product board** (Admin → Tickets) where the team triages, builds and ships it — with
  a **"Copy for Claude"** hand-off that hands the whole ticket to the AI to develop. Clients can
  track their own reports under **Settings → My reports**, and get a heads-up when what they
  flagged ships. Closes Pulse's *insight → action → results* loop on the product itself.
- **2026-06-30** — **Owl data catalogue is now editable in Pulse** 🧪: a new **Admin → Owl data
  catalogue** screen lists **every field** in the Active Tickets explore (measures + dimensions,
  incl. payments & orders if they're in the explore) with a **checkbox to include it for the
  Owl**. Ticked fields become usable in chat/WhatsApp; contact fields stay locked (privacy-safe
  lookup-only). Changes take effect on the Owl's next answer — no code change or restart.
- **2026-06-30** — **Owl opens with quick prompt-starters** 🧪: the web Owl chat now greets an
  empty conversation with **tappable starter pills** — concrete prompts like *Today's sales ·
  Sales overview · Last 7 days · Goal tracking · Sales by hour* — and leads with **the user's
  own most-asked questions** (personalised quick pills from their history), topped up with the
  curated starters. Tap one to ask straight away.
- **2026-06-30** — **Owl "/" menu now includes actions** 🧪: the slash-command palette in the
  web Owl chat covers the **actions** too — **/alerts** (check *or* set one up), **/campaigns**
  (review *or* draft one) and **/segment** (build an audience) — so creating things is one tap
  from the composer, not just asking questions. One entry per domain (no duplicate rows);
  sourced from the tool registry, so it can't drift from what the Owl can actually do.
- **2026-06-30** — **WhatsApp Owl: team broadcast lists** 🧪: subscribe a **list of team
  numbers** to one client’s daily update (no Pulse account needed for recipients). WhatsApp
  groups aren’t available via the API, so the Owl fans the same update out 1-to-1 to the whole
  list — built once per client, sent to each in-window number. Managed in Admin → WhatsApp Owl.
- **2026-06-30** — **Event Ops (pilot)** 🧪 — new §12: a phone-first console to track
  **devices & stations live at an event**. Add inventory (single or bulk auto-numbered),
  set up stations, **scan to move** devices between the Hive and stations (append-only
  audit trail), and log **liaison checks/issues** with resolutions. Live overview shows
  where everything is and what's open. **Per-client opt-in** (off by default), dual-surface
  (Admin → client → Event Ops, and the client's own Event Ops area). Camera scanning with
  manual-entry fallback. v1 is device/station tracking; staffing/shifts/budgets are roadmap.
- **2026-06-30** — **Owl memory: now three layers + client self-service** 🧪: added **user**
  memory on top of client + event — this person's own preferences for how answers are shaped
  ("keep it short", "always lead with revenue"). All three layers now feed every answer (client
  facts → event facts → your personal style), web and WhatsApp. And clients can now **manage
  their own memory** themselves under **Settings → 🧠 Owl memory** (This account · An event ·
  Just me) — the same review/edit surface Howler has in Admin. User memory is always private to
  the person; client/event facts stay scoped + fail-closed; never stores personal/contact data.
- **2026-06-30** — **Owl memory (client + event)** 🧪: the Owl now remembers durable facts across
  chats — at **client** scope (every chat for that client) *and* **event** scope (only that
  event's context, so two festivals can hold different facts without bleeding into each other).
  It offers to remember things in conversation ("🧠 Remember it" — you confirm, nothing's stored
  silently, and it picks client vs event scope), and Howler/clients can review & edit both in
  **Admin → Owl memory** (and the AI audit). Remembered facts feed **every** answer for that
  client/event, on web and WhatsApp — so it stops re-asking what it knows. Scoped + fail-closed;
  never stores personal/contact data.
- **2026-06-30** — **Owl modes on WhatsApp** 🧪: the depth/action modes now reach WhatsApp via
  natural language — a customer can say **"go deeper"** for a fuller analysis or **"what should
  I do"** to have the Owl propose + draft the best next action (alert / segment / campaign,
  confirmed with a button). Default stays the quick, snappy reply; the deeper modes use more
  reasoning + more data cuts, kept chat-friendly (no tables).
- **2026-06-30** — **Owl modes: Quick / Analyst / Operator** 🧪: the Owl chat has a mode
  toggle — **⚡ Quick** (fast, grounded, default), **🔬 Analyst** (deeper: more reasoning,
  multiple data cuts, the "so what" + a recommendation, sharper follow-ups), and **🧭 Operator**
  (Analyst depth AND proactively drafts the single best next action — an alert, segment or
  campaign — for you to confirm; still draft-only, nothing sends without a tap). The mode is
  remembered per conversation, and any Quick answer has a **🔬 Dig deeper** one-tap to re-run
  that question deep. Same grounded brain — different brief + reasoning budget, not a
  different model.
- **2026-06-30** — **WhatsApp Owl: friendly reply to voice notes / media** 🧪: a voice note,
  image or file used to be **silently dropped** (the customer got nothing back). The Owl now
  recognises it and replies "I can't listen to voice notes yet — please type your question"
  (or send "menu"). Full voice→text transcription is a later step (needs a speech provider +
  Clickatell inbound-media access).
- **2026-06-30** — **WhatsApp Owl: starter prompts** 🧪: say "hi" / "menu" / "help" to the
  WhatsApp Owl and it now replies with a **welcome + suggested starter prompts** (the
  WhatsApp take on Meta AI's suggestion chips) — the top few as **tappable buttons** plus a
  numbered menu (tap or reply with a number). Steers customers to what it can do (sales,
  goals, alerts, campaigns). The starter list is overridable per platform.
- **2026-06-30** — **Owl can read sales by the hour** ✅: the Owl's data now includes an
  **hour-of-day grain**, so it can answer "what's our busiest sales hour?", show an
  intraday sell curve, and — importantly — make a **fair "today so far vs yesterday to
  the same time"** comparison (it trims both days to the current hour instead of
  comparing a part-day against a full day). The hour is the finest grain (no per-minute).
- **2026-06-30** — **Owl actions always link to where you can see them** ✅: whenever the
  Owl creates something — an **alert**, a **segment** or a **draft campaign** — the
  confirmation now includes a **"View it →" link** straight to the right page (Alerts /
  Engage → Segments / Engage → Campaigns). Works the same on **web chat and WhatsApp**.
- **2026-06-30** — **Combined-field filters (OR logic)** 🧪: a locked filter can now target
  **several fields at once** and match a value across them with **OR** — e.g. "Ticket Category
  OR Add-on Category = X" — with one operator (**Is / Is not / Contains**) and one value applying
  to all. Set in Admin → the client → locked filters (per suite or per dashboard). Built on Looker
  `filter_expression`, AND-combined with the client's data scope so it can never widen access.
  (Beta — pending live-Looker verification; the Dashboard Editor's own filters are the next step.)
- **2026-06-30** — **Per-campaign language override** ✅: any single email/SMS campaign
  can now pick its **own** AI copy language (in the campaign builder, next to the goal),
  overriding the client default — so a multi-language client can send one audience in
  French and another in English. The Owl can draft in a named language too. Re-draft
  after changing it; the saved copy is what sends.
- **2026-06-30** — **Per-client AI copy language** ✅: Howler can set the language the
  **AI writes in** for a client (English default) in **Admin → the client → Settings**
  (and the setup wizard). Every Pulse-written touch point then speaks it — insights, the
  home briefing, goals & alert reads, digests, campaign copy, and the Owl (in-app +
  WhatsApp). English + Afrikaans + the SA official languages + common international ones.
  Steers AI wording only; the app's own UI chrome stays English (full UI translation is a
  separate, larger project). Resolved through the branding chain, so it inherits like the
  rest of the brand.
- **2026-06-30** — **Per-client SMS sub-cap** ✅: campaigns now honour a separate,
  tighter SMS ceiling (default 5,000/campaign) on top of the audience cap, so a big
  email send can't accidentally trigger an equally-big SMS blast. Set it to 0 to
  block SMS for a client. Admin-only (Client → Settings); the capped number shows in
  the audience preview and is fed to the Owl when it drafts a campaign.
- **2026-06-30** — **Organise segments by event & folder** ✅: link any segment to an
  **event** and/or file it in a free-text **folder**, then **filter the list** by either —
  right on each segment card. Keeps a growing audience list tidy (all of one festival's
  segments together). The Owl auto-links a segment to the event it drafted a campaign for.
- **2026-06-30** — **WhatsApp Owl: take action by reply button** 🧪: the Owl can now set
  up an **alert** or save a **segment** from WhatsApp — it drafts it and sends a ✅ Confirm
  button (event-choice buttons when an alert could watch several events), committing through
  the same permission checks as the app. Campaigns stay app-only. Also added delivery-receipt
  capture (delivered/undelivered + reason) and a per-number test button.
- **2026-06-30** — **Bigger campaign audiences + per-client cap** ✅: the per-campaign recipient
  limit was raised from 2,000 to a **25,000** default, and Howler can now set a **per-client audience
  cap** in **Admin → the client → Settings** — blank uses the default, or set any value **up to
  500,000** for a large client (the Looker fetch scales to the cap). Segments now show a **progress
  bar** while their live audience resolves, and the members viewer lists up to 5,000 with the true
  total shown.
- **2026-06-30** — **Filters: a hand-added filter now actually filters the report** ✅: a
  dashboard filter added in the editor (not imported from Looker, so never wired into a
  tile's `listenTo`) now applies to every tile whose own query uses that filter's field —
  the same field-match the lock picker uses. Set the filter's **field** (e.g.
  *core_ticket_categories.name*) and lock/pick a value, and the matching tiles scope to it.
  Looker-imported filters keep their explicit wiring, so nothing over-filters.
- **2026-06-30** — **Filters: find a ticket category/type by id** ✅: in the lock / value
  pickers you can type a category's **id** (e.g. *16244*) to find it; the suggestion shown
  and the value stored are still the **name** (Looker matches ticket categories on the exact
  name, so the filter never holds a raw id).
- **2026-06-30** — **WhatsApp Owl: scheduled in-window updates** 🧪: a customer can be
  subscribed (per number, in **Admin → WhatsApp Owl**) to a daily **digest / goals /
  alerts** update on WhatsApp. Sent free-form only while they’re inside their 24-hour
  window (messaged in the last day); a master switch + per-number topic & time controls.
  Reaching everyone on a fixed schedule regardless of the window will use an approved
  WhatsApp template (next step).
- **2026-06-29** — **WhatsApp Owl: charts + tappable follow-ups** 🧪: the WhatsApp Owl now
  renders a **chart image** when a customer asks to see a trend/breakdown, and offers
  **2–3 follow-up questions** as native WhatsApp reply buttons (falling back to a numbered
  list where buttons aren't available). A new **Recent inbound** log in **Admin → WhatsApp
  Owl** shows messages flowing through end-to-end for easy diagnosis.
- **2026-06-28** — **Vanity login page** ✅: each client can have a white-labelled sign-in URL at
  `…/<slug>` (e.g. `/kunye`) — their logo, colours and a full-screen background image, so logging in
  feels like their own product. Howler sets the slug + background in **Admin → the client →
  Settings** (and the setup wizard's *Client* step); an unknown URL falls back to the standard login.
  A public endpoint serves **only non-secret branding** for the pre-login page.
- **2026-06-28** — **Custom categories** ✅: clients (and Howler on their behalf) can now
  **create their own categories** in the goal/alert editor — type a new one, save it, and
  it's remembered and offered thereafter. The list is **shared across goals and alerts** per
  client, so a category created once works in both.
- **2026-06-28** — **Alert tags** ✅: tag an alert with an operational area (Ticketing,
  Cashless, Access control, …, or a custom one); the Alerts page now groups alerts into
  **one row per tag**, mirroring the goal tags.
- **2026-06-28** — **Mobile dashboard polish** ✅: removed the left/right **swipe-between-tabs**
  gesture (it fought with scrolling wide tables and the page) — switch tabs by tapping the tab bar.
  **Tables** now scroll far more smoothly on mobile (momentum scrolling, the table owns its own
  pan, and a scroll stays inside the table instead of dragging the page), with more height to read.
- **2026-06-28** — **Reporting currency** ✅: a per-client display currency (ZAR default), **set by
  Howler** in **Admin → the client → Settings** (and surfaced in the setup wizard's *Client* step) —
  not client self-service. It flows across every Pulse-written surface: AI insights, the home
  briefing, goals, alerts and digests all present and describe money in the client's currency. Not a
  data filter and not the messaging-cost/billing currency (those stay separate); dashboard tile
  values keep the formatting from their data source.
- **2026-06-27** — **Slack for alerts & goals** 🟡: **Alerts** now have a **# Slack**
  channel (next to Push/Email/SMS) — tick it to route that alert to the client's
  connected Slack (enabled only when Slack is connected). The **goals** Owl brief
  gains a **Share → Post to Slack** so a goals summary can be posted straight to
  the channel. Both build on the Slack integration; Slack is now a first-class
  notification channel (alerts only go to Slack when ticked).
- **2026-06-27** — **Slack notifications (outbound)** 🟡: clients can connect Slack
  in **Settings → Integrations** (and Howler staff in Admin → client → Integrations)
  so Howler inbox messages also drop into their Slack channel. Connect with an
  **Incoming Webhook** or a **bot token + channel**; secrets are write-only and the
  integration is locked-by-default like the others. Outbound only for now — replies
  from Slack landing back in the Pulse inbox are a planned next phase.
- **2026-06-27** — **Dark-mode logo** ✅ (dual-surface): an optional second brand logo for dark
  mode, in admin branding *and* client self-service (account + per-event). In dark mode Pulse uses
  the dark logo when set; if it's blank, the normal logo is shown on a subtle light chip so a
  dark-ink logo never disappears against the dark header. Emails always use the main logo.
- **2026-06-27** — **Status notices** ✅: Howler can post a platform-issue notice
  **company-wide or to specific clients**, **update it** on a timeline as it develops,
  and **mark it resolved**. Clients see an always-on **in-app banner** plus a status
  feed; how loudly it's sent (email · push · SMS) follows the **severity**
  (info/maintenance → email, degraded → +push, outage → +SMS). Authored in
  **Admin → 🚨 Status**; read-only for clients. (See §11.)
- **2026-06-27** — **Image upload specs** ✅: every logo / icon / banner upload now shows
  short spec guidance (format · size · transparency · how small it renders) right under the
  picker — consistent across the admin console and client self-service, so we get correctly
  sized assets the first time.
- **2026-06-25** — **Share an insight or a tile** ✅: a **Share** button now sits on every
  (titled) tile and on the Owl's per-tile insight and whole-dashboard summary panels. One tap
  hands the finding off to **email, WhatsApp or Slack** — the reader can add a personal note,
  and we attach the insight/value text plus a link back to the view. Client-side hand-off (opens
  the reader's own mail/WhatsApp/Slack; Slack copies a ready-to-paste message), so it works on
  any phone or desktop with no setup.
- **2026-06-25** — **Live Pulse — the header heartbeat** 🧪: the top header (desktop) now
  streams a rotating, colour-coded **beat** of what's happening right now — **alert fires**
  plus **live tile momentum** ("+142 Tickets sold in the last hour", "+R8 500 Gross revenue").
  Momentum snapshots a client's key single-value tiles on a slow tick and shows the movement;
  it auto-picks the key tiles for now (hand-picking comes later). Taps through to Alerts.
- **2026-06-25** — **Ask — AI Data Analyst** 🧪: a conversational analyst (the Owl)
  clients open from the floating owl or the top-bar **Owl Data Analyst** button —
  ask about your data in plain language, scoped to the client. Opens **in-app**
  (docked beside dashboards by default, or overlay — A/B toggle), with a text-size
  control and an animated AI border. Powered by **Inventive** (per-client workspace
  setup). Embedded speed is bounded by third-party-iframe storage limits — being
  worked through with Inventive.

- **2026-06-24** — **Social metrics (organic)** 🟡🧪: pull a client's Facebook /
  Instagram / TikTok organic stats into Pulse — daily account trends (followers,
  reach, impressions) + per-post engagement, on a new mobile-first **Social** page
  (client self-service + admin). Reuses the Meta/TikTok connection (add the Page /
  IG account id in Integrations); syncs daily with a one-tap refresh. Connectors
  unit-tested; live API check pending real credentials. Dashboard-tile surfacing
  is the next step.
- **2026-06-24** — **Your Howler Support on the client's Team page** ✅: every client
  now sees who at Howler looks after them — name, job title and an email link — under
  **Settings → Team**. Howler can assign more than one contact and repoint them per
  client.
- **2026-06-24** — **Integration safety + self-service connect** ✅: each integration
  is **locked by default** (a 🔒 guard against accidental edits to a live connection —
  Owner/admin unlocks to change, the setup guide stays readable while locked), and an
  unconnected ad platform now offers a **Connect Meta/TikTok →** button that opens the
  right Settings page. Integration cards collapse for a cleaner page.
- **2026-06-24** — **Notifications: choose channel per type** ✅: mute a category
  (digests / goals / alerts / messages) on **email** while keeping it on **push** (or
  vice-versa) — a per-channel switch instead of one all-or-nothing toggle.
- **2026-06-24** — **Smarter source pickers** ✅: building a **segment** only offers
  dashboards/tiles that actually hold contact data (email/mobile), and building a
  **goal** only offers tiles you can track (a KPI number or a time series) — no more
  dead-end picks.
- **2026-06-24** — **Dashboard summary docks beside the dashboard** ✅: the Owl's
  whole-dashboard summary opens as a side panel that pushes the dashboard across (no
  overlay), so you can read the write-up next to the live tiles.
- **2026-06-24** — **Segment builder is event-first** ✅: when building a segment
  from a dashboard tile, multi-event clients now pick the **event (suite)** first,
  then only that event's dashboards are listed — so a segment is clearly tied to
  the right event instead of scrolling one long mixed dashboard list.
- **2026-06-24** — **Per-channel notification control** ✅: in **Settings →
  Notifications**, each category (Digests · Goals · Alerts · Messages) now has a
  **separate Email and Push switch**, so a client can (e.g.) keep goal **push** on
  but turn goal **emails** off — instead of muting a type everywhere. Existing
  opt-outs carry over to both channels. The in-app inbox always receives.
- **2026-06-24** — **Ad audiences hub (client self-service)** ✅: new **Engage → Ad
  audiences** tab gives clients a single, mobile-first view of every audience Pulse
  mirrors to Meta/TikTok — connection health, a one-tap **Verify connection**, and
  **live match-size / availability** read back from the platform — so they can see
  what's actually live without opening Ads Manager. Also fixed the TikTok push
  (file checksum + create-audience fields) and **verified it end-to-end against a
  live TikTok ad account**.
- **2026-06-23** — **Per-client dashboard versions** ✅: editing a shared dashboard from a
  client's view now offers **Save current** (update the template for everyone) or **Save as
  new** — forking a **client-owned version** (pick its folder + set) that only that client
  sees and that edits independently of the template. The editor shows a **Shared template /
  {Client} version** badge, and **↩ Revert to template** discards the copy and re-points the
  client back at the shared one. Also: editing from a client view now loads that client's
  actual filters (locks + saved view), so previews/Results match what they see.
- **2026-06-23** — **Edit a dashboard's locks in-context** ✅: an admin viewing a client's
  dashboard can now click a locked filter (or **🔒 Edit locks for this dashboard**), change
  the values, tick **Lock here**, and save — it writes the per-dashboard lock override for
  that client straight from the dashboard view (same store as the suite editor).
- **2026-06-23** — **Suite setup & navigation polish** ✅: when bundling a client's
  suite, sets now group by **folder → set → dashboards**, and you can tick **individual
  dashboards** in a set (include a subset for one client instead of all-or-nothing). New
  **per-dashboard locked filters** let an admin pin a filter (e.g. a specific event) on a
  single dashboard for one client while the rest of the suite keeps the suite-wide locks.
  Across the app, **back buttons** now appear on the dashboard view, the editor, folders and
  the mobile menu bar; the in-dashboard **carousels** resize to fit a smaller desktop window,
  and swiping a carousel on a phone no longer jumps to the next dashboard.
- **2026-06-22** — **Goal tags** ✅: tag a goal with an operational area (Ticketing,
  Cashless, Access control, …, or a custom one); the Goals page now groups goals into
  **one row per tag**. Mix/split goals also gained an **Owl commentary** line in their
  detail view, and now appear in the **rings summary** (represented by their focus slice).
- **2026-06-22** — **Alerts: templates + Ticket Type/Category starters** 🧪: alerts can now be
  **saved as reusable templates** — a client's own, or (admins) **🌐 global** templates pushed to
  every client (they re-link to each client's matching data by name). A **Templates** tab on the
  Alerts page lists and reuses them. The "Start from" gallery gains **🎟 Ticket type** and
  **🏷 Ticket category** starters that jump straight into a pre-filtered metric — pick the value +
  measure + number. The metric builder now reads **data → filter → measure** (filter first).
- **2026-06-22** — **Mix / split goals — richer visuals & last-year movement** ✅: per-slice
  tiles now show their **live number** as you build the goal; add an optional **last-year
  tile per slice** to surface the **movement** (▲/▼ pp vs last year) in the legend; and a
  mix/split goal can render as a **stacked bar, donut or dial** (with target-boundary
  markers), matching the other goal types. **Range goals** also now read the **real
  percentage** when over the band (e.g. *105%*) instead of capping the dial at 100%.
- **2026-06-22** — **Alerts: custom metric source** 🧪: alerts can now watch a metric
  that has **no dashboard tile** — pick a measure and filter it by a dimension like
  **Ticket Type** or **Category** (e.g. "tickets sold where Ticket Type = VIP"), with
  the filter value chosen from a real, scoped list of values. The picker only offers
  data sources the client already uses, and every read runs through the same per-client
  + per-event scope boundary as a tile, so it can't reach another client's or event's
  data. Removes the "an admin must build a tile first" step for slice-level alerts.
- **2026-06-22** — **Per-event branding** ✅ (dual-surface): a client running several events can now
  give **each event its own logo, colours and sender name**. It layers on top of the client's
  branding — anything left blank inherits the client (which inherits Howler) — so you override only
  what differs. An event's branding is used for **its campaigns**, **its single-event digests**, and
  the **in-app theme while viewing that event**; multi-event/portfolio digests stay on the client's
  branding. **Self-service:** clients manage it themselves in **Settings → Branding**, which is now
  split into **Account & portfolio** (their overall look) and **Events** (pick an event, brand it);
  Howler can also set it in the event (suite) detail → **Event branding**. Emails still send from
  Howler's verified domain by default — or the client's own verified custom domain
  (per-client) — so "different mailer per event" means a different look + sender
  display name; the sending address is per client, not per event.
- **2026-06-22** — **Alerts** 🧪 (new): clients (and Howler on their behalf) can set an
  **alert on any metric** — point it at a dashboard KPI tile and Pulse watches that live
  number, firing the moment it crosses. Three types out of the box (**🎉 sold out**,
  **⚠️ low stock**, **📈 crosses a number**) from a **template gallery**, delivered to the
  **inbox + push + email + SMS**. Edge-triggered with **cooldown**, **quiet hours** and a
  **once/every-time** choice so it never spams; each alert keeps a **fire history** and a
  **Test** button. Mobile-first, dual-surface, and scoped per client (an alert can only
  watch that client's data). Wave 1 of the alerts engine — surge/stall detection and
  AI-written messages come next.
- **2026-06-22** — **Multi-event digests** ✅: scheduled digest emails now understand clients
  running several events at once. The email leads with a **portfolio summary** (the cross-event
  story + top KPIs), then a **clearly-separated section per event** — each with its own headline,
  KPIs, narrative and suggested actions, so numbers from different events never blur together.
  The digest editor gains an **Events picker** (admin + client self-service): choose exactly which
  events a digest covers (defaults to all). Works for both AI-led and curated digests; single-event
  clients are unchanged.
- **2026-06-22** — **"Make it happen" pre-fills the right audience** ✅: when a client turns
  a **Worth a look** suggestion (e.g. recover abandoned carts) into a campaign, the editor now
  opens **pre-loaded with the audience source from that exact tile and event** — the right
  dashboard, the email/name/ticket/consent columns, and (for multi-event clients) **scoped to
  the event the suggestion was about**, so the preview, targeting and send all resolve the
  right cohort. Less setup, fewer wrong-event sends.
- **2026-06-22** — **Multi-event home briefing** ✅: for clients running several events
  at once, the home briefing now leads with a **portfolio summary across all events**
  (totals, biggest mover, what needs attention), then a **collapsible section per event**.
  Readers **choose which events** to include (defaults to active/on-sale events; past
  events off). The overall summary lands first, then the per-event sections fill in, so
  it stays fast. Single-event clients are unchanged.
- **2026-06-22** — **Goals — reusable templates + smarter forecast** 🧪: save a goal's setup
  as a **template** and start new goals from it (recurring monthly/quarterly targets in a
  tap); Howler can publish **🌐 global templates** to every client. Forecast now **blends recent run-rate (momentum)** with the last-time shape; the
  comparison defaults to **last year** with a **"Compare against" year picker**; "vs last
  time" reads the **same calendar day**; and the chart labels **real dates** for calendar
  goals (vs "days before event") and trims lagging flat data so **actual** ends on the last
  real sale.
- **2026-06-21** — **Goals — forecast chart & weekly nudge** 🧪: curve-linked goals get a
  **sell-curve & forecast chart** (last time · actual · a followable forecast line that
  hugs last event's remaining shape to its projected landing, with target + "you are
  here"). A calm **weekly "your goals this week" push** summarises what needs attention
  (behind · forecast short · checkpoint missed) plus wins; staff can fire a **test nudge**.
  The **digest goals paragraph** now also celebrates **wins** (goals reached/smashed,
  checkpoints hit) and flags **missed checkpoints** — not just pace and forecast.
- **2026-06-20** — **Goals in the digest** 🧪: a scheduled digest can now include a
  **goals summary** paragraph (toggle in the digest editor) — the event's targets with
  live progress, pace, vs-last-time and projected finish, leading with the North Star.
- **2026-06-20** — **Goals — pace, forecast & comparisons** 🧪: goals now read pace
  off **last event's real sell-curve** (days-before-event), show **vs last time** and
  a **projected final landing** on the card, let you set the baseline from a **picked
  dashboard tile** (remembered + live), suggest **checkpoints** on the same math, and
  support **drag-to-reorder** (carries to the home dashboard). Also: the briefing now
  **leads with ticketing** (not a reps board) and **GA4 tiles read their saved date
  range** so they stop coming back empty.
- **2026-06-19** — **Goals (Results pillar)** 🧪: set a **target** on the numbers
  that matter for an event and track them live. Each event gets a **North Star**
  plus secondary goals on the home, with a **progress bar + pace read**
  (ahead/on-track/behind) and an end-of-event **result band**. Set a goal from a
  **live dashboard tile** (tracks the real number) or **manually** (sponsorship,
  cash targets). Dual-surface (client + Howler-on-behalf). *(P1; briefing
  North-Star line + baseline onboarding next.)*
- **2026-06-19** — **Getting-started polish + Meta/TikTok step** 🧪: added a **“Connect
  Meta & TikTok”** step to the Getting started checklist (auto-ticks once an ad
  account is connected, with a guided walkthrough). Every walkthrough now has a
  **“do it now” button on its last slide** too, and all the **“Go” buttons land on
  the right place** — Settings opens the correct section (branding/team/notifications/
  integrations) and the dashboards step opens an actual dashboard instead of bouncing
  to home.
- **2026-06-19** — **One-touch install & notifications in the wizard** 🧪: the welcome
  wizard now has a dedicated **“Add Pulse to your phone”** step with a one-tap
  **Install** button (native prompt on Android/desktop; Add-to-Home-Screen guidance
  on iPhone), and the notifications step turns on push with a single tap. Usage
  tracking widened too — opening a dashboard and asking the Owl for an insight now
  feed the **Admin → Onboarding** feature-usage view.
- **2026-06-19** — **Onboarding that learns** 🧪 (internal): the wizards now record
  a usage **funnel** (open → step → skip/complete) and **feature usage**, surfaced
  in **Admin → Onboarding** with plain recommendations ("most people drop at step
  X — simplify it"). Two safe automatic touches: the welcome wizard **skips steps a
  client has already done**. Bigger flow changes stay human-decided on purpose (no
  silent auto-rewriting from a noisy signal).
- **2026-06-19** — **Guided onboarding & in-app walkthroughs** 🧪: the "Getting
  started" checklist is now a **guided-learning layer**. Brand-new clients get a
  one-time **welcome wizard** (branding → team → notifications) on first login;
  the checklist tasks are reworded and grouped into plain phases (*Make it yours ·
  Stay in the loop · See & act on your data*), each with a **"Show me how"**
  walkthrough. A **"Learn" launcher** on the home page explains the things people
  miss at a glance — **how the home page works, tuning your briefing, pinning vs
  following tiles, and how the Owl's AI insights work**. All copy lives in one
  editable place; mobile-first throughout.
- **2026-06-18** — **Owl auto-ingest for settlements & invoices** 🧪: CC the Owl
  on the settlement/invoice email you send a client and Pulse files it
  automatically — reads the PDF, cross-checks the totals, and **auto-publishes**
  to the client (trusted Howler senders only); anything that doesn't reconcile is
  held as a draft for review. Configurable under Admin → Integrations (kill-switch
  + trusted-sender allowlist). No manual upload step.
- **2026-06-18** — **Campaign costs & billing** 🟡: per-channel rate card — a
  platform **master** rate (Admin → Billing) with optional **per-client** fees
  (Admin → client → Fees; blank inherits master). Campaigns show an **estimated
  cost before sending** (audience reach × rate) and **actual cost** on the report;
  clients see their rates + spend under **Settings → Fees & billing**, and Howler
  gets a **spend rollup** across all clients. Per message sent, ZAR. (ROI/revenue
  attribution is a planned follow-up.)
- **2026-06-17** — **Digests can carry followed tiles** ✅: a digest (AI-led *or*
  curated) can now **include the client's followed tiles**, and optionally render
  them in the email — chart tiles as a **graph image** (rendered server-side),
  single-value tiles as a **metric chip**. Set per digest in the editor.
- **2026-06-17** — **Email templates** (Engage → Templates ✅): save reusable email
  content (subject + body or custom HTML + hero + CTA) with a live preview, then
  "Start from a template" or "Save as template" right inside the campaign builder.

- **2026-06-17** — **Onboarding checklist**: a light-touch "Getting started" card on
  the client home — steps auto-tick as they're done (branding saved, team invited,
  first segment/campaign, digest scheduled…) with deep-link CTAs + manual ticks;
  hides once complete/dismissed. Admins can read any client's setup progress.
- **2026-06-17** — **Digest feedback loop**: every digest is archived in-app, with
  👍/👎/💬 feedback buttons in the email (no login), reply-to-the-Owl, and an in-app
  archive to react to past digests. All feedback is AI-distilled into a per-client
  "preferences" note that future digests **and** briefings honour — the digest gets
  smarter the more it's used.
- **2026-06-16** — Added **"The continuous comms loop"** section (live data →
  briefing/digest + suggested actions → campaigns → tracked results → next read),
  and called out the **installable web app (PWA) with push notifications** as the
  channel that keeps the loop moving on the client's phone. Updated the positioning
  cheat-sheet (the loop + improved hook).
- **2026-06-16 (later)** — Drip steps now have the **full content editor per step**
  (built template *or* custom HTML, hero image, subject/body/CTA) — same as a once-off
  email. Digest fix: send up to 40 tile rows so daily series isn't truncated mid-month.
  Dashboard library: name sort + Tile/List view (List default); persistent folder-level
  "imported filters".
- **2026-06-16** — Engage hardening: multi-source segments (Union/Intersect/
  Exclude) incl. CSV/Sheet/saved-segment blocks with per-block filters; column
  matching + target-any-column on uploaded/Sheet lists; merge fields from any
  column; drip **timing toggle** (fresh-abandonment vs forward-from-send); per-step
  **open/click rates + drop-off** in the journey waterfall; promo code now appended
  correctly to the buy link (before UTM); Meta **and** TikTok audience sync
  (mirror + daily auto-sync); digests/briefings anchor to the send date. Initial
  version of this overview.
