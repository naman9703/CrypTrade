# Deploy on Railway

This app ships as **one Docker service**: the Node backend (port **8000**) serves the **built React UI** and **WebSocket** (`/ws`), while **uvicorn** runs the Python AI service on **127.0.0.1:8001** inside the same container (`scripts/docker-entrypoint.sh`).

Railway config lives in `railway.toml` (Dockerfile builder). Large or sensitive paths are excluded from CLI uploads via `.railwayignore`.

---

## Local dev vs Railway (what “works the same”)

| | **Local (`npm run dev`)** | **Railway (Docker)** |
|---|---------------------------|------------------------|
| Frontend | Vite dev server (e.g. `:5173`) | **Static files** from Node (`SERVE_FRONTEND=1`), same host as API |
| API | `:8000` / `api` | Same routes under `https://<your-domain>/api` |
| WebSocket | Proxied or `:8000/ws` | **`wss://<your-domain>/ws`** (same origin; see `frontend/src/ws/store.ts`) |
| AI service | `:8001` | **`127.0.0.1:8001`** inside the container; backend uses `AI_BASE_URL` |
| Env | `backend/.env`, `ai-service/.env` | **Railway Variables** only (files are not uploaded if in `.railwayignore`) |

Behavior (bot loop, strategies, AI predict/train, modes) is the **same code**. Differences are only **packaging** (one process tree, one public URL) and **where** env vars and data live.

---

## Model training on Railway — yes, it works

Training uses the same path as local: **UI “Train on real data”** → `POST /api/ai/train-real` → Binance klines → AI service **`/train/from-binance`**.

**Requirements on Railway:**

1. **Outbound network** — the container must reach **Binance** (REST). Default Railway services allow this.
2. **Time** — a full train (e.g. 35k candles × 10 symbols) can take **many minutes** and CPU. The backend AI client timeout is **15 minutes** (`900_000` ms in `aiClient.js`). If the train is longer, lower `candlesPerSymbol` or symbol count for a first test.
3. **Memory** — large trains load a lot of data in Python; if the service **OOMs**, use a larger Railway plan or reduce train size.
4. **Persistence** — after training, **`model.pkl`** / **`meta.json`** must live on a **volume** (`MODEL_DIR`) or they disappear on the next deploy.
5. **Reverse proxy timeout** — some browsers or edge proxies cut off long HTTP requests (~60–120s). If the UI train button **hangs then fails** but logs show training continued, trigger train via **`curl`** from your machine with a long `--max-time`, or run a smaller train from the UI.

**Optional:** Train locally, then copy `ai-service/data/model/*` into the mounted volume (advanced) if you want to avoid long runs on Railway.

**If `AI (no model)` never clears:** confirm **`POST /api/ai/train-real`** actually returns `ok: true` (Railway **logs** / browser network tab). Binance may be unreachable from some cloud IPs, or the **proxy may cut off** a long train. Use the UI **Train synthetic (quick)** (→ `POST /api/ai/train-bootstrap`) to create a real `model.pkl` without Binance; the header should show a loaded model within a few seconds after it finishes. **`GET /api/ai/health`** includes `model_loaded` and `model_path` for debugging.

---

## 1. Prerequisites

- [Railway](https://railway.app) account and a project.
- Repo connected to Railway (**GitHub** recommended) or Railway CLI for deploys.
- **Binance / demo API keys** (if not using `PAPER` only) stored in Railway **Variables**, not in git.

---

## 2. Deploy from GitHub (recommended)

Railway will **build from the commit** on your connected branch (same `Dockerfile` + `railway.toml` as local). You do **not** need `railway up` for day-to-day deploys once this is set up.

### 2.1 Put the code on GitHub

This folder must be a **git** repo with a remote on GitHub (private repo is fine).

From the repo root:

```bash
git init
git add -A
git commit -m "Initial commit"
# Create an empty repo on github.com (no README), then:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

Do **not** commit `backend/.env` or real API keys — they stay in `.gitignore` and only go into **Railway Variables**.

### 2.2 Create or attach the Railway service

**New project:** [Railway](https://railway.app) → **New Project** → **Deploy from GitHub** → authorize the Railway GitHub App → pick this repository.

**Existing project** (e.g. you used CLI `railway up` before): open your service (**trading-stack** or whatever) → **Settings** → **Source** (or **Connect Repo**) → connect the **same** GitHub repository. After connecting, Railway deploys from **Git**, not from CLI uploads.

### 2.3 Service settings

- **Root directory:** repo root (where **`Dockerfile`** and **`railway.toml`** live). Do not set a subdirectory unless you moved those files.
- **Build:** Railway should pick **`DOCKERFILE`** from `railway.toml`.
- **Trigger branch:** in **Service → Settings**, set the branch that should auto-deploy (often **`main`**).

Each **push** to that branch starts a new deployment. To deploy without a new commit, use the command palette: **CMD+K** → **Deploy Latest Commit** ([autodeploys guide](https://docs.railway.com/guides/github-autodeploys)).

### 2.4 Optional: Wait for CI

If you enable **Wait for CI** on the service, Railway waits until **GitHub Actions** on that push succeed. This repo includes **`.github/workflows/ci.yml`** (minimal gate). Accept any updated GitHub permissions Railway asks for. Details: [GitHub autodeploys](https://docs.railway.com/guides/github-autodeploys).

**Build output:** a single image that runs `scripts/docker-entrypoint.sh`.

---

## 3. Networking and ports

- Railway injects **`PORT`**. The backend listens on **`0.0.0.0:$PORT`** when `LISTEN_HOST=0.0.0.0` (set in the Dockerfile).
- **Do not** override `PORT` manually unless you know what you’re doing; Railway’s proxy expects its assigned port.
- **HTTPS URL:** Railway assigns a public domain. The backend reads **`RAILWAY_PUBLIC_DOMAIN`** and uses it for CORS / `FRONTEND_ORIGIN` when `FRONTEND_ORIGIN` is unset.

**WebSocket:** the UI should connect to **`wss://<your-domain>/ws`** (same origin if the frontend is served from the same service with `SERVE_FRONTEND=1`).

---

## 4. Required environment variables

Set these in Railway **Variables** (service → **Variables**).

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` (default in image). |
| `LISTEN_HOST` | `0.0.0.0` (already in Dockerfile). |
| `SERVE_FRONTEND` | `1` — serve Vite build from Node (already in Dockerfile). |
| `AI_BASE_URL` | `http://127.0.0.1:8001` — in-container AI (default in entrypoint). |
| `FRONTEND_ORIGIN` | Optional. If empty, backend uses `https://${RAILWAY_PUBLIC_DOMAIN}` when set. Add extra origins comma-separated if needed. |
| `TRADING_MODE` | e.g. `PAPER` for safest smoke test; or `BINANCE_DEMO_API` etc. |
| `MARKET_FEED` | `BINANCE` for live market data, or `SYNTH` if Binance blocks your region (see **HTTP 451** below). |
| `BINANCE_SYNTH_FALLBACK` | Default **on** in Docker: if `MARKET_FEED=BINANCE` and `GET https://api.binance.com/api/v3/ping` is not **200** (e.g. **451** geo-block from US / many clouds), the container switches to **`SYNTH`** at boot so the feed is not stuck **inactive**. Set **`0`** only if you must keep `BINANCE` and are on a Binance-eligible network. |
| `AI_PREDICT_TIMEOUT_MS` | e.g. `120000` if `/predict` times out on cold start. |
| `AI_HTTP_TIMEOUT_MS` | e.g. `30000` for health checks. |

**Binance / demo (only if used):** mirror your local `backend/.env` keys, e.g. `BINANCE_DEMO_API_KEY`, `BINANCE_DEMO_API_SECRET`, futures demo vars, etc. Never commit real keys.

**Optional tuning:** see `backend/.env.example` and `ai-service/.env.example` for training guards, spread/funding filters, `MODEL_DIR`, etc.

---

## 5. Persist the AI model (strongly recommended)

Without a volume, **redeploys wipe** `/app` except what you bake into the image. The entrypoint sets:

```text
MODEL_DIR=/app/ai-service/data/model
```

**This path is not on your laptop or in GitHub.** It exists **only inside the running container** on Railway (Linux). `scripts/docker-entrypoint.sh` runs `mkdir -p "$MODEL_DIR"` on every start, so the directory is there even before training; it is **empty** until `model.pkl` is written. In the Railway UI you do **not** browse to `/app/…`—you type **`/app/ai-service/data/model`** as the volume **mount path**.

**On Railway:**

1. Add a **Volume** to the service.
2. Mount it at **`/app/ai-service/data/model`** (or another path and set **`MODEL_DIR`** to that path).

After the first **`/api/ai/train-real`** (or bootstrap train), `model.pkl` and `meta.json` survive redeploys.

Optional: mount a second path for **`FEEDBACK_CSV`** / exchange store dirs if you need durable paper state on the server (set env paths accordingly).

---

## 6. Health checks

- **HTTP:** `GET /health` on your public URL (Node).
- **AI (internal):** `GET http://127.0.0.1:8001/health` only from inside the container (used by the entrypoint wait loop).

In Railway you can set a health check path to **`/health`** on the public service.

---

## 7. Build and deploy notes

- **`.railwayignore`** excludes `node_modules`, `.env`, `data`, etc., to keep uploads small when not using GitHub.
- **XGBoost on Linux:** the Dockerfile installs **`libgomp1`** so XGBoost can load (OpenMP).
- **Train requests** can run **many minutes**. Use the dashboard train action or call **`POST /api/ai/train-real`** with a client timeout ≥ **15 minutes**, or train locally and upload/sync a model into the volume.

---

## 8. Smoke test after deploy

1. Open `https://<your-railway-domain>/`.
2. Confirm the dashboard loads (static + API same origin).
3. `GET https://<domain>/health` → `ok: true`.
4. Open browser devtools → confirm **WebSocket** connects to `wss://<domain>/ws`.
5. Set mode to **`PAPER`** first; start bot only after you’re satisfied with connectivity.

---

## 9. Common issues

| Symptom | What to check |
|---------|----------------|
| CORS errors | Set `FRONTEND_ORIGIN` to your exact Railway HTTPS URL (include `https://`). |
| AI always unreachable | `AI_BASE_URL` must stay `http://127.0.0.1:8001` for this single-container layout. |
| Model missing after deploy | Add **Volume** + `MODEL_DIR` mount; re-run train. |
| Train timeout | Increase client timeout; reduce `candlesPerSymbol` for a test train. |
| 502 / crash on start | Check deploy logs: uvicorn must pass `/health` before Node binds. |

---

## 10. CLI alternative (no GitHub)

From the repo root (with Railway CLI logged in):

```bash
railway up
```

Ensure variables are set in the linked Railway project. `.railwayignore` avoids uploading local `node_modules` and `.env`.

---

## 11. Deploy so it matches your local `.env` (checklist)

1. **Copy variables** from `backend/.env` into Railway **Variables** (same keys: `TRADING_MODE`, `MARKET_FEED`, `DEFAULT_SYMBOL`, Binance keys, `AI_THRESHOLD`, guards, etc.). Do **not** set `PORT` unless you know you need to.
2. **AI / training tuning** (optional): set `TRAIN_RECENCY_HALF_LIFE_DAYS`, `TRAIN_ENSEMBLE_BAG_FRACTION`, `AI_CAL_BLEND_ISOTONIC`, etc. in Railway **Variables**. The entrypoint starts uvicorn as a child process; it **inherits** the container environment, so Python `os.getenv(...)` picks these up the same as a local `ai-service/.env`.
3. **Volume:** mount **`/app/ai-service/data/model`** for trained models (and redeploy survival).
4. **Optional second volume** (parity with local `data/`): e.g. mount **`/app/backend/data`** and set `PAPER_STORE_DIR`, `BINANCE_DEMO_*_STORE_DIR`, etc. to paths under that mount if you want paper/demo state to survive.
5. **Deploy** → open your Railway URL → confirm **`/health`**, **`/api/ai/health`**, WebSocket **connected**, then test **PAPER** before live/demo keys.

**Note:** Local `ai-service/.env` is **not** copied into the Docker image by default. Training defaults come from the Python app and from **train request body**. To mirror `TRAIN_RECENCY_HALF_LIFE_DAYS` etc. on Railway, either bake `ENV` into the Dockerfile or extend `docker-entrypoint.sh` to `export` them from Railway Variables (they are passed to child processes if set in Railway’s environment for the service).

---

For end-to-end product behavior (bot, AI, modes), see `docs/TRADING_FLOW_AND_FEATURES.md`.
