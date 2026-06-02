import { getPool } from "./pool.js";
import { query } from "./query.js";
import * as usersService from "./services/usersService.js";
import * as strategyService from "./services/strategyService.js";
import { readBotTradingConfig } from "../lib/botTradingConfigStore.js";

const MODE_SLUGS = ["paper", "demo_api", "testnet", "live"];

/**
 * Idempotent: one auto-migrated global strategy + initial version per user (not per mode).
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

  const existing = await query(
    `SELECT s.id
     FROM strategies s
     WHERE s.user_id = $1 AND s.is_archived = false
     ORDER BY s.created_at ASC
     LIMIT 1`,
    [userId],
  );

  if (existing.rows.length) {
    const strategyId = String(existing.rows[0].id);
    await query(`UPDATE strategies SET mode_id = NULL WHERE id = $1 AND mode_id IS NOT NULL`, [strategyId]);
    const cnt = await query(`SELECT COUNT(*)::int AS c FROM strategy_versions WHERE strategy_id = $1`, [strategyId]);
    if (Number(cnt.rows[0]?.c ?? 0) > 0) return { ok: true, skipped: true, reason: "already_seeded" };
    const fileRaw = readBotTradingConfig("paper");
    const configRaw =
      fileRaw && typeof fileRaw === "object"
        ? fileRaw
        : { v: 1, bot: {}, tradingFormDefaults: { amountUsdStr: "", slPctStr: "", tpPctStr: "" } };
    const ver = await strategyService.createVersion(
      strategyId,
      userId,
      configRaw,
      "v1 — initial import (repair)",
      null,
    );
    log?.info?.("strategy_auto_version_repair", { strategyId, versionId: ver.id });
    return { ok: true };
  }

  let configRaw = null;
  for (const slug of MODE_SLUGS) {
    const fileRaw = readBotTradingConfig(slug);
    if (fileRaw && typeof fileRaw === "object") {
      configRaw = fileRaw;
      break;
    }
  }
  if (!configRaw) {
    configRaw = { v: 1, bot: {}, tradingFormDefaults: { amountUsdStr: "", slPctStr: "", tpPctStr: "" } };
  }

  const strategy = await strategyService.createStrategy(
    userId,
    null,
    "Default Strategy",
    "Auto-imported from bot-trading-config.json",
    ["auto-migrated", "default-strategy"],
  );
  const ver = await strategyService.createVersion(
    strategy.id,
    userId,
    configRaw,
    "v1 — initial import",
    null,
  );
  log?.info?.("strategy_auto_migrated", { strategyId: strategy.id, versionId: ver.id });
  return { ok: true };
}
