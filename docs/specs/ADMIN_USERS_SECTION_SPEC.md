# Spec — Admin → Users section

**Status:** ✅ built 2026-06-23 (uncommitted in working tree — review & push to ship) · **Drafted:** 2026-06-23

> Built with **full audit (D1 = B)**. New: `server/audit.js` (route→action middleware),
> `user_actions` table + `last_login` (db.js), `GET /api/admin/users/:id` aggregator +
> enriched list (index.js), Admin → **Users** tab (AdminPage.jsx), `test/audit.test.js`.
> Activity timeline merges audited actions + dashboard views + feature/guide telemetry.

## Goal
A top-level **Users** section in Admin: a searchable **table of every user**, and
a **click-into detail view** for one user showing all their info — profile, roles,
last login, most recent action, and dashboards. Today admins can only see users
*per client* (each client's "Logins" tab) or *admins only* (the "Admin logins"
tab). There is no single place to see and inspect every user.

This is a **Howler-staff / internal** tool (it spans all clients), so the
dual-surface rule mostly doesn't apply — a client must never see another client's
users. The client-scoped equivalent already exists and stays as-is:
`/api/my/team/:entityId` + `<TeamManager>`. We're only adding the global admin view.

---

## What already exists (reuse, don't rebuild)

| Requirement | Already there? | Source |
|---|---|---|
| Users table | ✅ | `users` — id, email, password_hash, role (`admin`/`client`), created_at, notify_email, notify_push — `server/db.js:40` |
| List all users | ✅ endpoint | `GET /api/admin/users` → `db.listUsers()` — `server/index.js:215` |
| Roles (per client) | ✅ | `user_entities(user_id, entity_id, role)`; roles = owner/manager/marketing/finance/viewer — `server/db.js:48`, `server/roles.js:32` |
| "Profile" (top dashboards + last visit) | ✅ computed | `db.viewProfile(userId)` over `user_views` — `server/db.js:203` |
| Dashboard view history | ✅ | `user_views(user_id, suite_id, dashboard_id, at)` — `server/db.js:188` |
| Feature/guide telemetry | ✅ | `usage_events(entity_id, user_id, kind, name, step, event, ts)` — `server/telemetry.js:16` |
| Admin UI list→detail pattern | ✅ | `Entities` list → `ClientDetail` w/ section nav — `client/src/pages/AdminPage.jsx:645` |
| Admin nav registration | ✅ | `ADMIN_NAV` array — `client/src/pages/AdminPage.jsx:113` |
| Per-client logins UI (steal layout) | ✅ | `<EntityLogins>` — `client/src/pages/AdminPage.jsx:1031` |

## What does NOT exist (the actual new work)

1. **Last login** — the login handler (`server/index.js:119`) issues a cookie and
   returns; it writes **no timestamp**. `users` has no `last_login` column.
2. **"Most recent action"** — there is **no general audit/action log**. The closest
   signals are `user_views.at` (dashboard opens) and `usage_events.ts`
   (guides/features). No middleware records per-user actions.
3. **A combined per-user detail aggregator endpoint** — nothing returns "everything
   about one user" in one call today.
4. **A top-level Users tab** — `ADMIN_NAV` has `entities`, `logins` (admins only),
   `sets`, etc. but no all-users entry.

---

## Decisions to make (flagged — pick tomorrow)

- **D1 — "Most recent action" depth.**
  - **(A) Derived, cheap (recommended for v1):** compute last activity =
    `MAX` of the user's latest `user_views.at` and latest `usage_events.ts`, with a
    human label ("Opened *Marketing* dashboard", "Completed onboarding guide").
    Zero new tables, ships tomorrow.
  - **(B) Full audit log (Phase 2):** new `user_actions` table + request middleware
    capturing a real action timeline (logins, role changes, sends, downloads…).
    Bigger; do it after v1 if (A) proves too thin.
- **D2 — What "their dashboard" means.** Two readings — likely want both, small:
  - the **dashboards they actually use** (top list from `viewProfile`), and/or
  - the **dashboards they can access** (their entities' dashboards via memberships).
- **D3 — Scope of the table.** All users (admins + client users) with a role filter,
  or client users only? Recommend **all users, filterable** by role/entity/status.

---

## Data model changes (minimal)

```sql
-- migration in server/db.js (use the existing addColumn helper, see db.js:142)
addColumn('users', 'last_login', 'TEXT');   -- ISO timestamp, nullable
```
No other schema change needed for v1 (Decision D1 = A). Decision D1 = B would add a
`user_actions(id, user_id, entity_id, action, detail, at)` table + index.

---

## Backend

1. **Record login** — in `POST /api/auth/login` (`server/index.js:119`), on success
   call a new `db.touchLastLogin(user.id)` that sets `users.last_login = now`.
   *(Also consider the Google/SSO path if one exists — check `server/auth.js`.)*
2. **User list (enrich existing)** — extend `GET /api/admin/users` (or add
   `?detail=1`) so each row carries enough for the table: email, global role,
   `last_login`, membership count, and a derived `lastActiveAt`. Keep it cheap (no
   N+1 — one grouped query over `user_views`/`usage_events`).
3. **New: per-user detail** — `GET /api/admin/users/:id` (guard `auth.requireAdmin`)
   returning one aggregate:
   ```jsonc
   {
     "user":        { id, email, role, created_at, last_login, notify_email, notify_push },
     "memberships": [{ entityId, entityName, role, lens }],   // db.membershipsForUser + entity names + roles.lensForRole
     "profile":     { top: [{ dashboardId, title, count, lastAt }], lastVisit },  // db.viewProfile
     "recent":      [{ at, kind, label }],                    // merged user_views + usage_events, newest first, ~20
     "dashboards":  { used: [...], accessible: [...] }        // D2
   }
   ```
4. **API client helpers** — add `adminGetUser(id)` to `client/src/lib/api.js`
   (alongside `adminListUsers` at ~line 105).

## Frontend (`client/src/pages/AdminPage.jsx`)

1. Add `['users', 'Users', '🧑']` to `ADMIN_NAV` (`:113`).
2. `<UsersTab>` — list/table modeled on `Entities` (`:645`): searchable, sortable,
   columns = **Email · Role · Clients · Last login · Last active**. Row click →
   `setSelectedId(user.id)` → detail.
3. `<UserDetail>` — modeled on `ClientDetail` (`:725`) with a back button and section
   nav. Sections:
   - **Overview** — email, global role, created, notify prefs, **last login**,
     **most recent action**.
   - **Roles & clients** — memberships table (entity + role + lens); reuse role
     labels from `server/roles.js`.
   - **Profile / usage** — top dashboards + last visit from `viewProfile`.
   - **Activity** — the merged `recent` feed (timeline).
4. **Mobile-first** (CLAUDE.md): detail nav must stack to a horizontal tab row on
   narrow screens like `ClientDetail` already does; table collapses to stacked cards
   via `useIsMobile()`. Tap targets ≥ 40px.

---

## Build order (one focused day)

1. **Migration + login write** — `last_login` column + `touchLastLogin` in login handler. *(~20 min)*
2. **Detail endpoint** — `GET /api/admin/users/:id` aggregator + `adminGetUser`. *(~1 hr)*
3. **List enrichment** — add `last_login` + `lastActiveAt` to the users list. *(~30 min)*
4. **Users tab + table** — nav entry + `<UsersTab>`. *(~1 hr)*
5. **User detail view** — `<UserDetail>` + sections. *(~1.5 hr)*
6. **Mobile polish + test** — narrow viewport, empty states (never logged in / no activity). *(~45 min)*

Decision D1=B (full audit log) is a separate Phase 2 and not in this day's budget.

---

## Watch-outs
- No N+1: enrich the list with one grouped query, not a `viewProfile` per row.
- Empty states: brand-new users have `last_login = null` and no `user_views` — show
  "Never logged in" / "No activity yet", don't crash.
- Don't leak: this endpoint returns cross-client data — keep it strictly behind
  `auth.requireAdmin`; never expose under `/api/my/...`.
- `password_hash` must never appear in any response (`rowToUser`/`meUser` already strip it — verify the new aggregator does too).
- Update `docs/PRODUCT_OVERVIEW_SALES.md` only if this becomes client-visible (it
  won't for v1 — it's internal admin).
