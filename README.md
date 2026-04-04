# AI-Powered Crypto Trading Platform (Personal)

Hybrid full-stack architecture:

- **Frontend**: React + Tailwind dashboard
- **Backend**: Node.js (Express) API + WebSocket controller
- **AI Service**: Python (FastAPI) with XGBoost classifier
- **Exchange**: Paper trading by default; Binance integration via env vars

## Quick start (local, safe defaults)

### 1) Prereqs

- Node.js 20+
- Python 3.11+ (your system uses `python3`)

### 2) Install deps

```bash
npm install
python3 -m venv ai-service/.venv
source ai-service/.venv/bin/activate
pip install -r ai-service/requirements.txt
```

### 3) Configure env

Copy examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp ai-service/.env.example ai-service/.env
```

### 4) Run everything

```bash
npm run dev
```

Open the UI at `http://localhost:5173`.

## XGBoost note (macOS)

If XGBoost fails to load with a `libomp.dylib` error, install OpenMP:

```bash
brew install libomp
```

The AI service will **temporarily fall back** to a scikit-learn gradient boosting classifier if XGBoost is unavailable.

## Services

- **Frontend**: `http://localhost:5173`
- **Backend API**: `http://localhost:8000`
- **Backend WS**: `ws://localhost:8000/ws`
- **AI Service**: `http://localhost:8001`

## Safety model

- Default mode is **PAPER** (no real orders).
- Switching to Binance requires explicit env settings in `backend/.env`.

## Coin selection (scan → filter → score → pick)

With **`MARKET_FEED=BINANCE`** or **`MARKET_FEED=BINANCE_FUTURES`**, you can enable **AUTO coin selection** in the Trading panel (**Coin select → AUTO**) or via `POST /api/bot/config` with `{ "symbolMode": "AUTO" }`.

The backend periodically:

1. Pulls top **USDT** pairs by **24h quote volume**
2. Filters by **min volume** and **max spread** (book ticker)
3. Fetches **klines** for the top candidates and computes **ATR%, volume spike, trend strength**
4. Calls the **AI service** for a probability score on the best candidates
5. Ranks with a blended score and **switches the chart/trading symbol** to the top pick when you have **no open positions**

Tune thresholds in `backend/.env` (`UNIVERSE_*` vars). Manual scan: `GET /api/universe/scan`.

**Binance Spot Testnet user stream:** the listen-key endpoint often returns **HTTP 410** from the testnet edge. The app **retries** (see `BINANCE_TESTNET_USERDATA_REST_BASES`) and labels the header **Exec REST** when WebSocket execution feed is unavailable; **OCO / order polling** still drives position lifecycle.

