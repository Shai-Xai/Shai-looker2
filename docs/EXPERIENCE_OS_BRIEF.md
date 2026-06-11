# Pulse: The Experience Operating System
**Working brief — tasks, comms & the Owl knowledge layer · June 2026 · internal**

## The one-liner
Pulse becomes the operating system for the Howler–organiser relationship: every number, document, task and **conversation** about an event in one place — tracked, searchable, actionable. Organisers keep talking wherever they already talk (email, WhatsApp, Slack); **the Owl is always in the room**, collecting it into the event's single source of truth.

---

## The three layers

### 1. The Playbook (the knowledge)
Everything Howler does to make an event ready — on-sale setup, contracts, staffing, devices, briefing docs, resale, settlement — captured as a reusable template of tasks. Each task knows: who owns it (organiser / AM / ops), when it's due (anchored to the event's dates and phases **we already store**), how it's verified (manual tick / document upload / **data signal** — e.g. "On sale" auto-completes when the first ticket sells), and what it blocks.

### 2. The Spine (the state)
One unified structure under tasks AND messages — a task is just a thread with a due date and a done-state:

- **Threads** anchored to an event, optionally to a subject (task, settlement, dashboard, document — or none, for announcements).
- **Messages** in threads from Howler members, organisers, the Owl, **or ingested from external channels**.
- **Acknowledgements & read receipts** captured — "who saw this, when" finally exists.
- **Priorities:** FYI · needs-reply · must-acknowledge (banner on login until acked).

### 3. The Owl (the voice + memory)
- **Narrates:** the morning briefing folds in ops state — "contract still unsigned, 9 days to launch; your AM replied about devices yesterday."
- **Extracts:** reads every ingested message and *suggests* commitments → tasks ("Howler to deliver 40 devices by the 20th"), decisions, open questions. A human confirms; nothing auto-commits.
- **Recalls:** "What did we agree about staffing?" → answered from the corpus **with the source message cited**. Grounded, like everything Owl does — quotes, never invents.

---

## Ingestion-first: "CC the Owl"
We don't fight the channel war — we ingest it.

| Channel | Mechanism | Effort | Notes |
|---|---|---|---|
| **Email** | Per-event address (e.g. `bushfire@owl.howler.co.za`), inbound webhook (Postmark/Resend) | Low — **start here** | Where contracts & formal agreements already live. Near-free attribution (from/to/date). |
| **Pulse native** | Threads, announcements, task comments | Built on the spine | The only channel with structure (acks, CTAs, due dates) — home for accountability. |
| **Slack** | Owl app invited to shared/Connect channels | Medium | Well-supported APIs. |
| **WhatsApp** | v1: AM forwards key messages to the Owl email. Later: Business number for 1:1s; chat-export ingestion for groups | Deferred | Official API cannot join groups; unofficial bridges risk number bans — not acceptable for client-facing numbers. Pipe is channel-agnostic; WhatsApp plugs in whenever solved. |

**Tactical note:** the email pipe can ship early and *just collect* — the corpus compounds from week one, so by the time extraction/recall ship there are months of knowledge to be smart about.

**Trust rules (non-negotiable):** the Owl's presence is visible and sold as the benefit it is ("minutes taken automatically — nothing falls through the cracks"). Per-client consent toggle. Clear retention policy. Done openly this builds trust; done quietly it destroys it.

---

## Surfaces
- **Organiser home:** "Needs you" block (their open tasks + must-acks) — only shows when non-empty. Briefing mentions urgent items.
- **Event timeline:** one chronological record per event — messages (all channels), docs, tasks, milestones, settlements. Kills the AM-handover problem.
- **Inbox + bell:** unread counts, full history, filter by event.
- **Admin ops board (the AM cockpit):** cross-client view — due this week, overdue, readiness % per event, unanswered messages.
- **Outbound nudges (mailer engine):** organisers don't live in the platform — when something needs them, email reaches out and the reply lands back in Pulse, tracked.

## Build order
1. **Spine + inbox + bell** (unify existing settlement-notes & Investigate onto it)
2. **Announcements + must-acknowledge** — cheapest, highest-leverage; ships the "wow"
3. **Email ingestion** (collect-only is fine) + event timeline
4. **Playbook tasks** (from the workshop output below)
5. **Outbound nudges** via the mailer
6. **Owl layers:** briefing integration → extraction-as-suggestions → recall Q&A
7. Slack ingestion; WhatsApp when the mechanism is settled

**v1 constraints (anti-scope-creep):** Howler↔organiser only; every message anchored to an event; three priority levels; no realtime-chat theatrics (typing/presence). Tracked correspondence, not Slack.

---

## The workshop (where the team comes in)
The build is the easy part — **the playbook content lives in the AMs' and ops team's heads.** One working session, capture into the accompanying spreadsheet (one row per task):

**For every task:** what is it · how is it done (links/templates) · who owns it · when is it due (anchor: Launch±Nd / Event±Nd / phase) · what proves it's done (manual / document / data signal — name the signal) · what does it block · **who communicates about it, on which channel** · does it need a formal acknowledgement · what typically goes wrong.

**Also decide in the room:**
1. The default playbook name + variants needed later (festival vs venue series vs once-off)?
2. Which 5 tasks cause the most pain when missed? (They get must-acknowledge + nudges first.)
3. Which tasks could auto-verify from Looker data? (On-sale, resale-live, cashless-configured…)
4. Consent script for clients re: the Owl in their comms.
5. WhatsApp reality check: which conversations actually happen there, and would AMs forward them?

---

## Data model sketch (for engineering review)
```
playbooks            id, name
playbook_tasks       id, playbook_id, title, description, owner_role(organiser|am|ops),
                     anchor(phase_key | launch±Nd | event±Nd), verification(manual|document|data_signal),
                     data_signal?, blocks[], comms_default(channel, needs_ack), position

threads              id, entity_id, suite_id, subject_type(none|task|settlement|document|dashboard),
                     subject_id?, title, priority(fyi|needs_reply|must_ack), created_by, created_at
messages             id, thread_id, author_type(user|howler|owl|ingested), author_ref(email/user_id),
                     channel(pulse|email|slack|whatsapp), body, attachments[], sent_at,
                     ingest_meta{message_id, from, to, raw_ref}
receipts             message_id, user_id, kind(read|ack), at

event_tasks          id, suite_id, playbook_task_id?, title, owner_role, assignee?, due_at(computed),
                     status(todo|in_progress|blocked|done|na), verification, thread_id,
                     completed_by/at, verified_by(data|human)
extractions          id, message_id, type(task|decision|question), payload(json),
                     status(suggested|accepted|dismissed), reviewed_by/at
```
Everything keys off `suite_id` (the event) — same spine as briefing phases, settlements and documents. Backup/export and the organiser-scope security boundary apply as everywhere else in Pulse.

## Risks register
- **Notification fatigue** → strict priority discipline; digests over drips.
- **Half-adopted ingestion** ("some comms in, some not") → measure CC-rate per AM; make forwarding a team habit with leadership backing.
- **Extraction over-reach** → suggestions only, human confirms, always cite source.
- **WhatsApp ToS** → no unofficial bridges on client-facing numbers, ever.
- **Privacy** → visible Owl, consent toggle, retention policy before first ingest.
