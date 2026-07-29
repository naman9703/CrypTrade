/**
 * LIQ_CASCADE presets for UI / backtest.
 */
export const LIQ_CASCADE_1M_BASE = {
  timeframe: "1m",
  manualStrategy: "LIQ_CASCADE",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  liqCascadeInterval: "5min",
  liqCascadeZScoreMin: 2.0,
  liqCascadeLookbackBars: 48,
  liqCascadeWindowBars: 3,
  liqCascadeMinDispAtr: 1.0,
  liqCascadeMinOiDropPct: 0.12,
  liqCascadeDirectionMode: "fade",
  liqCascadeMaxTradesPerDay: 8,
  liqCascadeMinBarGap: 2,
  liqCascadeMaxHoldBars: 24,
  liqCascadeLiveTickEnabled: false,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: true,
};

export const LIQ_CASCADE_BTC_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "ETHUSDT",
};

export const LIQ_CASCADE_BNB_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "BNBUSDT",
  liqCascadeZScoreMin: 1.8,
  liqCascadeMinLiqUsdBar: 30_000,
};

export const LIQ_CASCADE_PORTFOLIO_1M = {
  ...LIQ_CASCADE_BTC_1M,
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
};

/** Live tick executor enabled — paper/testnet only by default. */
export const LIQ_CASCADE_BTC_1M_LIVE_TICK = {
  ...LIQ_CASCADE_BTC_1M,
  liqCascadeLiveTickEnabled: true,
};
