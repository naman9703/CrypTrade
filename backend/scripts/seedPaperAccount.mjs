/**
 * CLI: ensure paper system account (same as server boot).
 * Usage: cd backend && node scripts/seedPaperAccount.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const { initPool, getPool } = await import("../src/db/pool.js");
const { createLogger } = await import("../src/lib/logger.js");
const { ensurePaperSystemAccount } = await import("../src/db/ensurePaperSystemAccount.js");

const log = createLogger();
await initPool(log);
if (!getPool()) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const out = await ensurePaperSystemAccount({ log });
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
