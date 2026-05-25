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
