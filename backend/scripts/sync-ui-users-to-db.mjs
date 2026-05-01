/**
 * Upsert UI users from APP_UI_AUTH_* env into `users` (same merge rules as uiGate.loadUiAuthUsers).
 * Uses existing bcrypt hashes — no plaintext passwords. Sets role = 'admin'.
 *
 *   npm run db:sync-ui-users
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { createLogger } from "../src/lib/logger.js";
import { initPool, closePool } from "../src/db/pool.js";
import { query } from "../src/db/query.js";

const MAX_NUMBERED_UI_USERS = 20;

function loadUiAuthUsersFromEnv() {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 1; i <= MAX_NUMBERED_UI_USERS; i++) {
    const em = String(process.env[`APP_UI_AUTH_EMAIL_${i}`] || "")
      .toLowerCase()
      .trim();
    const h = String(process.env[`APP_UI_AUTH_PASSWORD_HASH_${i}`] || "").trim();
    if (em && h.startsWith("$2")) map.set(em, h);
  }
  const legEm = String(process.env.APP_UI_AUTH_EMAIL || "")
    .toLowerCase()
    .trim();
  const legH = String(process.env.APP_UI_AUTH_PASSWORD_HASH || "").trim();
  if (legEm && legH.startsWith("$2")) map.set(legEm, legH);
  return [...map.entries()].map(([emailNorm, hash]) => ({ emailNorm, hash }));
}

const log = createLogger();
await initPool(log);

const users = loadUiAuthUsersFromEnv();
if (!users.length) {
  console.error("No APP_UI_AUTH_EMAIL + APP_UI_AUTH_PASSWORD_HASH pairs found in .env");
  process.exit(1);
}

for (const { emailNorm, hash } of users) {
  await query(
    `INSERT INTO users (username, password_hash, role, is_active)
     VALUES ($1, $2, 'admin', true)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       is_active = true`,
    [emailNorm, hash],
  );
  console.log("synced admin user:", emailNorm);
}

await closePool();
console.log("done:", users.length, "user(s)");
