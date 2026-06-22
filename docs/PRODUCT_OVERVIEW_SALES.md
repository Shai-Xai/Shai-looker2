# Pulse — Product Overview (Sales & Account Managers)

> **Audience:** Howler sales & account-management teams. Plain-language guide to
> what Pulse does and the value to pitch. For the technical/architecture view see
> `PROJECT_OVERVIEW.md`; for the vision see `docs/EXPERIENCE_OS_BRIEF.md`.
>
> **Last updated:** 2026-06-22 · **Maintained:** updated as features ship (see the
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
- **Personalised home briefing** ✅ — each client lands on an AI-written summary of
  what matters right now (leads with ticketing/revenue), tailored to what they
  follow and view.
- **Mobile-first + installable** ✅ — works great on a phone, installs as an app.

**Pitch:** "Your data, read for you — no digging. Open the app and you already
know what changed and what to do."

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
- Requires connecting the client's ad account (access token + ad account) in
  Integrations. *Note: end-to-end push is pending live verification with a real ad
  account.*

**Pitch:** "Turn a Pulse audience into a Meta/TikTok ad audience in a click — keep
it auto-synced, and exclude people who already bought."

## 6. White-label branding & integrations  ✅ / 🟡
- **Per-client branding** ✅ — logo, colours, email sender display name and
  wording. Emails look like the client, sent from Howler's verified domain.
- **Integrations** (dual-surface: Howler-managed *and* client self-service):
  - **Looker** / **Anthropic (AI)** keys ✅ (fall back to Howler defaults)
  - **Email (Resend)** ✅, **SMS (Clickatell)** ✅
  - **Meta / TikTok** ad accounts 🟡
  - **Inventive** embedded AI analyst 🧪 ("Ask")
- **Secrets are write-only** — Pulse shows only whether a value is set, never the
  value.

**Pitch:** "It's their brand, their accounts, their data — Howler just powers it."

## 7. Admin console (Howler internal)  ✅
- Manage **clients**, their **dashboards/sets/suites**, the **tile library**, **AI
  instructions**, **integrations**, **settlements**, **logins/roles**, backups.
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
  **New vs Returning**, **age bands**, local/international, ticket tiers, channels. Pick a
  breakdown tile, set each slice's target share, and the goal shows the actual split as a
  stacked bar — **✓ Balanced** when every slice sits in its band, **⚠ Mix drifting** when
  one slips (e.g. Returning creeping up while New starves). Mark a **focus slice** to grow.
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
