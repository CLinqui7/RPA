#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime-lib.sh"

for name in cloudflare web api; do
  pid_file="$RUNTIME_DIR/$name.pid"
  if pid_alive "$pid_file"; then
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "STOPPED_${name^^}=YES"
  else
    echo "STOPPED_${name^^}=NOT_RUNNING"
  fi
  rm -f "$pid_file"
done

echo "STOP_ALL=PASS"

# RPA_RUNTIME_STRICT_CHILD_CLEANUP_V1
kill_processes_by_cwd_and_pattern() {
  local expected_cwd="$1"
  local pattern="$2"
  local found=0

  while read -r pid ppid args; do
    [[ -n "${pid:-}" ]] || continue
    [[ "$args" == *"$pattern"* ]] || continue

    local cwd=""
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$expected_cwd" ]] || continue

    found=1
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done < <(ps -eo pid=,ppid=,args=)

  sleep 1

  while read -r pid ppid args; do
    [[ -n "${pid:-}" ]] || continue
    [[ "$args" == *"$pattern"* ]] || continue

    local cwd=""
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$expected_cwd" ]] || continue

    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done < <(ps -eo pid=,ppid=,args=)

  if [[ "$found" -eq 1 ]]; then
    echo "STRICT_STOP_PATTERN=$pattern"
  fi
}

kill_processes_by_cwd_and_pattern "$PROJECT/api" "node --watch src/server.js"
kill_processes_by_cwd_and_pattern "$PROJECT/api" "npm run dev"
kill_processes_by_cwd_and_pattern "$PROJECT/web" "vite"
kill_processes_by_cwd_and_pattern "$PROJECT/web" "npm run dev"

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${API_PORT:-4100}/tcp" 2>/dev/null || true
  fuser -k "${WEB_PORT:-3000}/tcp" 2>/dev/null || true
fi

echo "STRICT_RUNTIME_CHILD_CLEANUP=PASS"
