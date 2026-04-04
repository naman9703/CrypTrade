# Railway: three services (frontend + backend + AI)

Use this layout when you want **separate** Railway services instead of the **single** Docker stack in the repo root (`Dockerfile` + `railway.toml`). Your existing **trading-stack** (monolith) can stay until the three services are verified; then you can stop or remove it.

| Service | Config-as-code (optional) | Dockerfile |
|---------|---------------------------|------------|
| **AI** (FastAPI) | `deploy/railway-ai.toml` | `ai-service/Dockerfile` |
| **Backend** (Node + WS) | `deploy/railway-backend.toml` | `backend/Dockerfile` |
| **Frontend** (static) | `deploy/railway-frontend.toml` | `frontend/Dockerfile` |

**Build context:** all three Dockerfiles expect the **repository root**. In Railway, set **Root Directory** to **empty** (repo root). Either set **Dockerfile Path** as below **or** point **Config as code** at the matching `deploy/railway-*.toml` file.

---

## 0. Create three services in the same project

1. Railway → your project (**btc-ai-pro** or similar) → **New** → **GitHub Repo** → pick **CrypTrade** (repeat until you have **three** services), or add **Empty service** and connect the repo on each.
2. Rename services for clarity: e.g. `cryptrade-ai`, `cryptrade-api`, `cryptrade-web`.
3. On **each** service → **Settings**:
   - **Branch**: `main` (or your deploy branch).
   - **Root directory**: leave **blank** (not `frontend/` or `backend/`).
   - **Config as code** → enable and set file to **`deploy/railway-ai.toml`**, **`deploy/railway-backend.toml`**, or **`deploy/railway-frontend.toml`** respectively  
     *(or skip config-as-code and only set **Dockerfile path** to `ai-service/Dockerfile`, `backend/Dockerfile`, `frontend/Dockerfile`)*.

---

## 1. Deploy AI service first

1. **Networking** → **Generate domain** → copy `https://…` (no trailing slash).
2. **Variables:** optional `MODEL_DIR` (default in image: `/app/data/model`). Add a **Volume** mounted at `/app/data/model` to persist `model.pkl`.
3. Deploy → `GET https://<ai-domain>/health` → JSON with `"ok": true`.

---

## 2. Deploy backend

1. **Networking** → generate API domain.
2. **Variables** (minimal):

| Variable | Example |
|----------|---------|
| `AI_BASE_URL` | `https://<ai-domain>` (HTTPS URL from step 1, no trailing slash) |
| `LISTEN_HOST` | `0.0.0.0` |
| `SERVE_FRONTEND` | `0` |
| `FRONTEND_ORIGIN` | `https://<frontend-domain>` (set after step 3, or update after first frontend deploy; comma-separate multiple origins) |
| `TRADING_MODE`, `MARKET_FEED`, Binance keys, etc. | Same as `docs/RAILWAY_DEPLOY.md` |

3. Deploy → `GET https://<api-domain>/health` and `GET https://<api-domain>/api/ai/health`.

---

## 3. Deploy frontend

1. **Variables** → add **`VITE_BACKEND_HTTP`** = `https://<api-domain>` (backend URL).  
   **Important:** in Railway, turn on **“Available at build time”** / **Build** scope for this variable so Docker receives it during `vite build` (same name as the Dockerfile `ARG`).
2. Alternative: **Settings → Build → Docker Build Args** and add `VITE_BACKEND_HTTP` = your backend URL (if your Railway UI exposes build args).
3. **Networking** → generate the URL users will open in the browser.
4. Deploy → open the **frontend** URL; in devtools, API calls should hit the **backend** host and WebSocket **`wss://<backend-host>/ws`** (derived from `VITE_BACKEND_HTTP`; see `frontend/src/ws/store.ts`).
5. Go back to **backend** → set **`FRONTEND_ORIGIN`** to the **frontend** `https://…` and redeploy if CORS blocked the first load.

---

## 4. CORS

The backend allows origins from `FRONTEND_ORIGIN` (and expands `localhost`/`127.0.0.1` pairs). Set `FRONTEND_ORIGIN` to your **frontend** `https://…` URL exactly.

---

## 5. Binance / region blocks

Split deploy does **not** fix Binance **451** from cloud IPs. If training or `MARKET_FEED=BINANCE` fails, try **`MARKET_FEED=BINANCE_FUTURES`** (public USDT-M), or `MARKET_FEED=SYNTH` and synthetic train. The monolith entrypoint probes spot/futures pings in `scripts/docker-entrypoint.sh`; backend-only images do **not** run that probe—set `MARKET_FEED` explicitly in Variables if needed.

---

## 6. Compared to one-container deploy

| | **One `Dockerfile` (root)** | **Three services (this doc)** |
|--|-----------------------------|--------------------------------|
| URLs | One host for UI + API + WS | Frontend and backend (and AI) have different hosts |
| Env | `AI_BASE_URL=http://127.0.0.1:8001` | `AI_BASE_URL=https://…` public AI URL |
| Frontend build | Baked with empty `VITE_BACKEND_HTTP` (same origin) | **Must** set `VITE_BACKEND_HTTP` build arg |
| Ops | Fewer moving parts | Separate scaling and redeploys per service |

---

## 7. Local smoke test (optional)

From repo root:

```bash
docker build -f ai-service/Dockerfile -t cryptrade-ai .
docker build -f backend/Dockerfile -t cryptrade-api .
docker build -f frontend/Dockerfile \
  --build-arg VITE_BACKEND_HTTP=http://host.docker.internal:8000 \
  -t cryptrade-ui .
```

Run each container with published ports and point `AI_BASE_URL` / `FRONTEND_ORIGIN` at your machine.
