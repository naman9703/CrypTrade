import { query } from "./query.js";
import { getPool } from "./pool.js";

/**
 * Idempotent: ensure `_paper_system` user and a single paper `system` account exist.
 * @param {{ log?: { info?: Function, warn?: Function } }} opts
 */
export async function ensurePaperSystemAccount(opts = {}) {
  const log = opts.log;
  if (!getPool()) return { ok: false, skipped: true, reason: "no_pool" };

  await query(
    `INSERT INTO users (username, password_hash, role, is_active)
     VALUES (
       '_paper_system',
       '$2b$12$AAAAAAAAAAAAAAAAAAAAAAe8BRTfE5NfnVnqBxGpq1FILLME/hV2T',
       'admin',
       false
     )
     ON CONFLICT (username) DO NOTHING`,
  );

  const u = await query(`SELECT id FROM users WHERE username = '_paper_system' LIMIT 1`);
  const userId = u.rows[0]?.id;
  if (!userId) {
    log?.warn?.("paper_system_user_missing");
    return { ok: false, error: "paper_system_user_missing" };
  }

  const tm = await query(`SELECT id FROM trading_modes WHERE slug = 'paper' LIMIT 1`);
  const modeId = tm.rows[0]?.id;
  if (!modeId) {
    log?.warn?.("paper_mode_missing");
    return { ok: false, error: "paper_mode_missing" };
  }

  const existing = await query(
    `SELECT id FROM accounts WHERE mode_id = $1 AND user_id = $2 AND account_type = 'system' LIMIT 1`,
    [modeId, userId],
  );
  if (existing.rows[0]?.id) {
    await query(
      `UPDATE accounts SET requires_api = false, account_type = 'system', label = 'Paper Trading' WHERE id = $1`,
      [existing.rows[0].id],
    );
    return { ok: true, accountId: existing.rows[0].id, existed: true };
  }

  const ins = await query(
    `INSERT INTO accounts (mode_id, user_id, label, account_type, binance_uid, is_active, requires_api, notes)
     VALUES ($1, $2, 'Paper Trading', 'system', NULL, true, false, NULL)
     RETURNING id`,
    [modeId, userId],
  );
  const id = ins.rows[0]?.id;
  log?.info?.("paper_system_account_created", { accountId: id });
  return { ok: true, accountId: id, existed: false };
}
