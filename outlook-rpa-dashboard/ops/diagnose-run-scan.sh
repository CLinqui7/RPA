#!/usr/bin/env bash
set -euo pipefail

PROJECT="${1:-/workspaces/RPA/outlook-rpa-dashboard}"
source "$PROJECT/ops/runtime-lib.sh"

API_PORT="$(api_port)"
BASE="http://127.0.0.1:$API_PORT"

echo "API_BASE=$BASE"
echo "===== HEALTH ====="
curl -fsS "$BASE/health" | python3 -m json.tool

echo "===== RUN SCAN DEPENDENCIES ====="
curl -fsS "$BASE/run-scan/dependencies" | python3 -m json.tool

echo "===== RUN SCAN STATUS ====="
curl -fsS "$BASE/run-scan/status?ts=$(date +%s%N)" \
  | python3 -m json.tool

echo "===== RECENT RPA LOG ====="
grep -E \
  "RPA_STAGE|RUN_SCAN|scanOutlook|upsertEmails|saveDownloadedDocuments|processScannedDocuments" \
  "$PROJECT/.runtime/api.log" \
  | tail -120 \
  || true

echo "DIAGNOSE_RUN_SCAN=PASS"
