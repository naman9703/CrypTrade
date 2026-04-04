#!/bin/sh
set -e
export AI_BASE_URL="${AI_BASE_URL:-http://127.0.0.1:8001}"
export SERVE_FRONTEND="${SERVE_FRONTEND:-1}"
export NODE_ENV="${NODE_ENV:-production}"

# AI models / feedback (mount a Railway volume on this path to persist across deploys)
export MODEL_DIR="${MODEL_DIR:-/app/ai-service/data/model}"
mkdir -p "$MODEL_DIR"

# Binance spot often returns HTTP 451 from many cloud IPs. USDT-M *public* fapi/fstream may still work.
# Order: spot ping → if blocked, try fapi ping → upgrade to BINANCE_FUTURES (real perps candles + depth + universe).
# Only use SYNTH if both fail. BINANCE_SYNTH_FALLBACK=0 skips all probes (keeps MARKET_FEED as you set it).
if [ "${MARKET_FEED:-SYNTH}" = "BINANCE" ]; then
  case "${BINANCE_SYNTH_FALLBACK:-1}" in
    0|false|FALSE|no|NO) ;;
    *)
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "https://api.binance.com/api/v3/ping" 2>/dev/null || printf "000")
      if [ "$code" != "200" ]; then
        fapi_ping="${BINANCE_FUTURES_REST_BASE:-https://fapi.binance.com}/fapi/v1/ping"
        fcode=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$fapi_ping" 2>/dev/null || printf "000")
        if [ "$fcode" = "200" ]; then
          echo "[entrypoint] Spot ping → HTTP $code (blocked or error). Futures $fapi_ping → OK. Using MARKET_FEED=BINANCE_FUTURES for live USDT-M market data (not synthetic)."
          export MARKET_FEED=BINANCE_FUTURES
        else
          echo "[entrypoint] Spot ping HTTP $code; futures ping HTTP $fcode. Using MARKET_FEED=SYNTH. For real data on cloud hosts set MARKET_FEED=BINANCE_FUTURES if fapi is reachable, or use a Binance-eligible network."
          export MARKET_FEED=SYNTH
        fi
      fi
      ;;
  esac
fi

# USDT-M public: optional connectivity check only — do not override BINANCE_FUTURES (WS may work when ping flakes).
if [ "${MARKET_FEED:-SYNTH}" = "BINANCE_FUTURES" ]; then
  case "${BINANCE_SYNTH_FALLBACK:-1}" in
    0|false|FALSE|no|NO) ;;
    *)
      fapi_ping="${BINANCE_FUTURES_REST_BASE:-https://fapi.binance.com}/fapi/v1/ping"
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$fapi_ping" 2>/dev/null || printf "000")
      if [ "$code" != "200" ]; then
        echo "[entrypoint] WARNING: $fapi_ping → HTTP $code (keeping MARKET_FEED=BINANCE_FUTURES). If feed stays inactive, set MARKET_FEED=SYNTH or use a Binance-eligible host."
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
