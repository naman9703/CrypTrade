import { getPool } from "./pool.js";
import { query } from "./query.js";
import * as usersService from "./services/usersService.js";
import * as strategyService from "./services/strategyService.js";
import { readBotTradingConfig } from "../lib/botTradingConfigStore.js";

const MODE_SLUGS = ["paper", "demo_api", "testnet", "live"];

/**
 * Idempotent: one auto-migrated strategy + initial version per mode per active user.
 * @param {{ log?: { info?: Function, warn?: Function } }} opts
 */
export async function ensureDefaultStrategies(opts = {}) {
  const log = opts.log;
  if (!getPool()) return { ok: false, skipped: true, reason: "no_pool" };

  const userId = await usersService.getFirstActiveUserId();
  if (!userId) {
    log?.warn?.("ensure_default_strategies_no_user");
    return { ok: false, skipped: true, reason: "no_active_user" };
  }

  for (const slug of MODE_SLUGS) {
    const modeId = await query(`SELECT id FROM trading_modes WHERE slug = $1`, [slug]).then((r) => r.rows[0]?.id);
    if (!modeId) {
      log?.warn?.("ensure_default_strategies_mode_missing", { slug });
      continue;
    }
    /** Match legacy rows: `mode_id` was added in 018; old auto-migrated rows may still have NULL. */
    const existing = await query(
      `SELECT s.id, s.mode_id
       FROM strategies s
       WHERE s.user_id = $1
         AND s.is_archived = false
         AND COALESCE(s.tags, ARRAY[]::text[]) @> ARRAY['auto-migrated', $2]::text[]
       ORDER BY s.created_at ASC
       LIMIT 1`,
      [userId, slug],
    );
    const fileRaw = readBotTradingConfig(slug);
    const configRaw =
      fileRaw && typeof fileRaw === "object"
        ? fileRaw
        : { v: 1, bot: {}, tradingFormDefaults: { amountUsdStr: "", slPctStr: "", tpPctStr: "" } };

    if (existing.rows.length) {
      const strategyId = String(existing.rows[0].id);
      const mid = existing.rows[0].mode_id;
      if (mid == null) {
        await query(`UPDATE strategies SET mode_id = $2 WHERE id = $1`, [strategyId, modeId]);
      }
      const cnt = await query(`SELECT COUNT(*)::int AS c FROM strategy_versions WHERE strategy_id = $1`, [
        strategyId,
      ]);
      const n = Number(cnt.rows[0]?.c ?? 0);
      if (n > 0) continue;
      const ver = await strategyService.createVersion(
        strategyId,
        userId,
        configRaw,
        "v1 — initial import (repair)",
        null,
      );
      log?.info?.("strategy_auto_version_repair", { slug, strategyId, versionId: ver.id });
      continue;
    }

    const strategy = await strategyService.createStrategy(
      userId,
      slug,
      `Default Strategy (${slug})`,
      "Auto-imported from bot-trading-config.json",
      ["auto-migrated", slug],
    );
    const ver = await strategyService.createVersion(
      strategy.id,
      userId,
      configRaw,
      "v1 — initial import",
      null,
    );
    log?.info?.("strategy_auto_migrated", { slug, strategyId: strategy.id, versionId: ver.id });
  }

  return { ok: true };
}
