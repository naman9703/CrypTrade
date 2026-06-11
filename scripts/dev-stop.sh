#!/usr/bin/env bash
# Stop local dev servers and free common ports (8000 backend, 8001 AI, 5173 Vite).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=kill-port.sh
source "$ROOT/scripts/kill-port.sh"

PORTS=(8000 8001 5173)
AI_PORT="${AI_SERVICE_PORT:-8001}"
if [[ "$AI_PORT" != "8001" ]]; then
  PORTS+=("$AI_PORT")
fi

# Orphaned uvicorn --reload workers may survive port kill if parent tree is detached.
pkill -TERM -f "uvicorn app.main:app" 2>/dev/null || true
sleep 0.3
pkill -KILL -f "uvicorn app.main:app" 2>/dev/null || true

for port in "${PORTS[@]}"; do
  kill_port "$port"
done

echo "Dev ports cleared."
