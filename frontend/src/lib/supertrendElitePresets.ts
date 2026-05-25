/**
 * SUPERTREND_ELITE — validated 1H presets.
 * Keep in sync with backend/src/strategy/presets/supertrendEliteOptimized.js
 */

export const SUPERTREND_ELITE_1H_BASE = {
  strategyMode: "MANUAL" as const,
  manualStrategy: "SUPERTREND_ELITE",
  marketMode: "FUTURES" as const,
  /** Must be off or backtest/live resolves to plain SUPERTREND path. */
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  eliteStRequireHtf4hAlign: true,
  eliteStHtf4hPeriod: 10,
  eliteStHtf4hMultiplier: 3,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStHtf1hMinSep: 0.0003,
  eliteStMinAdx: 0,
  eliteStRequireAdxRising: false,
  eliteStMinVolumeVsAvg: 0,
  eliteStRequireAtrExpansion: false,
  eliteStLiqSweepEnabled: false,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND" as const,
  supertrendFuturesExitOnFlip: true,
  /** Elite uses ST trail exits — fixed brackets destroy WR on 1H. */
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT" as const,
  futuresLeverage: 25,
};

/** BNBUSDT 1H — Jan–May 2026: ~73% WR, 15 trades, +22% (validated) */
export const SUPERTREND_ELITE_BNB_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  symbol: "BNBUSDT",
  timeframe: "1h",
};

/** BTCUSDT 1H — Jan–May 2026: ~64% WR, 11 trades, +62% (validated) */
export const SUPERTREND_ELITE_BTC_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  symbol: "BTCUSDT",
  timeframe: "1h",
};

/** BTCUSDT 1H + ADX≥20 rising — fewer trades, higher selectivity */
export const SUPERTREND_ELITE_BTC_1H_ADX = {
  ...SUPERTREND_ELITE_BTC_1H,
  eliteStMinAdx: 20,
  eliteStRequireAdxRising: true,
  eliteStAdxRisingLookback: 3,
};
