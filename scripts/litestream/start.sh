#!/usr/bin/env bash
# Boot wrapper: run the server under Litestream's continuous replication when
# it's configured, plain node otherwise. SAFE BY DEFAULT — a missing binary or
# missing BACKUP_S3_* credentials never blocks boot, it just logs and falls
# back, so this can ship before the bucket credentials are set.
#
# Kill switch: LITESTREAM_ENABLED=0 forces the plain-node path.
set -u

DB="${DB_FILE:-${DATA_DIR:-.}/howler.db}"

if [ "${LITESTREAM_ENABLED:-1}" != "0" ] \
  && [ -x ./litestream ] \
  && [ -n "${BACKUP_S3_ENDPOINT:-}" ] \
  && [ -n "${BACKUP_S3_BUCKET:-}" ] \
  && [ -n "${BACKUP_S3_ACCESS_KEY:-}" ] \
  && [ -n "${BACKUP_S3_SECRET_KEY:-}" ]; then
  echo "[litestream] replicating ${DB} → ${BACKUP_S3_ENDPOINT}/${BACKUP_S3_BUCKET}/litestream"
  exec ./litestream replicate -config scripts/litestream/litestream.yml -exec "node server/index.js"
fi

echo "[litestream] not configured (binary or BACKUP_S3_* missing) — starting plain node"
exec node server/index.js
