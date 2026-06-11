/**
 * SUPERTREND_ELITE — Optimized presets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KEY FINDING (systematic backtest, May 2025 – May 2026):
 *
 * • The 15m timeframe is UNSUITABLE for Supertrend trend-following, regardless
 *   of exit strategy.  All TP/SL ratios tested (0.5R – 2.7R) give PF < 1.
 *
 * • The 1H timeframe WITH Supertrend trailing stop is PROFITABLE:
 *     BNBUSDT 1H (Jan–May 2026):  73% WR, 15 trades, +22% return
 *     BTCUSDT 1H (Jun–May, 1yr):  54% WR, 76 trades, +70% return
 *
 * • Adding 4H ST alignment + 1H EMA structure gates dramatically improves
 *   BNBUSDT (73% WR) and helps select better trades on BTCUSDT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECOMMENDED USAGE:
 *   Timeframe : 1H  (mandatory — 15m is too noisy)
 *   Strategy  : SUPERTREND_ELITE
 *   Preset    : SUPERTREND_ELITE_1H_PRESET (this file)
 *   Symbols   : BNBUSDT, BTCUSDT
 */

// ── LEGACY — 15m preset (kept for reference, DO NOT use for live trading) ───

/** @deprecated  15m is unprofitable for this strategy. Use SUPERTREND_ELITE_1H_PRESET. */
export const SUPERTREND_ELITE_4H_PRESET = {
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  eliteStRequireHtf4hAlign:    true,
  eliteStHtf4hPeriod:          10,
  eliteStHtf4hMultiplier:      3.0,
  eliteStRequireHtf1hEmaAlign: false,
  eliteStMinAdx:               0,
  eliteStRequireAdxRising:     false,
  eliteStMinVolumeVsAvg:       0,
  eliteStRequireAtrExpansion:  false,
  eliteStLiqSweepEnabled:      false,
  supertrendFuturesFixedSlPct: 0.015,
  supertrendFuturesFixedTpPct: 0.008,
  supertrendFuturesExitOnFlip: false,
  trailingStopLossAuto:        false,
  riskPerTrade:                7,
  riskPerTradeUnit:            "PCT_EQUITY",
};

/** @deprecated */
export const SUPERTREND_ELITE_4H_TRAIL_PRESET = {
  ...SUPERTREND_ELITE_4H_PRESET,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesExitOnFlip: true,
  trailingStopLossAuto:        true,
  futuresTrailingStopMode:     "SUPERTREND",
  backtestBreakevenAtMfePct:   0.005,
};

// ── PRIMARY — 1H preset (validated, recommended) ─────────────────────────────

/**
 * SUPERTREND_ELITE — 1H with 4H + 1H-EMA alignment + trailing stop.
 *
 * Backtested results:
 *   BNBUSDT 1H  Jan–May 2026  : 73.3% WR  15 trades  +22% return  PF 2.04  DD  8.3%
 *   BTCUSDT 1H  Jun–May 1yr   : 53.9% WR  76 trades  +70% return  PF 1.61  DD 28.8%
 *   BTCUSDT 1H  Jun–Dec 2025  : 41.7% WR  24 trades  +14% return  PF 1.39
 *   BTCUSDT 1H  Jan–May 2026  : 63.6% WR  11 trades  +62% return  PF 4.86
 *
 * Gates:
 *   Gate 4 — 4H Supertrend direction  (ON)  : blocks counter-4H-trend entries
 *   Gate 3 — 1H EMA21 > EMA50 alignment (ON) : blocks entries in disordered trend structure
 *   ADX, Volume, ATR — OFF (insufficient data for 1H; add selectively after paper trading)
 *
 * Exit:
 *   Trailing stop = Supertrend line on primary TF (1H)
 *   Panel default brackets: 0.2% SL, 1.5% TP (toggle off in UI for trail-only)
 */
export const SUPERTREND_ELITE_1H_PRESET = {
  // ── Strategy ──────────────────────────────────────────────────────────────
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",

  // ── Primary Supertrend (1H) ───────────────────────────────────────────────
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,

  // ── Gates ─────────────────────────────────────────────────────────────────
  eliteStRequireHtf4hAlign:    true,   // block counter-4H signals
  eliteStHtf4hPeriod:          10,
  eliteStHtf4hMultiplier:      3.0,
  eliteStRequireHtf1hEmaAlign: true,   // block signals in disordered EMA structure
  eliteStHtf1hMinSep:          0.0003,
  // ADX / Volume / ATR — disabled (too aggressive on 1H; validate before enabling)
  eliteStMinAdx:               0,
  eliteStRequireAdxRising:     false,
  eliteStMinVolumeVsAvg:       0,
  eliteStRequireAtrExpansion:  false,
  eliteStLiqSweepEnabled:      false,

  // ── Exit: ST trail + panel default brackets (0.2% SL, 1.5% TP) ─────────
  trailingStopLossAuto:        true,
  futuresTrailingStopMode:     "SUPERTREND",
  supertrendFuturesExitOnFlip: true,   // also exit on opposite signal
  supertrendFuturesFixedSlPct: 0.002,
  supertrendFuturesFixedTpPct: 0.015,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,

  // ── Risk ──────────────────────────────────────────────────────────────────
  riskPerTrade:                5,      // 5% per trade (conservative — fewer trades on 1H)
  riskPerTradeUnit:            "PCT",
  futuresLeverage:             25,
};

/**
 * Variant: add ADX≥20 rising gate for stricter entry.
 *
 * Backtested on BTCUSDT 1H:
 *   H2 2025  : 38.9% WR  18 trades  -14% return  (H2 2025 was choppy — ADX hurts)
 *   Jan–May  : 63.6% WR  11 trades  +64% return  PF 6.23
 *
 * Best used in confirmed trend environments (up-trending market).
 */
export const SUPERTREND_ELITE_1H_ADX_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  eliteStMinAdx:          20,
  eliteStRequireAdxRising: true,
  eliteStAdxRisingLookback: 3,
};

/**
 * BTCUSDT 1H — tuned for BTC chop / liquidation avoidance.
 *
 * BNB preset uses eliteStHtf1hMinSep 0.03% — too loose on BTC: marginal EMA
 * structure lets counter-trend shorts in H2 2025 chop (one liq −18% equity hit).
 * 0.08% EMA separation filters weak structure; Jun 25–Jun 26 @ 5% risk:
 *   base BNB sep: BTC +39% DD 18.6% (1 liq) · tuned: BTC +72% DD 5.1% (0 liq)
 */
export const SUPERTREND_ELITE_BTC_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  symbol: "BTCUSDT",
  timeframe: "1h",
  eliteStHtf1hMinSep: 0.0008,
};

/** BNB 1H — validated base (0.03% EMA sep suits BNB trend persistence). */
export const SUPERTREND_ELITE_BNB_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  symbol: "BNBUSDT",
  timeframe: "1h",
};

// ── Dynamic Gate 3 sep modes (any-coin, no per-symbol hardcoding) ─────────────

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
};

/** ADX-scaled sep — best avg return in 7-coin sweep (2025-06 → 2026-06). */
export const SUPERTREND_ELITE_ADX_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  timeframe: "1h",
  eliteStHtf1hSepMode: "ADX",
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/** Rolling median of recent 1H EMA sep — lowest drawdown in sweep. */
export const SUPERTREND_ELITE_PERCENTILE_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  timeframe: "1h",
  eliteStHtf1hSepMode: "PERCENTILE",
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/** ATR-scaled sep — volatility-adaptive threshold. */
export const SUPERTREND_ELITE_ATR_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  timeframe: "1h",
  eliteStHtf1hSepMode: "ATR",
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

/**
 * Any coin — auto-calibrated gates + ADX sep + ATR brackets.
 * Recommended default for new instances (no per-symbol hardcoding).
 */
export const SUPERTREND_ELITE_AUTO_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  timeframe: "1h",
  eliteStAutoCalibrate: true,
  /** Profile-driven sep mode + ST multiplier (no per-coin hardcoding). */
  eliteStAutoFullTune: true,
  eliteStAutoProfileBars: 90,
  eliteStAutoBracketMode: "ATR",
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
};

/** @deprecated Use SUPERTREND_ELITE_AUTO_1H_PRESET — full auto-tune derives LINK settings from profile. */
export const SUPERTREND_ELITE_LINK_1H_PRESET = {
  ...SUPERTREND_ELITE_AUTO_1H_PRESET,
  symbol: "LINKUSDT",
  timeframe: "1h",
};

/** Warmup percentile sep — constant after calibration window. */
export const SUPERTREND_ELITE_CALIBRATED_1H_PRESET = {
  ...SUPERTREND_ELITE_1H_PRESET,
  timeframe: "1h",
  eliteStHtf1hSepMode: "CALIBRATED",
  ...ELITE_ST_DYNAMIC_SEP_DEFAULTS,
};

// ── UNIFIED_ELITE — Regime-gated Elite + liq proximity scaling + RANGE supplement ──

/**
 * UNIFIED_ELITE — 1H base with regime gate + liquidity proximity scale-up +
 * LIQ+SR supplemental in RANGE markets.
 *
 * Architecture:
 *   - Core: same SUPERTREND_ELITE 1H signal (validated, unchanged)
 *   - Layer 1: skip VOLATILE_AVOID + SQUEEZE regime bars
 *   - Layer 2: scale position 1.5× when a PDH/PDL sweep is within 8 bars
 *   - Layer 3: add LIQ+SR A+ trades (0.5× risk) in RANGE regime during London/NY
 *
 * Portfolio: run on BTC, ETH, BNB, LINK, XRP for 7–10 trades/month total.
 * Validate with: node scripts/backtest-unified-elite.mjs
 */
export const UNIFIED_ELITE_1H_PRESET = {
  manualStrategy: "UNIFIED_ELITE",
  strategyMode: "MANUAL",

  // ── Elite core (same 1H validated config) ────────────────────────────────
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  eliteStRequireHtf4hAlign: true,
  eliteStHtf4hPeriod: 10,
  eliteStHtf4hMultiplier: 3.0,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStHtf1hMinSep: 0.0003,
  eliteStMinAdx: 0,
  eliteStRequireAdxRising: false,
  eliteStMinVolumeVsAvg: 0,
  eliteStRequireAtrExpansion: false,
  eliteStLiqSweepEnabled: false,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0.002,
  supertrendFuturesFixedTpPct: 0.015,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,

  // ── Layer 1: regime gate (only blocks SQUEEZE — VOLATILE bars are high-ATR
  // momentum moves where the Elite signal is strongest) ─────────────────────
  unifiedRegimeGate: true,
  unifiedRegimeGateMode: "skip_squeeze_only",

  // ── Layer 2: liq proximity scale-up ──────────────────────────────────────
  unifiedLiqScale: true,
  unifiedLiqScaleFactor: 1.5,
  unifiedLiqLookback: 8,

  // ── Layer 3: LIQ+SR supplemental in RANGE ────────────────────────────────
  unifiedLiqSrEnabled: true,
  unifiedLiqSrMinScore: 10,
  unifiedLiqSrRiskScale: 0.5,
  unifiedLiqSrMaxPerDay: 1,
  unifiedLiqSrKillzone: "LONDON_NY",

  // ── Risk ─────────────────────────────────────────────────────────────────
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 25,
};

/** Variant: BNBUSDT 1H */
export const UNIFIED_ELITE_BNB_1H = {
  ...UNIFIED_ELITE_1H_PRESET,
  symbol: "BNBUSDT",
  timeframe: "1h",
};

/** Variant: BTCUSDT 1H */
export const UNIFIED_ELITE_BTC_1H = {
  ...UNIFIED_ELITE_1H_PRESET,
  symbol: "BTCUSDT",
  timeframe: "1h",
};
