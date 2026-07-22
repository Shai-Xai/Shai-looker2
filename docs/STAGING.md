# Staging environment — test deploys before they reach customers

Staging is a **second, isolated copy of Pulse** that deploys from a `staging`
branch. You push work there first, click around to confirm it's good, then
promote it to production. It has its **own database and its own secrets**, and —
most importantly — it **cannot send anything to real customers**.

## The workflow

```
feature branch ──PR──▶ staging branch ──auto-deploy──▶ staging site  (you test here)
                                                              │
                                          looks good?  merge  ▼
                                    staging ──PR──▶ main ──auto-deploy──▶ production
```

1. Do your work on a branch and open a PR **into `staging`** (not `main`).
2. Merging to `staging` auto-deploys the **staging site** — test there.
3. When it's good, open a PR **`staging` → `main`**. Merging deploys production.

So `main` only ever receives changes that already ran on staging.

## The safety net (why staging can't email your customers)

A staging server that runs the schedulers (digests, alerts, campaigns) with
real-looking data + real Resend/Clickatell keys could **blast actual customers
with test messages**. To make that impossible, the staging service sets
**`OUTBOUND_DISABLED=1`**, which hard-disables **all** outbound comms —
email (Resend), SMS + WhatsApp (Clickatell), web push, and Slack — regardless of
any in-app setting. Sends return `skipped` and are logged, so you can still see
*that* a message *would* have gone out, without it actually leaving.

> This is a code-level guard (`server/mailer.js`, `messaging.js`, `push.js`,
> `slack.js`), so it holds even if someone flips the in-app "mail enabled" switch.
> **Never remove `OUTBOUND_DISABLED=1` from staging.**

## One-time setup (Render dashboard — ~15 min)

The `render.yaml` blueprint already defines the staging service. Two ways to
create it:

**Option A — Blueprint sync (recommended).** In Render → your Blueprint → **Sync**.
Render reads the updated `render.yaml` and creates `howler-pulse-staging` (its own
disk + env vars). Then fill in the `sync:false` secrets for staging (see below).

**Option B — Manual.** Render → New → Web Service → same repo → **branch:
`staging`** → add a 1 GB disk at `/var/lib/pulse` → add the env vars (copy the
staging block from `render.yaml`, **including `OUTBOUND_DISABLED=1`**).

Either way, then:

1. **Create the `staging` branch** (once): from `main`, `git push origin main:staging`.
2. **Set staging secrets** in the Render dashboard for the staging service:
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` — a staging-only login. **This is the ONLY
     way into staging**: password-reset emails can't send (the outbound brake),
     so "Forgot password" is a dead end there — log in with these seeded
     credentials.
   - `APP_URL` — set to the staging URL (e.g.
     `https://howler-pulse-staging.onrender.com`). It defaults to PRODUCTION's
     URL, so without it any link staging renders (reset links, email previews,
     MCP/connector URLs) silently points at prod — the classic "I thought I was
     on staging" trap.
   - `LOOKER_*` — ideally a **read-only** Looker connection (staging only reads
     data; it never writes to Looker anyway).
   - `ANTHROPIC_API_KEY` — a separate or spend-capped key is wise.
   - Leave `BACKUP_S3_*` and `OPS_SLACK_WEBHOOK_URL` unset (a throwaway env needs
     neither).
   - `SESSION_SECRET` and `MASTER_KEY` are auto-generated per service — leave them.
   - `FAN_OTP_TEST_CODE` (optional, 6 digits, e.g. `424242`) — the Fan Owl's
     loyalty verification normally emails a one-time code, which the outbound
     brake blocks on staging. Set this and that shared code verifies any fan
     WITHOUT sending. Only honoured while `OUTBOUND_DISABLED=1` is also set, so
     it can never weaken production.
3. **Custom domain (optional):** point e.g. `staging.pulse.howler.co.za` at the
   staging service so it's easy to reach. Otherwise use the
   `howler-pulse-staging.onrender.com` URL Render gives you.

## Data on staging

Staging starts with an **empty database** (just the seeded admin) — clean and safe.
Two ways to get data to test against:

- **Simplest:** create a test client + a dashboard by hand in staging.
- **Realistic:** in production, Admin → Export the JSON, then Import it into
  staging. ⚠️ That JSON contains real customer PII and (encrypted) secrets — treat
  the file carefully, and remember staging's `MASTER_KEY` differs from
  production's, so imported secrets won't decrypt on staging (they'll read as
  "not set", which is fine — you set staging's own test keys). `OUTBOUND_DISABLED`
  means even real audiences can't be messaged.

## Cost

Staging is a **second paid Render instance + a second disk** (~the same as
production's starter plan). If cost matters, you can spin the staging service
**down between test sessions** and resume it when you need it — its disk (and data)
persists while it's suspended.

## When we move to Postgres

Once the database moves off the single disk (see
`docs/POSTGRES_MIGRATION_SCOPE.md`), staging gets simpler and cheaper: Render
**preview environments** can spin up an ephemeral staging copy **per pull request**
automatically, so you wouldn't need a permanent staging service at all. Until then,
the long-lived `staging` service above is the pragmatic setup.
