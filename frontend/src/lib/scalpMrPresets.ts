/**
 * SCALP_MR presets for UI / backtest (v2 HTF-aligned).
 */
export const SCALP_MR_5M_BASE = {
  timeframe: "5m",
  manualStrategy: "SCALP_MR",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  scalpMrRsiBuyMax: 36,
  scalpMrRsiSellMin: 64,
  scalpMrMaxAdx: 20,
  scalpMrSlMode: "entry_atr",
  scalpMrAtrSlMult: 0.75,
  scalpMrMinRr: 1.25,
  scalpMrMinTpPct: 0.22,
  scalpMrRequireHtfAlign: true,
  scalpMrTwoBarReclaim: true,
  scalpMrRequireConfirmCandle: true,
  scalpMrMaxTradesPerDay: 4,
  scalpMrMinBarGap: 6,
  scalpMrKillzoneMode: "LONDON_NY",
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  intradayLiqPartialTp: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "OFF",
  riskConsecutiveLossLimit: 2,
};

export const SCALP_MR_BNB_5M = {
  ...SCALP_MR_5M_BASE,
  symbol: "BNBUSDT",
};

export const SCALP_MR_BNB_5M_OPTIMIZED = {
  ...SCALP_MR_BNB_5M,
};

export const SCALP_MR_BNB_5M_LONG = {
  ...SCALP_MR_BNB_5M,
  scalpMrTradeSides: "LONG",
};

export const SCALP_MR_BTC_5M = {
  ...SCALP_MR_5M_BASE,
  symbol: "BTCUSDT",
};

export const SCALP_MR_ETH_5M = {
  ...SCALP_MR_5M_BASE,
  symbol: "ETHUSDT",
};

export const SCALP_MR_BNB_5M_FREQ = {
  ...SCALP_MR_BNB_5M,
  scalpMrRequireHtfAlign: false,
  scalpMrTwoBarReclaim: false,
  scalpMrMaxTradesPerDay: 8,
  scalpMrMinBarGap: 3,
};
