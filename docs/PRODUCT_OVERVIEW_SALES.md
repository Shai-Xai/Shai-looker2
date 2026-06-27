# Pulse — Product Overview (Sales & Account Managers)

> **Audience:** Howler sales & account-management teams. Plain-language guide to
> what Pulse does and the value to pitch. For the technical/architecture view see
> `PROJECT_OVERVIEW.md`; for the vision see `docs/EXPERIENCE_OS_BRIEF.md`.
>
> **Last updated:** 2026-06-27 · **Maintained:** updated as features ship (see the
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

## The continuous comms loop  ✅ (one-tap "Owl auto-pilot" 🔜)
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

> Today Pulse **surfaces** the insight + suggested action and **measures** the
> result. Closing the loop with a single tap — the **agentic Owl** drafting the
> campaign straight from a suggestion — is the flagship roadmap item (🔜).

**Pitch:** "It's not dashboards *and* email *and* reports — it's one living loop.
Your data tells you what to do, you do it in the same place, the result makes the
next call smarter — and it pings the client's phone to keep the loop moving. The
longer they use Pulse, the better it gets."

---

## 1. Dashboards & insight  ✅
- **Live dashboards** — KPIs, tables and charts built on the client's real
  ticketing/GA4 data. Howler builds the metrics; Pulse owns the whole interface
  (no clunky Looker embeds). Drill-through into detail.
- **Per-tile AI insight** ✅ — tap any tile and the Owl explains what the numbers
  mean in plain English, and answers follow-up questions, grounded in that data.
- **Share an insight or a tile** ✅ — a Share button on any tile and on the Owl's
  insight/summary panels hands the finding off to **email, WhatsApp or Slack** in
  one tap, with room to add a personal note and a link back to the view.
- **Personalised home briefing** ✅ — each client lands on an AI-written summary of
  what matters right now (leads with ticketing/revenue), tailored to what they
  follow and view.
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

**Pitch:** "Build the exact audience from your own data or a spreadsheet — combine
lists, subtract a suppression list, and it stays live."

### 5b. Campaigns — email & SMS  ✅
- Send **email, SMS, or both** to a segment, tile or pasted list.
- **AI-drafted copy** you can edit; branded template or custom HTML; hero image.
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
  named or "Howler" approvers, notified via inbox/push/email.

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

## 6. White-label branding & integrations  ✅ / 🟡
- **Per-client branding** ✅ — logo, colours, email sender display name and
  wording. Emails look like the client, sent from Howler's verified domain.
  Every logo/icon/image upload now shows **clear spec guidance** (format, size,
  transparency) right under the picker, on both the admin and client surfaces —
  so the assets we get back are the right shape first time.
- **Dark-mode logo** ✅ (dual-surface) — an optional second logo for dark mode.
  If a client's logo is a dark/black mark it can vanish on the dark header, so
  they (or we) can upload a light version that's used automatically in dark mode.
  Leave it blank and Pulse shows the normal logo on a subtle light chip so it
  always stays legible. Emails always use the main logo.
- **Integrations** (dual-surface: Howler-managed *and* client self-service):
  - **Looker** / **Anthropic (AI)** keys ✅ (fall back to Howler defaults)
  - **Email (Resend)** ✅, **SMS (Clickatell)** ✅
  - **Meta / TikTok** ad accounts 🟡
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
- **Dual-surface** — clients set their own alerts; Howler can set them on a client's
  behalf during onboarding so the first week already feels proactive.
- **Live Pulse strip** 🧪 — a glanceable, colour-coded **beat in the top header**
  (desktop) that streams what's happening right now: **alert fires** *and* **live
  momentum** off the client's key tiles ("+142 Tickets sold in the last hour", "+R8 500
  Gross revenue"). Rotates one at a time, newest first, and taps through to Alerts. The
  product, literally beating. *(Desktop for now; urgent alerts already reach the phone
  via push. Momentum auto-picks key tiles today; hand-picking comes later.)*

**Pitch:** "Stop watching dashboards — tell Pulse the number that matters and it taps
you on the shoulder the moment it happens, on whatever screen you're on."
*Checked every few minutes (data refreshes on the ~30-min pipeline). Coming next:
sales-surge/stall detection, AI-written alert messages, and one-tap actions from the
alert itself.*

---

## On the horizon (🔜 — not yet usable; for roadmap conversations only)
Use these to set direction, **not** to promise dates.
- **Conversational/agentic Owl** — chat that answers, analyses and *executes*
  (draft a campaign, remind an organiser…). The flagship.
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

- **2026-06-27** — **Dark-mode logo** ✅ (dual-surface): an optional second brand logo for dark
  mode, in admin branding *and* client self-service (account + per-event). In dark mode Pulse uses
  the dark logo when set; if it's blank, the normal logo is shown on a subtle light chip so a
  dark-ink logo never disappears against the dark header. Emails always use the main logo.
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
  Howler's verified domain, so "different mailer per event" means a different look + sender display
  name, not a different sending address.
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
