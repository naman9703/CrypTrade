/** Research preset — 5m HTF-trend RSI bounce scalper (long-only, fast exits). */
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

/** BTC-only — best OOS in Jan–May 2026 research (~+8% IS, 70% WR). */
export const TREND_PULLBACK_BTC_5M_FAST_SCALP = {
  ...TREND_PULLBACK_SCALP_OPTIMIZED,
  symbol: "BTCUSDT",
  universeCustomSymbols: ["BTCUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "SINGLE",
};

/** Multi-coin research preset — not validated profitable as a portfolio. */
export const TREND_PULLBACK_MULTI_5M_FAST_SCALP = {
  ...TREND_PULLBACK_SCALP_OPTIMIZED,
  universeCustomSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
};
