# Deploying Howler : Pulse

Pulse is a single Node/Express process that serves the built React app **and**
the API, keeps its own data in a **SQLite file**, and calls out to Looker and
Anthropic. Looker/BigQuery does the analytics compute — Pulse is a thin,
cached proxy.

> **Key constraint:** state lives in a SQLite file, so run **one instance** with
> a **persistent disk**. Don't use serverless or auto-scaling multi-instance
> hosting until you migrate storage to Postgres (see "Scaling" below).

---

## Recommended: one small VM + Caddy (auto-HTTPS) + systemd

### 1. Server
A small Linux VM (~2 vCPU / 2–4 GB) with a persistent disk. Install **Node 20+**.
Point a domain (e.g. `pulse.howler.co.za`) at its public IP.

### 2. Build
```bash
git clone <repo> /opt/pulse && cd /opt/pulse
npm ci
npm run build            # installs + builds the client into client/dist
```

### 3. Configure `/opt/pulse/.env` (never commit this)
```ini
NODE_ENV=production
PORT=3045
DATA_DIR=/var/lib/pulse              # SQLite db + session secret on the persistent disk
SESSION_SECRET=<long random string>  # so logins survive restarts
ADMIN_EMAIL=admin@howler.co.za        # seeded on first boot only
ADMIN_PASSWORD=<strong password>
# Looker + Anthropic can live here OR be set in Admin → Integrations (stored in the DB):
LOOKER_BASE_URL=https://yourco.cloud.looker.com
LOOKER_CLIENT_ID=...
LOOKER_CLIENT_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
```
```bash
sudo mkdir -p /var/lib/pulse && sudo chown $USER /var/lib/pulse
```

### 4. Run as a service (systemd) — survives logout/reboot
`/etc/systemd/system/pulse.service`:
```ini
[Unit]
Description=Howler Pulse
After=network.target

[Service]
WorkingDirectory=/opt/pulse
EnvironmentFile=/opt/pulse/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
User=pulse

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now pulse
sudo journalctl -u pulse -f      # logs
```

### 5. HTTPS reverse proxy (Caddy — gets/renews TLS automatically)
`/etc/caddy/Caddyfile`:
```
pulse.howler.co.za {
    reverse_proxy localhost:3045
}
```
```bash
sudo systemctl reload caddy
```
Now `https://pulse.howler.co.za` is reachable from **any browser**, gated by login.

### 6. Backups
The whole database is one file: `$DATA_DIR/howler.db` — and **backups are built
in** (`server/backup.js`). Every night the server takes an online snapshot
(safe under WAL — never copy the raw file by hand, you'd miss the `-wal`),
gzips it to `$DATA_DIR/backups/`, and keeps the last `BACKUP_KEEP` (default 3).

**That alone does NOT survive disk loss.** To get the snapshot off the box, set
the S3-compatible credentials (Cloudflare R2 is the cheapest option — a free
bucket is fine):

```
BACKUP_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=pulse-backups
BACKUP_S3_ACCESS_KEY=…
BACKUP_S3_SECRET_KEY=…
```

Check status / take one now / download the latest from Admin (or curl):
`GET /api/admin/backups`, `POST /api/admin/backups/run`,
`GET /api/admin/backups/download`. Failures raise an ops alert (see
`OPS_SLACK_WEBHOOK_URL`). To restore: gunzip the snapshot and point `DB_FILE`
at it.

---

### 7. CI-gated deploys (strongly recommended)
Out of the box Render's **Auto-Deploy** redeploys the moment `main` is pushed —
*before* GitHub Actions finishes, so broken code can go live with a red test
suite. The CI workflow already contains a `deploy` job that triggers Render
only after lint + tests + build are green. Activate it once (5 minutes):

1. Render → `howler-pulse` → **Settings → Deploy Hook** → copy the URL.
2. GitHub repo → **Settings → Secrets and variables → Actions** → new secret
   `RENDER_DEPLOY_HOOK` = that URL.
3. Render → **Settings** → turn **Auto-Deploy OFF**.

From then on every push to `main` deploys only after CI passes. (Until the
secret is set, the job skips harmlessly and Auto-Deploy keeps working as
before.)

### 8. Ops alerts (know when the night went wrong)
Set `OPS_SLACK_WEBHOOK_URL` to a **Howler-internal** Slack incoming webhook.
Backup failures, failed scheduled digests, email delivery failures and
unhandled errors then post to that channel (throttled to one per kind per
15 min) instead of dying quietly in the Render log stream. Without it,
everything still logs to stdout as before.

### 9. Secrets at rest (`MASTER_KEY`)
Integration credentials (Looker/Resend/Anthropic/Meta/TikTok/Clickatell/GitHub
tokens, webhook secrets, per-client keys) are **encrypted at rest**
(`server/secretbox.js`, AES-256-GCM) so a leaked DB export or off-box backup
can't be read. The encryption key comes from **`MASTER_KEY`** (set it in Render —
`render.yaml` generates one); if unset, a random key is persisted to
`DATA_DIR/.master-key`.

**Backup/restore implication:** a snapshot is useless without the key, which is
the point — but it means **restoring a backup requires the same `MASTER_KEY`**
(or the `.master-key` file). Keep a copy of `MASTER_KEY` somewhere safe (a
password manager) alongside your other break-glass credentials. Existing
plaintext secrets are sealed automatically on first boot after this ships.

## Pre-production checklist
- [ ] **Rotate the Looker API3 secret** (it was shared in chat during dev) and set the new one.
- [ ] Strong `SESSION_SECRET` and admin password.
- [ ] `NODE_ENV=production` (Secure cookies + trust proxy).
- [ ] **Looker IP allowlist:** if Looker restricts API by IP, add the server's IP.
- [ ] `DATA_DIR` on a persistent, backed-up disk.
- [ ] HTTPS only; lock down `.env` file permissions (`chmod 600`).

---

## Performance & scaling

Pulse already protects Looker with: a **query cache** (stale-while-revalidate),
**in-flight de-duplication** of identical queries, and an **outbound
concurrency limiter**. Tune via env (see `.env.example`):

| Var | Default | What it does |
|-----|---------|--------------|
| `QUERY_CACHE_TTL` | 60 | Seconds a Looker result is served "fresh". |
| `QUERY_CACHE_STALE` | 600 | After TTL, how long to serve the cached copy while refreshing in the background. |
| `QUERY_CACHE_MAX` | 500 | Max cached query results (LRU-ish eviction). |
| `LOOKER_MAX_CONCURRENCY` | 8 | Max simultaneous outbound Looker requests; spikes queue instead of overloading Looker/BigQuery. Match your Looker plan. |

**The real bottleneck at scale is Looker/BigQuery, not Pulse.** Each dashboard
view = N tile queries. Highest-impact levers:
1. **PDTs / aggregate (rollup) tables** in LookML so common tiles are pre-computed — cuts both latency and BigQuery cost.
2. Longer cache TTLs for expensive/slow explores (e.g. cashless).
3. Size the Looker plan's query concurrency and BigQuery slots for peak load.

### Going horizontal (true high volume / HA)
Auth is **stateless JWT cookies**, so multiple instances work as-is — the only
blocker is the SQLite file. To scale out:
1. Migrate the metadata store **SQLite → Postgres**. `server/db.js` is the only
   module that touches storage; swap its `better-sqlite3` calls for a Postgres
   client (e.g. `pg`). Tables/columns map 1:1.
2. Run **2+ Node instances** behind a load balancer.
3. Move the query cache to **shared Redis** so cache/dedup is shared across
   instances (higher hit rate, less Looker load).

Until then, a single well-sized VM comfortably serves dozens of clients with
moderate concurrency.
