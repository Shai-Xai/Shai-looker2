# Backup Setup Runbook — close production-readiness finding F1

**Audience:** whoever holds the Render and Cloudflare logins (non-technical is fine).
**Time needed:** ~15 minutes of clicking, once.
**Why:** Pulse already takes a nightly snapshot of its database — but until this
runbook is completed, that snapshot sits on the **same disk** as the database
itself. If that one disk is lost, everything is lost, snapshots included. This
is the single "Critical" finding (F1) in
`docs/PRODUCTION_READINESS_AUDIT_2026-07-20.md`.

There are three parts. Do them in order. When all three are done, tick the
matching boxes in `docs/PRODUCTION_READINESS.md`.

---

## Part 1 — Give the backups somewhere off-box to live (Cloudflare R2)

R2 is Cloudflare's file storage. Free tier is more than enough (backups are a
few MB each, 3 kept).

1. Log in at https://dash.cloudflare.com (create a free account if Howler
   doesn't have one).
2. In the left menu choose **R2 Object Storage** → **Create bucket**.
   - Name: `pulse-backups` · Location: leave on Automatic → **Create bucket**.
3. Back on the R2 overview page, open **API → Manage API tokens** (top right) →
   **Create API token**.
   - Name: `pulse-backup-writer`
   - Permissions: **Object Read & Write**, limited to the `pulse-backups` bucket.
   - **Create API Token**, then **copy three things from the confirmation
     screen** (they are only shown once):
     - Access Key ID
     - Secret Access Key
     - the endpoint URL, which looks like
       `https://<accountid>.r2.cloudflarestorage.com`

4. Now tell Pulse about the bucket. Log in at https://dashboard.render.com →
   open the **howler-pulse-v2** service → **Environment** tab → add four
   environment variables:

   | Key | Value |
   |---|---|
   | `BACKUP_S3_ENDPOINT` | the endpoint URL from step 3 |
   | `BACKUP_S3_BUCKET` | `pulse-backups` |
   | `BACKUP_S3_ACCESS_KEY` | the Access Key ID |
   | `BACKUP_S3_SECRET_KEY` | the Secret Access Key |

   Save — Render redeploys automatically (~1 minute of downtime).

5. **Verify:** open Pulse → **Admin → Backup**
   (https://howler-pulse-v2.onrender.com). The snapshot card at the top must
   now say **"protected off-box ✅"**. Press **Run snapshot now** and confirm
   the latest run says **"copied off-box"**. (Until this works, the card shows
   a red warning and ops gets a Slack nag after every nightly run — that is
   deliberate.)

## Part 2 — Escrow the two master keys (password manager)

A backup is only useful if it can be decrypted after a disaster. Two secret
values make that possible, and today they exist **only** inside Render:

1. In https://dashboard.render.com → howler-pulse-v2 → **Environment**, reveal
   and copy the values of `MASTER_KEY` and `SESSION_SECRET`.
2. Save both in the company password manager (e.g. 1Password) in a shared
   vault, labelled "Pulse production — MASTER_KEY / SESSION_SECRET — needed for
   any restore".

Without the exact `MASTER_KEY`, every client integration secret inside a
restored backup is permanently unreadable.

## Part 3 — Rehearse a restore once (ask a developer / Claude session)

One dry run on staging proves the whole chain works and records how long it
takes. The step-by-step restore procedure is in `DEPLOY.md` §9. Afterwards,
write the timings into `DEPLOY.md` and tick the punch-list box.

---

## How you'll know it's working from now on

- **Green path:** Admin → Backup shows "protected off-box ✅" and each nightly
  run's history line says "copied off-box".
- **Red path:** if off-box storage is missing or broken, the Backup tab shows a
  red warning card AND the internal ops Slack channel gets a daily
  "Nightly backup ran LOCAL-ONLY" alert (backup *failures* already alerted;
  local-only "successes" now alert too).
