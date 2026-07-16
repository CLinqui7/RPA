#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"
API_PORT="$(api_port)"
BASE="http://127.0.0.1:$API_PORT"

curl -fsS "$BASE/health" >/dev/null || {
  echo "API_UP=NO"
  echo "Run: bash $PROJECT/ops/start-all.sh"
  exit 1
}

echo "============================================================"
echo "1. CUSTOMER SKU / UPC"
echo "============================================================"
set +e
STATUS="$(curl -sS -o "$RUNTIME_DIR/customer-identifiers-reconcile.json" -w '%{http_code}' \
  -X POST "$BASE/po/customer-identifiers/reconcile" \
  -H 'Content-Type: application/json' \
  -d '{"limit":200,"upload":true}')"
set -e
echo "CUSTOMER_IDENTIFIER_HTTP=$STATUS"
python3 -m json.tool "$RUNTIME_DIR/customer-identifiers-reconcile.json" \
  || cat "$RUNTIME_DIR/customer-identifiers-reconcile.json"

echo "============================================================"
echo "2. PICK TICKET SNAPSHOT + PDF"
echo "============================================================"
set +e
STATUS="$(curl -sS -o "$RUNTIME_DIR/pick-tickets-reconcile.json" -w '%{http_code}' \
  -X POST "$BASE/po/pick-tickets/reconcile" \
  -H 'Content-Type: application/json' \
  -d '{"limit":500}')"
set -e
echo "PICK_TICKET_HTTP=$STATUS"
python3 -m json.tool "$RUNTIME_DIR/pick-tickets-reconcile.json" \
  || cat "$RUNTIME_DIR/pick-tickets-reconcile.json"

echo "============================================================"
echo "3. CURRENT PICK TICKETS"
echo "============================================================"
curl -fsS "$BASE/po/pick-tickets?limit=500" \
  | tee "$RUNTIME_DIR/pick-tickets.json" \
  | python3 -m json.tool

echo "RECONCILE_NOW=COMPLETE"
