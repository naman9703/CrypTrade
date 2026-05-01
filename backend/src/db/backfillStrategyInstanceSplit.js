/**
 * One-shot startup backfill for the strategy / instance config split (migration 022).
 *
 * Idempotent: only fills NULL columns. Safe to run on every boot.
 *
 * For each existing strategy_version where typed signal-brain blocks are NULL
 * (and cfg_raw is present), populate the new columns by extracting from cfg_raw.
 *
 * For each existing bot_instance where inst_symbol is NULL, seed inst_* from
 * the strategy version's cfg_raw — preserves current per-instance behaviour.
 */
import { query } from "./query.js";
import {
  buildSignalBrainBlocks,
  extractInstanceConfig,
} from "../lib/strategyInstanceSplit.js";

/** @param {{ log?: { info?: Function, warn?: Function } }} [opts] */
export async function backfillStrategyInstanceSplit({ log } = {}) {
  let svPatched = 0;
  let svSkipped = 0;
  let instPatched = 0;
  let instSkipped = 0;

  // ─── strategy_versions: populate typed signal-brain blocks ──────────────────
  const svRows = await query(
    `SELECT id, cfg_raw
     FROM strategy_versions
     WHERE cfg_raw IS NOT NULL
       AND (cfg_supertrend IS NULL AND cfg_ai IS NULL AND cfg_entry IS NULL AND cfg_exit IS NULL)`,
  );
  for (const row of svRows.rows) {
    try {
      const blocks = buildSignalBrainBlocks(row.cfg_raw ?? {});
      await query(
        `UPDATE strategy_versions SET
           primary_signal_type = $2,
           cfg_supertrend = COALESCE(cfg_supertrend, $3::jsonb),
           cfg_surf_pulse = COALESCE(cfg_surf_pulse, $4::jsonb),
           cfg_ema_cross  = COALESCE(cfg_ema_cross,  $5::jsonb),
           cfg_rsi        = COALESCE(cfg_rsi,        $6::jsonb),
           cfg_ai         = COALESCE(cfg_ai,         $7::jsonb),
           cfg_entry      = COALESCE(cfg_entry,      $8::jsonb),
           cfg_exit       = COALESCE(cfg_exit,       $9::jsonb),
           cfg_leverage   = COALESCE(cfg_leverage,   $10::jsonb),
           cfg_mde        = COALESCE(cfg_mde,        $11::jsonb),
           cfg_signal_gates = COALESCE(cfg_signal_gates, $12::jsonb)
         WHERE id = $1`,
        [
          row.id,
          blocks.primary_signal_type,
          blocks.cfg_supertrend,
          blocks.cfg_surf_pulse,
          blocks.cfg_ema_cross,
          blocks.cfg_rsi,
          blocks.cfg_ai,
          blocks.cfg_entry,
          blocks.cfg_exit,
          blocks.cfg_leverage,
          blocks.cfg_mde,
          blocks.cfg_signal_gates,
        ],
      );
      svPatched++;
    } catch (e) {
      svSkipped++;
      log?.warn?.("backfill_strategy_version_failed", {
        versionId: String(row.id),
        error: String(e?.message || e),
      });
    }
  }

  // ─── bot_instances: seed inst_* from the strategy version cfg_raw ──────────
  const instRows = await query(
    `SELECT bi.id AS instance_id, sv.cfg_raw
     FROM bot_instances bi
     JOIN strategy_versions sv ON sv.id = bi.strategy_version_id
     WHERE bi.is_deleted = false
       AND bi.inst_symbol IS NULL`,
  );
  for (const row of instRows.rows) {
    try {
      const inst = extractInstanceConfig(row.cfg_raw ?? {});
      await query(
        `UPDATE bot_instances SET
           inst_symbol               = COALESCE(inst_symbol,               $2),
           inst_timeframe            = COALESCE(inst_timeframe,            $3),
           inst_symbol_mode          = COALESCE(inst_symbol_mode,          $4),
           inst_market_mode          = COALESCE(inst_market_mode,          $5),
           inst_universe             = COALESCE(inst_universe,             $6::jsonb),
           inst_risk_per_trade       = COALESCE(inst_risk_per_trade,       $7),
           inst_risk_unit            = COALESCE(inst_risk_unit,            $8),
           inst_max_daily_loss       = COALESCE(inst_max_daily_loss,       $9),
           inst_max_daily_loss_unit  = COALESCE(inst_max_daily_loss_unit,  $10),
           inst_compound_pnl         = COALESCE(inst_compound_pnl,         $11)
         WHERE id = $1`,
        [
          row.instance_id,
          inst.inst_symbol,
          inst.inst_timeframe,
          inst.inst_symbol_mode,
          inst.inst_market_mode,
          inst.inst_universe,
          inst.inst_risk_per_trade,
          inst.inst_risk_unit,
          inst.inst_max_daily_loss,
          inst.inst_max_daily_loss_unit,
          inst.inst_compound_pnl,
        ],
      );
      // Capital fields: only set if not already populated (capital was previously
      // stored only on capital_allotments).
      await query(
        `UPDATE bot_instances bi
         SET
           inst_capital_mode = COALESCE(bi.inst_capital_mode, ca.allotment_mode),
           inst_capital_usdt = COALESCE(bi.inst_capital_usdt, ca.configured_usdt),
           inst_capital_pct  = COALESCE(bi.inst_capital_pct,  ca.configured_pct)
         FROM capital_allotments ca
         WHERE ca.instance_id = bi.id
           AND ca.status = 'active'
           AND bi.id = $1`,
        [row.instance_id],
      );
      instPatched++;
    } catch (e) {
      instSkipped++;
      log?.warn?.("backfill_bot_instance_failed", {
        instanceId: String(row.instance_id),
        error: String(e?.message || e),
      });
    }
  }

  log?.info?.("backfill_strategy_instance_split_done", {
    strategyVersions: { patched: svPatched, skipped: svSkipped },
    botInstances: { patched: instPatched, skipped: instSkipped },
  });
}
