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
The whole database is one file: `$DATA_DIR/howler.db`. Nightly copy via cron, or
use **Litestream** for continuous streaming backup to S3.

---

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
