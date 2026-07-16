#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"

API_PORT="$(api_port)"
WEB_PORT="$(web_port)"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"
API_LOG="$RUNTIME_DIR/api.log"
WEB_LOG="$RUNTIME_DIR/web.log"

cd "$PROJECT"

echo "PROJECT=$PROJECT"
echo "API_PORT=$API_PORT"
echo "WEB_PORT=$WEB_PORT"

if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "API_ALREADY_RUNNING=YES"
else
  if pid_alive "$API_PID_FILE"; then
    kill "$(cat "$API_PID_FILE")" 2>/dev/null || true
    sleep 1
  fi
  nohup npm --prefix api run dev >"$API_LOG" 2>&1 &
  echo $! > "$API_PID_FILE"
  if ! wait_url "http://127.0.0.1:$API_PORT/health" 75 1; then
    echo "===== API LOG ====="
    tail -160 "$API_LOG" || true
    echo "API_START=FAIL"
    exit 1
  fi
  echo "API_STARTED=YES"
fi

if curl -fsS "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then
  echo "WEB_ALREADY_RUNNING=YES"
else
  if pid_alive "$WEB_PID_FILE"; then
    kill "$(cat "$WEB_PID_FILE")" 2>/dev/null || true
    sleep 1
  fi
  VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
    nohup npm --prefix web run dev -- --host 0.0.0.0 \
    >"$WEB_LOG" 2>&1 &
  echo $! > "$WEB_PID_FILE"
  if ! wait_url "http://127.0.0.1:$WEB_PORT" 75 1; then
    echo "===== WEB LOG ====="
    tail -160 "$WEB_LOG" || true
    echo "WEB_START=FAIL"
    exit 1
  fi
  echo "WEB_STARTED=YES"
fi

echo "API_URL=http://127.0.0.1:$API_PORT"
echo "WEB_URL=http://127.0.0.1:$WEB_PORT"
echo "API_LOG=$API_LOG"
echo "WEB_LOG=$WEB_LOG"
echo "START_ALL=PASS"
