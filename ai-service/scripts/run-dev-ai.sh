#!/usr/bin/env bash
# Start AI service with OpenMP on PATH for XGBoost (macOS Homebrew — /opt/homebrew or ~/homebrew).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
cd "$ROOT"
PY="./.venv/bin/python"
PORT="${AI_SERVICE_PORT:-8001}"

# shellcheck source=../../scripts/kill-port.sh
source "$REPO_ROOT/scripts/kill-port.sh"

# uvicorn --reload can orphan workers on :8001 after Ctrl+C; always clear before bind and on exit.
cleanup() {
  pkill -TERM -f "uvicorn app.main:app.*--port ${PORT}" 2>/dev/null || true
  sleep 0.2
  pkill -KILL -f "uvicorn app.main:app.*--port ${PORT}" 2>/dev/null || true
  kill_port "$PORT"
}

trap cleanup EXIT INT TERM

if [[ "$(uname -s)" == "Darwin" ]]; then
  for LIBOMP in "$HOME/homebrew/opt/libomp/lib" "/opt/homebrew/opt/libomp/lib" "/usr/local/opt/libomp/lib"; do
    if [[ -f "$LIBOMP/libomp.dylib" ]]; then
      export DYLD_LIBRARY_PATH="$LIBOMP:${DYLD_LIBRARY_PATH:-}"
      break
    fi
  done
fi

if ! "$PY" scripts/verify_xgboost.py; then
  echo ""
  echo "dev:ai failed (see errors above). Fixes:"
  echo "  • macOS: brew install libomp"
  echo "  • Or skip check: SKIP_XGBOOST_VERIFY=1 npm run dev:ai"
  echo "  • Or run without AI: npm run dev:no-ai   (backend + frontend only; Vite EPIPE often means this task died first)"
  echo "  • Port still in use: npm run dev:stop"
  exit 1
fi

# Stale uvicorn/npm orphans from a prior dev session hold :8001 — free it before bind.
cleanup

echo "Starting AI service on 127.0.0.1:${PORT}…"
"$PY" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$PORT"
