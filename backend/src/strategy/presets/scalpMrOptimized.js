/**
 * SCALP_MR presets — research / experimental.
 *
 * Honest status: on BNB 5m with realistic fees, no config yet passes
 * WR + return + low-DD gates together. No certified deployable fallback in-repo.
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

  scalpMrBbPeriod: 20,
  scalpMrBbMult: 2,
  scalpMrRsiPeriod: 14,
  scalpMrRsiBuyMax: 36,
  scalpMrRsiSellMin: 64,
  scalpMrMaxAdx: 20,
  scalpMrMinAtrPct: 0.08,
  scalpMrMaxAtrPct: 0.5,
  scalpMrMinVolVsAvg: 1.1,
  scalpMrVolLookback: 20,
  scalpMrRangeRR: 1.35,
  scalpMrSlMode: "entry_atr",
  scalpMrAtrSlMult: 0.75,
  scalpMrMinRr: 1.25,
  scalpMrMinTpPct: 0.22,
  scalpMrMinReclaimAtr: 0.18,
  scalpMrRequireConfirmCandle: true,
  scalpMrRequireHtfAlign: true,
  scalpMrTwoBarReclaim: true,
  scalpMrMaxBbWidthPct: 1.6,
  scalpMrMinBbWidthPct: 0.4,
  scalpMrMaxTradesPerDay: 4,
  scalpMrMinBarGap: 6,
  scalpMrKillzoneMode: "LONDON_NY",

  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: true,
  scalpMrUsePartialTp: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "OFF",
  riskConsecutiveLossLimit: 2,
  maxDailyLoss: 1.5,
  maxDailyLossUnit: "PCT",
};

/** Research preset — HTF pullback fade gates (strict; few trades). */
export const SCALP_MR_BNB_5M = {
  ...SCALP_MR_5M_BASE,
  symbol: "BNBUSDT",
  scalpMrRequireHtfAlign: false,
  scalpMrTwoBarReclaim: false,
  scalpMrRsiBuyMax: 40,
  scalpMrRsiSellMin: 60,
  scalpMrMaxAdx: 25,
  scalpMrMinRr: 1.35,
  scalpMrAtrSlMult: 0.8,
  scalpMrMinTpPct: 0.18,
  scalpMrMaxBbWidthPct: 2.2,
  scalpMrMinBbWidthPct: 0.2,
  scalpMrRequireConfirmCandle: false,
  scalpMrMaxTradesPerDay: 6,
  scalpMrMinBarGap: 4,
};

/** Not validated — do not deploy live without fresh OOS pass. */
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
  scalpMrMinAtrPct: 0.05,
  scalpMrMaxAtrPct: 0.42,
  scalpMrMinVolVsAvg: 1.15,
};

export const SCALP_MR_ETH_5M = {
  ...SCALP_MR_5M_BASE,
  symbol: "ETHUSDT",
  scalpMrMinAtrPct: 0.06,
  scalpMrMaxAtrPct: 0.48,
  scalpMrMinVolVsAvg: 1.12,
};

/** Legacy higher-frequency preset (not recommended without re-validation). */
export const SCALP_MR_BNB_5M_FREQ = {
  ...SCALP_MR_BNB_5M,
  scalpMrRequireHtfAlign: false,
  scalpMrTwoBarReclaim: false,
  scalpMrRsiBuyMax: 42,
  scalpMrRsiSellMin: 58,
  scalpMrMaxAdx: 28,
  scalpMrMinVolVsAvg: 1.0,
  scalpMrRequireConfirmCandle: false,
  scalpMrMaxTradesPerDay: 8,
  scalpMrMinBarGap: 3,
};

export const SCALP_MR_BNB_5M_ALL_SESSION = {
  ...SCALP_MR_BNB_5M_FREQ,
  scalpMrKillzoneMode: "ALL",
  intradaySmcKillzoneMode: "ALL",
  intradaySmcKillzoneEnabled: false,
};

export const SCALP_MR_15M_BASE = {
  ...SCALP_MR_5M_BASE,
  timeframe: "15m",
  scalpMrHtfBarsPerHour: 4,
  scalpMrMinBarGap: 4,
  scalpMrMinAtrPct: 0.1,
  scalpMrMaxAtrPct: 0.65,
};

export const SCALP_MR_BNB_15M = {
  ...SCALP_MR_15M_BASE,
  symbol: "BNBUSDT",
};
