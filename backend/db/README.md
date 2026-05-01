# Database (PostgreSQL + TimescaleDB)

Local dev uses Docker Compose at the **repo root** (`docker-compose.db.yml`). SQL migrations live in `migrations/` and are applied with `npm run db:migrate` from `backend/`.

## Connection (`DATABASE_URL`)

Set in `backend/.env` (never commit real secrets):

| Setting   | Default (local compose) |
|-----------|-------------------------|
| Host      | `127.0.0.1`             |
| Port      | `54333` (host) → `5432` (container) |
| Database  | `trading`               |
| User      | `postgres`              |
| Password  | `tradingdev` (change for anything beyond local dev) |

Example:

```bash
DATABASE_URL=postgres://postgres:tradingdev@127.0.0.1:54333/trading
```

For a hosted DB, replace the URL entirely; you still need **PostgreSQL 16** and the **TimescaleDB** extension for hypertables used in migrations.

## Compose: service and container

| Item | Value |
|------|--------|
| Compose file | `docker-compose.db.yml` (repo root) |
| Service name | `timescale` |
| Image | `timescale/timescaledb:latest-pg16` |
| Named volume (compose key) | `trading-timescale-data` |

Docker may name the running container like `trading-timescale-1` (project directory name + service). Check with:

```bash
docker compose -f docker-compose.db.yml ps -a
```

## Start / stop

From **repo root**:

```bash
# Start (detached)
docker compose -f docker-compose.db.yml up -d

# Stop containers (keeps volume / data)
docker compose -f docker-compose.db.yml down

# Stop and delete data volume (destructive)
docker compose -f docker-compose.db.yml down -v
```

## Migrations

From **`backend/`** (loads `backend/.env`):

```bash
npm run db:migrate
```

Start compose, wait for healthy DB, then migrate (from `backend/`):

```bash
npm run db:migrate:local
```

From **repo root**:

```bash
npm run db:up
npm run db:migrate
```

If the DB user cannot `CREATE ROLE` (some managed providers):

```bash
SKIP_DB_ROLES=1 npm run db:migrate
```

Applied migration filenames are recorded in `public.schema_migrations`.

## Phase 1B — App connection

With `DATABASE_URL` set in `backend/.env`:

- The API opens a **shared `pg` pool** (`src/db/pool.js`) at startup and logs `db_connected` (or exits if the DB is unreachable).
- **GET `/health/db`** — cheap connectivity check (public; no secrets).
- **GET `/api/trading-modes`** — **public** (no login); reads `trading_modes` from the DB when connected, else static fallback. Same JSON for authenticated clients.
- **UI auth**: if a row exists in `users` for the login email, the password is checked against `users.password_hash`; otherwise existing env bcrypt users are used.
- **Sessions**: stored in **`express_sessions`** via `connect-pg-simple` (migration `015_express_sessions.sql`). Apply migrations after upgrading.

```bash
cd backend && npm run db:migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='your-secure-password' npm run db:seed-admin
```

To copy existing **env bcrypt users** (`APP_UI_AUTH_EMAIL` / `_1`… + `PASSWORD_HASH`) into `users` as **`admin`** (same passwords, no plaintext):

```bash
npm run db:sync-ui-users
```

**Note:** Migration `013` defines `app_role` as **NOLOGIN**. Local dev typically uses the `postgres` user in `DATABASE_URL`. For production, create a **login** role granted `app_role` and use that in `DATABASE_URL`.

## Backups (optional)

Before risky experiments (`down -v`, manual SQL, testing destructive migrations):

**Logical dump** (works anywhere `DATABASE_URL` reaches):

```bash
# From repo root or any machine with pg_dump
pg_dump "$DATABASE_URL" -Fc -f trading-$(date +%Y%m%d).dump
```

Restore (example):

```bash
pg_restore -d "$DATABASE_URL" --clean trading-YYYYMMDD.dump
```

**Volume** (Docker-only): identify the volume with `docker volume ls` (often prefixed with the compose project name), then use Docker’s backup/restore patterns for that volume—or rely on `pg_dump` above for simplicity.
