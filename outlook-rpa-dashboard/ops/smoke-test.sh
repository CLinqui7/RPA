#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"
API_PORT="$(api_port)"
WEB_PORT="$(web_port)"
BASE="http://127.0.0.1:$API_PORT"

curl -fsS "$BASE/health" | python3 -m json.tool >/tmp/rpa-v4-health.json
curl -fsS "$BASE/po/operational-extensions/status" \
  | python3 -m json.tool >/tmp/rpa-v4-extensions.json
curl -fsS "$BASE/po/customer-identifiers/status" \
  | python3 -m json.tool >/tmp/rpa-v4-identifiers.json
curl -fsS "$BASE/po/pick-tickets?limit=10" \
  | python3 -m json.tool >/tmp/rpa-v4-pick-tickets.json
curl -fsS "$BASE/po/checklists/status" \
  | python3 -m json.tool >/tmp/rpa-v4-checklists.json
curl -fsS "http://127.0.0.1:$WEB_PORT" >/tmp/rpa-v4-web.html

echo "API_HEALTH=PASS"
echo "OPERATIONAL_EXTENSIONS=PASS"
echo "CUSTOMER_IDENTIFIER_STATUS=PASS"
echo "PICK_TICKET_LIST=PASS"
echo "CHECKLIST_CATALOG=PASS"
echo "WEB_HTTP=PASS"
echo "A2000_WRITES_PERFORMED_BY_SMOKE_TEST=NO"
echo "SUPABASE_WRITES_PERFORMED_BY_SMOKE_TEST=NO"
echo "SMOKE_TEST=PASS"
