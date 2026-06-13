# CLAUDE.md — working notes for Howler : Pulse

Guidance for anyone (human or AI) building on this codebase. Keep it short and
current.

## What Pulse is (read first)
Pulse is the **Experience OS** for Howler's clients and internal teams — a
data-driven system that turns data into **insight → action → results** and makes
the work more efficient. Today it spans dashboards, AI insights, a messaging
inbox, digests, settlements/documents and an email/SMS campaign engine; it keeps
evolving toward that vision. Orient with `PROJECT_OVERVIEW.md` (stack + current
state) and **`docs/EXPERIENCE_OS_BRIEF.md`** (the North Star: Playbook · Spine ·
Owl, ingestion, build order, data model). Judge new work by whether it advances
the insight → action → results → efficiency loop.

## Product principles

### Mobile-first (always)
Clients live on their phones. **Every UI must be designed and built mobile-first**
— it has to look and work great on a phone before we worry about desktop. In
practice: single-column layouts that stack on small screens (don't ship side-by-side
grids that squish); tap targets ≥ 40px; no fixed widths that overflow; test the
narrow viewport first. Use the existing `useIsMobile()` hook to collapse
multi-column editors/previews into a stack on mobile. The app is an installable
PWA — treat the phone as the primary surface, not an afterthought.

### Self-service first (dual-surface rule)
**Every client-facing feature must ship with BOTH:**
1. **Back-end / admin management** — Howler staff can configure it on a client's
   behalf (in Admin → the client's detail tabs), and
2. **Client self-service** — the client can manage it themselves (in their own
   Settings / Integrations & branding area), scoped to their entity.

Drive as much self-service for clients as possible. When scoping any feature,
explicitly plan the admin surface *and* the client surface up front — not as an
afterthought. Client self-service endpoints live under `/api/my/...` and must
enforce entity ownership; the admin equivalents live under
`/api/admin/entities/:id/...`. The same UI component should usually serve both
(see `MailTemplateEditor` with its `scope` prop: `platform` | `admin-client` |
`my`).

When a setting layers (platform default → client override), blank client fields
should inherit the tier below, and the UI should show what's inherited.

## Architecture notes
- Disposable modules: self-contained features own their tables + routes and mount
  with one line (e.g. `server/os.js`, `server/mailer.js`). Easy to remove.
- Secrets are write-only: responses report whether a value is set + a mask, never
  the value. Branding/presentation (non-secret) can ride to the browser freely.
- Email sends from one verified Resend domain; per-client "branding" is the look
  (logo/colour/sender display name/wording), not the sending address.

## Git
- Develop on the assigned `claude/*` branch; push to it AND to `main`
  (`git push -u origin <branch> && git push origin <branch>:main`). Render
  deploys from `main`.
