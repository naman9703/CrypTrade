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

if ! "$PY" scripts/verify_xgboost.py; then
  echo ""
  echo "dev:ai failed (see errors above). Fixes:"
  echo "  • macOS: brew install libomp"
  echo "  • Or skip check: SKIP_XGBOOST_VERIFY=1 npm run dev:ai"
  echo "  • Or run without AI: npm run dev:no-ai   (backend + frontend only; Vite EPIPE often means this task died first)"
  exit 1
fi
exec "$PY" -m uvicorn app.main:app --reload --port "${AI_SERVICE_PORT:-8001}"
