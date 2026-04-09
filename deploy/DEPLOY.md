# Production deploy (GitHub → VPS)

This guide assumes a **Linux VPS** (Ubuntu 22.04/24.04), **Docker Engine + Compose plugin**, and a small trusted group of users. **Trading risk is yours**—test on paper/testnet first.

## 1. Push to GitHub (no secrets)

1. Create a **private** repository (recommended for trading code).
2. On your laptop:
   ```bash
   git remote add origin https://github.com/YOU/REPO.git
   git add -A
   git status   # confirm .env files are NOT listed
   git commit -m "Initial production deploy assets"
   git push -u origin main
   ```
3. **Never commit** `backend/.env`, `ai-service/.env`, `frontend/.env`, API keys, or session secrets. `.gitignore` already excludes `.env` and `data/`.

## 2. VPS baseline

1. **SSH** in as a sudo user.
2. Install Docker:
   ```bash
   sudo apt update && sudo apt install -y ca-certificates curl
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER"
   ```
   Log out and back in so `docker` works without `sudo`.
3. Optional: **UFW** (adjust for your SSH port):
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

## 3. Clone the repo on the VPS

```bash
sudo mkdir -p /opt/trading
sudo chown "$USER:$USER" /opt/trading
cd /opt/trading
git clone https://github.com/YOU/REPO.git .
```

## 4. Configure environment (secrets)

### `backend/.env`

```bash
cp backend/.env.example backend/.env
chmod 600 backend/.env
nano backend/.env
```

**Production minimum (adapt to your mode):**

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` |
| `PORT` | `8000` (match Compose) |
| `AI_BASE_URL` | `http://ai:8001` **when using docker-compose** |
| `FRONTEND_ORIGIN` | Exact public URL users open, e.g. `https://trading.example.com` |
| `APP_UI_AUTH_ENABLED` | `1` |
| `REQUIRE_APP_UI_AUTH_IN_PRODUCTION` | `1` |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `APP_UI_AUTH_EMAIL` / `APP_UI_AUTH_PASSWORD_HASH` | bcrypt hashes (use `backend/scripts/hash-ui-password.mjs`) |
| `TRUST_PROXY` | `1` when Caddy/nginx terminates TLS in front |
| `COOKIE_SECURE` | `1` if you enforce HTTPS |
| `TRADING_MODE`, `MARKET_FEED`, Binance keys | As needed; keep **testnet/paper** until satisfied |

Do **not** set `BOT_HTTP_API_KEY` unless you need headless API access; it bypasses login for narrow routes.

### `ai-service/.env`

```bash
cp ai-service/.env.example ai-service/.env
chmod 600 ai-service/.env
```

Defaults are fine for Docker; Compose overrides `MODEL_DIR` / feedback paths via environment.

## 5. Run with Docker Compose

From repo root on the VPS:

```bash
docker compose up -d --build
docker compose ps
curl -sS http://127.0.0.1:8000/health
```

The stack publishes **`127.0.0.1:8000`** only (not the full internet). Put **Caddy** or **nginx** on 443 and reverse-proxy to that socket.

## 6. HTTPS with Caddy (recommended)

1. Point a DNS A/AAAA record (free DuckDNS or similar) at your VPS IP.
2. Install [Caddy](https://caddyserver.com/docs/install).
3. Use `deploy/Caddyfile.example` as a template; set your hostname and `reverse_proxy 127.0.0.1:8000`.
4. Reload Caddy.
5. Set **`FRONTEND_ORIGIN=https://your.hostname`** in `backend/.env` and **restart** the app container:
   ```bash
   docker compose up -d --force-recreate app
   ```

## 7. Verify security

- Open **`https://your.hostname`** → login page; no data before auth.
- **`/health`** returns only `{"ok":true}``.
- After login, UI and **WSS** work (same host → `wss://…/ws`).
- Logs: `docker compose logs -f app ai`

## 8. Updates from GitHub

```bash
cd /opt/trading
git pull
docker compose up -d --build
```

## 9. Alternative: no Docker (Node + systemd)

- Build SPA: `npm ci && npm run build` at repo root.
- Run backend with `SERVE_FRONTEND=1`, `NODE_ENV=production`, paths so `frontend/dist` exists at `../../frontend/dist` from `backend/src` (clone full repo).
- Run AI service separately (`uvicorn` in a second unit or screen).
- See `deploy/trading.service.example` as a starting point; set `EnvironmentFile=/etc/trading/app.env`.

## 10. GitHub Actions

`.github/workflows/ci.yml` runs on push/PR to `main`/`master`: `npm ci`, workspace build, Python `compileall`, and `docker build`. **No secrets required** for CI.

---

If Compose reports missing `env_file`, create the file from `.example` first (`cp backend/.env.example backend/.env`).
