# Railway **git-hustle**: two services (recommended)

Deploy with **two** Railway services in project **`git-hustle`**:

| Service | Image | What it runs |
|---------|--------|----------------|
| **`git-hustle-app`** (or `git-hustle-api`) | **`Dockerfile.app`** | **Node**: REST API, **`/ws`**, and **built Vite UI** (same URL). |
| **`git-hustle-ai`** | **`ai-service/Dockerfile`** | **FastAPI**: `/health`, `/predict`, training. |

Set on the **app** service:

| Variable | Value |
|----------|--------|
| `AI_BASE_URL` | `https://<your-ai-service>.up.railway.app` — **no** trailing slash. |
| `LISTEN_HOST` | `0.0.0.0` |
| `FRONTEND_ORIGIN` | `https://<your-app-service>.up.railway.app` (same as the public URL users open). |

`SERVE_FRONTEND=1` is already the default in **`Dockerfile.app`** (do not set `0` unless you remove the static UI from this service).

**Config as code (each service):**

- **App**: `deploy/railway-app.toml` → builds **`Dockerfile.app`**
- **AI**: `deploy/railway-ai.toml` → builds **`ai-service/Dockerfile`**

**Root directory:** repo root (empty). Do not use `backend/` or `frontend/` as the service root.

### Order

1. Deploy **AI** → generate domain → `GET https://<ai>/health`
2. Deploy **app** → set `AI_BASE_URL` → generate domain → open **`https://<app>/`** in the browser  
3. Verify `GET https://<app>/health` and `GET https://<app>/api/ai/health`

### Files in repo

| Path | Role |
|------|------|
| `Dockerfile.app` | Multi-stage Node: `npm run build` for frontend, then `node backend/src/index.js` with `frontend/dist` served. |
| `deploy/railway-app.toml` | Railway build/deploy for the app service. |
| `deploy/railway-ai.toml` | Railway build/deploy for the AI service. |
| `Dockerfile.monolith` + `deploy/railway-monolith.toml` | **Optional** all-in-one (Node + Python in one container); see `docs/RAILWAY_DEPLOY.md`. |

### Free tier / service limits

If you cannot add a third service, this **two-service** layout matches the limit. If you already have **`git-hustle-api`** (API-only), either:

- **Replace** its Dockerfile config with **`deploy/railway-app.toml`** (or `Dockerfile.app`) and remove a separate frontend service, **or**
- Create **`git-hustle-app`** and remove the old API + web pair after cutover.

### Migrating from a three-service split

If you used **`backend/Dockerfile`** + **`frontend/Dockerfile`**:

1. Delete or pause **`git-hustle-web`** (if present).
2. Point the API service at **`deploy/railway-app.toml`** (or set `RAILWAY_DOCKERFILE_PATH=Dockerfile.app`).
3. Set **`SERVE_FRONTEND=1`** only if your image is **`Dockerfile.app`** (already default there); remove **`VITE_BACKEND_HTTP`** build args — same-origin is baked into **`Dockerfile.app`**.
4. Set **`FRONTEND_ORIGIN`** to your **app** service URL (the one users open).

---

## Optional: three separate services

For **AI** + **backend-only** + **frontend-only** (`serve` on a third URL), see **`docs/RAILWAY_DEPLOY_SPLIT.md`** (`deploy/railway-backend.toml`, `deploy/railway-frontend.toml`). Requires an extra Railway service and **`VITE_BACKEND_HTTP`** at **frontend build time**.

---

## Local smoke test (optional)

From repo root:

```bash
docker build -f ai-service/Dockerfile -t cryptrade-ai .
docker build -f Dockerfile.app -t cryptrade-app .
```

Run AI on `:8001`, app on `:8000` with `AI_BASE_URL=http://host.docker.internal:8001`.
