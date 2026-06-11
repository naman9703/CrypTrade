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
  supertrendFuturesExitOnFlip: true,
  /** Elite 1H — PERCENT buffer 0.05%; not ATR/post-T02 ladder from ST auto-trade UI. */
  futuresTrailingStAdvanced: true,
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStopMode: "SUPERTREND" as const,
  trailBufferMode: "PERCENT" as const,
  trailBufferRate: 0.0005,
  trailBufferAtrMult: 0,
  trailPostT02ActivationBufferRate: 0,
  trailActivationSlippageFrac: 0,
  trailT01LockSlippageFrac: 0,
  /** Panel defaults: 0.2% SL when enabled; 1.5% TP when trailing is on. */
  supertrendFuturesFixedSlPct: 0.002,
  supertrendFuturesFixedTpPct: 0.015,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
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

/**
 * BTCUSDT 1H — BTC-tuned: 0.08% 1H EMA min sep (BNB 0.03% is too loose on BTC chop).
 * Jun 25–Jun 26 @ 5% risk: ~+72% ret, ~5% DD, 0 liq exits (vs +39% / 18.6% DD base).
 */
export const SUPERTREND_ELITE_BTC_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  symbol: "BTCUSDT",
  timeframe: "1h",
  eliteStHtf1hMinSep: 0.0008,
};

/** BTCUSDT 1H + ADX≥20 rising — fewer trades, higher selectivity */
export const SUPERTREND_ELITE_BTC_1H_ADX = {
  ...SUPERTREND_ELITE_BTC_1H,
  eliteStMinAdx: 20,
  eliteStRequireAdxRising: true,
  eliteStAdxRisingLookback: 3,
};

const ELITE_ST_DYNAMIC_SEP_DEFAULTS = {
  eliteStHtf1hMinSepAtrMult: 0.25,
  eliteStHtf1hMinSepFloor: 0.0002,
  eliteStHtf1hMinSepCeil: 0.0012,
  eliteStHtf1hSepPercentileLookback: 90,
  eliteStHtf1hSepPercentileMult: 1.0,
  eliteStHtf1hSepAdxBase: 0.0003,
  eliteStHtf1hSepAdxAlpha: 1.5,
  eliteStHtf1hSepAdxRef: 25,
  eliteStHtf1hSepCalibratePct: 40,
  eliteStHtf1hSepCalibrateBars: 90,
} as const;

/**
 * Any coin — auto-calibrated gates + ADX sep + ATR brackets (recommended).
 * Keep in sync with backend SUPERTREND_ELITE_AUTO_1H_PRESET.
 */
export const SUPERTREND_ELITE_AUTO_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStAutoCalibrate: true,
  eliteStAutoFullTune: true,
  eliteStAutoProfileBars: 90,
  eliteStAutoBracketMode: "ATR" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT" as const,
};

/** @deprecated Full auto-tune derives LINK settings from coin profile. */
export const SUPERTREND_ELITE_LINK_1H = {
  ...SUPERTREND_ELITE_AUTO_1H,
  symbol: "LINKUSDT",
  timeframe: "1h",
};

/** Any coin — ADX-scaled Gate 3 sep (sweep winner on 7 coins). */
export const SUPERTREND_ELITE_ADX_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStHtf1hSepMode: "ADX" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/** Any coin — rolling median 1H EMA sep (lowest DD in sweep). */
export const SUPERTREND_ELITE_PERCENTILE_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStHtf1hSepMode: "PERCENTILE" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/** Any coin — ATR-scaled sep. */
export const SUPERTREND_ELITE_ATR_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStHtf1hSepMode: "ATR" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/** Any coin — warmup percentile sep, constant thereafter. */
export const SUPERTREND_ELITE_CALIBRATED_1H = {
  ...SUPERTREND_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStHtf1hSepMode: "CALIBRATED" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

// ── UNIFIED_ELITE presets ──────────────────────────────────────────────────────

/**
 * UNIFIED_ELITE base — Elite 1H signal + regime gate + liq proximity scaling
 * + LIQ/SR supplemental in RANGE regime.
 * Keep in sync with backend/src/strategy/presets/supertrendEliteOptimized.js
 */
export const UNIFIED_ELITE_1H_BASE = {
  ...SUPERTREND_ELITE_1H_BASE,
  manualStrategy: "UNIFIED_ELITE",

  // Layer 1: only skip SQUEEZE regime — VOLATILE_AVOID bars are high-ATR moves
  // where Elite trend entries are strongest (skipping them hurts returns).
  unifiedRegimeGate: true,
  unifiedRegimeGateMode: "skip_squeeze_only",

  // Layer 2: scale position 1.5× when PDH/PDL sweep within 8 bars
  unifiedLiqScale: true,
  unifiedLiqScaleFactor: 1.5,
  unifiedLiqLookback: 8,

  // Layer 3: LIQ+SR A+ supplemental in RANGE (0.5× risk, London/NY only)
  unifiedLiqSrEnabled: true,
  unifiedLiqSrMinScore: 10,
  unifiedLiqSrRiskScale: 0.5,
  unifiedLiqSrMaxPerDay: 1,
  unifiedLiqSrKillzone: "LONDON_NY",
};

/** BNBUSDT 1H — recommended starting point */
export const UNIFIED_ELITE_BNB_1H = {
  ...UNIFIED_ELITE_1H_BASE,
  symbol: "BNBUSDT",
  timeframe: "1h",
};

/** BTCUSDT 1H */
export const UNIFIED_ELITE_BTC_1H = {
  ...UNIFIED_ELITE_1H_BASE,
  symbol: "BTCUSDT",
  timeframe: "1h",
};

/** UNIFIED_ELITE + ADX dynamic sep — recommended any-coin portfolio starting point. */
export const UNIFIED_ELITE_ADX_1H = {
  ...UNIFIED_ELITE_1H_BASE,
  timeframe: "1h",
  eliteStHtf1hSepMode: "ADX" as const,
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};
