/**
 * Tokyo Session preset for UI / backtest.
 */
export const TOKYO_SESSION_15M_BASE = {
  timeframe: "15m",
  manualStrategy: "TOKYO_SESSION",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2,
  riskPerTradeUnit: "PCT",
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  intradayLiqEntryAtSignalClose: true,
  tokyoSessionStartUtc: 0,
  tokyoSessionEndUtc: 4,
  tokyoEntryMode: "SWEEP_HI_ONLY",
  tokyoSweepMaxBarIdx: 8,
  tokyoMinPreAsiaWidthPct: 0.004,
  tokyoHiSweepOnlyDays: true,
  tokyoSweepTpTarget: "PRE_LOW",
  tokyoDirMode: "BOTH_BODY",
  tokyoSlMode: "DYNAMIC",
  tokyoTpMode: "DYNAMIC",
  tokyoSlBufferPct: 0.0015,
  tokyoSlMinPct: 0.004,
  tokyoSlMaxPct: 0.012,
  tokyoTpMinPct: 0.005,
  tokyoPartialTp: false,
  tokyoMaxTradesPerDay: 1,
  tokyoMinFirst2RangePct: 0,
  tokyoSkipMixedBodies: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  trailingStopLossAuto: false,
};

export const TOKYO_SESSION_BNB_15M = {
  ...TOKYO_SESSION_15M_BASE,
  symbol: "BNBUSDT",
};
