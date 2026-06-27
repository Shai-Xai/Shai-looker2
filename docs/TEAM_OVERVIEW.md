# Pulse: The Experience Operating System
**Team overview — what we're building, why, and how we'll deliver it**

---

## Where we are today

In the last weeks Pulse has grown from an analytics dashboard into something bigger. Organisers now get: live dashboards scoped to their events, an AI analyst (the Owl) that briefs them personally every morning on what changed and what's worth looking at, interactive settlement reports and invoices instead of PDFs, and ways to tune all of it to their needs.

But there's a whole half of our relationship with organisers that still lives **outside** the platform: everything the account managers and ops team do to make an event happen. Contracts, on-sale setup, pricing approvals, staffing orders, device orders, briefing packs, resale decisions, comp lists, debriefs. Today that work runs on memory, spreadsheets, email threads and WhatsApp groups — scattered, untracked, and dependent on individual heroics.

## The goal

**Make Pulse the operating system for the entire Howler–organiser relationship.** One place where every number, every document, every task and every conversation about an event lives — tracked, searchable, and actionable.

When we get this right:
- **Nothing falls through the cracks.** Every event-readiness task has an owner, a due date, and a visible status — for us *and* the organiser.
- **Nothing gets lost.** Conversations are captured wherever they happen; "what did we agree about staffing?" has an answer with a source.
- **Organisers feel served, not chased.** They see exactly what Howler is doing for their event, what we need from them, and when — and the Owl reminds them personally.
- **Handovers stop hurting.** A new AM reads one event timeline and knows the whole relationship.

## The three pieces

### 1. The Playbook — what needs doing
Every task involved in making an event ready, captured once as a reusable template: what it is, who owns it (organiser / AM / ops), when it's due (anchored to the event's launch and event dates — which Pulse already knows), and how we know it's done. Some tasks even **verify themselves from live data** — "event on sale" ticks itself when the first ticket sells.

Each event gets its own copy of the playbook. Organisers see a "Needs you" list on their home page; AMs get a board across all their events showing what's due, what's late, and how ready each event is.

### 2. The Comms Spine — what's being said
Messages between Howler and organisers become part of the platform: announcements organisers **must acknowledge** (with a record of who acknowledged, when), threads attached to tasks and settlements, and an inbox per event.

Crucially, **we don't force anyone to change where they talk.** People will keep using email and WhatsApp — so the Owl gets CC'd. Every event gets an Owl email address; AMs copy it on client correspondence (and forward the key WhatsApp messages). Everything lands in the event's timeline. The platform doesn't compete with email — it remembers it.

### 3. The Owl — the memory and the voice
The Owl already briefs organisers on their numbers. Now it also:
- folds ops into the briefing — *"contract still unsigned, 9 days to launch"*
- reads ingested messages and **suggests** tasks and decisions it spots ("Howler to deliver 40 devices by the 20th") — a human always confirms
- answers questions from the record — *"what did we agree about resale?"* — citing the actual message

Everything the Owl says is grounded in real data and real messages. It quotes; it never invents.

## How we'll deliver it

**Step 0 — the workshop (this is where you come in).** The hardest part isn't code — it's capturing what's in your heads. One working session with AMs + ops to fill in the playbook template (one row per task: what, who, when, proof, comms). We've pre-filled ~20 seed tasks to react to. We'll also decide: the 5 tasks that hurt most when missed, which tasks can self-verify from data, and how we introduce the Owl-on-email to clients.

**Then we build in slices, each useful on its own:**
1. Messaging spine + inbox + notification bell
2. Announcements with must-acknowledge (the early "wow")
3. Owl email ingestion + the event timeline (starts collecting knowledge immediately — the corpus compounds from week one)
4. Playbook tasks (from the workshop output)
5. Email nudges when something needs an organiser and they're not logged in
6. Owl intelligence: ops in briefings → suggested tasks from messages → "ask the record" Q&A

**Deliberate v1 boundaries** (so this ships instead of sprawling): Howler↔organiser comms only, everything anchored to an event, three priority levels, no real-time chat bells and whistles. This is tracked correspondence and accountable work — not another Slack.

## What we need from the team
1. **Attend the playbook workshop** and bring your real checklists, templates and horror stories.
2. **Correct the seed tasks** in the capture sheet — they're educated guesses to react to, not the answer.
3. **Adopt the CC-the-Owl habit** once the ingestion address exists — the system is only as smart as what it sees.
4. **Tell us where it'll break.** You know the edge cases (postponed events, multi-day festivals, difficult clients). We'd rather design for them now.

---

*Companion docs: `EXPERIENCE_OS_BRIEF.md` (full architecture & build order) · `playbook-capture-template.csv` (the workshop sheet).*
