import { query, withTransaction } from "../query.js";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";

/**
 * @param {string} accountId UUID
 * @param {string} apiKey
 * @param {string} secret plaintext; never logged
 */
export async function addCredentials(accountId, apiKey, secret) {
  const enc = encryptSecret(secret);
  return withTransaction(async (client) => {
    await client.query(`UPDATE api_credentials SET is_active = false WHERE account_id = $1 AND is_active = true`, [
      accountId,
    ]);
    const ins = await client.query(
      `INSERT INTO api_credentials (account_id, api_key, secret_enc, encryption_ver)
       VALUES ($1, $2, $3, 1)
       RETURNING id, account_id, api_key, encryption_ver, permissions, last_verified_at, is_active, created_at`,
      [accountId, apiKey, enc],
    );
    return ins.rows[0];
  });
}

/**
 * Active credential metadata only (no decrypted secret).
 * @param {string} accountId
 */
export async function getCredentials(accountId) {
  const result = await query(
    `SELECT id, account_id, api_key, encryption_ver, permissions, last_verified_at, is_active, created_at
     FROM api_credentials
     WHERE account_id = $1 AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

/**
 * Internal: plaintext secret for exchange factory (Phase 2A). Do not expose over HTTP.
 * @param {string} accountId
 * @returns {Promise<{ apiKey: string, secret: string } | null>}
 */
export async function decryptCredentialsForEngine(accountId) {
  const result = await query(
    `SELECT api_key, secret_enc FROM api_credentials WHERE account_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const secret = decryptSecret(String(row.secret_enc || ""));
  return { apiKey: String(row.api_key || ""), secret };
}

/**
 * @param {string} accountId
 */
export async function revokeCredentials(accountId) {
  const result = await query(
    `UPDATE api_credentials SET is_active = false WHERE account_id = $1 AND is_active = true`,
    [accountId],
  );
  return { revoked: result.rowCount ?? 0 };
}
