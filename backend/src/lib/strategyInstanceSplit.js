/**
 * Strategy / Instance config split — canonical field map and helpers.
 *
 * MENTAL MODEL
 *   STRATEGY (signal brain): WHEN/HOW to enter, exit, filter, size by leverage.
 *                            Reusable across instances. Backtested independently.
 *   INSTANCE (operational):  WHICH symbol/timeframe, WHAT account, HOW MUCH capital,
 *                            WHAT risk. Per-deployment overrides.
 *
 * RUNTIME CONTRACT
 *   The bot engine consumes a single flat config object (legacy shape kept intact).
 *   - Strategy `cfg_raw` = signal-brain-only flat config (no symbol/risk/capital pollution).
 *   - Instance `inst_*` columns = operational overrides.
 *   - At engine boot we merge: bot.config = { ...strategy.cfg_raw, ...applyInstanceOverrides(instance) }.
 *
 * This file is the single source of truth for which keys belong to which side.
 */

/** Flat config keys owned by INSTANCE (operational deployment).  All others stay on STRATEGY. */
export const INSTANCE_FIELD_KEYS = Object.freeze([
  // market
  "symbol",
  "timeframe",
  "symbolMode",
  "marketMode",
  // universe (instance-side; the *autoCoinPick* flag still belongs to strategy because it's algorithmic)
  "universe",
  "universeCoinSelectMode",
  "universePinnedSymbols",
  "universeCoinBase",
  "universeCustomSymbols",
  // risk
  "riskPerTrade",
  "riskPerTradeUnit",
  "maxDailyLoss",
  "maxDailyLossUnit",
  // capital
  "allowedBudgetInputMode",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "capitalAllotmentCompoundPnlUi",
]);

const INSTANCE_FIELD_SET = new Set(INSTANCE_FIELD_KEYS);

/** Allowed primary signal types (matches CHECK constraint in 022). */
export const PRIMARY_SIGNAL_TYPES = Object.freeze([
  "SUPERTREND",
  "SURF_PULSE_ML",
  "EMA_CROSS",
  "RSI",
  "MANUAL",
]);

/**
 * Pick the bot subtree from a persist payload. Existing payloads can either be
 * `{ v, bot, tradingFormDefaults }` or a legacy flat object (we tolerate both).
 * @param {Record<string, unknown>|null|undefined} cfgRaw
 */
export function pickBotSubtree(cfgRaw) {
  const root = cfgRaw && typeof cfgRaw === "object" ? cfgRaw : {};
  return root.bot && typeof root.bot === "object" ? root.bot : root;
}

/**
 * Determine the primary signal type from a flat bot config.
 * Defaults to SUPERTREND (matches all existing strategies).
 */
export function resolvePrimarySignalType(bot) {
  const b = bot && typeof bot === "object" ? bot : {};
  if (b.strategyMode === "MANUAL") {
    const m = String(b.manualStrategy || "").toUpperCase();
    if (m === "SURF_PULSE_ML") return "SURF_PULSE_ML";
    if (m === "EMA_CROSS") return "EMA_CROSS";
    if (m === "RSI") return "RSI";
    return "MANUAL";
  }
  return "SUPERTREND";
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal-brain block extractors (flat → typed JSONB blocks)
// ─────────────────────────────────────────────────────────────────────────────

export function extractSupertrendBlock(b) {
  return {
    period: b.supertrendPeriod ?? null,
    multiplier: b.supertrendMultiplier ?? null,
    wilderAtr: b.supertrendWilderAtr ?? null,
    spotAuto: b.supertrendSpotAuto ?? null,
    futuresAuto: b.supertrendFuturesAuto ?? null,
  };
}

export function extractSurfPulseBlock(b) {
  if (b.surfPulseMlThreshold == null) return null;
  return {
    mlThreshold: b.surfPulseMlThreshold,
    spotAuto: b.supertrendSpotAuto ?? null,
    futuresAuto: b.supertrendFuturesAuto ?? null,
  };
}

export function extractEmaCrossBlock(b) {
  if (b.emaCrossFastPeriod == null && b.emaCrossSlowPeriod == null) return null;
  return {
    fastPeriod: b.emaCrossFastPeriod ?? null,
    slowPeriod: b.emaCrossSlowPeriod ?? null,
    signalPeriod: b.emaCrossSignalPeriod ?? null,
    spotAuto: b.supertrendSpotAuto ?? null,
    futuresAuto: b.supertrendFuturesAuto ?? null,
  };
}

export function extractRsiBlock(b) {
  if (b.rsiPeriod == null && b.rsiOverbought == null && b.rsiOversold == null) return null;
  return {
    period: b.rsiPeriod ?? null,
    overbought: b.rsiOverbought ?? null,
    oversold: b.rsiOversold ?? null,
    spotAuto: b.supertrendSpotAuto ?? null,
    futuresAuto: b.supertrendFuturesAuto ?? null,
  };
}

export function extractAiBlock(b) {
  return {
    enabled: b.aiThreshold != null,
    strategyMode: b.strategyMode ?? "AUTO",
    manualStrategy: b.manualStrategy ?? null,
    threshold: b.aiThreshold ?? null,
    aiConfidenceFilter: b.supertrendFuturesAiConfidenceFilter ?? null,
    minAiProb: b.supertrendFuturesMinAiProb ?? null,
  };
}

export function extractEntryBlock(b) {
  return {
    openStyle: b.supertrendFuturesEntryOpenStyle ?? null,
    maxSlippagePct: b.supertrendFuturesMaxEntrySlippagePct ?? null,
    maxSignalLagMs: b.supertrendFuturesMaxSignalLagMs ?? null,
    recheckMs: b.supertrendEntryRecheckMs ?? null,
    iocFallbackMarket: b.supertrendIocFallbackMarket ?? null,
    requireMarkPrice: b.supertrendRequireMarkPrice ?? null,
    requireBookTicker: b.supertrendRequireBookTicker ?? null,
    twoWay: b.supertrendFuturesTwoWay ?? null,
  };
}

export function extractExitBlock(b) {
  return {
    fixedSlPct: b.supertrendFuturesFixedSlPct ?? null,
    fixedTpPct: b.supertrendFuturesFixedTpPct ?? null,
    trailingEnabled: b.trailingStopLossAuto ?? null,
    trailingMode: b.futuresTrailingStopMode ?? null,
    bufferMode: b.trailBufferMode ?? null,
    bufferRate: b.trailBufferRate ?? null,
    openFeeRate: b.trailOpenFeeRate ?? null,
    closeFeeRate: b.trailCloseFeeRate ?? null,
    feeBeMultiplier: b.trailFeeBeMultiplier ?? null,
    activationSlippageFrac: b.trailActivationSlippageFrac ?? null,
    t01LockSlippageFrac: b.trailT01LockSlippageFrac ?? null,
    trailBufferAtrMult: b.trailBufferAtrMult ?? null,
    postT02ActivationBufferRate: b.trailPostT02ActivationBufferRate ?? null,
    minSlDistFrac: b.trailMinSlDistFrac ?? null,
    minGapFromMarkFrac: b.trailMinGapFromMarkFrac ?? null,
    maintMarginRate: b.trailMaintMarginRate ?? null,
    postT02SpacingFrac: b.trailPostT02SpacingFrac ?? null,
    postT02MaxExtraTiers: b.trailPostT02MaxExtraTiers ?? null,
    extraScalpingPcts: b.trailingStopExtraScalpingPcts ?? null,
    feeBreakeven: b.futuresTrailingStFeeBreakeven ?? null,
    advancedTrailing: b.futuresTrailingStAdvanced ?? null,
  };
}

export function extractLeverageBlock(b) {
  return {
    mode: b.futuresLeverageMode ?? null,
    value: b.futuresLeverage ?? null,
  };
}

export function extractSignalGatesBlock(b) {
  return {
    enabled: true,
    strengthGateEnabled: b.signalStrengthGatesTrades ?? null,
    strengthOpenMin: b.signalStrengthOpenMin ?? null,
    moveQualityGateEnabled: b.supertrendMoveQualityGate ?? null,
    moveQualityMinScore: b.supertrendMoveQualityMinScore ?? null,
    minAdx: b.supertrendMinAdx ?? null,
    minMoveSlRatio: b.supertrendMinMoveSlRatio ?? null,
    expectedMoveAtrMult: b.supertrendExpectedMoveAtrMult ?? null,
    minAtrExpansion: b.supertrendMinAtrExpansion ?? null,
    minBodyVsAvg: b.supertrendMinBodyVsAvg ?? null,
    minDirectionalBody: b.supertrendMinDirectionalBody ?? null,
    minVolumeVsAvg: b.supertrendMinVolumeVsAvg ?? null,
    breakoutConfirmEnabled: b.supertrendBreakoutConfirm ?? null,
    breakoutMaxBars: b.supertrendBreakoutMaxBars ?? null,
  };
}

/**
 * Build the typed signal-brain blocks from a flat bot config.
 * The block matching `primarySignalType` is always populated; siblings stay null.
 */
export function buildSignalBrainBlocks(rawCfg) {
  const root = rawCfg && typeof rawCfg === "object" ? rawCfg : {};
  const b = pickBotSubtree(root);
  const primary = resolvePrimarySignalType(b);
  return {
    primary_signal_type: primary,
    cfg_supertrend: primary === "SUPERTREND" ? extractSupertrendBlock(b) : null,
    cfg_surf_pulse: primary === "SURF_PULSE_ML" ? extractSurfPulseBlock(b) : null,
    cfg_ema_cross: primary === "EMA_CROSS" ? extractEmaCrossBlock(b) : null,
    cfg_rsi: primary === "RSI" ? extractRsiBlock(b) : null,
    cfg_ai: extractAiBlock(b),
    cfg_entry: extractEntryBlock(b),
    cfg_exit: extractExitBlock(b),
    cfg_leverage: extractLeverageBlock(b),
    cfg_mde: b.marketDecision ?? null,
    cfg_signal_gates: extractSignalGatesBlock(b),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance operational config — extract / apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract operational fields from a flat bot config into the instance JSON shape
 * stored in `bot_instances.inst_*`. Used during backfill and when seeding an
 * instance from the strategy's currently-saved defaults.
 */
export function extractInstanceConfig(rawCfg) {
  const b = pickBotSubtree(rawCfg);
  const universe =
    b.universe && typeof b.universe === "object"
      ? b.universe
      : {
          mode: b.universeCoinSelectMode ?? null,
          pinnedSymbols: b.universePinnedSymbols ?? null,
          coinBase: b.universeCoinBase ?? null,
          customSymbols: b.universeCustomSymbols ?? null,
          autoCoinPick: b.universeAutoCoinPick ?? null,
        };
  return {
    inst_symbol: b.symbol ?? null,
    inst_timeframe: b.timeframe ?? null,
    inst_symbol_mode: b.symbolMode ?? null,
    inst_market_mode: b.marketMode ?? null,
    inst_universe: universe,
    inst_risk_per_trade: b.riskPerTrade ?? null,
    inst_risk_unit: b.riskPerTradeUnit ?? null,
    inst_max_daily_loss: b.maxDailyLoss ?? null,
    inst_max_daily_loss_unit: b.maxDailyLossUnit ?? null,
    inst_capital_mode: b.allowedBudgetInputMode ?? null,
    inst_capital_usdt: b.allowedBudgetUsdt ?? null,
    inst_capital_pct: b.allowedBudgetWalletPct ?? null,
    inst_compound_pnl: b.capitalAllotmentCompoundPnlUi ?? null,
  };
}

/**
 * Strip operational (instance-owned) fields from a flat bot config so the
 * resulting payload represents only the signal brain — what we save as a
 * strategy version. Returns a new object preserving outer shape.
 */
export function stripInstanceFieldsFromCfgRaw(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return cfgRaw;
  const root = { ...cfgRaw };
  const hasBotSubtree = root.bot && typeof root.bot === "object";
  const target = hasBotSubtree ? { ...root.bot } : root;
  for (const key of INSTANCE_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) delete target[key];
  }
  if (hasBotSubtree) root.bot = target;
  return hasBotSubtree ? root : target;
}

/**
 * Merge instance operational config back INTO a strategy's flat cfg_raw
 * to produce the complete flat config the bot engine consumes.
 *
 * Rules:
 *   - When an instance value is non-null, it overrides the strategy default.
 *   - When an instance value is null/undefined, the strategy default wins.
 *   - This preserves the bot's runtime contract (single flat config object).
 *
 * @param {Record<string, unknown>|null|undefined} strategyCfgRaw
 * @param {Record<string, unknown>|null|undefined} instConfig  inst_* shape (from instanceService)
 */
export function mergeInstanceIntoCfgRaw(strategyCfgRaw, instConfig) {
  const root =
    strategyCfgRaw && typeof strategyCfgRaw === "object"
      ? JSON.parse(JSON.stringify(strategyCfgRaw))
      : {};
  if (!instConfig || typeof instConfig !== "object") return root;
  const hasBotSubtree = root.bot && typeof root.bot === "object";
  const target = hasBotSubtree ? root.bot : root;

  /** assign only when v is non-null/undefined */
  const setIf = (key, v) => {
    if (v == null) return;
    target[key] = v;
  };

  setIf("symbol", instConfig.inst_symbol);
  setIf("timeframe", instConfig.inst_timeframe);
  setIf("symbolMode", instConfig.inst_symbol_mode);
  setIf("marketMode", instConfig.inst_market_mode);
  setIf("riskPerTrade", instConfig.inst_risk_per_trade);
  setIf("riskPerTradeUnit", instConfig.inst_risk_unit);
  setIf("maxDailyLoss", instConfig.inst_max_daily_loss);
  setIf("maxDailyLossUnit", instConfig.inst_max_daily_loss_unit);
  setIf("allowedBudgetInputMode", instConfig.inst_capital_mode);
  setIf("allowedBudgetUsdt", instConfig.inst_capital_usdt);
  setIf("allowedBudgetWalletPct", instConfig.inst_capital_pct);
  setIf("capitalAllotmentCompoundPnlUi", instConfig.inst_compound_pnl);

  if (instConfig.inst_universe && typeof instConfig.inst_universe === "object") {
    target.universe = instConfig.inst_universe;
    const u = instConfig.inst_universe;
    setIf("universeCoinSelectMode", u.mode);
    setIf("universePinnedSymbols", u.pinnedSymbols);
    setIf("universeCoinBase", u.coinBase);
    setIf("universeCustomSymbols", u.customSymbols);
  }

  return root;
}

/**
 * Predicate: is this flat-config key owned by the instance?
 * Useful for partial PATCH endpoints that route updates to the right table.
 */
export function isInstanceFieldKey(key) {
  return INSTANCE_FIELD_SET.has(String(key));
}
