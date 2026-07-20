/**
 * Optimized TREND_PULLBACK scalp preset (research — validate before live).
 * Tuned from Jan–May 2026 multi-coin backtests: long-only, faster exits, tighter SL.
 */
export const TREND_PULLBACK_SCALP_OPTIMIZED = {
  manualStrategy: "TREND_PULLBACK",
  timeframe: "5m",
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 10,
  trailingStopLossAuto: false,
  supertrendFuturesFixedSlPct: 0.005,
  supertrendFuturesFixedTpPct: 0.008,
  trendPullbackLongOnly: true,
  trendPullbackRsiOversold: 23,
  trendPullbackRsiRecoverMin: 37,
  trendPullbackRsiExitLong: 38,
  trendPullbackQuickProfitPct: 0.0012,
  trendPullbackMinProfitPct: 0.0006,
  trendPullbackCooldownBars: 4,
  trendPullbackMaxHoldMin: 45,
};
