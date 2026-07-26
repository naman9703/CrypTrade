/** VOLUME_PROFILE — standalone strategy presets (sync with backend) */

export const VP_REGIME_IMMUNITY = {
  vpRegimeImmunity: true,
  vpMaxPriorTrendPct: 0.012,
  vpPriorTrendLookback: 16,
  vpBuyBreakoutMinHtfSep: 0.004,
  vpBuyRelaxedMinHtfSep: 0.0035,
  vpBuyHighPathMinPct: 0.012,
  vpSellBreakdownMinHtfSep: 0.0035,
};

export const VOLUME_PROFILE_BASE = {
  strategyMode: "MANUAL" as const,
  manualStrategy: "VOLUME_PROFILE",
  marketMode: "FUTURES" as const,
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL" as const,
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT" as const,
  slippagePct: 0.0005,
  volumeProfileEnabled: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  requireVpSetup: true,
  vpRequireHtfAlign: true,
  vpAllowHvnFlip: false,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown"],
  vpTierAOnly: true,
  intradayVpBrackets: true,
  vpStructureBrackets: true,
  vpLookbackBars: 384,
  vpMinRR: 2,
  vpMinRunPct: 0.01,
  vpMinScore: 12,
  vpMinBarGap: 12,
  vpSessionStartHour: 7,
  vpSessionEndHour: 22,
  vpMinAdx: 24,
  vpMinHtfSepPct: 0.0035,
  vpMinCloseBeyondPct: 0.0025,
  vpMinBreakoutBody: 0.52,
  vpMinBreakoutCloseStrength: 0.62,
  ...VP_REGIME_IMMUNITY,
  vpHardBlockCeilingFloor: false,
  vpLvnSizeMult: 2,
  vpBreakoutMinVolRatio: 1.6,
  vpValBreakdownMinVolRatio: 1.6,
  vpBreakoutMinPathPct: 0.007,
  vpMaxTradesPerDay: 2,
  supertrendFuturesFixedSlPct: 0.004,
  supertrendFuturesFixedTpPct: 0.014,
};

export const VOLUME_PROFILE_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

export const VOLUME_PROFILE_TIER_A_15M = {
  ...VOLUME_PROFILE_15M,
};

export const VOLUME_PROFILE_BALANCED_15M = {
  ...VOLUME_PROFILE_15M,
  vpMinHtfSepPct: 0.0032,
  vpMinScore: 11,
};

/** FREQUENCY — coin-resolved auction funnel (sync backend volumeProfileOptimized.js). */
export const VOLUME_PROFILE_FREQ_CORE = {
  /** Runtime merges resolveVolumeProfileFreqPreset(symbol) entry knobs per leg. */
  vpPlaybook: "FREQ" as const,
  vpTierAOnly: false,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
  vpAllowHvnFlip: false,
  vpRequireHtfAlign: false,
  vpRegimeImmunity: false,
  vpMinAdx: 0,
  vpMinBarVolRatio: 0.45,
  vpMinAtrPct: 0.0006,
  vpMaxAtrPct: 0.06,
  vpMinScore: 8,
  vpMinRR: 1.2,
  vpMinRunPct: 0.003,
  vpMinCloseBeyondPct: 0.0008,
  vpMinBreakoutBody: 0.32,
  vpMinBreakoutCloseStrength: 0.48,
  vpBreakoutMinVolRatio: 1.05,
  vpValBreakdownMinVolRatio: 1.05,
  vpBreakoutMinPathPct: 0.003,
  vpLvnMinVolRatio: 0.95,
  vpMinWickRatio: 0.18,
  vpNearTolPct: 0.0025,
  vpRejectionMinVolRatio: 1.0,
  vpRejectionSpikePct: 0.002,
  vpOutsideVaLookback: 8,
  vpSessionStartHour: 0,
  vpSessionEndHour: 24,
  vpMaxTradesPerDay: 1,
  vpMinBarGap: 4,
  vpMaxSlPct: 0.012,
  vpMaxTpPct: 0.03,
  vpBuyBreakoutMinHtfSep: 0,
  vpBuyRelaxedMinHtfSep: 0,
  vpBuyHighPathMinPct: 0,
  vpSellBreakdownMinHtfSep: 0,
} as const;

/** BNB — legacy funnel preset (superseded by VOLUME_PROFILE_FREQ_BNB_15M for FREQ resolve). */
export const VOLUME_PROFILE_FREQ_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "naked_poc", "val_breakdown"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0025,
  vpMinScore: 7,
  vpMinBreakoutBody: 0.28,
  vpMinBreakoutCloseStrength: 0.45,
  vpBreakoutMinVolRatio: 1.0,
  vpBreakoutMinPathPct: 0.0025,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
};

/** BNB — VAL-short native stack (2026-07-20). See backend preset for doctrine. */
export const VOLUME_PROFILE_FREQ_BNB_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0025,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: false,
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellBlockBull60Extending: true,
  vpValSellBull60ExtendRatio: 0.6,
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
  vpValSellBlockWeakBearVacuum: true,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumValBear: true,
  vpPreparedBlockVacuumVah: false,
  vpValSellBlockFlatPrior60: true,
  vpValSellFlatPrior60LoPct: -0.08,
  vpValSellFlatPrior60HiPct: 0.08,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
  vpNoveltyEnabled: false,
};

/** SOL — VAL + prepared rej bear60 (2026-07-21). Wick 0.40 + HTF 0.20%; see backend doctrine. */
export const VOLUME_PROFILE_FREQ_SOL_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "SOLUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.002,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpRejectionMinWickRatio: 0.4,
  vpNoveltyEnabled: false,
};

/** AVAX — VAL+rej prepared-cell stack (2026-07-22 H4). See backend doctrine. */
export const VOLUME_PROFILE_FREQ_AVAX_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "AVAXUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellBlockWeakBearVacuum: true,
  vpValSellChaseFilter: true,
  vpValSellChaseMaxPrior5dPct: 0.05,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: false,
  vpPreparedBlockVacuumValBear: false,
  vpPreparedBlockCellKeys: [
    "SELL|val_breakdown|bear_trend|vacuum",
    "SELL|val_breakdown|bull_chop|vacuum",
    "SELL|val_breakdown|bear_trend|structured",
    "SELL|val_breakdown|bull_chop|structured",
    "SELL|val_breakdown|bear_trend|tight",
    "SELL|va_rejection|weak_bear|vacuum",
    "BUY|va_rejection|bull_chop|structured",
    "BUY|va_rejection|bull_chop|vacuum",
    "BUY|va_rejection|bull_chop|tight",
  ],
  vpNoveltyEnabled: false,
};

/** ETH — macro-adapt SELL + chop trail + regime-adaptive playbooks (2026-07-16). */
export const VOLUME_PROFILE_FREQ_ETH_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "ETHUSDT",
  timeframe: "15m",
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpSellMacroAdapt: true,
  vpSellMinHtfSepPct: 0.0025,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
  vpSellNonBearMinHtfSepPct: 0.005,
  vpSellBearPrior60dPct: -0.05,
  vpSellWeakBearMinHtfSepPct: 0.005,
  vpSellWeakBearPrior20dFloorPct: -0.1,
  vpBuyChaseFilter: true,
  vpBuyChaseMaxPrior5dPct: 0.08,
  vpVacuumEntryMode: "breakout",
  backtestChopMfeTrail: true,
  backtestChopMfeTrailSides: "SELL",
  backtestChopPriorMs: 60 * 86_400_000,
  backtestChopPriorAbsMax: 0.05,
  backtestChopMfeTrailActivatePct: 0.01,
  backtestChopMfeTrailGivebackFrac: 0.35,
  vpRejectionMinWickRatio: 0.35,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: true,
  vpBuyVacuumBullPriorPct: 0.05,
  vpBuyVacuumPriorLookback: 96 * 60,
  vpBuyVacuumMaxPrior5dPct: 0.01,
  vpBuyVacuumPrior5dLookback: 96 * 5,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"],
  // H1+H2+H3 relative extending-bull60 VAL abstain (lock ~+690%)
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellBlockBull60Extending: true,
  vpValSellBull60ExtendRatio: 0.6,
  // H4 — BUY rej min reclaim body (signal-bar); 21–22 −13%→−3%, lock holds ~+669%
  vpBuyRejectionMinBody: 0.2,
  // H6 — block bull_trend vacuum VAH; keep weak_bear vacuum VAH
  vpBuyBreakoutBlockBullVacuum: true,
  // H5 — residual elevated prior60 weak_bear vacuum VAL (ceil 15%, keeps ~9.5% runner)
  vpValSellBlockWeakBearVacuumHighPrior60: true,
  vpValSellWeakBearVacPrior60Pct: 0.15,
  // Vol-target sizing for Calmar (high-ATR de-risk)
  volTargetSizing: true,
  volTargetAtrPct: 0.005,
  volTargetMinMult: 0.4,
  volTargetMaxMult: 2,
  vpNoveltyEnabled: false,
};

/**
 * DOGE — F3 rej + paying POC cells (2026-07-26). Bleed POC denied.
 * Backend resolve when vpPlaybook=FREQ + DOGEUSDT. Not deploy-certified (tw ~0.21).
 */
export const VOLUME_PROFILE_FREQ_DOGE_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "DOGEUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["va_rejection", "poc_bounce"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 6,
  vpMinBarGap: 1,
  vpMaxTradesPerDay: 2,
  vpRejectionSellBearMinHtfSepPct: 0.005,
  vpBuyRejectionMaxPrior60dPct: 1.0,
  vpMinAtrPct: 0.008,
  vpBuyRejectionMinBody: 0.25,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: false,
  vpPreparedBlockVacuumValBear: false,
  vpPreparedBlockCellKeys: [
    "SELL|poc_bounce|weak_bear|structured",
    "SELL|poc_bounce|bear_trend|tight",
    "SELL|poc_bounce|bull_trend|vacuum",
    "SELL|poc_bounce|bear_trend|structured",
    "BUY|poc_bounce|bull_trend|vacuum",
    "SELL|poc_bounce|bear_trend|vacuum",
  ],
  vpNoveltyEnabled: false,
};

/** BTC — two-sided; prepared-regime abstention + vacuum-cap / short locks (2026-07-17). */
export const VOLUME_PROFILE_FREQ_BTC_15M = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BTCUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.005,
  vpSellMinHtfSepPct: 0.005,
  vpSellMacroAdapt: true,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
  vpSellWeakBearMinHtfSepPct: 0.008,
  vpSellWeakBearPrior20dFloorPct: -0.1,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  vpBuyBreakoutMaxPathPct: 0.02,
  vpBuyBreakoutMaxPathNonBullOnly: true,
  vpBuyVacuumBullPriorPct: 0.05,
  vpBuyVacuumPriorLookback: 96 * 60,
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: true,
  vpPreparedBlockVacuumValBear: true,
  vpPreparedVacuumPathPct: 0.02,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0,
  vpMinScore: 6,
  vpValBreakdownMinVolRatio: 1.0,
  vpMinBreakoutBody: 0.28,
  vpMinBreakoutCloseStrength: 0.45,
  vpMinBarGap: 1,
  vpMaxTradesPerDay: 2,
};

export function resolveVolumeProfileFreqPreset(symbol: string) {
  const sym = String(symbol ?? "").toUpperCase();
  if (sym === "ETHUSDT") return VOLUME_PROFILE_FREQ_ETH_15M;
  if (sym === "BTCUSDT") return VOLUME_PROFILE_FREQ_BTC_15M;
  if (sym === "BNBUSDT") return VOLUME_PROFILE_FREQ_BNB_15M;
  if (sym === "SOLUSDT") return VOLUME_PROFILE_FREQ_SOL_15M;
  if (sym === "AVAXUSDT") return VOLUME_PROFILE_FREQ_AVAX_15M;
  if (sym === "DOGEUSDT") return VOLUME_PROFILE_FREQ_DOGE_15M;
  return VOLUME_PROFILE_FREQ_15M;
}

/** Multi-coin — engine resolves per-symbol entry via vpPlaybook=FREQ. */
export const VOLUME_PROFILE_FREQ_PORTFOLIO_15M = {
  ...VOLUME_PROFILE_FREQ_ETH_15M,
  vpPlaybook: "FREQ" as const,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["ETHUSDT", "BNBUSDT", "BTCUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

export const VOLUME_PROFILE_BTC_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BTCUSDT",
  timeframe: "15m",
};

export const VOLUME_PROFILE_5M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  vpLookbackBars: 288,
  vpMinBarGap: 18,
  vpMinScore: 11,
  vpMaxTradesPerDay: 2,
};
