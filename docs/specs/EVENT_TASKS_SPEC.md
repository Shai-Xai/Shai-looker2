# Spec — Event Tasks + AM Cockpit (v1)

> Status: **draft for review** · Owner: (tbd) · Roadmap: 5.1 · North Star:
> `docs/EXPERIENCE_OS_BRIEF.md` (Playbook · Spine · Owl). This is the v1 task
> layer — deliberately scoped to ship without the workshop-fed Playbook or the
> Howler data-signal integration, both of which slot in later.

## 1. Problem & goal
Half of the Howler↔organiser relationship — the work that makes an event ready
(contracts, on-sale setup, pricing, staffing, devices, briefing packs, resale,
settlement) — lives **outside** Pulse in memory, spreadsheets, email and
WhatsApp. It's untracked and depends on individual heroics; handovers hurt.

**Goal:** give every event-readiness item an **owner, a due date and a visible
status** — for Howler *and* the organiser — inside Pulse. Internally, an **AM
cockpit** shows what's due, what's late, and how ready each event is.

This is the brief's "a task is just a thread with a due date and a done-state":
tasks reuse the existing **Spine** (`server/os.js`) for discussion, receipts and
notifications.

## 2. Users
- **Account Manager (AM) / Ops** — Howler admins (`users.role==='admin'`),
  optionally linked to specific clients via `entityIds`. Live in the **cockpit**;
  create/assign/track tasks across events.
- **Organiser (client)** — sees the tasks they own on a "Needs you" block and a
  per-event task list; completes their own, comments, acknowledges.

## 3. Goals / non-goals (v1)

**In scope**
- Ad-hoc tasks per event (no template yet): title, description, owner role,
  optional assignee, due date, status, verification type, optional "blocks".
- A per-task **thread** (Spine) for discussion, documents and receipts.
- **Manual** and **document-upload** verification.
- Client surfaces: "Needs you" on home + per-event task list + complete/comment.
- Admin **AM cockpit**: cross-client board (due this week, overdue, readiness %)
  + per-client/event management.
- Notifications: on assign, due-soon, overdue (reusing announce + push + email +
  the morning briefing). Optional **must-acknowledge** per task.

**Out of scope (later slices)**
- The **Playbook** (`playbooks`, `playbook_tasks`) and auto-instantiating a
  playbook per event — needs the AM/ops **workshop** content first.
- **Data-signal auto-verification** ("On sale" ticks itself) — depends on the
  **Howler integration** (roadmap 4.1) / Looker signals.
- Owl **extraction** (suggest tasks from ingested messages) — separate slice.
- Recurring tasks, full dependency-graph UI, cross-event templates.

## 4. Data model (v1)
New disposable module **`server/tasks.js`** owns one table; the per-task thread
lives in the existing Spine (`os_threads` with `subject_type='task'`,
`subject_id = event_tasks.id`).

```
event_tasks
  id            TEXT PRIMARY KEY
  entity_id     TEXT NOT NULL          -- client (denormalised for scoping/queries)
  suite_id      TEXT NOT NULL          -- the event
  playbook_task_id TEXT DEFAULT ''     -- reserved (v1 always '')
  title         TEXT NOT NULL
  description   TEXT DEFAULT ''
  owner_role    TEXT DEFAULT 'am'      -- organiser | am | ops
  assignee_id   TEXT DEFAULT ''        -- concrete user responsible (client user or admin)
  due_at        TEXT DEFAULT ''        -- ISO date (explicit in v1; computed-from-anchor later)
  status        TEXT DEFAULT 'todo'    -- todo | in_progress | blocked | done | na
  verification  TEXT DEFAULT 'manual'  -- manual | document
  needs_ack     INTEGER DEFAULT 0      -- organiser must acknowledge (rides Spine must_ack)
  blocks        TEXT DEFAULT '[]'      -- JSON array of event_task ids this blocks (minimal)
  thread_id     TEXT DEFAULT ''        -- Spine thread for discussion/docs/receipts
  created_by    TEXT
  created_at    TEXT
  updated_at    TEXT
  completed_by  TEXT DEFAULT ''
  completed_at  TEXT DEFAULT ''
  verified_by   TEXT DEFAULT ''        -- human (v1) | data (later)

  INDEX (entity_id), (suite_id), (status), (due_at)
```

Everything keys off `suite_id` (the event) — same spine as briefing phases,
settlements and documents. Organiser-scope security boundary + backup/export
apply as everywhere else.

## 5. Permissions (`roles.js` additions)
Two new atomic gates (enforcement always checks the permission, never the role):
- `TASKS_VIEW` — see tasks for entities you belong to.
- `TASKS_MANAGE` — create / edit / assign / complete tasks.

Proposed mapping (open for review): **owner, manager → VIEW+MANAGE**;
**marketing, finance → VIEW** (+ MANAGE only of tasks assigned to them);
**viewer → none**. Howler **admins bypass** (full access) and own the cockpit.

> Open question: should an AM's cockpit be scoped to their **linked** entities
> (`entityIds`) by default, with an "all clients" toggle? (We already have the
> admin↔entity linkage from the campaign-approval work.)

## 6. API (dual-surface)
Admin (`requireAdmin` or `TASKS_MANAGE`):
- `GET  /api/admin/tasks` — cockpit feed: all (or linked) entities; query params
  `due=week|overdue|all`, `status`, `entityId`, `suiteId`; returns tasks +
  per-event **readiness** rollup.
- `GET  /api/admin/entities/:id/tasks?suiteId=` — one client/event.
- `POST /api/admin/entities/:id/tasks` — create (auto-creates the Spine thread).
- `PATCH /api/admin/tasks/:taskId` — status / assignee / due / fields.
- `DELETE /api/admin/tasks/:taskId`.

Client self-service (`/api/my/...`, entity-ownership enforced):
- `GET   /api/my/tasks?suiteId=` — tasks for the active entity (+ a `needsYou`
  subset: open, assigned to me or my role, or must-ack).
- `PATCH /api/my/tasks/:taskId` — limited: advance status of tasks they own,
  attach a document, acknowledge.

Discussion/documents/receipts reuse the existing **Spine** thread endpoints
(`/api/os/threads/:threadId/...`) via the task's `thread_id` — no new comment
plumbing.

## 7. Surfaces (UI — mobile-first)
**Client**
- **"Needs you" block** on `ClientHome` — open tasks they own + must-acks; only
  renders when non-empty (per brief). Briefing mentions urgent items.
- **Event task list** — within the event/suite context: title, owner chip, due
  (with overdue styling), status; tap → **task detail** = meta + the Spine
  thread (comments, docs, ack button).

**Admin — the AM cockpit**
- New left-rail item in `AdminPage` (e.g. "Ops" / "Tasks"). Cross-client board:
  filter **Due this week · Overdue · All**, group by event, **readiness %** per
  event (done ÷ non-na). Quick status change + assignee.
- Per-client **Tasks** tab in the client detail view (create/manage that
  client's tasks).

## 8. Verification (v1)
- **manual** — owner/AM ticks done → `status='done'`, `verified_by='human'`,
  `completed_by/at` set.
- **document** — attach a document (to the task thread) → then mark done. Counts
  as evidence; still `verified_by='human'`.
- **data** (`verified_by='data'`) is reserved; arrives with the Howler/Looker
  signal integration (4.1).

## 9. Notifications (reuse, don't rebuild)
Via `os.announce({subjectType:'task', subjectId})` + `push` + `mailer`, mirroring
the campaign-approval notify pattern:
- **Assigned / created-for-you** → notify assignee (inbox + push + email).
- **Due soon (e.g. T-3d) / overdue** → daily `scheduler` tick notifies owner +
  AM; folds into the morning **briefing** ("contract still unsigned, 9 days to
  launch").
- **needs_ack** → rides the existing **must-acknowledge** banner on login.
- Discipline: digest over drip (brief's notification-fatigue risk).

## 10. Readiness metric
Per event: `done / (total − na)` as a %. Surfaced on the cockpit (per event) and
optionally to the organiser ("Your event is 80% ready"). Cheap to compute from
`event_tasks`.

## 11. Build milestones (each useful on its own)
1. **M1 — Engine + admin CRUD.** `tasks.js` + table; create/list/update/delete;
   per-task Spine thread; per-client/event admin list. (Internal value first.)
2. **M2 — Client surfaces.** "Needs you" on home + per-event list + complete /
   comment / ack (dual-surface, `/api/my/...`).
3. **M3 — AM cockpit.** Cross-client board, filters, readiness %.
4. **M4 — Notifications + briefing fold-in + must-ack.**
5. **Later** — Playbook templates → instantiate per event (post-workshop);
   data-signal verification (post-4.1); Owl extraction.

## 12. Open questions
1. Role→permission mapping (§5) — confirm who can manage vs view client-side.
2. AM cockpit default scope — linked entities only, or all clients?
3. Due dates — explicit only in v1, or also support the brief's anchors
   (Launch±Nd / Event±Nd / phase) now using the event dates we store in
   `suites.briefing`?
4. Documents — link existing **Documents** to a task, or just thread attachments
   (note: inbound/thread attachments aren't fully built — see `INBOUND_SETUP.md`).
5. Can organisers **create** their own tasks (requests to Howler), or v1
   admin-created only?
6. `owner_role` vs `assignee_id` — is the role label enough for v1, or do we need
   concrete assignment from day one?

## 13. Risks
- **Notification fatigue** → strict priority discipline; digest over drip.
- **Scope creep into the Playbook** → v1 is ad-hoc tasks only; templates are a
  later slice gated on the workshop.
- **Empty-state adoption** → seed a handful of tasks per active event so the
  cockpit isn't blank on launch; make task-creation a one-screen action.
- **Double source of truth** with the eventual Howler integration → keep `tasks`
  as the system of record for *readiness*; data signals only *verify*, they don't
  own the task.
