# Scope: moving Pulse off single-file SQLite (for zero-downtime deploys & scale)

_Status: scoping only — nothing here is built yet. Written 2026-07-02._

## Why we'd do this

Two problems share one root cause:

1. **Every deploy briefly takes the site down.** Pulse's database is a single SQLite
   file on a Render **persistent disk**, and that disk can attach to only **one**
   instance at a time. So Render must stop the old version, move the disk, and start
   the new one — a ~30–90s gap on every deploy. True zero-downtime is *impossible*
   while the DB lives on that disk.
2. **We can only ever run one instance.** No horizontal scaling, no redundancy — if
   that one instance is unhealthy, Pulse is down. Today's ceiling is a single
   0.5-vCPU box.

Moving the database to a **networked database** (managed Postgres, or a libSQL/Turso
service) removes the disk, which unlocks **rolling, zero-downtime deploys** (new
instance boots healthy → traffic shifts → old instance retires) and **multiple
instances** for scale + redundancy.

## The one hard part: synchronous → asynchronous

This is 90% of the work and the reason it's a project, not an afternoon.

Pulse uses **better-sqlite3**, whose queries are **synchronous** — the code reads
like `const row = db.prepare('…').get(id)` and blocks until the row is back.
Networked databases (Postgres via `pg`, libSQL, etc.) are **asynchronous** — every
one of those calls becomes `await db.query(...)`.

Measured coupling in the current codebase:

| Metric | Count |
|---|---|
| `db.prepare(...)` call sites | **757** |
| Synchronous `.get()/.all()/.run()` calls | **1,175** |
| Server files touching the DB | **41** |
| `db.transaction(...)` blocks | 17 |
| SQLite-only SQL (`INSERT OR IGNORE/REPLACE`, `json_extract`, `AUTOINCREMENT`, `PRAGMA`) | ~50 sites |

Converting to async isn't just find-and-replace: making a function `async` ripples to
**every caller** of that function (they must `await` it too), which ripples again up
the call tree. In an Express app the top of most call trees is a route handler, which
can already be async — so it's tractable, but it touches a large fraction of the
server.

## Two routes to consider (pick one)

### Option A — Managed Postgres (the "standard" answer)
Render (or Neon/Supabase) hosts Postgres; Pulse connects over the network with `pg`.

- **Pros:** battle-tested, the obvious "grown-up" database, great tooling/backups,
  removes the disk entirely, unlocks many instances.
- **Cons:** the **full sync→async rewrite** (the 1,175 calls above), a SQL-dialect
  port, and a data migration. Largest effort.

### Option B — libSQL / Turso (the pragmatic answer — evaluate first)
libSQL is SQLite-compatible with a client whose API closely mirrors better-sqlite3,
plus **embedded replicas**: each instance keeps a local copy synced from a remote
primary. This can give multi-instance + zero-downtime **with far less code churn**,
because the query style stays close to today's.

- **Pros:** dramatically less rewrite (keeps most SQL and much of the call style);
  same SQLite SQL dialect (no `AUTOINCREMENT`/`json_extract`/`INSERT OR REPLACE`
  port); replication + multi-region built in; managed backups.
- **Cons:** newer/smaller ecosystem than Postgres; the embedded-replica write path
  and consistency model need validation for our write-heavy scheduler; still some
  async conversion (its network client is async, though a local-file mode is sync).
- **Recommendation:** **spike this first** (1–2 days) — if the compatibility holds,
  it's the cheapest path to the actual goal (zero-downtime + scale).

> Net recommendation: **prototype Option B for 1–2 days.** If it doesn't hold up,
> commit to Option A as a larger, well-understood project.

## What the work actually involves (either option)

1. **Data-access seam.** Route all DB access through one module (`db.js` already is
   the seam — good). This is where the driver swap and async conversion concentrate.
2. **Async conversion** (Option A; partial for B): make DB helpers `async`, then
   `await` them up the call tree across the 41 files. Do it module-by-module behind
   the test suite.
3. **SQL dialect port** (Option A only):
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL` / `GENERATED … AS IDENTITY`
   - `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`
   - `INSERT OR REPLACE` → `INSERT … ON CONFLICT (key) DO UPDATE …`
   - `json_extract(x,'$.k')` / `json_array_length` → `->>`, `jsonb`, `jsonb_array_length`
   - `?` placeholders → `$1, $2, …`
   - Drop `PRAGMA` (WAL/journal — Postgres-managed); booleans real, not 0/1
   - `db.transaction(fn)` → `BEGIN/COMMIT` with a client from the pool
4. **One-time data migration.** Export the live SQLite DB → load into the new store.
   Because rows are simple (mostly TEXT/JSON blobs), this is a scripted dump→insert
   with the type/constraint mapping above. Add a verification pass (row counts +
   spot-checks per table).
5. **Deploy architecture change** (`render.yaml`): remove the `disk:`, add
   `DATABASE_URL`, set `numInstances: 2+`, keep `healthCheckPath: /health` so Render
   does a **rolling** deploy. Provision the managed DB with automated backups (this
   also *replaces* `server/backup.js` — managed DBs back themselves up).
6. **Move remaining single-instance state off-process.** A few things assume one
   instance and would need a shared store once we run 2+: the in-memory rate limiter
   (`ratelimit.js` — already flagged "swap the Map for Redis"), the query result
   cache (`query.js` qCache — fine to keep per-instance, just less hit-rate), and the
   **schedulers** (digests/alerts/campaigns) which must run on **exactly one**
   instance — add a simple leader-lock (a row in the DB) so only one instance ticks.
   This is essential: without it, 2 instances = double-sent digests.

## Big asset we already have

The **354-test suite** runs against a real database. Pointing it at Postgres/libSQL
in CI turns the migration from "hope it works" into "the same tests must pass on the
new store" — that's the safety net that makes this feasible. Budget time to get the
suite green on the new DB; that green suite *is* the migration's definition of done.

## Risks / watch-outs

- **Write-heavy scheduler.** The nightly digest/alert/campaign engine does bursty
  writes; validate throughput + the leader-lock under load.
- **Latency.** SQLite reads are microseconds (in-process); a network DB adds ~1–5ms
  per query. Hot paths that did many small queries (we already fixed the worst N+1s)
  should be re-checked — batch where it matters.
- **Transactions across the network** behave differently than better-sqlite3's
  synchronous ones; the 17 transaction blocks need individual review.
- **Cutover.** Plan a single short maintenance window for the final data copy
  (source of truth switches once) — ironically the one deploy that *is* downtime.

## Effort estimate (rough, one experienced engineer)

| Phase | Option B (libSQL spike-first) | Option A (Postgres) |
|---|---|---|
| Spike / feasibility | 1–2 days | — |
| Async conversion across 41 files | 3–6 days | 6–10 days |
| SQL dialect port | minimal | 2–4 days |
| Data migration script + verify | 1–2 days | 2–3 days |
| Scheduler leader-lock + shared rate-limit | 1–2 days | 1–2 days |
| Deploy config + CI-on-new-DB + hardening | 2–3 days | 2–3 days |
| **Total** | **~1.5–3 weeks** | **~3–5 weeks** |

Not a weekend job — but a bounded, well-understood one, and the test suite de-risks it.

## Recommended sequence

1. **Now (done):** maintenance page during the deploy blip + deploy in quiet hours.
   This makes today's downtime tolerable at zero cost.
2. **Soon:** a **1–2 day libSQL/Turso spike** to see if the low-churn path is viable.
3. **When it's worth ~2–4 weeks** (zero-downtime becomes a real requirement, or we
   approach the single-instance ceiling — the review put that around ~100 clients):
   execute the chosen option, gated on the full test suite passing on the new DB.

**Bottom line:** the maintenance page fixes the *perception* today; a networked
database is the only thing that removes the downtime itself — and libSQL is worth a
short look before committing to the larger Postgres project.
