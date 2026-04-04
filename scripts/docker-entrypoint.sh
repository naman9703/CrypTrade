#!/bin/sh
set -e
export AI_BASE_URL="${AI_BASE_URL:-http://127.0.0.1:8001}"
export SERVE_FRONTEND="${SERVE_FRONTEND:-1}"
export NODE_ENV="${NODE_ENV:-production}"

# AI models / feedback (mount a Railway volume on this path to persist across deploys)
export MODEL_DIR="${MODEL_DIR:-/app/ai-service/data/model}"
mkdir -p "$MODEL_DIR"

# Binance often returns HTTP 451 from US and many cloud provider IPs (legal / geo block).
# Logs then show: binance_ws_error "Unexpected server response: 451" and the header stays BINANCE (inactive).
# Probe REST once; if not 200, fall back to synthetic market data so the bot can run.
# Set BINANCE_SYNTH_FALLBACK=0 to skip this and keep MARKET_FEED=BINANCE (still likely broken on blocked IPs).
if [ "${MARKET_FEED:-SYNTH}" = "BINANCE" ]; then
  case "${BINANCE_SYNTH_FALLBACK:-1}" in
    0|false|FALSE|no|NO) ;;
    *)
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "https://api.binance.com/api/v3/ping" 2>/dev/null || printf "000")
      if [ "$code" != "200" ]; then
        echo "[entrypoint] Binance https://api.binance.com/api/v3/ping → HTTP $code. Using MARKET_FEED=SYNTH (synthetic candles). Train-on-real-data needs Binance-eligible network; use \"Train synthetic (quick)\" or set BINANCE_SYNTH_FALLBACK=0 to force BINANCE."
        export MARKET_FEED=SYNTH
      fi
      ;;
  esac
fi

echo "Starting AI service on 127.0.0.1:8001…"
cd /app/ai-service
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 &
AI_PID=$!

# Wait until /health responds (avoid racing node before sklearn loads)
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -sf "http://127.0.0.1:8001/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cleanup() {
  echo "Stopping AI service…"
  kill "$AI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Node backend on 0.0.0.0:${PORT:-8000}…"
cd /app/backend
exec node src/index.js
