# Testing

Automated tests for the server, run with Node's built-in test runner — **no test
dependencies** to install or audit.

```bash
npm test          # runs everything in test/*.test.js
node --test --test-name-pattern="organiser" "test/*.test.js"   # filter by name
```

CI runs the same `npm test` on every push and pull request
(`.github/workflows/ci.yml`), plus a client build.

## What's covered today

The first batch deliberately targets the **highest-risk** code — the multi-tenant
data boundary and access control — because a regression there leaks one client's
data to another.

- **`test/scope.test.js`** — `auth.scopeForQuery`, the boundary that forces each
  client's organiser filter onto every Looker query:
  - a client query is forced to their own organiser, and they can't override it
    from the browser;
  - two clients never resolve to the same scope;
  - it **fails closed** (deny, not "see everything") when no organiser is
    configured, or when the explore has no resolvable organiser field;
  - admins are unscoped only when not previewing a client; previewing a client
    suite scopes even an admin to that client;
  - a client can't view through another client's suite.
- **`test/auth.test.js`** — password hashing (bcrypt, never plaintext / never
  returned), credential verification, and role→permission enforcement
  (admin-all, non-member-none, finance/viewer restrictions).

## How it works

`test/helpers.js` points `DATA_DIR`/`DB_FILE` at a throwaway temp directory
**before** requiring `server/db.js` (which opens SQLite at load time), so every
run gets a fresh, isolated database. `node --test` runs each file in its own
process, so there's no shared state between files. The suite is **hermetic** — it
makes no network calls; with no Looker credentials present, the scope resolver's
last-resort live lookup fails closed, which is exactly the behaviour we assert.

## Extending

Add a `test/<area>.test.js` and `require('./helpers')` for a seeded DB plus the
`makeEntity` / `makeClient` / `makeAdmin` / `seedOrganiserDashboard` helpers.
Good next targets: campaign audience resolution (`server/actions.js`), digest
scheduling windows (`server/scheduler.js`), and the `/api/my/...` route guards
(IDOR) via supertest-style HTTP tests.
