/**
 * One-time (or idempotent) admin user in `users` for DB-backed UI login.
 * Username is stored as normalized email (matches POST /api/auth/login body.email).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run db:seed-admin
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { createLogger } from "../src/lib/logger.js";
import { initPool, closePool } from "../src/db/pool.js";
import { createUser } from "../src/db/services/usersService.js";

const log = createLogger();
await initPool(log);

const email = String(process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME || "")
  .trim()
  .toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");

if (!email.includes("@")) {
  console.error("Set ADMIN_EMAIL to your UI login email (e.g. you@example.com).");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Set ADMIN_PASSWORD (minimum 8 characters).");
  process.exit(1);
}

try {
  const user = await createUser(email, password, "admin");
  console.log("Admin user created:", user.id, user.username);
} catch (err) {
  if (err.code === "23505") {
    console.log("Admin user already exists (duplicate username).");
  } else {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  await closePool();
}
