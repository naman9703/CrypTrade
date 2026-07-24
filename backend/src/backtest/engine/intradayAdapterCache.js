/**
 * LRU cache for precomputed intraday / SR_INTRADAY signal series.
 * Avoids rebuilding selectIntradayPicks on every backtest worker run.
 */

const MAX_ENTRIES = 12;
/** @type {Map<string, { series: unknown[], at: number }>} */
const cache = new Map();

function stableCfgSlice(cfg) {
  if (!cfg || typeof cfg !== "object") return "";
  const keys = [
    "manualStrategy",
    "intradayGateLiquidity",
    "intradayGateSession",
    "intradayGateFib",
    "intradayGateVp",
    "intradayGateOrderFlow",
    "intradayOfKillzoneMode",
    "intradayOfRequireKeyLevel",
    "intradayOfRequireConfirmation",
    "intradayOfMinStackBars",
    "intradayOfMinConfluence",
    "intradayOfUseOrderBook",
    "intradayOfAllowProxy",
    "intradayOfLevelProximityPct",
    "intradayOfDivergenceLookback",
    "intradayOfAbsorptionVolMult",
    "intradayOfAbsorptionRangeAtrMult",
    "intradayOfStackDeltaRatio",
    "intradayOfBookImbalanceMin",
    "intradayOfSoloMinScore",
    "intradayOfVetoMode",
    "intradayOfMinPartialScore",
    "intradayOfConfluenceMode",
    "intradayOfAllowCvdOnly",
    "intradayOfRequirePremiumDiscount",
    "intradayOfTp1Enabled",
    "intradayOfTp2Enabled",
    "intradayOfPartialFrac",
    "intradayOfMinRr",
    "intradayOfBreakevenAfterPartial",
    "intradayOfApproachLookback",
    "intradayOfEntryAtSignalClose",
    "intradayOfExitOnDeltaAgainst",
    "intradayOfExitGraceBars",
    "intradayOfExitMinDeltaRatio",
    "intradayOfMaxHoldBars",
    "intradaySmcUseOrderFlow",
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
    "intradaySmcLookbackBars",
    "intradaySmcBosMaxBars",
    "intradaySmcChochMaxBars",
    "intradaySmcEntryZoneMode",
    "intradaySmcRequireFvgRetrace",
    "intradaySmcKillzoneMode",
    "intradaySmcMinAdx",
    "intradaySmcHtfStrictness",
    "intradaySmcHtfBiasMode",
    "intradaySmcRequireHtfBias",
    "intradaySmcChochStrict",
    "intradaySmcRequirePremiumDiscount",
    "intradaySmcPremiumDiscountOte",
    "intradaySmcDealingRangeLookback",
    "intradaySmcMaxBarsAfterReclaim",
    "intradaySmcChochRequireTrend",
    "intradaySmcDisplacementBodyMult",
    "intradaySmcDisplacementAtrMult",
    "intradaySmcSlMode",
    "intradaySmcMinRr",
    "intradaySmcMaxTpRr",
    "intradaySmcMaxHoldBars",
    "intradaySmcTp2Mode",
    "intradaySmcFvgEntryMode",
    "intradaySmcRegimeFilterEnabled",
    "intradaySmcRegimeAtrPctMin",
    "intradaySmcRegimeAtrPctMax",
    "supertrendFuturesUseFixedSl",
    "supertrendFuturesUseFixedTp",
    "intradayLiqMaxTpRr",
    "intradaySrAPlusMode",
    "intradaySrMinVolRatio",
    "intradaySrMinHtfSep",
    "intradaySrZoneWidthPct",
    "intradaySrBosMaxBarsAfterReclaim",
    "intradaySrRequireBos",
    "intradaySrRequireConfirm",
    "intradayLiqStrictMode",
    "intradayLiqMinScore",
    "intradayLiqMinRr",
    "intradayLiqFirstCycleOnly",
    "intradayLiqMinReclaimClosePct",
    "intradayLiqMinReclaimBodyRatio",
    "intradayLiqMaxSlPct",
    "intradayLiqMaxSweepBars",
    "intradayLiqMinSweepExtensionPct",
    "intradayLiqSessionExtreme",
    "intradayLiqSessionExtremeMinExtensionPct",
    "intradayLiqSessionExtremeMinTouches",
    "intradayLiqOnePickPerDay",
    "intradayLiqMaxFadeDayRangePct",
    "intradayLiqPostDisplacementCooldownBars",
    "intradayLiqDisplacementBarAtrMult",
    "intradayLiqRequireHtfAlign",
    "intradayLiqMinHtfSep",
    "intradayLiqPartialTp",
    "intradayLiqTp1Enabled",
    "intradayLiqTp2Enabled",
    "intradayLiqPartialFrac",
    "intradayLiqTp1Rr",
    "intradayLiqTp2Rr",
    "intradayLiqTp2PartialFrac",
    "intradayLiqBreakevenAfterPartial",
    "intradayLiqMitigationEntry",
    "intradayLiqMitigationWaitBars",
    "intradayLiqMitigationFrac",
    "intradayLiqLevelRebreakExitBars",
    "intradayTierMode",
    "srIntradayMaxTradesPerDay",
    "srIntradayMinBarGap",
    "srIntradaySweepPct",
    "srIntradayMinScore",
    "intradayLiqMaxTradesPerSidePerDay",
    "intradayLiqTrendContinuation",
    "intradayLiqVetoCounterTrend",
    "intradayLiqBreakdownDayBias",
    "intradayLiqRequireChoch",
    "intradayLiqChochMaxBars",
    "intradayLiqChochRequireTrend",
    "intradayLiqRequireKillzone",
    "intradayLiqClassicOnTrendDays",
    "intradayLiqTrendOnlyBreakdownDays",
    "intradayLiqTrendFadeEma",
    "intradayLiqTrendMinAdx",
    "intradayLiqTrendMinRvol",
    "intradayLiqTrendFadeMinRvol",
    "intradayLiqTrendMinBarsBeyondLevel",
    "intradayLiqTrendMinDispAtr",
    "intradayLiqTrendRsiMinShort",
    "intradayLiqTrendRsiMaxShort",
    "intradayLiqTrendFadeMinRvol",
    "intradayLiqTrendFadeMinAdx",
    "intradayLiqTrendMinDayRangePct",
    "intradayLiqTrendMinLiqQuality",
    "intradayLiqTrendDisplacementOnly",
    "intradayLiqTrendAtrFallback",
    "intradayLiqTrendAtrTpMult",
    "intradayLiqTrendFadeMaxDayRangePct",
    // Regime-adaptive strategy + risk overlay (so cache invalidates on change).
    "regimeAdaptiveEnableTrend",
    "regimeAdaptiveEnableRange",
    "regimeAdaptiveEnableBreakout",
    "regimeAdaptiveMinGrade",
    "regimeAdaptiveConfidenceFloor",
    "regimeAdaptiveMaxTradesPerDay",
    "regimeAdaptiveMinBarGap",
    "regimeAdaptiveKillzoneMode",
    "regimeAdaptiveTrendRR",
    "regimeAdaptiveRangeRR",
    "regimeAdaptiveBreakoutRR",
    "regimeAdaptiveAtrSlMult",
    "regimeAdaptiveTrendAdx",
    "regimeAdaptiveSqueezePctile",
    "regimeAdaptiveVolatileAtrPct",
    "riskScale",
    "volTargetSizing",
    "volTargetAtrPct",
    "riskKillSwitchDdPct",
    "riskConsecutiveLossLimit",
    "riskWeeklyMaxLossPct",
    "timeframe",
  ];
  return keys.map((k) => `${k}:${JSON.stringify(cfg[k])}`).join("|");
}

export function intradayAdapterCacheKey(candles, cfg, tf) {
  if (!candles?.length) return "";
  const first = candles[0].ts;
  const last = candles[candles.length - 1].ts;
  return `${String(cfg?.symbol ?? "")}:${tf}:${candles.length}:${first}:${last}:${stableCfgSlice(cfg)}`;
}

export function getCachedIntradaySeries(key) {
  if (!key) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit.series;
}

export function setCachedIntradaySeries(key, series) {
  if (!key || !series) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { series, at: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function clearIntradayAdapterCache() {
  cache.clear();
}
