#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$OPS_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT/.runtime"
mkdir -p "$RUNTIME_DIR"

read_env_value() {
  local key="$1"
  local env_file="$PROJECT/api/.env"
  python3 - "$env_file" "$key" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
target = sys.argv[2]
if not path.exists():
    raise SystemExit(0)

for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
    line = raw.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('export '):
        line = line[7:].strip()
    if '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key.strip() != target:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    print(value)
    break
PY
}

api_port() {
  local value
  value="$(read_env_value PORT || true)"
  printf '%s\n' "${value:-4100}"
}

web_port() {
  python3 - "$PROJECT/web/vite.config.js" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8', errors='replace') if path.exists() else ''
match = re.search(r'\bport\s*:\s*(\d+)', text)
print(match.group(1) if match else '3000')
PY
}

pid_alive() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_url() {
  local url="$1"
  local attempts="${2:-60}"
  local delay="${3:-1}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}
