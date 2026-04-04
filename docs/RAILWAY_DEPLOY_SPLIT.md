# Railway: three services (frontend + backend + AI)

Use this layout when you want **separate** Railway services instead of the **single** Docker stack in the repo root (`Dockerfile` + `railway.toml`).

| Service | Dockerfile | Public URL use |
|---------|------------|----------------|
| **AI** (FastAPI) | `ai-service/Dockerfile` | Backend calls this via `AI_BASE_URL` |
| **Backend** (Node + WS) | `backend/Dockerfile` | Frontend HTTP + WebSocket |
| **Frontend** (static) | `frontend/Dockerfile` | Browser |

**Build context:** all three Dockerfiles expect the **repository root** (so `COPY backend/...`, `COPY ai-service/...` work). In each Railway service, set **Root Directory** to **`.`** (empty / repo root) and set **Dockerfile Path** to `ai-service/Dockerfile`, `backend/Dockerfile`, or `frontend/Dockerfile`.

---

## 1. Deploy AI service first

1. New Railway service → **GitHub repo** → same repo.
2. **Settings → Build → Dockerfile Path:** `ai-service/Dockerfile`
3. **Settings → Networking:** generate a domain (e.g. `https://your-ai.up.railway.app`).
4. **Variables:** optional `MODEL_DIR` (default `/app/data/model`). Mount a **volume** on that path to persist `model.pkl`.
5. Deploy and confirm `GET https://<ai-domain>/health` returns JSON with `ok: true`.

---

## 2. Deploy backend

1. New service → same repo.
2. **Dockerfile Path:** `backend/Dockerfile`
3. **Networking:** generate a domain (e.g. `https://your-api.up.railway.app`).
4. **Variables** (minimal):

| Variable | Example |
|----------|---------|
| `AI_BASE_URL` | `https://your-ai.up.railway.app` (no trailing slash) |
| `LISTEN_HOST` | `0.0.0.0` |
| `SERVE_FRONTEND` | `0` |
| `FRONTEND_ORIGIN` | `https://your-frontend.up.railway.app` (your static UI URL; add both `www` and apex if needed, comma-separated) |
| `TRADING_MODE`, `MARKET_FEED`, Binance keys, etc. | Same as `docs/RAILWAY_DEPLOY.md` |

5. Confirm `GET https://<api-domain>/health` and `GET https://<api-domain>/api/ai/health` (AI proxy works).

---

## 3. Deploy frontend

1. New service → same repo.
2. **Dockerfile Path:** `frontend/Dockerfile`
3. **Build → Docker Build Args** (Railway UI):

| Build argument | Value |
|----------------|-------|
| `VITE_BACKEND_HTTP` | `https://your-api.up.railway.app` |

Do **not** set `VITE_BACKEND_WS` unless you use a non-standard path; the app **derives** `wss://…/ws` from `VITE_BACKEND_HTTP` (see `frontend/src/ws/store.ts`).

4. **Networking:** generate the **frontend** domain users will open.
5. Deploy and open the frontend URL; check browser devtools: API calls go to the backend host, WebSocket to `wss://<backend-host>/ws`.

---

## 4. CORS

The backend allows origins from `FRONTEND_ORIGIN` (and expands `localhost`/`127.0.0.1` pairs). Set `FRONTEND_ORIGIN` to your **frontend** `https://…` URL exactly.

---

## 5. Binance / region blocks

Split deploy does **not** fix Binance **451** from cloud IPs. If training or `MARKET_FEED=BINANCE` fails, use `MARKET_FEED=SYNTH`, synthetic train, or the single-container entrypoint probe in `scripts/docker-entrypoint.sh` (backend-only image does **not** run that probe—set `MARKET_FEED` explicitly in Variables if needed).

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
