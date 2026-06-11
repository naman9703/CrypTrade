/**
 * CRT + TBS preset — BNB 15m intraday (4H reference candle, LTF TBS entry).
 *
 * ICT flow: TBS on CRT sweep during London → CHoCH within 8 bars → entry.
 * v2 tuning (Jun 2026): London-only killzone + entry-below-EQ + min R:R cuts
 * chase losses while keeping the best risk-adjusted return on BNB.
 *
 * For ~1 trade/day use multi-coin portfolio (see backtest-crt-tbs-portfolio.mjs).
 */

export const CRT_TBS_BNB_15M = {
  symbol: "BNBUSDT",
  timeframe: "15m",
  manualStrategy: "CRT_TBS",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2,
  riskPerTradeUnit: "PCT",

  crtHtfMs: 4 * 60 * 60 * 1000,
  crtSweepPct: 0.0006,
  crtMinTbsWick: 0.32,
  crtMinBodyRatio: 0.25,
  crtMinRangeAtr: 0.4,
  crtMinRangePct: 0.0025,
  crtStructureMode: "choch",
  crtRequireChoch: true,
  crtRequireMss: false,
  crtChochMaxBars: 8,
  crtMaxTradesPerDay: 2,
  crtMinBarGap: 4,
  crtPartialFrac: 0.5,
  crtTradeSides: "LONG",
  crtPremiumDiscountFilter: true,
  crtKillzoneOnTbsBar: true,
  /** Skip longs entered above CRT equilibrium (chase losses). */
  crtRequireEntryBelowEq: true,
  /** Require structural room to CRT high — blocks cramped entries. */
  crtMinRrToTp2: 0.5,

  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON",
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
  intradayLiqEntryAtSignalClose: true,
};

/**
 * Balanced: more trades than v2, still filters chase entries.
 * BNB ~21 trades/yr (+9.4%), portfolio ~0.15 trades/day across 5 coins.
 */
export const CRT_TBS_BNB_15M_BALANCED = {
  ...CRT_TBS_BNB_15M,
  crtMinRrToTp2: 0.3,
  intradaySmcKillzoneMode: "LONDON_NY",
};

/** Higher-frequency preset: CHoCH|BOS, relaxed gates (more trades, lower edge). */
export const CRT_TBS_BNB_15M_FREQ = {
  ...CRT_TBS_BNB_15M_BALANCED,
  crtStructureMode: "choch_or_bos",
  crtRequireEntryBelowEq: false,
  crtMinRrToTp2: 0.3,
  crtMaxTradesPerDay: 3,
  crtMinBarGap: 2,
};

/** Multi-coin portfolio preset — BNB-tuned gates on all symbols. */
export const CRT_TBS_PORTFOLIO_15M = {
  ...CRT_TBS_BNB_15M_BALANCED,
};
