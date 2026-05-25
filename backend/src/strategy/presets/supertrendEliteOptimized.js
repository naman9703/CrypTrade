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
 *   No fixed TP — let winners run
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

  // ── Exit: trailing Supertrend, no hard TP ────────────────────────────────
  trailingStopLossAuto:        true,
  futuresTrailingStopMode:     "SUPERTREND",
  supertrendFuturesExitOnFlip: true,   // also exit on opposite signal

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
