#!/bin/sh
# Generate heartbeat.mp3 if it doesn't exist (runs on Railway startup)
ASSETS_DIR="$(dirname "$0")/../assets"
mkdir -p "$ASSETS_DIR"
if [ ! -f "$ASSETS_DIR/heartbeat.mp3" ]; then
  echo "[gen_heartbeat] Generating heartbeat.mp3..."
  ffmpeg -f lavfi -i "sine=frequency=60:duration=0.1" -af "volume=0.5" -y "$ASSETS_DIR/heartbeat.mp3" 2>/dev/null
  echo "[gen_heartbeat] Done."
else
  echo "[gen_heartbeat] heartbeat.mp3 already exists."
fi
