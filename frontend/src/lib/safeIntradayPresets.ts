/**
 * SAFE_INTRADAY — conservative 15m intraday preset.
 * Keep aligned with backend/src/strategy/safeIntraday.js
 */

export const SAFE_INTRADAY_15M_BASE = {
  strategyMode: "MANUAL" as const,
  manualStrategy: "SAFE_INTRADAY",
  marketMode: "FUTURES" as const,
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  eliteStMinAdx: 20,
  eliteStRequireAdxRising: true,
  eliteStMinVolumeVsAvg: 1.5,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStRequireHtf4hAlign: true,
  eliteStRequireAtrExpansion: true,
  eliteStLiqSweepEnabled: false,
  safeIntradayMaxTradesPerDay: 2,
  safeIntradayKillzoneMode: "LONDON_NY",
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND" as const,
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT" as const,
  futuresLeverage: 10,
  maxDailyLoss: 1.5,
  maxDailyLossUnit: "PCT" as const,
  riskKillSwitchDdPct: 8,
  riskConsecutiveLossLimit: 2,
  riskWeeklyMaxLossPct: 4,
};

/** BNB 15m — use with BTC/ETH/LINK/XRP instances for portfolio. */
export const SAFE_INTRADAY_BNB_15M = {
  ...SAFE_INTRADAY_15M_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};
