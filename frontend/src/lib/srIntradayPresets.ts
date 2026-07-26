/** SR_INTRADAY / INTRADAY_PRO — sync with backend presets */

export const INTRADAY_PRO_BASE = {
  strategyMode: "MANUAL" as const,
  manualStrategy: "SR_INTRADAY",
  marketMode: "FUTURES" as const,
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND" as const,
  supertrendFuturesExitOnFlip: false,
  supertrendHtf4hEnabled: true,
  supertrendHtf4hPeriod: 10,
  supertrendHtf4hMultiplier: 3,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL" as const,
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT" as const,
  slippagePct: 0.0005,
  supertrendFuturesFixedSlPct: 0.0035,
  supertrendFuturesFixedTpPct: 0.01,
  srIntradayMaxTradesPerDay: 5,
  srIntradayMinBarGap: 4,
  srIntradayMinScore: 8,
  intradaySoloGateMinScore: 5,
  intradayFibStrictMode: true,
  intradayFibConfirmNextBar: true,
  intradayFibAllowedRatios: [0.5, 0.618],
  intradayFibMinScore: 8,
  srIntradaySessionStartHour: 7,
  srIntradaySessionEndHour: 22,
  intradayMinTechniqueCount: 3,
  intradayRequireSessionReclaim: true,
  intradayRequireFibOrVp: true,
  intradayLearnedRulesEnabled: true,
  intradayBigMoveMinScore: 11,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayGateFib: true,
  intradayGateVp: true,
  intradayGateOrderFlow: true,
  intradayGateHtfRegime: true,
};

/** Primary preset — veto stack blocks loss clusters */
export const INTRADAY_PRO_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/** Fib gate only — retrace-coherent 0.5/0.618 + autopsy vetoes + BE @ 0.15% MFE */
export const INTRADAY_PRO_FIB_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateLiquidity: false,
  intradayGateSession: false,
  intradayGateFib: true,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayFibStrictMode: true,
  intradayFibAllowedRatios: [0.618],
  intradayFibRequireRetraceCoherence: true,
  intradayFibGoldenRetraceMin: 0.55,
  intradayFibGoldenRetraceMax: 0.68,
  intradayFibLearnedRulesEnabled: true,
  intradayFibMinRetraceRatio: 0.55,
  intradayFibMaxRetraceRatio: 0.68,
  intradayFibConfirmNextBar: false,
  intradayFibRequireRsiAlign: false,
  intradayFibRequireHtfAlign: true,
  intradayFibMinWickRatio: 0.4,
  intradayFibMinHtfSep: 0.00065,
  intradayFibMinAdx: 20,
  intradayFibMinLegAtrMult: 2.5,
  intradayFibMaxBarsSinceSwing: 18,
  intradayFibTolPct: 0.0014,
  intradayFibTpMode: "extension",
  intradayFibExtensionFrac: 0.618,
  intradayFibMinRr: 1.5,
  intradayFibMinScore: 8,
  intradayRequireFibOrVp: false,
  intradayRequireSessionReclaim: false,
  intradayMinTechniqueCount: 1,
  intradayTierMode: "all",
  srIntradayMinScore: 8,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 4,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  backtestBreakevenAtMfePct: 0,
  intradayFibEntryAtSignalClose: true,
};

/** Volume Profile — POC/HVN/LVN gates + structure SL/TP at next HVN */
export const INTRADAY_PRO_VP_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateVp: true,
  intradayVpBrackets: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  intradayLvnSizeMult: 2,
  vpLookbackBars: 672,
  vpMinRR: 1.35,
  vpMinRunPct: 0.003,
  requireVpSetup: false,
  srIntradayMinScore: 9,
};

/** LIQ solo — PDH/PDL sweep+reclaim (strict classical) */
export const INTRADAY_PRO_LIQ_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateLiquidity: true,
  intradayGateSession: false,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  /** Explicit — draft merge must not leave a prior SMC/ICT path on. */
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  intradayGateInstitutionalSr: false,
  intradaySrAPlusMode: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayLiqStrictMode: true,
  intradayLiqMinScore: 6,
  intradayLiqMinRr: 1.5,
  intradayLiqRejectSameBarReclaim: true,
  intradayLiqMinReclaimBodyRatio: 0.35,
  intradayLiqMinSweepExtensionPct: 0.008,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqOnePickPerDay: true,
  intradayLiqRequireHtfAlign: true,
  intradayLiqMaxTpRr: 5,
  srIntradayMaxTradesPerDay: 3,
  intradayMinTechniqueCount: 1,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  intradayLiqUseEntryScore: true,
  intradayLiqMinEntryScore: 52,
  intradayLiqReclaimHoldBars: 1,
  /** Classical PDH/PDL reclaim — not LIQ_DAILY trend-router (that preset sets true). */
  intradayLiqBreakdownDayBias: false,
};

/**
 * LIQ_CORE — concept-only classical rebuild (docs/LIQ_CORE_PLAYBOOK.md).
 * Chronological picks; PDH/PDL + session extremes; no body/score/V2 stacks.
 */
export const INTRADAY_PRO_LIQ_CORE_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqPlaybook: "LIQ_CORE",
  intradayLiqPickMode: "chronological",
  intradayLiqOnePickPerDay: false,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 3,
  intradayLiqRejectSameBarReclaim: false,
  intradayLiqMinReclaimBodyRatio: 0,
  intradayLiqMinReclaimClosePct: 0,
  intradayLiqMinSweepExtensionPct: 0,
  intradayLiqMinRr: 1,
  intradayLiqRequireHtfAlign: false,
  intradayLiqUseEntryScore: false,
  intradayLiqUseEntryScoreV2: false,
  intradayLiqMinEntryScore: 0,
  // Path confirm (P1): wait 2 bars after reclaim — mild PF lift, freq intact; still EDGE FAIL.
  intradayLiqReclaimHoldBars: 2,
  intradayLiqRequireChoch: false,
  intradayLiqMarketStateGate: false,
  intradayLiqDaySituationBias: false,
  intradayLiqContinuationGate: false,
  intradayLiqSweepQualityGate: false,
  intradayLiqBreakdownDayBias: false,
  intradayLiqMaxTradesPerSidePerDay: 2,
  srIntradayMaxTradesPerDay: 4,
  srIntradayMinBarGap: 2,
  intradayLiqMaxHoldBars: 48,
  // Closer structural TP (T1) + no early TP1 partial (X4). Dead-trade off (REJECT on CORE).
  intradayLiqMaxTpRr: 2,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
};

export const INTRADAY_PRO_LIQ_CORE_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  symbols: ["BNBUSDT", "ETHUSDT", "BTCUSDT"],
};

/** BNB LIQ AST+vol15 research sleeve — asia+london, PDH/PDL-only; low freq. */
export const INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqSessionNarratives: ["asia_accum", "london_sweep"],
  srIntradaySessionStartHour: 0,
  srIntradaySessionEndHour: 24,
  intradayLiqSessionExtreme: false,
  intradayLiqRequireSameBarReclaim: true,
  intradayLiqDaySituationBias: true,
  intradayLiqMaxSlPct: 0.008,
  intradayLiqRequirePremiumDiscountAlign: true,
  intradayLiqSweepMinVolRatio: 1.5,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/** BNB LIQ prepared-mit research sleeve — disp+minSl+mitigation+toxic; ~1.5/wk. */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.5,
  intradayLiqMitigationWaitBars: 6,
  intradayLiqDaySituationBias: true,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/** BNB prepared-mit return-max — hours 0–20 + mitFrac 0.35. */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_H020_15M = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M,
  intradayLiqMitigationFrac: 0.35,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
};

/** BNB prepared-mit freq-restore — one-sided buy_breakdown + mit 0.30 / h020. */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.3,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
  intradayLiqDaySituationBias: "buy_breakdown",
  // Compressed-regime stand-down — see 2026-07-25-liq-bnb-buybd-compression-standdown.md
  intradayLiqRangeCompressionMin: 0.75,
  // Strong-trend stand-down — see 2026-07-25-liq-bnb-buybd-nevergreen-maxadx.md
  intradayLiqMaxAdx: 50,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/** BNB prepared-mit sell_breakout return-max cousin — disp 1.1. */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_SELLBO_15M = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  intradayLiqDaySituationBias: "sell_breakout",
  intradayLiqMitigationFrac: 0.35,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqSweepDisplacementMinAtrMult: 1.1,
};

export const INTRADAY_PRO_LIQ_CORE_SIGNATURE_KEYS = [
  "intradayLiqPlaybook",
  "intradayLiqPickMode",
  "intradayLiqOnePickPerDay",
  "intradayLiqSessionExtreme",
  "intradayLiqRejectSameBarReclaim",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqMinRr",
  "intradayLiqUseEntryScore",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqMaxTpRr",
  "intradayLiqReclaimHoldBars",
];

/**
 * BTC 15m — research-promoted PDH/PDL sweep+reclaim (BTC-only).
 * Loser autopsy: skip breakdown/breakout-day fades + require CHoCH after sweep + killzone.
 * Research-grade — not validation-gate approved; beats multi-coin LIQ portfolio.
 */
export const INTRADAY_PRO_LIQ_BTC_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "BTCUSDT",
  timeframe: "15m",
  riskPerTrade: 2,
  intradayLiqPdhPdlOnly: true,
  intradayLiqSessionExtreme: false,
  intradayLiqBreakdownDayBias: true,
  intradayLiqDaySituationBias: true,
  intradayLiqMarketStateGate: false,
  intradayLiqRequireKillzone: false,
  /** CHoCH gate gave 0 trades on 2025 BTC window — off until re-tuned. */
  intradayLiqRequireChoch: false,
  intradayLiqChochRequireTrend: false,
  intradayLiqChochMaxBars: 12,
  intradayLiqOnePickPerDay: true,
  srIntradayMaxTradesPerDay: 2,
};

/** Keys that identify the BTC liq preset in the UI (subset — not full patch equality). */
export const INTRADAY_PRO_LIQ_BTC_15M_SIGNATURE_KEYS = [
  "symbol",
  "timeframe",
  "intradayLiqBreakdownDayBias",
  "intradayLiqPdhPdlOnly",
  "intradayLiqDaySituationBias",
] as const;

/**
 * BNB + BTC liquidity sweep portfolio (validated subset — see backend preset notes).
 * ~2%/month realistic at 3.5% risk/coin; not 30–50%/month.
 */
export const INTRADAY_PRO_LIQ_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  riskPerTrade: 3.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "BTCUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/** FREQ_EDGE — classical fade only; trend continuation off; breakdown veto on. */
export const LIQ_FREQ_EDGE_CORE = {
  intradayLiqPlaybook: "FREQ_EDGE",
  intradayLiqTrendContinuation: false,
  intradayLiqClassicEnabled: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqVetoCounterTrend: true,
} as const;

export const INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...LIQ_FREQ_EDGE_CORE,
  intradayLiqBreakdownDayBias: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqPartialTp: true,
  intradayLiqSessionExtreme: false,
};

export const INTRADAY_PRO_LIQ_FREQ_EDGE_SIGNATURE_KEYS = [
  "intradayLiqPlaybook",
  "intradayLiqTrendContinuation",
  "intradayLiqBreakdownDayBias",
  "universeCustomSymbols",
] as const;

/** Keys that identify the ETH liq preset in the UI (subset — not full patch equality). */
export const INTRADAY_PRO_LIQ_ETH_15M_SIGNATURE_KEYS = [
  "symbol",
  "timeframe",
  "intradayLiqMinRr",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqRequireHtfAlign",
  "intradayLiqVetoCounterTrend",
  "intradayLiqMaxTpRr",
  "intradayLiqMinQuality",
  "intradayLiqAllowTrailOnlyExit",
  "trailingStopLossAuto",
  "trailOnlyAfterTp2Fill",
] as const;

/** True when bot/view cfg matches a preset on signature fields (for active preset styling). */
export function presetMatchesBot(
  preset: Record<string, unknown>,
  bot: Record<string, unknown> | null | undefined,
  keys: readonly string[] = Object.keys(preset),
): boolean {
  if (!bot || typeof bot !== "object") return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(preset, key)) continue;
    const a = preset[key];
    const b = bot[key];
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > 1e-9) return false;
      continue;
    }
    if (a !== b) return false;
  }
  return true;
}

/** ETH 15m — classical SWEEP_RECLAIM fade + context-score trail exit */
export const INTRADAY_PRO_LIQ_ETH_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "ETHUSDT",
  timeframe: "15m",
  riskPerTrade: 3.5,
  srIntradaySweepPct: 0.001,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 0,
  intradayLiqMinReclaimBodyRatio: 0.35,
  intradayLiqMinReclaimClosePct: 0.0002,
  intradayLiqMinScore: 5,
  intradayLiqMinQuality: 0,
  intradayLiqRequireHtfAlign: false,
  intradayLiqVetoCounterTrend: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqEntryMode: "fade",
  intradayLiqPdhPdlOnly: false,
  intradayLiqMinAdx: 0,
  intradayLiqMaxAdx: 0,
  intradayLiqMaxTpRr: 3.35,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 2,
  intradayLiqSessionExtremeMinExtensionPct: 0.001,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  trailOnlyAfterTp2Fill: false,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  intradayLiqMaxHoldBars: 200,
  intradayLiqMaxFadeDayRangePct: 0.06,
  intradayLiqPostDisplacementCooldownBars: 4,
  intradayLiqDisplacementBarAtrMult: 2,
  intradayLiqRequireSweepDisplacement: false,
  intradayLiqTrailRequireDisplacement: false,
  intradayLiqSweepDisplacementMinAtrMult: 0,
  intradayLiqRequirePostReclaimDisplacement: false,
  intradayLiqPostReclaimDispAtrMult: 0.6,
  intradayLiqMinSweepPokeWickRatio: 0.2,
  intradayLiqSweepMinVolRatio: 0.9,
  intradayLiqSweepQualityGate: false,
  intradayLiqMaxSweepAttempts: 3,
  intradayLiqMaxAbsorptionProxy: 0.7,
  intradayLiqUseEntryScore: false,
  intradayLiqTrailUseContextScore: true,
  intradayLiqMinEntryScore: 38,
  intradayLiqReclaimHoldBars: 0,
  backtestTrailMicroTf: "5m",
};

export const INTRADAY_PRO_LIQ_FREQ_EDGE_ETH_15M = {
  ...INTRADAY_PRO_LIQ_ETH_15M,
  ...LIQ_FREQ_EDGE_CORE,
};

export const INTRADAY_PRO_LIQ_FREQ_EDGE_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "ETHUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/** LIQ + VP proximity — fast path; sweep level must be near VP structure. */
export const LIQ_VP_PROXIMITY_CORE = {
  intradayLiqPlaybook: "LIQ_VP_PROXIMITY",
  intradayLiqVpProximityMaxPct: 0.0015,
  volumeProfileEnabled: true,
  vpProfileMode: "rolling",
  vpLookbackBars: 384,
  vpVolumeDistribute: "close_weighted",
  vpIncludePriorSession: true,
  vpEnableNakedPoc: true,
  vpValueAreaPct: 0.7,
} as const;

export const INTRADAY_PRO_LIQ_VP_PROXIMITY_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...LIQ_VP_PROXIMITY_CORE,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "ETHUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

export const INTRADAY_PRO_LIQ_VP_PROXIMITY_SIGNATURE_KEYS = [
  "intradayLiqPlaybook",
  "intradayLiqVpProximityMaxPct",
  "universeCustomSymbols",
] as const;

/**
 * Full patch for Apply + Save — ensures routing/gates match the ETH LIQ solo engine.
 * Spreads preset defaults; backend materialization enforces them again at backtest time.
 */
/** Clear SMC / institutional S/R keys so a LIQ solo preset does not inherit stale engine fields. */
const LIQ_SOLO_STALE_ENGINE_CLEAR: Record<string, unknown> = {
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  intradayGateInstitutionalSr: false,
  intradaySrAPlusMode: false,
  intradaySrRequireBos: false,
  intradaySrRequireConfirm: false,
  intradaySrRequireVolume: false,
  intradaySrRequireHtfTrend: false,
};

/** Full patch for Apply + Save — BNB+ETH FREQ_EDGE portfolio. */
export function buildLiqFreqEdgePortfolioPatch(): Record<string, unknown> {
  return {
    ...INTRADAY_PRO_LIQ_FREQ_EDGE_PORTFOLIO_15M,
    ...LIQ_SOLO_STALE_ENGINE_CLEAR,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  };
}

/** Full patch for Apply + Save — BNB+ETH LIQ+VP proximity portfolio. */
export function buildLiqVpProximityPortfolioPatch(): Record<string, unknown> {
  return {
    ...INTRADAY_PRO_LIQ_VP_PROXIMITY_PORTFOLIO_15M,
    ...LIQ_SOLO_STALE_ENGINE_CLEAR,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  };
}

export function buildEthLiqPresetApplyPatch(): Record<string, unknown> {
  return {
    ...INTRADAY_PRO_LIQ_ETH_15M,
    ...LIQ_SOLO_STALE_ENGINE_CLEAR,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  };
}

/** Full patch for Apply + Save — BTC research LIQ solo preset. */
export function buildBtcLiqPresetApplyPatch(): Record<string, unknown> {
  return {
    ...INTRADAY_PRO_LIQ_BTC_15M,
    ...LIQ_SOLO_STALE_ENGINE_CLEAR,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  };
}

/** Situation router — data-driven multi-playbook (year study route table) */
export const BNB_SITUATION_ROUTER_15M = {
  symbol: "BNBUSDT",
  timeframe: "15m",
  strategyMode: "MANUAL" as const,
  manualStrategy: "SITUATION_INTRADAY",
  marketMode: "FUTURES" as const,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL" as const,
  riskPerTrade: 2,
  riskPerTradeUnit: "PCT" as const,
  situationMaxTradesPerDay: 2,
  situationMinBarGap: 4,
  situationMinScore: 7,
  situationMaxLossStreak: 2,
  situationMaxExhaustionPerDay: 2,
  situationExhaustionMinBarsFromOpen: 20,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
};

/** LIQ daily — classical + breakdown-day trend continuation (LH-fade / displacement) */
export const INTRADAY_PRO_LIQ_DAILY_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqTrendContinuation: true,
  intradayLiqTrendOnlyBreakdownDays: true,
  intradayLiqClassicOnTrendDays: false,
  intradayLiqVetoCounterTrend: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqTrendFadeEma: 21,
  intradayLiqTrendMinAdx: 18,
  intradayLiqTrendMinRvol: 1.0,
  intradayLiqTrendFadeMinRvol: 0.65,
  intradayLiqTrendMinBarsBeyondLevel: 2,
  intradayLiqTrendMinDispAtr: 0.4,
  intradayLiqTrendRsiMinShort: 34,
  intradayLiqTrendRsiMaxShort: 55,
};

/** Institutional A+ S/R — HTF trend + zones + sweep + BOS + confirmation + volume */
export const INTRADAY_PRO_SR_APLUS_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradaySrAPlusMode: true,
  intradayGateInstitutionalSr: true,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayGateHtfRegime: true,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayLiqStrictMode: true,
  intradayLiqMinScore: 6,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 2.0,
  intradaySrMinVolRatio: 1.15,
  intradaySrRequireBos: true,
  intradaySrRequireConfirm: true,
  intradaySrRequireVolume: true,
  intradaySrRequireHtfTrend: false,
  intradaySrMinHtfSep: 0.0004,
  intradaySrZoneWidthPct: 0.002,
  intradaySrBosMaxBarsAfterReclaim: 3,
  intradaySrMinConfirmWick: 0.28,
  intradayLiqOnePickPerDay: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 4,
  srIntradayMinScore: 5,
  intradayMinTechniqueCount: 1,
  intradayRequireSessionReclaim: false,
  intradayRequireFibOrVp: false,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  backtestBreakevenAtMfePct: 0,
};

/** SMC/ICT sweep baseline — BNB 15m Jan–May 2026 (corrected brackets): ~50% WR, negative return. */
export const INTRADAY_PRO_ICT_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  /** Solo SMC gate — all other intraday gates off */
  intradayGateSmcIct: true,
  intradaySmcIctMode: true,
  intradayGateLiquidity: false,
  intradayGateSession: false,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayGateInstitutionalSr: false,
  intradaySrAPlusMode: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayLiqStrictMode: true,
  intradayLiqMinSweepExtensionPct: 0.003,
  intradayLiqMinRr: 1.5,
  intradayLiqSessionExtreme: true,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
  intradayLiqOnePickPerDay: false,
  intradaySmcMinScore: 7,
  intradaySmcIctProfile: "sweep",
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradaySmcChochStrict: false,
  intradaySmcRequireMss: false,
  intradaySmcRequireRetrace: false,
  intradaySmcRequireFvgRetrace: false,
  intradaySmcRequireChoch: false,
  intradaySmcRequireBos: false,
  intradaySmcRequireConfirm: false,
  intradaySmcLookbackBars: 36,
  intradaySmcMinRr: 1.5,
  intradaySmcBosMaxBars: 10,
  intradaySmcChochMaxBars: 10,
  intradaySmcKillzoneMode: "ALL",
  intradaySmcHtfBiasMode: "ema",
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcMinAdx: 12,
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcSlMode: "structure",
  intradaySmcMaxTpRr: 5,
  intradaySmcMaxHoldBars: 48,
  srIntradayMaxTradesPerDay: 5,
  srIntradayMinScore: 7,
  intradayMinTechniqueCount: 1,
  intradayRequireSessionReclaim: false,
  intradayRequireFibOrVp: false,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
};

/** SMC/ICT full stack — BNB 15m Jan–May 2026: ~4 entries, ~75% WR, ~+3.7% @ 2.5% risk (strict ICT). */
export const INTRADAY_PRO_ICT_FULL_15M = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcIctProfile: "full",
  intradaySmcPickMode: "daily_sniper",
  intradaySmcOneTradePerDay: true,
  intradaySmcChochStrict: true,
  intradaySmcRequireMss: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcRequireChoch: true,
  intradaySmcRequireBos: true,
  intradaySmcRequireConfirm: false,
  intradaySmcKillzoneMode: "LONDON_NY",
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "both",
  intradaySmcRequireHtfBias: true,
  intradaySmcRequirePremiumDiscount: true,
  intradaySmcPremiumDiscountOte: false,
  intradaySmcDealingRangeLookback: 48,
  intradaySmcMinAdx: 12,
  intradaySmcMinScore: 8,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqOnePickPerDay: true,
};

/**
 * Frozen research — CHoCH + FVG CE + internal TP2 + minR:R 1.5 + session extreme ON.
 * +0.27R/trade n=11 Jan–May 2026 (pilot only). Deploy at minimal size; do not tune.
 */
export const INTRADAY_PRO_ICT_RESEARCH_15M = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcFvgEntryMode: "midpoint",
  intradaySmcEntryZoneMode: "FVG",
  intradaySmcChochStrict: false,
  intradaySmcTp2Mode: "internal",
  intradaySmcMinRr: 1.5,
  intradayLiqSessionExtreme: true,
};

/** Same frozen stack on 1H — parallel backtest for better PDH/PDL geometry. */
export const INTRADAY_PRO_ICT_RESEARCH_1H = {
  ...INTRADAY_PRO_ICT_RESEARCH_15M,
  symbol: "BNBUSDT",
  timeframe: "1h",
  intradaySmcLookbackBars: 24,
  intradaySmcMaxHoldBars: 72,
  intradaySmcChochMaxBars: 8,
  intradaySmcBosMaxBars: 8,
};

/** Tier-A big moves — session + sweep + CVD + ST trail */
export const INTRADAY_PRO_BIGMOVE_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayTierMode: "A" as const,
  srIntradayMinScore: 10,
  trailingStopLossAuto: true,
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedTpPct: 0,
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendWilderAtr: true,
  backtestBreakevenAtMfePct: 0.004,
};

export const INTRADAY_PRO_5M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  srIntradayMinBarGap: 8,
};

export const SR_INTRADAY_SNIPER_BASE = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_15M = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_5M = INTRADAY_PRO_5M;
export const SR_INTRADAY_BTC_15M = { ...INTRADAY_PRO_15M, symbol: "BTCUSDT" };
export const SR_INTRADAY_TRAIL_15M = INTRADAY_PRO_BIGMOVE_15M;
