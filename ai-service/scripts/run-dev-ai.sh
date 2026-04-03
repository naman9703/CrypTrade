#!/usr/bin/env bash
# Start AI service with OpenMP on PATH for XGBoost (macOS Homebrew — /opt/homebrew or ~/homebrew).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="./.venv/bin/python"

if [[ "$(uname -s)" == "Darwin" ]]; then
  for LIBOMP in "$HOME/homebrew/opt/libomp/lib" "/opt/homebrew/opt/libomp/lib" "/usr/local/opt/libomp/lib"; do
    if [[ -f "$LIBOMP/libomp.dylib" ]]; then
      export DYLD_LIBRARY_PATH="$LIBOMP:${DYLD_LIBRARY_PATH:-}"
      break
    fi
  done
fi

"$PY" scripts/verify_xgboost.py
exec "$PY" -m uvicorn app.main:app --reload --port "${AI_SERVICE_PORT:-8001}"
