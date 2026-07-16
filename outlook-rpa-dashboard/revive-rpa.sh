#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT="/workspaces/RPA/outlook-rpa-dashboard"
API_PORT="4100"
WEB_PORT="3001"
DISPLAY_NUMBER="99"
API_LOG="/tmp/outlook-rpa-api.log"
WEB_LOG="/tmp/outlook-rpa-web.log"
XVFB_LOG="/tmp/xvfb-rpa.log"
TUNNEL_LOG="/tmp/cloudflared-rpa.log"
cd "$PROJECT"
echo
echo "=================================================="
echo " REVIVIENDO OUTLOOK RPA"
echo "=================================================="
echo "PROJECT=$PROJECT"
echo "DATE=$(date -Is)"
echo
function kill_port() {
 local port="$1"
 local pids
 pids="$(
   lsof -tiTCP:"$port" \
     -sTCP:LISTEN \
     2>/dev/null || true
 )"
 if [ -n "$pids" ]; then
   echo "Cerrando puerto $port: $pids"
   kill -9 $pids 2>/dev/null || true
 fi
}
function wait_http() {
 local url="$1"
 local name="$2"
 local attempts="${3:-40}"
 for attempt in $(seq 1 "$attempts"); do
   if curl -fsS \
     --max-time 4 \
     "$url" \
>/dev/null 2>&1
   then
     echo "${name}_OK=YES"
     return 0
   fi
   sleep 1
 done
 echo "${name}_OK=NO"
 return 1
}
echo "=================================================="
echo " 1. VALIDANDO DEPENDENCIAS"
echo "=================================================="
for command in \
 node \
 npm \
 curl \
 jq \
 lsof
do
 if ! command -v "$command" >/dev/null 2>&1; then
   echo "ERROR: falta el comando $command"
   exit 1
 fi
done
if ! command -v Xvfb >/dev/null 2>&1; then
 echo "Instalando Xvfb..."
 sudo apt-get update -qq
 sudo apt-get install -y \
   xvfb \
   x11-utils
fi
if ! command -v cloudflared >/dev/null 2>&1; then
 echo "Instalando cloudflared..."
 ARCH="$(
   uname -m
 )"
 case "$ARCH" in
   x86_64|amd64)
     CLOUDFLARED_BINARY="cloudflared-linux-amd64"
     ;;
   aarch64|arm64)
     CLOUDFLARED_BINARY="cloudflared-linux-arm64"
     ;;
   *)
     echo "ERROR: arquitectura no soportada: $ARCH"
     exit 1
     ;;
 esac
 curl -fL \
   "https://github.com/cloudflare/cloudflared/releases/latest/download/${CLOUDFLARED_BINARY}" \
   -o /tmp/cloudflared
 chmod +x /tmp/cloudflared
 sudo mv \
   /tmp/cloudflared \
   /usr/local/bin/cloudflared
fi
echo "NODE=$(node --version)"
echo "NPM=$(npm --version)"
echo "CLOUDFLARED=$(cloudflared --version | head -1)"
echo
echo "=================================================="
echo " 2. DETENIENDO PROCESOS VIEJOS"
echo "=================================================="
kill_port "$API_PORT"
kill_port "$WEB_PORT"
pkill -f \
 "api/src/server.js" \
 2>/dev/null || true
pkill -f \
 "vite.*${WEB_PORT}" \
 2>/dev/null || true
pkill -f \
 "cloudflared tunnel.*${WEB_PORT}" \
 2>/dev/null || true
pkill -f \
 "cloudflared.*127.0.0.1:${WEB_PORT}" \
 2>/dev/null || true
pkill -f \
 "playwright" \
 2>/dev/null || true
pkill -f \
 "chrome-linux.*outlook-profile" \
 2>/dev/null || true
pkill -f \
 "chromium.*outlook-profile" \
 2>/dev/null || true
sleep 2
echo
echo "=================================================="
echo " 3. INICIANDO DISPLAY VIRTUAL"
echo "=================================================="
if DISPLAY=:"$DISPLAY_NUMBER" \
 xdpyinfo \
>/dev/null 2>&1
then
 echo "XVFB_ALREADY_RUNNING=YES"
else
 pkill -f \
   "Xvfb :${DISPLAY_NUMBER}" \
   2>/dev/null || true
 rm -f \
   "/tmp/.X${DISPLAY_NUMBER}-lock" \
   2>/dev/null || true
 rm -f \
   "/tmp/.X11-unix/X${DISPLAY_NUMBER}" \
   2>/dev/null || true
 : > "$XVFB_LOG"
 nohup Xvfb \
   :"$DISPLAY_NUMBER" \
   -screen 0 \
   1920x1080x24 \
   -ac \
   +extension RANDR \
> "$XVFB_LOG" \
   2>&1 &
 XVFB_PID=$!
 disown "$XVFB_PID" \
   2>/dev/null || true
 sleep 3
fi
if ! DISPLAY=:"$DISPLAY_NUMBER" \
 xdpyinfo \
>/dev/null 2>&1
then
 echo "ERROR: Xvfb no inició"
 cat "$XVFB_LOG" 2>/dev/null || true
 exit 1
fi
echo "XVFB_OK=YES"
echo "DISPLAY=:${DISPLAY_NUMBER}"
echo
echo "=================================================="
echo " 4. VALIDANDO CÓDIGO"
echo "=================================================="
node --check \
 api/src/server.js
if [ -f api/src/po/parsers/index.js ]; then
 node --check \
   api/src/po/parsers/index.js
fi
if [ -f api/src/po/parsers/bealls.js ]; then
 node --check \
   api/src/po/parsers/bealls.js
fi
if [ -f api/src/po/parsers/marshalls.js ]; then
 node --check \
   api/src/po/parsers/marshalls.js
fi
if [ ! -d api/node_modules ]; then
 echo "Instalando dependencias de API..."
 npm --prefix api ci
fi
if [ ! -d web/node_modules ]; then
 echo "Instalando dependencias de frontend..."
 npm --prefix web ci
fi
echo "CODE_CHECK_OK=YES"
echo
echo "=================================================="
echo " 5. INICIANDO API"
echo "=================================================="
: > "$API_LOG"
nohup env \
 DISPLAY=:"$DISPLAY_NUMBER" \
 PORT="$API_PORT" \
 node \
 --env-file=api/.env \
 api/src/server.js \
> "$API_LOG" \
 2>&1 &
API_PID=$!
disown "$API_PID" \
 2>/dev/null || true
echo "API_PID=$API_PID"
if ! wait_http \
 "http://127.0.0.1:${API_PORT}/health" \
 "API" \
 45
then
 echo
 echo "=== ERROR API ==="
 tail -n 150 "$API_LOG" 2>/dev/null || true
 exit 1
fi
echo
curl -sS \
 "http://127.0.0.1:${API_PORT}/health" \
 | jq .
echo
echo "=================================================="
echo " 6. INICIANDO FRONTEND"
echo "=================================================="
: > "$WEB_LOG"
nohup npm \
 --prefix web \
 run dev \
 -- \
 --host 0.0.0.0 \
 --port "$WEB_PORT" \
> "$WEB_LOG" \
 2>&1 &
WEB_PID=$!
disown "$WEB_PID" \
 2>/dev/null || true
echo "WEB_PID=$WEB_PID"
if ! wait_http \
 "http://127.0.0.1:${WEB_PORT}/" \
 "WEB" \
 45
then
 echo
 echo "=== ERROR WEB ==="
 tail -n 150 "$WEB_LOG" 2>/dev/null || true
 exit 1
fi
echo
curl -sSI \
 "http://127.0.0.1:${WEB_PORT}/" \
 | head -n 1
echo
echo "=================================================="
echo " 7. INICIANDO CLOUDFLARE QUICK TUNNEL"
echo "=================================================="
: > "$TUNNEL_LOG"
nohup cloudflared tunnel \
 --no-autoupdate \
 --url \
 "http://127.0.0.1:${WEB_PORT}" \
> "$TUNNEL_LOG" \
 2>&1 &
TUNNEL_PID=$!
disown "$TUNNEL_PID" \
 2>/dev/null || true
echo "TUNNEL_PID=$TUNNEL_PID"
PUBLIC_URL=""
for attempt in $(seq 1 60); do
 PUBLIC_URL="$(
   grep -oE \
     'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
     "$TUNNEL_LOG" \
     | head -1 \
     || true
 )"
 if [ -n "$PUBLIC_URL" ]; then
   break
 fi
 if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
   echo "ERROR: cloudflared se cerró"
   cat "$TUNNEL_LOG" 2>/dev/null || true
   exit 1
 fi
 sleep 1
done
if [ -z "$PUBLIC_URL" ]; then
 echo "ERROR: Cloudflare no generó una URL"
 tail -n 150 "$TUNNEL_LOG" 2>/dev/null || true
 exit 1
fi
echo
echo "=================================================="
echo " 8. ESPERANDO DNS Y PROBANDO URL PÚBLICA"
echo "=================================================="

PUBLIC_HOST="$(
  printf '%s' "$PUBLIC_URL" \
  | sed -E 's#^https?://##; s#/.*$##'
)"

echo "PUBLIC_HOST=$PUBLIC_HOST"
echo "Esperando propagación DNS de Cloudflare..."

DNS_OK=NO
PUBLIC_WEB_STATUS="000"
PUBLIC_API_STATUS="000"

for ATTEMPT in $(seq 1 40); do
  echo "PUBLIC_CHECK_ATTEMPT=$ATTEMPT"

  if getent hosts "$PUBLIC_HOST" \
    >/tmp/rpa-public-dns.txt \
    2>/dev/null
  then
    DNS_OK=YES

    PUBLIC_WEB_STATUS="$(
      curl -sS \
        --connect-timeout 10 \
        --max-time 20 \
        -o /dev/null \
        -w "%{http_code}" \
        "$PUBLIC_URL/" \
        || true
    )"

    PUBLIC_API_STATUS="$(
      curl -sS \
        --connect-timeout 10 \
        --max-time 20 \
        -o /tmp/rpa-public-health.json \
        -w "%{http_code}" \
        "$PUBLIC_URL/api/health" \
        || true
    )"

    echo "PUBLIC_WEB_HTTP=$PUBLIC_WEB_STATUS"
    echo "PUBLIC_API_HTTP=$PUBLIC_API_STATUS"

    if [ "$PUBLIC_WEB_STATUS" = "200" ] \
      && [ "$PUBLIC_API_STATUS" = "200" ]
    then
      break
    fi
  else
    echo "DNS_PENDING=YES"
  fi

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "ERROR: cloudflared se cerró"
    tail -n 150 "$TUNNEL_LOG" 2>/dev/null || true
    exit 1
  fi

  sleep 3
done

echo "DNS_OK=$DNS_OK"
echo "PUBLIC_WEB_HTTP=$PUBLIC_WEB_STATUS"
echo "PUBLIC_API_HTTP=$PUBLIC_API_STATUS"

if [ "$PUBLIC_WEB_STATUS" != "200" ]; then
  echo "ERROR: frontend público no respondió 200"
  echo "El túnel local continúa activo."
  echo "RPA_PUBLIC_URL=$PUBLIC_URL"
  tail -n 150 "$TUNNEL_LOG" 2>/dev/null || true
  exit 1
fi

if [ "$PUBLIC_API_STATUS" != "200" ]; then
  echo "ERROR: API pública no respondió 200"
  cat /tmp/rpa-public-health.json 2>/dev/null || true
  exit 1
fi

echo
jq . \
  /tmp/rpa-public-health.json \
  2>/dev/null || true

echo
echo "=================================================="
echo " 9. ESTADO FINAL"
echo "=================================================="
echo
echo "API_LOCAL=http://127.0.0.1:${API_PORT}"
echo "WEB_LOCAL=http://127.0.0.1:${WEB_PORT}"
echo "RPA_PUBLIC_URL=$PUBLIC_URL"
echo
echo "API_PID=$API_PID"
echo "WEB_PID=$WEB_PID"
echo "XVFB_DISPLAY=:${DISPLAY_NUMBER}"
echo "TUNNEL_PID=$TUNNEL_PID"
echo
echo "=== PROCESOS ==="
ps -eo \
 pid,etime,stat,%cpu,%mem,cmd \
 | grep -E \
   "api/src/server.js|vite.*${WEB_PORT}|Xvfb :${DISPLAY_NUMBER}|cloudflared tunnel" \
 | grep -v grep \
 || true
echo
echo "=== MEMORIA ==="
free -h || true
echo
echo "=================================================="
echo " TODO INICIADO CORRECTAMENTE"
echo "=================================================="
echo
echo "Abre esta URL:"
echo
echo "$PUBLIC_URL"
echo
echo "IMPORTANTE:"
echo "La URL cambia cada vez que Codespaces se reinicia."
echo
