/**
 * CRT + TBS preset for UI / backtest.
 */
export const CRT_TBS_15M_BASE = {
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
  crtChochMaxBars: 8,
  crtMaxTradesPerDay: 2,
  crtMinBarGap: 4,
  crtTradeSides: "LONG",
  crtPremiumDiscountFilter: true,
  crtKillzoneOnTbsBar: true,
  crtRequireEntryBelowEq: true,
  crtMinRrToTp2: 0.5,
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON",
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
  intradayLiqEntryAtSignalClose: true,
};

export const CRT_TBS_BNB_15M = {
  ...CRT_TBS_15M_BASE,
  symbol: "BNBUSDT",
};
