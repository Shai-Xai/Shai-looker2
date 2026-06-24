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
- AI prompts are auditable: every hardcoded system prompt lives in `server/insights.js`
  and MUST be exposed via `promptRegistry()` (it powers the Admin → AI "Everything
  the AI is told" audit + the resolved-prompt tool). When you add a new prompt
  const, add it to `promptRegistry()` in the same change — `test/prompts.test.js`
  fails the build otherwise. Configurable instruction layers (global, per-client
  `aiContext`, per-event briefing, role lenses, phase/time defaults, digest focus,
  reader tunes) are aggregated by `GET /api/admin/ai-overview`; surface new layers
  there too.

## Keep the sales overview current
`docs/PRODUCT_OVERVIEW_SALES.md` is the sales/AM-facing feature guide. Whenever you
ship (or change the status of) a **client-relevant** feature, update it in the SAME
change: adjust the relevant section + status tag, bump **Last updated**, and add a
dated **Changelog** line. Keep it benefit-led and honest (don't overclaim — use the
status key: ✅ Live · 🟡 needs setup · 🧪 beta · 🔜 coming soon).

## Keep the client setup wizard current
The back-end **Client setup wizard** (Admin → 🧙 Setup wizard, in `SetupWizard` /
`server/setupWizard.js`) is the guided, step-by-step path account managers use to
stand a new client up. **Whenever you add a new back-end setting that is part of
standing a client up** (a new entity/suite field, a new required integration, a new
onboarding step), wire it into the wizard in the SAME change — don't let the wizard
drift behind what setup now requires:
- If it's a whole new setup stage, add a step to `WIZARD_DEFAULTS` (and its
  behaviour by `key` in `SetupWizard`), keeping required vs optional honest.
- If it belongs inside an existing step, add the field there and, where the step
  has a guided section tour, add a `[data-tour]` anchor + a matching entry in that
  step's `TOURS` list so the walkthrough still covers every section.
- Update each step's `canProceed` / `reqDone` if the new setting is required to go
  live, so "Continue" stays locked until it's done.
Remember the wizard reuses the real editors (`ClientSuites`, `EntityLogins`,
`MailTemplateEditor`, …) — adding the setting to those usually surfaces it in the
wizard automatically; the tour copy is the part that still needs a manual update.

## Git
- Develop on the assigned `claude/*` branch; push to it AND to `main`
  (`git push -u origin <branch> && git push origin <branch>:main`). Render
  deploys from `main`.
