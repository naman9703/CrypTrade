import { query } from "../query.js";
import { normalizeModeSlugParam } from "../../lib/modeSlug.js";

/**
 * @param {string} modeSlug
 */
async function getModeIdBySlug(modeSlug) {
  const slug = normalizeModeSlugParam(modeSlug);
  if (!slug) return null;
  const r = await query(`SELECT id FROM trading_modes WHERE slug = $1`, [slug]);
  return r.rows[0]?.id ?? null;
}

function mapAccountRow(row) {
  if (!row) return null;
  const cred =
    row.cred_id != null
      ? {
          id: String(row.cred_id),
          apiKey: maskApiKey(String(row.cred_api_key || "")),
          isActive: Boolean(row.cred_is_active),
          lastVerifiedAt: row.cred_last_verified_at ? new Date(row.cred_last_verified_at).toISOString() : null,
          permissions:
            row.cred_permissions != null && typeof row.cred_permissions === "object"
              ? row.cred_permissions
              : null,
        }
      : null;
  return {
    id: String(row.id),
    modeSlug: String(row.mode_slug),
    label: String(row.label || ""),
    accountType: String(row.account_type || "main"),
    binanceUid: row.binance_uid != null ? String(row.binance_uid) : null,
    isActive: Boolean(row.is_active),
    requiresApi: row.requires_api !== false,
    notes: row.notes != null ? String(row.notes) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    credentials: cred,
  };
}

export function maskApiKey(apiKey) {
  const s = String(apiKey || "");
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

const LIST_SQL = `
SELECT
  a.id,
  a.user_id,
  a.label,
  a.account_type,
  a.binance_uid,
  a.is_active,
  a.requires_api,
  a.notes,
  a.created_at,
  a.updated_at,
  tm.slug AS mode_slug,
  c.id AS cred_id,
  c.api_key AS cred_api_key,
  c.is_active AS cred_is_active,
  c.last_verified_at AS cred_last_verified_at,
  c.permissions AS cred_permissions
FROM accounts a
JOIN trading_modes tm ON tm.id = a.mode_id
LEFT JOIN LATERAL (
  SELECT c2.*
  FROM api_credentials c2
  WHERE c2.account_id = a.id AND c2.is_active = true
  ORDER BY c2.created_at DESC
  LIMIT 1
) c ON true
WHERE tm.slug = $1
  AND (
    a.user_id = $2
    OR (tm.slug = 'paper' AND a.account_type = 'system')
  )
ORDER BY a.created_at ASC
`;

/**
 * @param {string} modeSlug
 * @param {string} ownerUserId users.id
 */
export async function getAllAccountsForMode(modeSlug, ownerUserId) {
  const slug = normalizeModeSlugParam(modeSlug);
  if (!slug) return [];
  const r = await query(LIST_SQL, [slug, ownerUserId]);
  return r.rows.map(mapAccountRow).filter(Boolean);
}

/**
 * @param {string} modeSlug
 * @param {string} ownerUserId
 */
export async function getActiveAccountsForMode(modeSlug, ownerUserId) {
  const all = await getAllAccountsForMode(modeSlug, ownerUserId);
  return all.filter((a) => a.isActive);
}

/**
 * @param {string} accountId
 */
export async function getAccountById(accountId) {
  const r = await query(
    `SELECT
       a.id,
       a.user_id,
       a.label,
       a.account_type,
       a.binance_uid,
       a.is_active,
       a.requires_api,
       a.notes,
       a.created_at,
       a.updated_at,
       tm.slug AS mode_slug,
       c.id AS cred_id,
       c.api_key AS cred_api_key,
       c.is_active AS cred_is_active,
       c.last_verified_at AS cred_last_verified_at,
       c.permissions AS cred_permissions
     FROM accounts a
     JOIN trading_modes tm ON tm.id = a.mode_id
     LEFT JOIN LATERAL (
       SELECT c2.*
       FROM api_credentials c2
       WHERE c2.account_id = a.id AND c2.is_active = true
       ORDER BY c2.created_at DESC
       LIMIT 1
     ) c ON true
     WHERE a.id = $1`,
    [accountId],
  );
  return mapAccountRow(r.rows[0]);
}

/**
 * @param {string} modeSlug
 * @param {string} ownerUserId
 * @param {{ label: string, accountType: string, binanceUid?: string | null, notes?: string | null }} input
 */
export async function createAccount(modeSlug, ownerUserId, input) {
  const slug = normalizeModeSlugParam(modeSlug);
  if (!slug) throw new Error("invalid_mode_slug");
  if (slug === "paper") throw new Error("paper_accounts_not_user_created");
  const modeId = await getModeIdBySlug(slug);
  if (modeId == null) throw new Error("mode_not_found");

  const label = String(input.label || "").trim();
  if (!label) throw new Error("label_required");
  const accountType = String(input.accountType || "main").toLowerCase();
  if (!["main", "sub"].includes(accountType)) throw new Error("invalid_account_type");
  const binanceUid = input.binanceUid != null && String(input.binanceUid).trim() ? String(input.binanceUid).trim() : null;
  const notes = input.notes != null && String(input.notes).trim() ? String(input.notes).trim() : null;

  const r = await query(
    `INSERT INTO accounts (mode_id, user_id, label, account_type, binance_uid, notes, requires_api, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true, true)
     RETURNING id`,
    [modeId, ownerUserId, label, accountType, binanceUid, notes],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("insert_failed");
  return getAccountById(String(id));
}

/**
 * @param {string} accountId
 * @param {{ label?: string, notes?: string | null, binance_uid?: string | null }} patch
 */
export async function updateAccount(accountId, patch) {
  const cur = await query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
  const row = cur.rows[0];
  if (!row) return null;

  const nextLabel = patch.label !== undefined ? String(patch.label || "").trim() : row.label;
  if (!nextLabel) throw new Error("label_required");
  const nextNotes = patch.notes !== undefined ? (patch.notes == null ? null : String(patch.notes)) : row.notes;
  const nextUid =
    patch.binance_uid !== undefined
      ? patch.binance_uid == null || String(patch.binance_uid).trim() === ""
        ? null
        : String(patch.binance_uid).trim()
      : row.binance_uid;

  await query(
    `UPDATE accounts SET label = $2, notes = $3, binance_uid = $4 WHERE id = $1`,
    [accountId, nextLabel, nextNotes, nextUid],
  );
  return getAccountById(accountId);
}

/**
 * @param {string} accountId
 */
export async function deactivateAccount(accountId) {
  const r = await query(
    `UPDATE accounts SET is_active = false WHERE id = $1 AND is_active = true RETURNING id`,
    [accountId],
  );
  return { deactivated: r.rowCount ?? 0 };
}

/** For authz checks (ownership + system paper visibility). */
export async function getAccountAccessRow(accountId) {
  const r = await query(
    `SELECT a.id, a.user_id, a.account_type, a.requires_api, tm.slug AS mode_slug
     FROM accounts a
     JOIN trading_modes tm ON tm.id = a.mode_id
     WHERE a.id = $1`,
    [accountId],
  );
  return r.rows[0] ?? null;
}
