/**
 * Strategy Config Profile — frontend mirror of backend strategyConfigProfile.js.
 * Keep strategyConfigProfile.data.json in sync with backend copy.
 */

import profileData from "./strategyConfigProfile.data.json" with { type: "json" };

export type ChartMarkupKind = "elite" | "smc_ict" | "liquidity" | "tokyo" | "fib" | "none";

export type StrategyProfileDef = {
  label: string;
  category: string;
  nativePrefixes?: string[];
  nativeKeys?: string[];
  overlays?: string[];
  prepare?: string;
  chartMarkup: ChartMarkupKind;
  usesIntradayMaxHold?: boolean;
  uiSections?: string[];
};

const BASELINE_STRATEGIES = new Set([
  "CONFLUENCE",
  "EMA_CROSS",
  "RSI_MEAN",
  "BREAKOUT_VOL",
  "MOMENTUM_SURGE",
  "ENSEMBLE",
  "TREND_PULLBACK",
  "HTF_RSI",
  "HTF_LEG_RIDER",
  "SMART_REVERSAL",
  "BTC_CONSENSUS",
  "APEX_TREND",
]);

const SHARED_CORE_KEYS = new Set([
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesEntryOpenStyle",
  "supertrendFuturesExitOnFlip",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesMaxEntrySlippagePct",
  "supertrendFuturesMaxSignalLagMs",
  "supertrendFuturesIocFallbackMarket",
  "supertrendFuturesRequireBookTicker",
  "supertrendFuturesRequireMarkPrice",
  "supertrendFuturesTwoWay",
  "supertrendFuturesEntryRecheckMs",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "futuresTrailingStAdvanced",
  "futuresTrailingStFeeBreakeven",
  "trailBufferMode",
  "trailBufferRate",
  "trailBufferAtrMult",
  "trailOpenFeeRate",
  "trailCloseFeeRate",
  "trailFeeBeMultiplier",
  "trailMaintMarginRate",
  "trailMinGapFromMarkFrac",
  "trailMinSlDistFrac",
  "trailActivationSlippageFrac",
  "trailT01LockSlippageFrac",
  "trailPostT02ActivationBufferRate",
  "trailPostT02MaxExtraTiers",
  "trailPostT02SpacingFrac",
  "trailSizingMode",
  "trailDynamicBeAtrMult",
  "trailDynamicBeT01LockAtrMult",
  "trailDynamicBeRegimeAdjust",
  "trailDynamicBeRegimeLowMult",
  "trailDynamicBeRegimeHighMult",
  "trailDynamicAdvAtrHwmMult",
  "trailDynamicAdvMfeGivebackFrac",
  "trailDynamicAdvMfeMinR",
  "trailDynamicAdvMergeSupertrend",
  "trailDynamicAdvAtrSource",
  "trailDynamicAdvPostT02StepAtrMult",
  "trailingStopExtraScalpingPcts",
  "trailOnlyAfterTp2Fill",
  "futuresLeverage",
  "futuresLeverageMode",
  "aiThreshold",
  "backtestPositionSizing",
  "portfolioPositionSizing",
  "backtestBreakevenAtMfePct",
  "tradeHistoryTakerOpenFeeRate",
  "tradeHistoryTakerCloseFeeRate",
  "tradeHistoryMakerOpenFeeRate",
  "tradeHistoryMakerCloseFeeRate",
  "smartSignalStrengthThreshold",
  "smartSignalStrengthThresholdMeta",
  "capitalSplitAcrossCoins",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "perTradeBudgetCapEnabled",
  "perTradeBudgetInputMode",
  "multiCoinCapitalSizingActive",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
]);

const OVERLAY_GROUPS: Record<string, { prefixes?: string[]; keys?: string[] }> = {
  intelligence: { prefixes: ["intelligenceGate"] },
  marketDecision: { keys: ["marketDecision"] },
  moveQuality: { prefixes: ["supertrendMoveQuality"] },
  bigMove: { prefixes: ["supertrendBigMove"] },
  signalStrength: { prefixes: ["signalStrength"] },
  stConfirmation: { prefixes: ["supertrendConfirmation", "supertrendBreakout"] },
  htf4h: { prefixes: ["supertrendHtf4h"] },
  futuresAiConfidence: { keys: ["supertrendFuturesAiConfidenceFilter", "supertrendFuturesMinAiProb"] },
  surfPulseMl: { prefixes: ["surfPulseMl"] },
  volumeProfileGates: {
    prefixes: ["volumeProfile", "vp", "vpLookback", "vpMinRR", "intradayGateVp", "intradayVp"],
    keys: ["vpLookbackBars", "vpMinRR", "requireVpSetup"],
  },
  intradayGates: { prefixes: ["intraday", "srIntraday"] },
};

const PROFILES = profileData.profiles as Record<string, StrategyProfileDef>;

export function getStrategyProfile(manualStrategy: string | null | undefined): StrategyProfileDef & { key: string } {
  const key = String(manualStrategy ?? "").trim().toUpperCase();
  if (key && PROFILES[key]) return { key, ...PROFILES[key] };
  if (BASELINE_STRATEGIES.has(key)) return { key: "baseline", ...PROFILES.baseline };
  return { key: key || "baseline", ...PROFILES.baseline };
}

function keyMatchesNative(key: string, profile: StrategyProfileDef): boolean {
  for (const prefix of profile.nativePrefixes ?? []) {
    if (key.startsWith(prefix)) return true;
  }
  for (const nk of profile.nativeKeys ?? []) {
    if (key === nk) return true;
  }
  return false;
}

function keyMatchesOverlayGroup(key: string, groupId: string): boolean {
  const group = OVERLAY_GROUPS[groupId];
  if (!group) return false;
  for (const prefix of group.prefixes ?? []) {
    if (key.startsWith(prefix)) return true;
  }
  for (const k of group.keys ?? []) {
    if (key === k) return true;
  }
  return false;
}

/** Check if a persist key is allowed for this strategy (prefix-aware). */
export function profileAllowsKey(key: string, manualStrategy: string | null | undefined): boolean {
  if (SHARED_CORE_KEYS.has(key)) return true;
  const profile = getStrategyProfile(manualStrategy);
  if (keyMatchesNative(key, profile)) return true;
  for (const og of profile.overlays ?? []) {
    if (keyMatchesOverlayGroup(key, og)) return true;
  }
  return false;
}

export function profileHasUiSection(manualStrategy: string | null | undefined, sectionId: string): boolean {
  const profile = getStrategyProfile(manualStrategy);
  return (profile.uiSections ?? []).includes(sectionId);
}

export function profileUsesIntradayMaxHold(manualStrategy: string | null | undefined): boolean {
  return getStrategyProfile(manualStrategy).usesIntradayMaxHold === true;
}

export function profileChartMarkup(manualStrategy: string | null | undefined): ChartMarkupKind {
  return getStrategyProfile(manualStrategy).chartMarkup ?? "none";
}

export function filterBotForProfile(
  bot: Record<string, unknown>,
  manualStrategy: string | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bot)) {
    if (profileAllowsKey(key, manualStrategy)) out[key] = value;
  }
  return out;
}

export function strategyTypeLabel(manualStrategy: string | null | undefined): string {
  return getStrategyProfile(manualStrategy).label;
}

export function exportProfileMetadata() {
  return profileData;
}
