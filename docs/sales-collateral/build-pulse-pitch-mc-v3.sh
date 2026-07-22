#!/usr/bin/env bash
# Build script for the Milk & Cookies board deck, version 2.
# Renders pulse-pitch-mc-v3.src.html -> Pulse-Sales-Pitch-mc-v3.pdf
# Never touches v1 (pulse-pitch.src.html / Pulse-Sales-Pitch.pdf).
#
# Versioning rule: do NOT edit an existing version in place. Each round of
# changes is a new numbered copy (v3, v4, ...) with its own build script.
set -euo pipefail

cd "$(dirname "$0")"

SRC="pulse-pitch-mc-v3.src.html"
OUT="Pulse-Sales-Pitch-mc-v3.pdf"

# Find a Chromium/Chrome binary (honour $CHROMIUM if set).
CHROME="${CHROMIUM:-}"
if [ -z "$CHROME" ]; then
  for c in chromium chromium-browser google-chrome google-chrome-stable /opt/pw-browsers/chromium; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "No Chromium/Chrome found. Set CHROMIUM=/path/to/chromium and re-run." >&2
  exit 1
fi

"$CHROME" --headless --no-sandbox \
  --print-to-pdf="$OUT" --no-pdf-header-footer \
  "$SRC"

echo "Built $OUT from $SRC"
