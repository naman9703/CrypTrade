import { query } from "../query.js";
import {
  buildSignalBrainBlocks,
  stripInstanceFieldsFromCfgRaw,
  pickBotSubtree,
} from "../../lib/strategyInstanceSplit.js";

/**
 * Map persisted trading config (`{ v, bot, tradingFormDefaults }` or legacy flat bot) into cfg_* columns.
 * @param {Record<string, unknown>} cfgRaw
 */
export function extractCfgColumns(cfgRaw) {
  const root = cfgRaw && typeof cfgRaw === "object" ? cfgRaw : {};
  const b = pickBotSubtree(root);
  const universe =
    b.universe && typeof b.universe === "object"
      ? b.universe
      : {
          mode: b.universeCoinSelectMode,
          pinnedSymbols: b.universePinnedSymbols,
          coinBase: b.universeCoinBase,
          customSymbols: b.universeCustomSymbols,
          autoCoinPick: b.universeAutoCoinPick,
        };
  const signalGates = {
    signalStrengthGatesTrades: b.signalStrengthGatesTrades,
    signalStrengthOpenMin: b.signalStrengthOpenMin,
    supertrendMoveQualityGate: b.supertrendMoveQualityGate,
    supertrendMoveQualityMinScore: b.supertrendMoveQualityMinScore,
    supertrendBreakoutConfirm: b.supertrendBreakoutConfirm,
  };
  return {
    cfg_symbol: b.symbol,
    cfg_timeframe: b.timeframe,
    cfg_symbol_mode: b.symbolMode,
    cfg_market_mode: b.marketMode,
    cfg_strategy_mode: b.strategyMode,
    cfg_manual_strategy: b.manualStrategy,
    cfg_ai_threshold: b.aiThreshold,
    cfg_risk_per_trade: b.riskPerTrade,
    cfg_risk_unit: b.riskPerTradeUnit,
    cfg_max_daily_loss: b.maxDailyLoss,
    cfg_max_daily_loss_unit: b.maxDailyLossUnit,
    cfg_capital_mode: b.allowedBudgetInputMode,
    cfg_capital_fixed_usdt: b.allowedBudgetUsdt,
    cfg_capital_pct: b.allowedBudgetWalletPct,
    cfg_compound_pnl: b.capitalAllotmentCompoundPnlUi,
    cfg_st_period: b.supertrendPeriod,
    cfg_st_multiplier: b.supertrendMultiplier,
    cfg_st_wilder_atr: b.supertrendWilderAtr,
    cfg_st_spot_auto: b.supertrendSpotAuto,
    cfg_st_futures_auto: b.supertrendFuturesAuto,
    cfg_futures_leverage_mode: b.futuresLeverageMode,
    cfg_futures_leverage: b.futuresLeverage,
    cfg_futures_fixed_sl_pct: b.supertrendFuturesFixedSlPct,
    cfg_futures_fixed_tp_pct: b.supertrendFuturesFixedTpPct,
    cfg_entry_open_style: b.supertrendFuturesEntryOpenStyle,
    cfg_max_entry_slippage_pct: b.supertrendFuturesMaxEntrySlippagePct,
    cfg_max_signal_lag_ms: b.supertrendFuturesMaxSignalLagMs,
    cfg_trailing_auto: b.trailingStopLossAuto,
    cfg_trailing_mode: b.futuresTrailingStopMode,
    cfg_trail_buffer_mode: b.trailBufferMode,
    cfg_trail_buffer_rate: b.trailBufferRate,
    cfg_trail_open_fee_rate: b.trailOpenFeeRate,
    cfg_trail_close_fee_rate: b.trailCloseFeeRate,
    cfg_mde: b.marketDecision,
    cfg_universe: universe,
    cfg_signal_gates: signalGates,
    cfg_surf_pulse_ml_threshold: b.surfPulseMlThreshold,
  };
}

function mapVersionRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id),
    versionNumber: Number(row.version_number),
    label: row.label != null ? String(row.label) : null,
    promotedFrom: row.promoted_from != null ? String(row.promoted_from) : null,
    cfgRaw: row.cfg_raw,
    primarySignalType: row.primary_signal_type != null ? String(row.primary_signal_type) : "SUPERTREND",
    blocks: {
      supertrend: row.cfg_supertrend ?? null,
      surfPulse: row.cfg_surf_pulse ?? null,
      emaCross: row.cfg_ema_cross ?? null,
      rsi: row.cfg_rsi ?? null,
      ai: row.cfg_ai ?? null,
      entry: row.cfg_entry ?? null,
      exit: row.cfg_exit ?? null,
      leverage: row.cfg_leverage ?? null,
      mde: row.cfg_mde ?? null,
      signalGates: row.cfg_signal_gates ?? null,
    },
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    createdBy: String(row.created_by),
    cfg: {
      symbol: row.cfg_symbol,
      timeframe: row.cfg_timeframe,
      symbolMode: row.cfg_symbol_mode,
      marketMode: row.cfg_market_mode,
      strategyMode: row.cfg_strategy_mode,
      manualStrategy: row.cfg_manual_strategy,
      aiThreshold: row.cfg_ai_threshold,
      riskPerTrade: row.cfg_risk_per_trade,
      riskUnit: row.cfg_risk_unit,
      maxDailyLoss: row.cfg_max_daily_loss,
      maxDailyLossUnit: row.cfg_max_daily_loss_unit,
      capitalMode: row.cfg_capital_mode,
      capitalFixedUsdt: row.cfg_capital_fixed_usdt,
      capitalPct: row.cfg_capital_pct,
      compoundPnl: row.cfg_compound_pnl,
      stPeriod: row.cfg_st_period,
      stMultiplier: row.cfg_st_multiplier,
      stWilderAtr: row.cfg_st_wilder_atr,
      stSpotAuto: row.cfg_st_spot_auto,
      stFuturesAuto: row.cfg_st_futures_auto,
      futuresLeverageMode: row.cfg_futures_leverage_mode,
      futuresLeverage: row.cfg_futures_leverage,
      futuresFixedSlPct: row.cfg_futures_fixed_sl_pct,
      futuresFixedTpPct: row.cfg_futures_fixed_tp_pct,
      entryOpenStyle: row.cfg_entry_open_style,
      maxEntrySlippagePct: row.cfg_max_entry_slippage_pct,
      maxSignalLagMs: row.cfg_max_signal_lag_ms,
      trailingAuto: row.cfg_trailing_auto,
      trailingMode: row.cfg_trailing_mode,
      trailBufferMode: row.cfg_trail_buffer_mode,
      trailBufferRate: row.cfg_trail_buffer_rate,
      trailOpenFeeRate: row.cfg_trail_open_fee_rate,
      trailCloseFeeRate: row.cfg_trail_close_fee_rate,
      mde: row.cfg_mde,
      universe: row.cfg_universe,
      signalGates: row.cfg_signal_gates,
      surfPulseMlThreshold: row.cfg_surf_pulse_ml_threshold,
    },
  };
}

function mapStrategyRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    description: row.description != null ? String(row.description) : null,
    tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
    isArchived: Boolean(row.is_archived),
    modeId: row.mode_id != null ? Number(row.mode_id) : null,
    modeSlug: row.mode_slug != null ? String(row.mode_slug) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** @param {string} userId @param {string|null|undefined} [_modeSlug] ignored — strategies are mode-agnostic @param {string} name @param {string|null} [description] @param {string[]} [tags] */
export async function createStrategy(userId, _modeSlug, name, description = null, tags = []) {
  const ins = await query(
    `INSERT INTO strategies (user_id, mode_id, name, description, tags)
     VALUES ($1, NULL, $2, $3, $4)
     RETURNING id`,
    [userId, String(name || "").trim() || "Untitled", description, Array.isArray(tags) ? tags : []],
  );
  const id = ins.rows[0]?.id;
  return id ? getStrategy(String(id)) : null;
}

/** @param {string} strategyId */
export async function getStrategy(strategyId) {
  const r = await query(
    `SELECT s.*, tm.slug AS mode_slug
     FROM strategies s
     LEFT JOIN trading_modes tm ON tm.id = s.mode_id
     WHERE s.id = $1`,
    [strategyId],
  );
  return mapStrategyRow(r.rows[0]);
}

/**
 * @param {string} userId
 * @param {{ includeArchived?: boolean, modeSlug?: string }} [opts]
 * modeSlug is ignored — signal-brain strategies are shared across all trading modes.
 */
export async function listStrategies(userId, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const params = [userId];
  let sql = `
    SELECT s.*, tm.slug AS mode_slug
    FROM strategies s
    LEFT JOIN trading_modes tm ON tm.id = s.mode_id
    WHERE s.user_id = $1`;
  if (!includeArchived) sql += ` AND s.is_archived = false`;
  sql += ` ORDER BY s.created_at ASC`;
  const r = await query(sql, params);
  return r.rows.map(mapStrategyRow);
}

/**
 * Same as listStrategies plus latestVersion per strategy (one extra query).
 * @param {string} userId
 * @param {{ includeArchived?: boolean, modeSlug?: string }} [opts]
 */
export async function listStrategiesWithLatest(userId, opts = {}) {
  const strategies = await listStrategies(userId, opts);
  if (!strategies.length) {
    return strategies.map((s) => ({ ...s, latestVersion: null }));
  }
  const ids = strategies.map((s) => s.id);
  const r = await query(
    `SELECT DISTINCT ON (strategy_id) *
     FROM strategy_versions
     WHERE strategy_id = ANY($1::uuid[])
     ORDER BY strategy_id, version_number DESC`,
    [ids],
  );
  const byStrategy = new Map(r.rows.map((row) => [String(row.strategy_id), mapVersionRow(row)]));
  return strategies.map((s) => ({ ...s, latestVersion: byStrategy.get(s.id) ?? null }));
}

/** @param {string} strategyId */
export async function archiveStrategy(strategyId) {
  await query(`UPDATE strategies SET is_archived = true WHERE id = $1`, [strategyId]);
}

/** @param {string} strategyId @param {{ name?: string, description?: string | null, tags?: string[] }} patch */
export async function updateStrategyMeta(strategyId, patch) {
  const cur = await getStrategy(strategyId);
  if (!cur) return null;
  const name = patch.name != null ? String(patch.name).trim() : cur.name;
  const description = patch.description !== undefined ? patch.description : cur.description;
  const tags = patch.tags != null ? patch.tags : cur.tags;
  await query(`UPDATE strategies SET name = $2, description = $3, tags = $4 WHERE id = $1`, [
    strategyId,
    name || "Untitled",
    description,
    Array.isArray(tags) ? tags : [],
  ]);
  return getStrategy(strategyId);
}

/**
 * @param {string} strategyId
 * @param {string} userId
 * @param {Record<string, unknown>} configRaw
 * @param {string|null} [label]
 * @param {string|null} [promotedFrom]
 *
 * Strategy versions store the SIGNAL BRAIN only:
 *   - new typed blocks (cfg_supertrend, cfg_ai, cfg_entry, …) are authoritative
 *   - cfg_raw stores the FLAT bot payload with operational fields (symbol/risk/capital)
 *     stripped, so the same strategy can be reused across instances cleanly.
 *   - legacy scalar cfg_* columns are still populated for backward compatibility
 *     and analytics queries that already depend on them.
 */
export async function createVersion(strategyId, userId, configRaw, label = null, promotedFrom = null) {
  const cols = extractCfgColumns(configRaw);
  const blocks = buildSignalBrainBlocks(configRaw);
  const cleanRaw = stripInstanceFieldsFromCfgRaw(
    configRaw && typeof configRaw === "object" ? configRaw : {},
  );
  const r = await query(
    `INSERT INTO strategy_versions (
      strategy_id, label, promoted_from,
      cfg_symbol, cfg_timeframe, cfg_symbol_mode, cfg_market_mode, cfg_strategy_mode, cfg_manual_strategy,
      cfg_ai_threshold, cfg_risk_per_trade, cfg_risk_unit, cfg_max_daily_loss, cfg_max_daily_loss_unit,
      cfg_capital_mode, cfg_capital_fixed_usdt, cfg_capital_pct, cfg_compound_pnl,
      cfg_st_period, cfg_st_multiplier, cfg_st_wilder_atr, cfg_st_spot_auto, cfg_st_futures_auto,
      cfg_futures_leverage_mode, cfg_futures_leverage, cfg_futures_fixed_sl_pct, cfg_futures_fixed_tp_pct,
      cfg_entry_open_style, cfg_max_entry_slippage_pct, cfg_max_signal_lag_ms,
      cfg_trailing_auto, cfg_trailing_mode, cfg_trail_buffer_mode, cfg_trail_buffer_rate,
      cfg_trail_open_fee_rate, cfg_trail_close_fee_rate,
      cfg_mde, cfg_universe, cfg_signal_gates, cfg_surf_pulse_ml_threshold,
      cfg_raw, created_by,
      primary_signal_type,
      cfg_supertrend, cfg_surf_pulse, cfg_ema_cross, cfg_rsi,
      cfg_ai, cfg_entry, cfg_exit, cfg_leverage
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, $20, $21, $22, $23,
      $24, $25, $26, $27,
      $28, $29, $30,
      $31, $32, $33, $34, $35, $36,
      $37, $38, $39, $40,
      $41::jsonb, $42,
      $43,
      $44::jsonb, $45::jsonb, $46::jsonb, $47::jsonb,
      $48::jsonb, $49::jsonb, $50::jsonb, $51::jsonb
    )
    RETURNING *`,
    [
      strategyId,
      label,
      promotedFrom,
      cols.cfg_symbol,
      cols.cfg_timeframe,
      cols.cfg_symbol_mode,
      cols.cfg_market_mode,
      cols.cfg_strategy_mode,
      cols.cfg_manual_strategy,
      cols.cfg_ai_threshold,
      cols.cfg_risk_per_trade,
      cols.cfg_risk_unit,
      cols.cfg_max_daily_loss,
      cols.cfg_max_daily_loss_unit,
      cols.cfg_capital_mode,
      cols.cfg_capital_fixed_usdt,
      cols.cfg_capital_pct,
      cols.cfg_compound_pnl,
      cols.cfg_st_period,
      cols.cfg_st_multiplier,
      cols.cfg_st_wilder_atr,
      cols.cfg_st_spot_auto,
      cols.cfg_st_futures_auto,
      cols.cfg_futures_leverage_mode,
      cols.cfg_futures_leverage,
      cols.cfg_futures_fixed_sl_pct,
      cols.cfg_futures_fixed_tp_pct,
      cols.cfg_entry_open_style,
      cols.cfg_max_entry_slippage_pct,
      cols.cfg_max_signal_lag_ms,
      cols.cfg_trailing_auto,
      cols.cfg_trailing_mode,
      cols.cfg_trail_buffer_mode,
      cols.cfg_trail_buffer_rate,
      cols.cfg_trail_open_fee_rate,
      cols.cfg_trail_close_fee_rate,
      cols.cfg_mde ?? null,
      cols.cfg_universe ?? null,
      cols.cfg_signal_gates ?? null,
      cols.cfg_surf_pulse_ml_threshold,
      cleanRaw,
      userId,
      blocks.primary_signal_type,
      blocks.cfg_supertrend,
      blocks.cfg_surf_pulse,
      blocks.cfg_ema_cross,
      blocks.cfg_rsi,
      blocks.cfg_ai,
      blocks.cfg_entry,
      blocks.cfg_exit,
      blocks.cfg_leverage,
    ],
  );
  return mapVersionRow(r.rows[0]);
}

/**
 * Overwrite an existing strategy version in place (same `id` / `version_number`).
 * Used by Trading "Save" so the bound instance keeps one logical version instead
 * of growing a chain of duplicate snapshots.
 *
 * @param {string} versionId
 * @param {string} userId
 * @param {Record<string, unknown>} configRaw
 * @param {string|null|undefined} label Pass `undefined` to leave `label` unchanged.
 */
export async function updateVersion(versionId, userId, configRaw, label = undefined) {
  const owned = await query(
    `SELECT sv.id
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     WHERE sv.id = $1 AND s.user_id = $2`,
    [versionId, userId],
  );
  if (!owned.rows.length) return null;

  const cols = extractCfgColumns(configRaw);
  const blocks = buildSignalBrainBlocks(configRaw);
  const cleanRaw = stripInstanceFieldsFromCfgRaw(
    configRaw && typeof configRaw === "object" ? configRaw : {},
  );

  const vals = [];
  const next = (v) => {
    vals.push(v);
    return `$${vals.length}`;
  };
  const sets = [];
  if (label !== undefined) sets.push(`label = ${next(label)}`);
  sets.push(`cfg_symbol = ${next(cols.cfg_symbol)}`);
  sets.push(`cfg_timeframe = ${next(cols.cfg_timeframe)}`);
  sets.push(`cfg_symbol_mode = ${next(cols.cfg_symbol_mode)}`);
  sets.push(`cfg_market_mode = ${next(cols.cfg_market_mode)}`);
  sets.push(`cfg_strategy_mode = ${next(cols.cfg_strategy_mode)}`);
  sets.push(`cfg_manual_strategy = ${next(cols.cfg_manual_strategy)}`);
  sets.push(`cfg_ai_threshold = ${next(cols.cfg_ai_threshold)}`);
  sets.push(`cfg_risk_per_trade = ${next(cols.cfg_risk_per_trade)}`);
  sets.push(`cfg_risk_unit = ${next(cols.cfg_risk_unit)}`);
  sets.push(`cfg_max_daily_loss = ${next(cols.cfg_max_daily_loss)}`);
  sets.push(`cfg_max_daily_loss_unit = ${next(cols.cfg_max_daily_loss_unit)}`);
  sets.push(`cfg_capital_mode = ${next(cols.cfg_capital_mode)}`);
  sets.push(`cfg_capital_fixed_usdt = ${next(cols.cfg_capital_fixed_usdt)}`);
  sets.push(`cfg_capital_pct = ${next(cols.cfg_capital_pct)}`);
  sets.push(`cfg_compound_pnl = ${next(cols.cfg_compound_pnl)}`);
  sets.push(`cfg_st_period = ${next(cols.cfg_st_period)}`);
  sets.push(`cfg_st_multiplier = ${next(cols.cfg_st_multiplier)}`);
  sets.push(`cfg_st_wilder_atr = ${next(cols.cfg_st_wilder_atr)}`);
  sets.push(`cfg_st_spot_auto = ${next(cols.cfg_st_spot_auto)}`);
  sets.push(`cfg_st_futures_auto = ${next(cols.cfg_st_futures_auto)}`);
  sets.push(`cfg_futures_leverage_mode = ${next(cols.cfg_futures_leverage_mode)}`);
  sets.push(`cfg_futures_leverage = ${next(cols.cfg_futures_leverage)}`);
  sets.push(`cfg_futures_fixed_sl_pct = ${next(cols.cfg_futures_fixed_sl_pct)}`);
  sets.push(`cfg_futures_fixed_tp_pct = ${next(cols.cfg_futures_fixed_tp_pct)}`);
  sets.push(`cfg_entry_open_style = ${next(cols.cfg_entry_open_style)}`);
  sets.push(`cfg_max_entry_slippage_pct = ${next(cols.cfg_max_entry_slippage_pct)}`);
  sets.push(`cfg_max_signal_lag_ms = ${next(cols.cfg_max_signal_lag_ms)}`);
  sets.push(`cfg_trailing_auto = ${next(cols.cfg_trailing_auto)}`);
  sets.push(`cfg_trailing_mode = ${next(cols.cfg_trailing_mode)}`);
  sets.push(`cfg_trail_buffer_mode = ${next(cols.cfg_trail_buffer_mode)}`);
  sets.push(`cfg_trail_buffer_rate = ${next(cols.cfg_trail_buffer_rate)}`);
  sets.push(`cfg_trail_open_fee_rate = ${next(cols.cfg_trail_open_fee_rate)}`);
  sets.push(`cfg_trail_close_fee_rate = ${next(cols.cfg_trail_close_fee_rate)}`);
  sets.push(`cfg_mde = ${next(cols.cfg_mde ?? null)}`);
  sets.push(`cfg_universe = ${next(cols.cfg_universe ?? null)}`);
  sets.push(`cfg_signal_gates = ${next(cols.cfg_signal_gates ?? null)}`);
  sets.push(`cfg_surf_pulse_ml_threshold = ${next(cols.cfg_surf_pulse_ml_threshold)}`);
  sets.push(`cfg_raw = ${next(cleanRaw)}::jsonb`);
  sets.push(`primary_signal_type = ${next(blocks.primary_signal_type)}`);
  sets.push(`cfg_supertrend = ${next(blocks.cfg_supertrend)}::jsonb`);
  sets.push(`cfg_surf_pulse = ${next(blocks.cfg_surf_pulse)}::jsonb`);
  sets.push(`cfg_ema_cross = ${next(blocks.cfg_ema_cross)}::jsonb`);
  sets.push(`cfg_rsi = ${next(blocks.cfg_rsi)}::jsonb`);
  sets.push(`cfg_ai = ${next(blocks.cfg_ai)}::jsonb`);
  sets.push(`cfg_entry = ${next(blocks.cfg_entry)}::jsonb`);
  sets.push(`cfg_exit = ${next(blocks.cfg_exit)}::jsonb`);
  sets.push(`cfg_leverage = ${next(blocks.cfg_leverage)}::jsonb`);
  const idPh = next(versionId);
  const sql = `UPDATE strategy_versions SET ${sets.join(", ")} WHERE id = ${idPh}`;
  const r = await query(sql, vals);
  if (!r.rowCount) return null;
  return getVersion(versionId);
}

/** @param {string} versionId */
export async function getVersion(versionId) {
  const r = await query(`SELECT * FROM strategy_versions WHERE id = $1`, [versionId]);
  return mapVersionRow(r.rows[0]);
}

/** @param {string} strategyId */
export async function getLatestVersion(strategyId) {
  const r = await query(
    `SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY version_number DESC LIMIT 1`,
    [strategyId],
  );
  return mapVersionRow(r.rows[0]);
}

/** @param {string} strategyId */
export async function listVersions(strategyId) {
  const r = await query(
    `SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY version_number ASC`,
    [strategyId],
  );
  return r.rows.map(mapVersionRow);
}

/** @param {string} versionId */
export async function getStrategyByVersionId(versionId) {
  const r = await query(
    `SELECT s.*, tm.slug AS mode_slug
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     LEFT JOIN trading_modes tm ON tm.id = s.mode_id
     WHERE sv.id = $1`,
    [versionId],
  );
  return mapStrategyRow(r.rows[0]);
}

/** @param {string} strategyId @param {string} userId */
export async function assertStrategyOwnedByUser(strategyId, userId) {
  const s = await getStrategy(strategyId);
  if (!s || s.userId !== String(userId)) return null;
  return s;
}
