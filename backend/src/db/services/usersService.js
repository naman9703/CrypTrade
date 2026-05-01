import bcrypt from "bcrypt";
import { query } from "../query.js";

/** @param {string} username normalized email or login name */
/** First active user row (deterministic order for single-tenant server prefs hydrate). */
export async function getFirstActiveUserId() {
  const result = await query(`SELECT id FROM users WHERE is_active = true ORDER BY created_at ASC LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

export async function findUserByUsername(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return null;
  const result = await query(
    `SELECT id, username, password_hash, role, is_active, created_at
     FROM users
     WHERE lower(username) = $1 AND is_active = true`,
    [u],
  );
  return result.rows[0] ?? null;
}

export async function validatePassword(user, plainPassword) {
  return bcrypt.compare(String(plainPassword || ""), String(user.password_hash || ""));
}

/**
 * @param {string} username store UI login email here (Phase 1A schema has no separate email column)
 * @param {string} plainPassword
 * @param {string} [role]
 */
export async function createUser(username, plainPassword, role = "admin") {
  const hash = await bcrypt.hash(String(plainPassword), 12);
  const result = await query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, username, role, created_at`,
    [String(username).trim().toLowerCase(), hash, role],
  );
  return result.rows[0];
}

function mergeUiPrefsObjects(current, patch) {
  const c = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  const p = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const out = { ...c };
  for (const k of Object.keys(p)) {
    const pv = p[k];
    const cv = out[k];
    if (
      pv !== null &&
      typeof pv === "object" &&
      !Array.isArray(pv) &&
      cv !== null &&
      typeof cv === "object" &&
      !Array.isArray(cv)
    ) {
      out[k] = { ...cv, ...pv };
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** @param {string} userId UUID */
export async function getUiPrefsByUserId(userId) {
  const result = await query(`SELECT ui_prefs FROM users WHERE id = $1 AND is_active = true`, [userId]);
  const row = result.rows[0];
  const raw = row?.ui_prefs;
  if (raw && typeof raw === "object") return raw;
  return {};
}

/**
 * @param {string} userId UUID
 * @param {Record<string, unknown>} patch shallow + one-level-deep merge for nested objects
 */
export async function mergeUiPrefsForUser(userId, patch) {
  const cur = await getUiPrefsByUserId(userId);
  const next = mergeUiPrefsObjects(cur, patch);
  await query(`UPDATE users SET ui_prefs = $2::jsonb WHERE id = $1 AND is_active = true`, [
    userId,
    JSON.stringify(next),
  ]);
  return next;
}
