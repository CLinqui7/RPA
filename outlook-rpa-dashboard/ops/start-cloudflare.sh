#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"
WEB_PORT="$(web_port)"
BIN="$RUNTIME_DIR/cloudflared"
LOG="$RUNTIME_DIR/cloudflare.log"
PID_FILE="$RUNTIME_DIR/cloudflare.pid"

if ! curl -fsS "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then
  echo "WEB_UP=NO"
  echo "Run first: bash $PROJECT/ops/start-all.sh"
  exit 1
fi

if pid_alive "$PID_FILE"; then
  echo "CLOUDFLARE_ALREADY_RUNNING=YES"
  grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$LOG" \
    | tail -1 | sed 's/^/CLOUDFLARE_URL=/' || true
  exit 0
fi

if command -v cloudflared >/dev/null 2>&1; then
  BIN="$(command -v cloudflared)"
elif [[ ! -x "$BIN" ]]; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset='cloudflared-linux-amd64' ;;
    aarch64|arm64) asset='cloudflared-linux-arm64' ;;
    *) echo "Unsupported architecture: $arch"; exit 1 ;;
  esac
  echo "DOWNLOADING_CLOUDFLARED=$asset"
  curl -fL --retry 3 --retry-delay 2 \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset" \
    -o "$BIN"
  chmod +x "$BIN"
fi

: > "$LOG"
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  nohup "$BIN" tunnel --no-autoupdate run \
    --token "$CLOUDFLARE_TUNNEL_TOKEN" >"$LOG" 2>&1 &
  mode='NAMED_TOKEN_TUNNEL'
else
  nohup "$BIN" tunnel --no-autoupdate \
    --url "http://127.0.0.1:$WEB_PORT" >"$LOG" 2>&1 &
  mode='QUICK_TUNNEL'
fi

echo $! > "$PID_FILE"

url=''
for _ in $(seq 1 45); do
  if ! pid_alive "$PID_FILE"; then
    echo "===== CLOUDFLARE LOG ====="
    cat "$LOG" || true
    echo "CLOUDFLARE_START=FAIL"
    exit 1
  fi
  url="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$LOG" | tail -1 || true)"
  if [[ "$mode" == 'NAMED_TOKEN_TUNNEL' || -n "$url" ]]; then
    break
  fi
  sleep 1
done

echo "CLOUDFLARE_MODE=$mode"
[[ -n "$url" ]] && echo "CLOUDFLARE_URL=$url"
echo "CLOUDFLARE_LOG=$LOG"
echo "CLOUDFLARE_START=PASS"
