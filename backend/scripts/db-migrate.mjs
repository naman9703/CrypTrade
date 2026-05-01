/**
 * Apply SQL migrations from db/migrations in lexicographic order.
 * Tracks applied files in public.schema_migrations.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs
 *   npm run db:migrate
 *
 * Start local Timescale from repo root compose + wait + migrate:
 *   npm run db:migrate:local
 *
 * If the DB user cannot CREATE ROLE, skip security migration:
 *   SKIP_DB_ROLES=1 npm run db:migrate
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
dotenv.config({ path: path.join(backendRoot, ".env") });

const migrationsDir = path.join(backendRoot, "db", "migrations");

const argv = new Set(process.argv.slice(2));
const wantCompose = argv.has("--compose");
const wantWait = argv.has("--wait") || wantCompose;

function startLocalCompose() {
  const composeFile = path.join(repoRoot, "docker-compose.db.yml");
  if (!fs.existsSync(composeFile)) {
    throw new Error(`Missing ${composeFile}`);
  }
  console.log("docker compose -f docker-compose.db.yml up -d");
  execSync("docker compose -f docker-compose.db.yml up -d", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

async function waitForPg(url, maxMs = 120_000) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < maxMs) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      console.log("postgres ready");
      return;
    } catch (e) {
      lastErr = String(e?.message || e);
      try {
        await c.end();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Postgres not reachable within ${maxMs}ms (last: ${lastErr})`);
}

async function main() {
  if (wantCompose) {
    try {
      startLocalCompose();
    } catch (e) {
      console.error(e);
      console.error("Is Docker Desktop running? Start it and retry.");
      process.exit(1);
    }
  }

  const url = process.env.DATABASE_URL;
  if (!url || !String(url).trim()) {
    console.error("DATABASE_URL is required (set in backend/.env or env).");
    process.exit(1);
  }

  if (wantWait) {
    console.log("waiting for database…");
    await waitForPg(url);
  }

  const skipRoles = process.env.SKIP_DB_ROLES === "1";
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    if (e?.code === "ECONNREFUSED") {
      console.error(
        "Cannot reach Postgres (connection refused). If you use docker-compose.db.yml:\n" +
          "  1) Fix Docker Desktop if you see daemon I/O errors (restart Docker, free disk space, or Troubleshoot → Reset).\n" +
          "  2) From repo root: docker compose -f docker-compose.db.yml up -d\n" +
          "  3) Then: npm run db:migrate (backend) or npm run db:setup (repo root)\n" +
          "Or set DATABASE_URL to any reachable Timescale/Postgres 16+ instance.",
      );
    }
    throw e;
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.*\.sql$/u.test(f))
      .sort();

    for (const file of files) {
      if (skipRoles && file === "013_roles.sql") {
        const { rows: already } = await client.query("SELECT 1 AS ok FROM schema_migrations WHERE version = $1", [
          file,
        ]);
        if (!already.length) {
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        }
        console.log(`skip ${file} (SKIP_DB_ROLES=1, recorded)`);
        continue;
      }

      const { rows } = await client.query("SELECT 1 AS ok FROM schema_migrations WHERE version = $1", [file]);
      if (rows.length) {
        console.log(`ok ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`apply ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    console.log("migrations complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
