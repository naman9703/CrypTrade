# Production deploy (GitHub → VPS)

This guide assumes a **Linux VPS** (Ubuntu 22.04/24.04), **Docker Engine + Compose plugin**, and a small trusted group of users. **Trading risk is yours**—test on paper/testnet first.

## Pre-deployment checklist

- **VPS**: ~**2 GB RAM** minimum recommended (Node app + AI service + Docker overhead); **20 GB+** disk.
- **DNS**: A/AAAA at the VPS if you want **public HTTPS** (Let’s Encrypt / Caddy). **Not required** if you use **§5.1** (SSH tunnel or a private mesh) — see there.
- **GitHub**: Code pushed; **no** `backend/.env`, `ai-service/.env`, or API keys in the repo.
- **Local sanity check** (on your laptop, optional):
  ```bash
  cd /path/to/repo
  npm install
  npm run build
  ```
- **Password hash** for UI login: run `backend/scripts/hash-ui-password.mjs` locally; store only the **bcrypt hash** on the server.

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

## 2. VPS baseline (Docker + dedicated app user)

Run these once as a user that has **`sudo`** (e.g. `ubuntu`). **Do not** use `root` for day‑to‑day deploys after this.

### 2.1 Install Docker

```bash
sudo apt update && sudo apt install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
```

### 2.2 Create a dedicated user `albustrading` (recommended)

This account owns the app directory and runs **`docker compose`**. It should **not** have passwordless `sudo` unless you explicitly want that.

```bash
# Create login user + home directory
sudo adduser albustrading
```

Add `albustrading` to the **`docker`** group so it can run Compose **without** `sudo`:

```bash
sudo usermod -aG docker albustrading
```

Create the app directory and give it to **`albustrading`** only:

```bash
sudo mkdir -p /opt/trading
sudo chown albustrading:albustrading /opt/trading
sudo chmod 750 /opt/trading
```

**SSH as `albustrading`:** copy your public key (same as your admin user, or a deploy key):

```bash
sudo mkdir -p /home/albustrading/.ssh
sudo chmod 700 /home/albustrading/.ssh
sudo cp ~/.ssh/authorized_keys /home/albustrading/.ssh/authorized_keys   # adjust source if needed
sudo chown -R albustrading:albustrading /home/albustrading/.ssh
sudo chmod 600 /home/albustrading/.ssh/authorized_keys
```

From your laptop:

```bash
ssh albustrading@YOUR_SERVER_IP
```

**Group change applies after a new login:** if `docker compose` says “permission denied”, run `newgrp docker` once or disconnect SSH and connect again.

> **Caddy / nginx** still install with `sudo` on the host and often listen on **80/443** as root—that’s normal. Only **building and running the trading stack** is done as **`albustrading`**.

### 2.3 Firewall

As your **sudo** user (not necessarily `albustrading`):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

(Change the SSH rule if you use a non‑22 port.)

### 2.4 Already deployed as `root` / another user?

**Goal:** same files, same Docker stack — only **ownership** and **who you SSH as** change.

1. **If the repo is under `/root/...`** (or any path root owns), move it to **`/opt/trading`** and hand it off (adjust source if yours differs):

   ```bash
   sudo mkdir -p /opt/trading
   sudo mv /root/trading/* /opt/trading/   # or: sudo rsync -a /root/trading/ /opt/trading/
   # if you used rsync, remove the old tree after verifying: sudo rm -rf /root/trading
   ```

2. **Create `albustrading`**, Docker access, and ownership:

   ```bash
   sudo adduser albustrading    # skip if user exists
   sudo usermod -aG docker albustrading
   sudo chown -R albustrading:albustrading /opt/trading
   sudo chmod 750 /opt/trading
   ```

3. **SSH as `albustrading`** (see §2.2 — copy `authorized_keys` if you have not already).

4. From your laptop: **`ssh albustrading@…`**, **`cd`** to the **directory that contains `docker-compose.yml`** (e.g. **`/opt/trading`** if you cloned with **`git clone … .`**, or **`/opt/trading/CrypTrade`** if the repo lives in a subfolder), then run **`docker compose`** as before. You should **not** need **`sudo docker`**.

**If the app lived somewhere else** (e.g. `/home/ubuntu/trading`), point `chown` at that directory instead, or move that tree into `/opt/trading` first so paths stay consistent with this guide.

## 3. Clone the repo on the VPS

As **`albustrading`**:

**Option A — repo root is `/opt/trading`:**

```bash
sudo mkdir -p /opt/trading
sudo chown albustrading:albustrading /opt/trading
cd /opt/trading
git clone https://github.com/YOU/REPO.git .
```

**Option B — repo in a subfolder (e.g. `CrypTrade`):**

```bash
sudo mkdir -p /opt/trading
sudo chown albustrading:albustrading /opt/trading
cd /opt/trading
git clone https://github.com/YOU/REPO.git CrypTrade
cd CrypTrade
```

Always run **`git pull`** and **`docker compose`** from the directory that contains **`docker-compose.yml`**.

(Private repo: use SSH deploy key or HTTPS + PAT. For a **deploy key**, attach it to `albustrading`’s `~/.ssh/config` or use HTTPS with a PAT stored only in `albustrading`’s environment, never in git.)

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

1. Point a DNS A/AAAA record (e.g. DuckDNS) at your VPS IP.
2. Install [Caddy](https://caddyserver.com/docs/install).
3. Use `deploy/Caddyfile.example` as a template; set your hostname and `reverse_proxy 127.0.0.1:8000`.
4. Reload Caddy (`sudo systemctl reload caddy`).
5. Set **`FRONTEND_ORIGIN=https://your.hostname`** in `backend/.env` and **restart** the app container:
   ```bash
   docker compose up -d --force-recreate app
   ```

### 6b. HTTPS with nginx + Let’s Encrypt (alternative)

1. `sudo apt install -y nginx` and use **`deploy/nginx-site.example`** as a base.
2. Obtain certs: `sudo certbot --nginx -d your.hostname`.
3. Ensure **`proxy_set_header Upgrade`** and **`Connection`** match the example so **`/ws`** works.
4. Set `TRUST_PROXY=1`, `FRONTEND_ORIGIN=https://your.hostname`, recreate `app` as above.

## 7. Verify security & behavior

- [ ] **With HTTPS hostname:** **`https://your.hostname`** shows login; no portfolio before auth.
- [ ] **With SSH tunnel (§5.1):** **`http://localhost:8000`** shows login; **`FRONTEND_ORIGIN`** / **`COOKIE_SECURE`** match §5.1.
- [ ] **`curl -sS https://your.hostname/health`** or (tunnel) **`curl -sS http://127.0.0.1:8000/health`** on the VPS → `{"ok":true}`.
- [ ] After login, **live data** / charts update (WebSocket OK).
- [ ] **`docker compose logs -f app ai`** — no crash loops.

## 8. Logs & monitoring

```bash
cd /opt/trading
docker compose logs -f --tail=200 app ai
sudo journalctl -u caddy -e          # if using Caddy systemd
```

There is no built-in APM; for a small VPS, **logs + provider metrics** (CPU/RAM) are enough. Add **Uptime Kuma** or similar separately if you want pings.

## 9. Backups

Worth backing up:

| What | Where (Docker Compose) |
|------|-------------------------|
| AI model + feedback | Volume **`ai-model-data`** (`MODEL_DIR` in container) |
| Paper / mode data | Volume **`trading-data`** → `/app/backend/data` |
| **Secrets** | **`backend/.env`**, **`ai-service/.env`** (store a **password-manager** or **offline** copy—never only on the VPS) |

Example backup (run on host, adjust paths):

```bash
docker run --rm -v trading_trading-data:/data -v $(pwd):/backup alpine tar czf /backup/trading-data.tgz -C /data .
```

List volume names: `docker volume ls`.

## 10. Updates from GitHub

From the **same directory as `docker-compose.yml`** (adjust the path if your clone is under a subfolder):

```bash
cd /opt/trading/CrypTrade   # or: cd /opt/trading  if you cloned with “.”
git pull
docker compose up -d --build
sleep 3
curl -sS http://127.0.0.1:8000/health
docker compose ps
```

Or run the helper script (from the repo root on the VPS):

```bash
./deploy/vps-update.sh
```

If **`git`** prints **“detected dubious ownership”** (common when the repo is owned by another user but you run **`git`** as **`root`**), either run **`git`** as that user or allow the directory once:

```bash
git config --global --add safe.directory /opt/trading/CrypTrade
```

## 11. Alternative: no Docker (Node + systemd)

- Build SPA: `npm ci && npm run build` at repo root.
- Run backend with `SERVE_FRONTEND=1`, `NODE_ENV=production`, paths so `frontend/dist` exists at `../../frontend/dist` from `backend/src` (clone full repo).
- Run AI service separately (`uvicorn` in a second unit or screen).
- See `deploy/trading.service.example` as a starting point; set `EnvironmentFile=/etc/trading/app.env`.

## 12. GitHub Actions

`.github/workflows/ci.yml` runs on push/PR to `main`/`master`: `npm ci`, workspace build, Python `compileall`, and `docker build`. **No secrets required** for CI.

---

## Troubleshooting

| Symptom | What to try |
|--------|-------------|
| **`docker compose` fails** missing `env_file` | `cp backend/.env.example backend/.env` and `cp ai-service/.env.example ai-service/.env`, then edit. |
| **502 Bad Gateway** (Caddy/nginx) | `curl -sS http://127.0.0.1:8000/health`; `docker compose ps`; `docker compose logs app`. |
| **Login / session issues** | `FRONTEND_ORIGIN` must **exactly** match the browser URL; `TRUST_PROXY=1`; HTTPS + `COOKIE_SECURE=1`. |
| **UI stuck / no live prices** | WebSocket blocked: **nginx** — use the dedicated **`location /ws`** in **`deploy/nginx-site.example`** (`Upgrade` / `Connection`, **`proxy_buffering off`**, long **`proxy_read_timeout`**). **Caddy** — see **`deploy/Caddyfile.example`** (`flush_interval -1`). The app sends **RFC ping** frames every **`WS_PING_INTERVAL_MS`** (default 30s) so idle links are not dropped by middleboxes. Verify with **GET** (not `curl -I` / HEAD — that returns **200** + HTML from the SPA). Run only the `curl` line: `curl -sS -D- -o /dev/null --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://YOUR_HOST/ws` → first line **`HTTP/1.1 101 Switching Protocols`**. If **`401`**, fix **login session** (same browser host as `FRONTEND_ORIGIN`, HTTPS + `COOKIE_SECURE=1`). |
| **`fatal: not a git repository`** in `/opt/trading` | The clone may be in a **subfolder** (e.g. **`CrypTrade`**). **`cd`** to the folder that contains **`.git`** and **`docker-compose.yml`**. |
| **`dubious ownership`** (git) | `git config --global --add safe.directory /full/path/to/repo` or fix ownership: `chown -R albustrading:albustrading /opt/trading/CrypTrade`. |
| **CORS errors** | Wrong `FRONTEND_ORIGIN`; must be the SPA origin, not a different subdomain without listing it. |
| **Build: backend lockfile** | Image uses `npm install` in backend stage if no `backend/package-lock.json` (see root `Dockerfile`). |

---

## Security practices (short)

- Never commit **`.env`**; rotate **`SESSION_SECRET`** and exchange keys if leaked.
- Prefer **`REQUIRE_APP_UI_AUTH_IN_PRODUCTION=1`** on any public VPS.
- Omit **`BOT_HTTP_API_KEY`** unless you need scripted `GET /api/state` / bot start-stop.
- Keep **`apt upgrade`** and **Docker images** rebuilt after `git pull` for security patches.

---

If Compose reports missing `env_file`, create the file from `.example` first (`cp backend/.env.example backend/.env`).
