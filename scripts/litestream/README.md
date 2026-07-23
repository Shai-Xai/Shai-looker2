# Litestream — continuous DB replication (disaster recovery layer 2)

Two backup layers, one bucket, one credential pair (`BACKUP_S3_*`):

| layer | what | data loss on disk failure |
|---|---|---|
| `server/backup.js` | nightly gzipped snapshot → `<bucket>/pulse-<stamp>.db.gz` | up to 24 h |
| **Litestream** (this) | continuous WAL streaming → `<bucket>/litestream/…` | **seconds** |

## How it runs

- The Render build downloads the Litestream binary (see `render.yaml`
  buildCommand); `scripts/litestream/start.sh` is the start command.
- If the binary or any `BACKUP_S3_*` var is missing (or
  `LITESTREAM_ENABLED=0`), boot falls back to plain `node server/index.js`
  — replication can never break a deploy.
- Config: `scripts/litestream/litestream.yml` (1s sync, hourly snapshots,
  72 h point-in-time retention).

## One-time setup (production dashboard)

1. Cloudflare R2 → create/reuse a bucket (the nightly-backup one is fine).
2. R2 API token with read/write on that bucket.
3. Render → howler-pulse → Environment: set `BACKUP_S3_ENDPOINT`
   (`https://<accountid>.r2.cloudflarestorage.com`), `BACKUP_S3_BUCKET`,
   `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`. (Also activates the
   nightly off-box copy if it wasn't already.)
4. Redeploy. Boot log should show `[litestream] replicating …`.

Staging doesn't need this — leave its `BACKUP_S3_*` unset.

## Restore drill (do this once so it's boring in a real incident)

On a fresh disk/service with the same env vars, BEFORE the app first boots:

```bash
curl -fsSL https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz | tar xz
./litestream restore -config scripts/litestream/litestream.yml "$DATA_DIR/howler.db"
```

Then start the service. `MASTER_KEY` must be the ORIGINAL value (it encrypts
integration secrets at rest) — keep a copy of it somewhere safe outside Render.

Restore to a point in time: add `-timestamp 2026-07-23T10:00:00Z`.
