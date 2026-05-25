/**
 * VOLUME_PROFILE — selective Tier-A VP setups (LVN vacuum + VA breakouts).
 * Backtest: npm run backtest:volume-profile -- BNBUSDT 15m
 */

/** Shared production tuning (BNB 15m ~+14.5% / 5mo; BTC 15m ~+28% / 5mo in research). */
/** Regime immunity — blocks counter-trend / fake VA breakouts (H2 2025 trap pattern). */
export const VP_REGIME_IMMUNITY = {
  vpRegimeImmunity: true,
  vpMaxPriorTrendPct: 0.012,
  vpPriorTrendLookback: 16,
  vpBuyBreakoutMinHtfSep: 0.004,
  vpBuyRelaxedMinHtfSep: 0.0035,
  vpBuyHighPathMinPct: 0.012,
  vpSellBreakdownMinHtfSep: 0.0035,
};

export const VOLUME_PROFILE_PRODUCTION = {
  vpTierAOnly: true,
  vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown"],
  vpMinScore: 12,
  vpMinRR: 2,
  vpMinAdx: 24,
  vpMinHtfSepPct: 0.0035,
  vpMinCloseBeyondPct: 0.0025,
  vpMaxTradesPerDay: 2,
  vpMinBarGap: 12,
  vpBreakoutMinVolRatio: 1.6,
  vpValBreakdownMinVolRatio: 1.6,
  vpBreakoutMinPathPct: 0.007,
  vpLvnSizeMult: 2,
  ...VP_REGIME_IMMUNITY,
};

export const VOLUME_PROFILE_BASE = {
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  marketMode: "FUTURES",
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
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
  minLvnRunPct: 0.01,
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
  vpLvnMinVolRatio: 1.15,
  vpMinWickRatio: 0.32,
  vpMaxSlPct: 0.008,
  vpMaxTpPct: 0.028,
  supertrendFuturesFixedSlPct: 0.004,
  supertrendFuturesFixedTpPct: 0.014,
};

/** Primary — optimized BNB 15m */
export const VOLUME_PROFILE_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/** Alias — same production tuning (legacy UI label) */
export const VOLUME_PROFILE_TIER_A_15M = {
  ...VOLUME_PROFILE_15M,
};

/** More signals (~1/mo) — targets ~80% WR; allows slightly weaker HTF trend */
export const VOLUME_PROFILE_BALANCED_15M = {
  ...VOLUME_PROFILE_15M,
  vpMinHtfSepPct: 0.0032,
  vpMinScore: 11,
};

export const VOLUME_PROFILE_BTC_15M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BTCUSDT",
  timeframe: "15m",
};

/** Slightly more signals on 5m — still Tier-A only */
export const VOLUME_PROFILE_5M = {
  ...VOLUME_PROFILE_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  vpLookbackBars: 288,
  vpMinBarGap: 18,
  vpMinScore: 11,
  vpMaxTradesPerDay: 2,
};
