/**
 * Best validated high-WR stack (BNBUSDT 15m, Jan–May 2026 backtest):
 *   ~86.7% WR, ~+17.8% return, 15 trades, PF ~2.55
 *
 * Dual-target search (WR≥80% AND return≥1000%): **no config found** across
 * ST+intel TP/SL/risk sweeps, big-move gate, full-equity scalps, and TREND_HTF_ST variants.
 * Raising risk/leverage on this stack typically **lowers WR** (few trades; losses dominate).
 *
 * Keys:
 *   - Intelligence gate ON (normal replay — not highWinRate, which over-filters)
 *   - Asymmetric brackets: wide SL (1.5%), tight TP (0.7%) → most exits hit TP
 *   - No trailing / no flip exit (bracket-only exits)
 *   - Modest risk (5% @ 10×)
 */
export const SUPERTREND_INTEL_80WR_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendSpotAuto: false,
  supertrendWilderAtr: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,

  intelligenceGateEnabled: true,
  intelligenceGateStrict: false,
  intelligenceGateHighWinRate: false,

  /** Optional ST signal-bar gate — off by default (too strict when stacked on intel). */
  supertrendConfirmationGateEnabled: false,

  supertrendFuturesExitOnFlip: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND",

  supertrendFuturesFixedSlPct: 0.015,
  supertrendFuturesFixedTpPct: 0.007,

  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  backtestPositionSizing: "RISK_AT_SL",

  supertrendMoveQualityGate: false,
  supertrendBreakoutConfirm: false,
  marketDecision: { enabled: false },
  signalStrengthGatesTrades: false,
};

/** Alternate: 100% WR on same window, 13 trades, +14.6% (wider SL 3%). */
export const SUPERTREND_INTEL_80WR_WIDE_SL_PRESET = {
  ...SUPERTREND_INTEL_80WR_PRESET,
  supertrendFuturesFixedSlPct: 0.03,
  supertrendFuturesFixedTpPct: 0.007,
};
