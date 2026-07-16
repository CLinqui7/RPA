#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"

API_PORT="$(api_port)"
WEB_PORT="$(web_port)"

echo "API_PORT=$API_PORT"
echo "WEB_PORT=$WEB_PORT"

if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "API_UP=YES"
  curl -fsS "http://127.0.0.1:$API_PORT/health" | python3 -m json.tool
else
  echo "API_UP=NO"
fi

if curl -fsS "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then
  echo "WEB_UP=YES"
else
  echo "WEB_UP=NO"
fi

if curl -fsS "http://127.0.0.1:$API_PORT/po/operational-extensions/status" >/dev/null 2>&1; then
  echo "OPERATIONAL_EXTENSIONS=YES"
  curl -fsS "http://127.0.0.1:$API_PORT/po/operational-extensions/status" \
    | python3 -m json.tool
else
  echo "OPERATIONAL_EXTENSIONS=NO"
fi

if pid_alive "$RUNTIME_DIR/cloudflare.pid"; then
  echo "CLOUDFLARE_RUNNING=YES"
  grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' \
    "$RUNTIME_DIR/cloudflare.log" 2>/dev/null | tail -1 \
    | sed 's/^/CLOUDFLARE_URL=/' || true
else
  echo "CLOUDFLARE_RUNNING=NO"
fi
