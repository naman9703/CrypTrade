import { normalizeIntradayGatesOnBot } from "./intradayGatesUi";

/**
 * Client-side mirror of backend `strategyInstanceSplit.INSTANCE_FIELD_KEYS`
 * for comparing live bot edits vs the saved strategy version (signal brain only).
 *
 * Snapshots use the same **key set** as `bot.js` → `buildTradingConfigPersistPayload().bot`
 * so WS-only fields (`running`, `lastDecision`, …) do not keep "Configuration changed" stuck on.
 * Keep this list in sync with that function's `bot: { … }` literal.
 */
export const STRATEGY_INSTANCE_FIELD_KEYS = [
  "symbol",
  "timeframe",
  "symbolMode",
  "marketMode",
  "universe",
  "universeCoinSelectMode",
  "universePinnedSymbols",
  "universeCoinBase",
  "universeCustomSymbols",
  "riskPerTrade",
  "riskPerTradeUnit",
  "maxDailyLoss",
  "maxDailyLossUnit",
  "allowedBudgetInputMode",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "capitalAllotmentCompoundPnlUi",
] as const;

/** Must match `backend/src/state/bot.js` → `buildTradingConfigPersistPayload` → `bot` keys. */
const PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE: readonly string[] = [
  "symbol",
  "timeframe",
  "symbolMode",
  "universePinnedSymbol",
  "universeCoinBase",
  "universeCustomSymbols",
  "universeCoinSelectMode",
  "universePinControl",
  "universeAutoCoinPick",
  "universePinnedSymbols",
  "aiThreshold",
  "riskPerTrade",
  "maxDailyLoss",
  "riskPerTradeUnit",
  "maxDailyLossUnit",
  "capitalSplitAcrossCoins",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "allowedBudgetInputMode",
  "allowedBudgetPnlAnchorMs",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "capitalAllotmentCompoundPnlUi",
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
  "perTradeBudgetCapEnabled",
  "perTradeBudgetInputMode",
  "multiCoinCapitalSizingActive",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "futuresLeverageMode",
  "futuresLeverage",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesAiConfidenceFilter",
  "signalStrengthGatesTrades",
  "supertrendMoveQualityGate",
  "supertrendMoveQualityMinScore",
  "supertrendMoveQualityMinAdx",
  "supertrendMoveQualityMinMoveSlRatio",
  "supertrendMoveQualityExpectedMoveAtrMult",
  "supertrendMoveQualityMinAtrExpansion",
  "supertrendMoveQualityMinBodyVsAvg",
  "supertrendMoveQualityMinDirectionalBody",
  "supertrendMoveQualityMinVolumeVsAvg",
  "marketDecision",
  "supertrendBreakoutConfirm",
  "supertrendBreakoutMaxBars",
  "signalStrengthOpenMin",
  "smartSignalStrengthThreshold",
  "smartSignalStrengthThresholdMeta",
  "supertrendFuturesMinAiProb",
  "surfPulseMlGateEnabled",
  "surfPulseMlThreshold",
  "intelligenceGateEnabled",
  "intelligenceGateStrict",
  "intelligenceGateHighWinRate",
  "supertrendConfirmationGateEnabled",
  "supertrendConfirmationMinAdx",
  "supertrendConfirmationMinVolRatio",
  "supertrendConfirmationMinBodyAtrRatio",
  "supertrendConfirmationMaxAdverseWickFrac",
  "supertrendConfirmationMaxDistFromStAtr",
  "supertrendConfirmationRequireHtfAlign",
  "supertrendHtf4hEnabled",
  "supertrendHtf4hPeriod",
  "supertrendHtf4hMultiplier",
  "volumeProfileEnabled",
  "volumeProfileSoftGates",
  "volumeProfileGatesEnabled",
  "intradayVpBrackets",
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayGateHtfRegime",
  "intradayGateInstitutionalSr",
  "intradayGateSmcIct",
  "intradaySmcIctMode",
  "intradaySmcMinScore",
  "intradaySmcIctProfile",
  "intradaySmcPickMode",
  "intradaySmcOneTradePerDay",
  "intradaySmcRequireMss",
  "intradaySmcRequireRetrace",
  "intradaySmcRequireChoch",
  "intradaySmcRequireBos",
  "intradaySmcRequireConfirm",
  "intradaySmcRequireFvgRetrace",
  "intradaySmcLookbackBars",
  "intradaySmcMinRr",
  "intradaySmcMinAdx",
  "intradaySmcHtfStrictness",
  "intradaySmcHtfBiasMode",
  "intradaySmcRequireHtfBias",
    "intradaySmcChochStrict",
    "intradaySmcBosMaxBars",
    "intradaySmcChochMaxBars",
    "intradaySmcRequirePremiumDiscount",
    "intradaySmcPremiumDiscountOte",
    "intradaySmcDealingRangeLookback",
    "intradaySmcOteMin",
    "intradaySmcOteMax",
    "intradaySmcPremiumDiscountTolPct",
    "srIntradayMaxTradesPerDay",
  "srIntradayMinBarGap",
  "intradayLiqStrictMode",
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqSessionExtreme",
  "intradaySmcSlMode",
  "intradaySmcMaxTpRr",
  "intradaySmcMaxHoldBars",
  "intradaySmcKillzoneMode",
  "intradaySmcEntryZoneMode",
  "intradaySmcFvgEntryMode",
  "intradaySmcTp2Mode",
  "intradaySrAPlusMode",
  "intradaySrMinVolRatio",
  "intradaySrMinHtfSep",
  "intradaySrZoneWidthPct",
  "intradaySrBosMaxBarsAfterReclaim",
  "intradaySrMinConfirmWick",
  "intradaySrRequireBos",
  "intradaySrRequireConfirm",
  "intradaySrRequireVolume",
  "intradaySrRequireHtfTrend",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqPartialTp",
  "intradayLiqMinRr",
  "intradayFibStrictMode",
  "intradayFibConfirmNextBar",
  "intradayFibRequireRsiAlign",
  "intradayFibRequireHtfAlign",
  "intradayFibLearnedRulesEnabled",
  "intradayFibRequireRetraceCoherence",
  "intradayFibAllowedRatios",
  "intradayFibGoldenRetraceMin",
  "intradayFibGoldenRetraceMax",
  "intradayFibMinRetraceRatio",
  "intradayFibMaxRetraceRatio",
  "intradayFibMinWickRatio",
  "intradayFibMinAdx",
  "intradayFibMinLegAtrMult",
  "intradayFibMinHtfSep",
  "intradayFibMinScore",
  "intradayFibTpMode",
  "intradayFibExtensionFrac",
  "intradayFibMinRr",
  "intradayFibMinLegAtrMult",
  "intradayFibMaxBarsSinceSwing",
  "intradayFibBracketSource",
  "intradayFibGoldenScalpTpPct",
  "intradayFibGoldenScalpSlPct",
  "intradayFibEntryAtSignalClose",
  "intradayTierMode",
  "backtestBreakevenAtMfePct",
  "vpLookbackBars",
  "vpMinRR",
  "eliteStRequireHtf4hAlign",
  "eliteStHtf4hPeriod",
  "eliteStHtf4hMultiplier",
  "eliteStRequireHtf1hEmaAlign",
  "eliteStHtf1hMinSep",
  "eliteStMinAdx",
  "eliteStRequireAdxRising",
  "eliteStMinVolumeVsAvg",
  "eliteStRequireAtrExpansion",
  "eliteStMinAtrExpansion",
  "eliteStLiqSweepEnabled",
  "supertrendBigMoveGateEnabled",
  "supertrendBigMoveMinStrength",
  "supertrendBigMoveMinMoveSlRatio",
  "supertrendBigMoveMinAdx",
  "supertrendBigMoveMinScore",
  "supertrendBigMoveMaxCandlesSinceFlip",
  "supertrendBigMoveMinVolumeVsAvg",
  "supertrendBigMoveExpectedMoveAtrMult",
  "supertrendFuturesExitOnFlip",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "futuresTrailingStFeeBreakeven",
  "futuresTrailingStAdvanced",
  "trailingStopExtraScalpingPcts",
  "trailOpenFeeRate",
  "trailCloseFeeRate",
  "tradeHistoryMakerOpenFeeRate",
  "tradeHistoryMakerCloseFeeRate",
  "tradeHistoryTakerOpenFeeRate",
  "tradeHistoryTakerCloseFeeRate",
  "trailFeeBeMultiplier",
  "trailBufferRate",
  "trailActivationSlippageFrac",
  "trailT01LockSlippageFrac",
  "trailBufferAtrMult",
  "trailBufferMode",
  "trailPostT02ActivationBufferRate",
  "trailMinSlDistFrac",
  "trailMinGapFromMarkFrac",
  "trailMaintMarginRate",
  "trailPostT02SpacingFrac",
  "trailPostT02MaxExtraTiers",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesTwoWay",
  "supertrendFuturesMaxEntrySlippagePct",
  "supertrendFuturesEntryOpenStyle",
  "supertrendFuturesEntryRecheckMs",
  "supertrendFuturesIocFallbackMarket",
  "supertrendFuturesRequireMarkPrice",
  "supertrendFuturesRequireBookTicker",
  "supertrendFuturesMaxSignalLagMs",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "trendHtfStRegimeGate",
  "trendHtfStSurgicalLossFilter",
  "trendHtfStQualityFilter",
  "trendHtfStFlipExitBeforeSl",
  "trendHtfStMaxEntryRangeAtr",
  "trendHtfStMinHtfSep",
  "trendHtfStRegimeTpTrend",
  "trendHtfStRegimeTpMixed",
  "trendHtfStRegimeTpChop",
  "backtestBreakevenAtMfePct",
];

/** Live engine counters — not strategy parameters; exclude from dirty compare. */
const RUNTIME_ONLY_BOT_KEYS = new Set<string>([
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
  "allowedBudgetPnlAnchorMs",
  "smartSignalStrengthThresholdMeta",
]);

function stripInstanceFieldsFromCfgRaw(cfgRaw: Record<string, unknown>): Record<string, unknown> {
  const root = { ...cfgRaw };
  const hasBotSubtree = root.bot && typeof root.bot === "object" && !Array.isArray(root.bot);
  const target = hasBotSubtree
    ? { ...(root.bot as Record<string, unknown>) }
    : ({ ...root } as Record<string, unknown>);
  for (const key of STRATEGY_INSTANCE_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) delete target[key];
  }
  if (hasBotSubtree) return { ...root, bot: target };
  return target;
}

function pickPersistBotShape(flat: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeIntradayGatesOnBot(flat);
  const out: Record<string, unknown> = {};
  for (const k of PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE) {
    if (RUNTIME_ONLY_BOT_KEYS.has(k)) continue;
    out[k] = normalized[k];
  }
  return out;
}

/** cfg_raw shape aligned with what Save persists (for dirty baseline after Save). */
export function canonicalCfgRawFromUiBot(bot: unknown): Record<string, unknown> {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
    return stripInstanceFieldsFromCfgRaw({ v: 1, bot: {} });
  }
  return stripInstanceFieldsFromCfgRaw(persistLikePayloadFromUiBot(bot));
}

/** Match `getTradingConfigPersistPayload` / WS bot: nested `bot` or flat legacy. */
export function persistLikePayloadFromUiBot(bot: unknown): Record<string, unknown> {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) return { v: 1, bot: {} };
  const o = bot as Record<string, unknown>;
  if (o.bot && typeof o.bot === "object" && !Array.isArray(o.bot)) return { ...o };
  const v = typeof o.v === "number" ? o.v : 1;
  const tradingFormDefaults = o.tradingFormDefaults;
  const botOnly = { ...o };
  delete botOnly.v;
  delete botOnly.tradingFormDefaults;
  return {
    v,
    bot: botOnly as Record<string, unknown>,
    ...(tradingFormDefaults && typeof tradingFormDefaults === "object" && !Array.isArray(tradingFormDefaults)
      ? { tradingFormDefaults }
      : {}),
  };
}

/** Strip instance fields, then keep only persist-payload bot keys (+ v / tradingFormDefaults). */
function canonicalSignalBrainRecord(root: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripInstanceFieldsFromCfgRaw(root);
  const v = typeof stripped.v === "number" ? stripped.v : 1;
  const flat =
    stripped.bot && typeof stripped.bot === "object" && !Array.isArray(stripped.bot)
      ? ({ ...(stripped.bot as Record<string, unknown>) } as Record<string, unknown>)
      : ({ ...stripped } as Record<string, unknown>);
  delete flat.v;
  delete flat.tradingFormDefaults;
  const bot = pickPersistBotShape(flat);
  const out: Record<string, unknown> = { v, bot };
  const tfd = stripped.tradingFormDefaults;
  if (tfd && typeof tfd === "object" && !Array.isArray(tfd)) {
    out.tradingFormDefaults = { ...(tfd as Record<string, unknown>) };
  }
  return out;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** Canonical signal-brain JSON for equality vs `StrategyVersion.cfgRaw`. */
export function signalBrainSnapshotFromUiBot(bot: unknown): string {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
    return stableStringify(canonicalSignalBrainRecord({ v: 1, bot: {} }));
  }
  const payload = persistLikePayloadFromUiBot(bot);
  return stableStringify(canonicalSignalBrainRecord(payload));
}

export function signalBrainSnapshotFromCfgRaw(cfgRaw: Record<string, unknown> | null | undefined): string {
  if (!cfgRaw || typeof cfgRaw !== "object") {
    return stableStringify(canonicalSignalBrainRecord({ v: 1, bot: {} }));
  }
  return stableStringify(canonicalSignalBrainRecord({ ...cfgRaw }));
}
