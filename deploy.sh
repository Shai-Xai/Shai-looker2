#!/usr/bin/env bash
# Update Howler : Pulse in production: back up the database, pull, build, restart.
# Usage:  ./deploy.sh
# Config (env or edit defaults):
#   SERVICE_NAME   systemd service to restart        (default: pulse)
#   BRANCH         git branch to deploy              (default: current branch)
#   DATA_DIR       where howler.db lives             (default: from .env, else server/data)
#   KEEP_BACKUPS   how many DB backups to retain     (default: 10)
set -euo pipefail

cd "$(dirname "$0")"

SERVICE_NAME="${SERVICE_NAME:-pulse}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

# Resolve DATA_DIR: explicit env > .env file > default.
if [ -z "${DATA_DIR:-}" ]; then
  if [ -f .env ]; then DATA_DIR="$(grep -E '^DATA_DIR=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"; fi
  DATA_DIR="${DATA_DIR:-server/data}"
fi
DB_FILE="${DB_FILE:-$DATA_DIR/howler.db}"

echo "▶ Deploying '$BRANCH'  (service: $SERVICE_NAME, data: $DATA_DIR)"

# 1) Back up the database (it's a single file). SQLite-safe online backup if the
#    sqlite3 CLI is present; otherwise a plain copy.
if [ -f "$DB_FILE" ]; then
  BACKUP_DIR="$DATA_DIR/backups"
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  DEST="$BACKUP_DIR/howler-$STAMP.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_FILE" ".backup '$DEST'"
  else
    cp "$DB_FILE" "$DEST"
  fi
  echo "  ✓ DB backed up → $DEST"
  # Retain only the most recent $KEEP_BACKUPS backups.
  ls -1t "$BACKUP_DIR"/howler-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
else
  echo "  ⚠ No DB at $DB_FILE yet (first deploy?) — skipping backup."
fi

# 2) Pull the latest code.
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
echo "  ✓ Code at $(git rev-parse --short HEAD)"

# 3) Install deps + build the client.
npm ci
npm run build
echo "  ✓ Built client"

# 4) Restart the service.
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
  sudo systemctl restart "$SERVICE_NAME"
  echo "  ✓ Restarted $SERVICE_NAME"
  sudo systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
else
  echo "  ⚠ systemd service '$SERVICE_NAME' not found — restart your server process manually."
fi

echo "✅ Deploy complete."
