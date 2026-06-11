/**
 * TOKYO_SESSION — BNB 15m overnight hi-sweep fade (ICT Asia liquidity model).
 * Study Jan–Jun 2026: hi sweep → short to pre-Asia low, ~61% WR, +9.5% non-compounded.
 * Run: node scripts/backtest-tokyo-sweep-fade-tune.mjs
 */

export const TOKYO_SESSION_BNB_15M = {
  symbol: "BNBUSDT",
  timeframe: "15m",
  manualStrategy: "TOKYO_SESSION",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2,
  riskPerTradeUnit: "PCT",
  supertrendFuturesAuto: false,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  intradayLiqEntryAtSignalClose: true,

  tokyoSessionStartUtc: 0,
  tokyoSessionEndUtc: 4,
  /** SWEEP_HI_ONLY — fade overnight high sweep; skip first-two follow. */
  tokyoEntryMode: "SWEEP_HI_ONLY",
  /** First 2h — grid tune: maxBar=8 best H1 2026 (+12.7% vs +5.2% @ maxBar=5). */
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
