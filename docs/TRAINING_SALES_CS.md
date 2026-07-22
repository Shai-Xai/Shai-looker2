# Pulse — Sales & Client Services Training Pack

> **Audience:** the trainer/facilitator running the sales & client-services
> training, and the trainees themselves (it doubles as the course handout).
> Pairs with `docs/TRAINING_THEORY_EXAM.md` (the theory question bank) and the
> in-app practical exam (Admin → **🎓 Training** on
> https://howler-pulse-v2.onrender.com/admin).
>
> Source of truth for feature detail: `docs/PRODUCT_OVERVIEW_SALES.md` (kept
> current as features ship) and the live product itself.

## What the training produces

By the end, every salesperson and account/client-services person can:

1. **Pitch Pulse in one breath** — the Experience OS: *insight → action →
   results*, one living loop, white-label, mobile-first, scoped per client.
2. **Drive the system themselves** — stand a client up, build a dashboard,
   create segments, draft + submit campaigns, set goals and alerts, schedule a
   digest, and talk to a client through the inbox.
3. **Answer the buyer's hard questions** — data security & scoping, POPIA,
   approvals, what's live vs beta (be honest — use the ✅/🟡/🧪/🔜 status key).

Both exams gate a pass: the **theory exam** (external system — see
`docs/TRAINING_THEORY_EXAM.md`) and the **practical exam inside Pulse** (the
system grades itself — see "The practical exam" below).

---

## Before the day — facilitator prep checklist

- [ ] **Create a sandbox client** in Admin → Clients (e.g. "Training FC") with a
      real organiser scope so dashboards return data, or accept empty tiles and
      focus on flows. **Never run training inside a live client.**
- [ ] Give the sandbox client 1–2 **suites** with dashboard **sets** attached, so
      trainees can see a "finished" example before building their own.
- [ ] **Admin logins for every trainee** (Admin → Users) — trainees take the
      practical under their own login; the exam matches attempts by email.
- [ ] Build the **practical exam** in Admin → 🎓 Training: pick the sandbox
      client, tick the tasks, set the pass mark (default 70%) and time limit,
      then add the trainees — each gets a personal exam code (e.g. `PX-7Q2M`).
- [ ] Load the **theory exam** into your quiz system from the question bank
      (`docs/TRAINING_THEORY_EXAM.md`).
- [ ] Projector-check the **demo loop** (module 2) on a phone-sized window too —
      mobile-first is part of the pitch.

## Suggested agenda (1 day)

| Time | Module | Format |
|---|---|---|
| 09:00 | 1. What Pulse is — the loop & the pitch | Talk + discussion |
| 09:45 | 2. The demo loop (briefing → campaign → result) | Live demo |
| 10:30 | 3. Insight: dashboards, briefing, digests, the Owl | Demo + hands-on |
| 11:30 | 4. Action: segments, campaigns, approvals | Hands-on |
| 13:00 | 5. Results: goals, alerts, tracking | Hands-on |
| 13:45 | 6. Client services: standing a client up + the inbox | Hands-on |
| 14:45 | 7. Trust & the hard questions | Q&A drill |
| 15:15 | **Theory exam** (external system, ~40 min) | Individual |
| 16:00 | **Practical exam in Pulse** (60–90 min) | Individual |

Split over two half-days if needed: modules 1–4 on day one, 5–7 + exams on day
two.

---

## Module notes

### 1. What Pulse is (the pitch)
- The one-liner: **"Pulse is Howler's Experience OS — it turns an organiser's
  data into insight → action → results, in one place, branded to them."**
- The loop: live data → the Owl reads it (briefing/digests + suggested actions)
  → you act (campaign/drip to the exact segment) → results come back as data →
  the next read is sharper. **One loop, not a pile of tools.**
- vs Mailchimp/Klaviyo/Looker: campaigns are powered by **the same governed
  data as the dashboards** — see a cohort, act on it, measure it, same place.
- Mobile-first + installable **PWA** with push — the loop reaches the client's
  phone without a login.
- Drill: each trainee delivers the one-liner from memory; the room scores it.

### 2. The demo loop (the money demo)
Run the full circle in under 10 minutes, narrating the loop stages:
briefing insight → "worth a look" → segment → AI-drafted campaign → submit for
approval → show the campaign report (opens/clicks/conversions) → show how that
lands back in the dashboards. This demo is the backbone of every sales meeting.

### 3. Insight
Dashboards (suites → sets → dashboards, per-client scoping, drill-through, tile
AI insights), the home briefing, scheduled digests (role lenses), Ask the Owl.
Hands-on: everyone builds a two-tile dashboard in the sandbox.

### 4. Action (Engage)
Segments (tile / upload / paste / Google Sheet; union–intersect–exclude;
always-live; event-scoping), campaigns (email/SMS, block builder, AI copy +
design, merge fields, promo codes, UTM + open/click tracking), **the approval
gate** (nothing sends without approval), send caps, POPIA consent.
Hands-on: build a segment, draft a campaign, submit it for approval — the exact
tasks the practical exam checks.

### 5. Results
Goals (targets per event, North Star), alerts (threshold / low-stock / sold-out,
channels, quiet hours), live updates on event day, campaign conversion tracking.
Hands-on: set a goal and an alert on the sandbox event.

### 6. Client services — standing a client up
The Setup wizard (Admin → 🧙 Setup wizard) end-to-end: client → scope → suites +
sets → branding → logins + roles → integrations. The **dual-surface rule**:
everything Howler configures for a client, the client can also self-serve in
their own Settings, scoped to them. The inbox: threads, priorities, read/ack,
announcements. Hands-on: each trainee creates a suite, a client login and an
inbox thread in the sandbox.

### 7. Trust & the hard questions (drill)
Server-side scoping that **fails closed**; write-only secrets; POPIA (consent,
unsubscribe, hashed ad-sync, no cross-client pooling); roles & permissions;
approval gates; the honest status key (✅/🟡/🧪/🔜 — never overclaim a 🧪).
Format: rapid-fire objection handling in pairs.

---

## The practical exam (in Pulse)

Lives in **Admin → 🎓 Training** (https://howler-pulse-v2.onrender.com/admin).
How it works:

- The trainer builds an exam from a **catalog of auto-verifiable tasks** and
  points it at the **sandbox client**. Current catalog: create an event suite
  (with sets), create a client login, build a dashboard (≥2 tiles), create a
  segment, draft an email campaign (subject + body), submit it for approval,
  set a goal, create an alert, schedule a digest, start an inbox thread.
- Each trainee gets a **personal exam code** (e.g. `PX-7Q2M`) and must put it in
  the **name of everything they create** — that's how the grader finds their
  work and keeps trainees from colliding in the shared sandbox.
- Trainees open the same Training tab, see **My exams**, hit **Start**, work
  through the checklist, and click **"Check my work"** as often as they like —
  the server inspects the real database for evidence of each task and shows
  what's missing ("campaign exists but has no subject line yet").
- **Submit** runs one final check and locks in the score against the pass mark.
  The trainer watches the live results board (per-trainee progress, per-task
  evidence) and can close the exam when time is up.
- Grading is automatic and identical for everyone — the exam marker is the
  system state itself. For a retake, delete the attempt and re-add the trainee
  (they get a fresh code).

**Cleanup:** after the exam, the sandbox client is full of `PX-…` objects —
delete them (or the whole sandbox client) before the next intake.

## The theory exam (external system)

Runs in your quiz platform of choice; the complete question bank + answer key +
import advice is in `docs/TRAINING_THEORY_EXAM.md`. Keep the pass mark aligned
with the practical (70%) so "passed the training" means one thing.
