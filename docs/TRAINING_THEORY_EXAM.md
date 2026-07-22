# Pulse — Sales & CS Theory Exam (question bank + answer key)

> **Audience:** the trainer building the theory exam in an external quiz system.
> **Do not hand this file to trainees** — it contains the answer key.
> Companion docs: `docs/TRAINING_SALES_CS.md` (course pack) and the practical
> exam in Admin → **🎓 Training** (https://howler-pulse-v2.onrender.com/admin).
> Facts are grounded in `docs/PRODUCT_OVERVIEW_SALES.md` — if the product moves,
> update the questions with it.

## Running it in another system — recommendation

- **Google Forms in quiz mode** (https://forms.google.com) is the fastest fit:
  the team already lives on Google, it self-marks MCQ/true-false instantly,
  locks in an answer key with per-question feedback, and exports results to
  Sheets. Setup: New form → Settings → **Make this a quiz** → paste the
  questions below → set the answer key + 1 point each → Settings → collect
  email + limit to 1 response.
- Any equivalent works the same way (Quizizz https://quizizz.com, Kahoot
  https://kahoot.com, or your LMS) — the bank below is deliberately
  copy-paste-plain.
- **Structure:** 35 auto-marked questions (sections A–F) + 3 short-answer
  scenario questions (section G, hand-marked). Suggested time **40 minutes**,
  pass mark **70%** (aligned with the practical exam).
- Shuffle question and option order if your platform supports it.

Correct answers are marked **(✔)**; short explanations follow each section for
marker feedback.

---

## Section A — What Pulse is (positioning)

**A1.** Pulse is best described as…
A. A Looker dashboard skin — B. An email marketing tool —
C. **Howler's Experience OS: data turned into insight → action → results in one white-label platform (✔)** —
D. A ticketing system

**A2.** The "continuous comms loop" means:
A. Weekly reports are emailed automatically —
B. **Live data feeds briefings/digests with suggested actions; you act via campaigns; results flow back into the data and sharpen the next read (✔)** —
C. Clients can chat to Howler — D. Campaigns repeat on a schedule

**A3.** Versus Mailchimp/Klaviyo, Pulse's key difference is:
A. It's cheaper — B. It sends faster —
C. **Audiences and campaigns are powered by the same governed data that drives the dashboards — see a cohort, act on it, measure it in one place (✔)** —
D. It has more templates

**A4.** True/False: Pulse is an installable web app (PWA) that can deliver push
notifications even when closed. — **True (✔)**

**A5.** "Mobile-first" at Howler means:
A. There is a separate iOS app —
B. **Every UI must look and work great on a phone before desktop is considered (✔)** —
C. Desktop is unsupported — D. Only dashboards work on mobile

**A6.** The honest status key on the sales overview: what does 🧪 mean?
A. Live — B. Needs setup — C. **Beta/limited — position carefully, don't overclaim (✔)** — D. Coming soon

*A explanations: the one-liner and loop are the backbone of every pitch; the
data-to-action difference is the competitive wedge; 🧪 features are pitched as
"early access", never as fully live.*

## Section B — Insight: dashboards, briefing, digests

**B1.** The client content hierarchy is:
A. Dashboards → Sets → Suites — B. **Suites (event context) → Sets (dashboard groups) → Dashboards (✔)** —
C. Folders → Files — D. Events → Tickets → Reports

**B2.** A client logs in and sees…
A. All Howler clients' data — B. Whatever they search for —
C. **Only their own dashboards, force-scoped to their organiser/events on the server (✔)** —
D. A demo dataset

**B3.** Scheduled digests can be tailored by:
A. Nothing, one format — B. **Reader role/lens (exec, marketing, finance…), cadence, timezone and recipients (✔)** —
C. Font size only — D. Language only

**B4.** True/False: per-tile AI insights and the home briefing are generated
from the client's own scoped data. — **True (✔)**

**B5.** "Ask" (the Owl) lets a client:
A. Edit LookML — B. **Ask questions of their own event data in plain language and get grounded, cited answers (✔)** —
C. Email support — D. Change their scope

**B6.** Drill-through on a dashboard tile does what?
A. Deletes the tile — B. **Opens the underlying rows behind the number (✔)** —
C. Emails the chart — D. Changes the query for everyone

## Section C — Action: segments & campaigns (Engage)

**C1.** A segment is:
A. A frozen list exported once — B. **A named, always-live audience definition that re-resolves at use/send time (✔)** —
C. A dashboard filter — D. An email template

**C2.** Segment sources include: (multi-select)
**Dashboard tile (✔)** · **Uploaded CSV/Excel (✔)** · **Pasted list (✔)** ·
**Linked Google Sheet, read live (✔)** · Instagram DMs (✘)

**C3.** "Abandoned-cart people minus an uploaded 'already called' list" uses
which combine mode? A. Union — B. Intersect — C. **Exclude (✔)** — D. Merge

**C4.** Linking a segment to an event does what?
A. Renames it — B. **Groups it in the list AND scopes its resolution to that event only — it never silently widens (✔)** —
C. Makes it read-only — D. Shares it with other clients

**C5.** True/False: a campaign can send without any approval if the author is in
a hurry. — **False (✔)** (nothing sends without explicit approval)

**C6.** Who can be an approver? (multi-select)
**Named client approvers (✔)** · **A specific Howler team member on the account (✔)** ·
**The generic "Howler" slot — any Howler member linked to the client (✔)** · Any member of the public (✘)

**C7.** Merge fields let you personalise with:
A. Only {{name}} — B. **{{name}}, {{ticketType}} and ANY column from the audience (✔)** —
C. Nothing — D. Subject lines only

**C8.** The SMS sub-cap exists because:
A. SMS is unreliable — B. **SMS costs real money per message — the cap stops a large email send from firing an equally large SMS blast; 0 switches SMS off for that client (✔)** —
C. Networks block bulk SMS — D. It's a POPIA rule

**C9.** POPIA consent in campaigns works how?
A. It's ignored — B. **Per-channel marketing consent is shown at preview and enforced at send, with one-click unsubscribe; a transactional override exists for genuinely non-marketing messages (✔)** —
C. Only email needs consent — D. Consent is assumed after purchase

**C10.** Campaign results tracked per recipient include:
A. Nothing — B. Opens only —
C. **Opens, clicks, conversions/revenue (promo + UTM), per journey step (✔)** — D. Screenshots

## Section D — Results: goals & alerts

**D1.** A goal in Pulse is:
A. A to-do item — B. **A measurable target for an event (e.g. tickets, revenue) tracked live against the data, with an optional North Star (✔)** —
C. A KPI on a slide — D. A budget line

**D2.** Alert rule types include: (multi-select)
**Threshold (✔)** · **Low-stock/depletion (✔)** · **Sold-out (✔)** · Sentiment (✘)

**D3.** Alert delivery channels can be: (multi-select)
**Push (✔)** · **Email (✔)** · **SMS (✔)** · Fax (✘)

**D4.** True/False: alerts support quiet hours, and an "important" priority can
break through them. — **True (✔)**

**D5.** On event day, "Live updates" gives the team:
A. A phone call — B. **A compact multi-metric snapshot on a cadence (gates pace, bar revenue, top outlets, device health) to inbox/push/WhatsApp (✔)** —
C. A daily PDF — D. Nothing until the debrief

## Section E — Comms & documents

**E1.** The messaging inbox connects:
A. Clients to each other — B. **A client and Howler, in threads with priorities, read/ack receipts and push/email notification (✔)** —
C. Pulse to WhatsApp groups — D. Trainees to trainers

**E2.** Settlements & documents in Pulse:
A. Are emailed only — B. **Live in the client's portal — settlements and event documents in one scoped place (✔)** —
C. Are public — D. Don't exist yet

**E3.** True/False: campaigns send from one verified Howler domain; per-client
branding is the look (logo, colour, sender display name), not the sending
address. — **True (✔)**

**E4.** A client-facing "status notice" is used to:
A. Advertise — B. **Keep clients informed during platform issues/maintenance (✔)** — C. Collect feedback — D. Bill clients

## Section F — Setup, admin & trust

**F1.** The right order to stand a client up (Setup wizard):
A. Campaign first — B. **Create client + scope → suites & sets → branding → logins & roles → integrations (✔)** —
C. Logins first, scope later — D. Any order, nothing depends on anything

**F2.** The "dual-surface rule" means:
A. Two monitors — B. **Everything Howler can configure for a client, the client can also self-serve in their own Settings, scoped to them (✔)** —
C. Light + dark mode — D. Web + mobile

**F3.** Client roles exist because:
A. Pricing tiers — B. **Different people at a client need different powers — e.g. a Viewer sees dashboards only; approving/sending campaigns needs the permission (✔)** —
C. Legal requires it — D. They don't

**F4.** API keys / secrets pasted into Pulse are:
A. Visible to admins — B. **Write-only: responses only ever report "set" + a mask, never the value (✔)** —
C. Emailed for backup — D. Stored in the browser

**F5.** If a client has NO data scope configured, queries…
A. Show all data — B. **Fail closed — they return nothing rather than risk leaking another client's data (✔)** —
C. Show demo data — D. Ask the user

**F6.** True/False: one client can see another client's audiences if they guess
the URL. — **False (✔)** (scoping is enforced server-side, not in the browser)

## Section G — Scenarios (short answer, hand-marked, 5 pts each)

**G1.** A prospect says: *"We already have Mailchimp and a BI tool — why
Pulse?"* Write your 3-sentence answer.
*Marking guide: one loop not separate tools; campaigns driven by the same
governed live data as the dashboards; white-label + scoped + measured results
feeding the next decision. Bonus: PWA/push, approvals.*

**G2.** A client asks: *"How do I know my competitor on your platform can't see
my numbers?"* Write the trust answer.
*Marking guide: server-side force-scoping per organiser/event, cannot be
bypassed from the browser, fails closed with no scope; write-only secrets; no
cross-client pooling (POPIA).*

**G3.** An organiser wants to "email everyone who abandoned checkout, except
people we already phoned, with their own discount code — and prove it worked."
Name the Pulse pieces you'd use, in order.
*Marking guide: segment (abandoned source, Exclude the uploaded phoned list) →
email campaign with merge fields + unique promo codes → approval → open/click +
promo/UTM conversion tracking → results in the campaign report/dashboards.*

---

### Answer key summary (auto-marked sections)

A: 1-C · 2-B · 3-C · 4-True · 5-B · 6-C
B: 1-B · 2-C · 3-B · 4-True · 5-B · 6-B
C: 1-B · 2-(tile, CSV/Excel, pasted, Sheet) · 3-C · 4-B · 5-False · 6-(client, Howler member, Howler slot) · 7-B · 8-B · 9-B · 10-C
D: 1-B · 2-(threshold, depletion, sold-out) · 3-(push, email, SMS) · 4-True · 5-B
E: 1-B · 2-B · 3-True · 4-B
F: 1-B · 2-B · 3-B · 4-B · 5-B · 6-False
