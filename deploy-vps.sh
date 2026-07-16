#!/usr/bin/env bash
# Rebuild & recreate the litewebui container on a Linux host with Docker.
# Usage:
#   export AUTH_PASSWORD="$(echo -n 'yourpass' | sha256sum | awk '{print $1}')"
#   export NINEROUTER_BASE_URL=http://172.17.0.1:20128/v1   # optional
#   ./deploy-vps.sh
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-litewebui}"
NAME="${NAME:-litewebui}"
PORT="${PORT:-3050}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
# default = SHA-256("changeme")
AUTH_PASSWORD="${AUTH_PASSWORD:-057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86}"
NINEROUTER_BASE_URL="${NINEROUTER_BASE_URL:-http://172.17.0.1:20128/v1}"
VOLUME="${VOLUME:-litewebui-data}"

echo "== docker build =="
sudo docker build --no-cache -t "$IMAGE" .

echo "== recreate container =="
sudo docker stop "$NAME" 2>/dev/null || true
sudo docker rm "$NAME" 2>/dev/null || true
sudo docker run -d --name "$NAME" --restart unless-stopped \
  -p "${PORT}:3050" \
  -e AUTH_USERNAME="$AUTH_USERNAME" \
  -e AUTH_PASSWORD="$AUTH_PASSWORD" \
  -e NINEROUTER_BASE_URL="$NINEROUTER_BASE_URL" \
  -e DATA_DIR=/data \
  -v "${VOLUME}:/data" \
  "$IMAGE"

sleep 1
echo "== health =="
curl -sf "http://127.0.0.1:${PORT}/api/health" && echo
echo "== build stamp =="
curl -s "http://127.0.0.1:${PORT}/" | grep -E 'litewebui-build|app.js' | head -n 3 || true
echo "DONE — open http://YOUR_IP:${PORT} and hard-refresh (Ctrl+Shift+R)"