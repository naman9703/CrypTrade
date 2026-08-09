/**
 * Supertrend XGBoost feature contract — entry-only numeric vector for train/predict.
 * Keep in sync with ai-service SUPERTREND_XGB_FEATURE_COLUMNS.
 */
export const SUPERTREND_XGB_FEATURE_KEYS = Object.freeze([
  "atr14_pct",
  "atr_percentile",
  "adx14",
  "rsi14",
  "dist_ema20_pct",
  "dist_ema50_pct",
  "dist_ema200_pct",
  "ema_stack",
  "vol_vs_avg20",
  "body_pct",
  "upper_wick_pct",
  "lower_wick_pct",
  "dist_swing_high_pct",
  "dist_swing_low_pct",
  "entry_hour_utc",
  "entry_weekday",
  "session",
  "side",
]);

const EMA_STACK_MAP = { bearish: -1, mixed: 0, bullish: 1 };
const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const SESSION_MAP = {
  Asia: 0,
  AsiaLondon: 1,
  London: 2,
  Overlap: 3,
  NY: 4,
  Off: 5,
};

function numOr(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Encode raw tradeCsvFeatures-style fields + side into the API feature dict.
 * @param {Record<string, unknown>} raw
 * @param {"BUY"|"SELL"|string} side
 */
export function encodeSupertrendXgbFeatures(raw = {}, side = "BUY") {
  const stack = String(raw.emaStack ?? raw.ema_stack ?? "").toLowerCase();
  const wd = String(raw.entryWeekday ?? raw.entry_weekday ?? "");
  const sess = String(raw.session ?? "");
  const sideU = String(side || "BUY").toUpperCase();
  return {
    atr14_pct: numOr(raw.atr14Pct ?? raw.atr14_pct),
    atr_percentile: numOr(raw.atrPercentile ?? raw.atr_percentile),
    adx14: numOr(raw.adx14),
    rsi14: numOr(raw.rsi14),
    dist_ema20_pct: numOr(raw.distToEma20Pct ?? raw.dist_ema20_pct),
    dist_ema50_pct: numOr(raw.distToEma50Pct ?? raw.dist_ema50_pct),
    dist_ema200_pct: numOr(raw.distToEma200Pct ?? raw.dist_ema200_pct),
    ema_stack: EMA_STACK_MAP[stack] ?? 0,
    vol_vs_avg20: numOr(raw.volVsAvg20 ?? raw.vol_vs_avg20),
    body_pct: numOr(raw.bodyPct ?? raw.body_pct),
    upper_wick_pct: numOr(raw.upperWickPct ?? raw.upper_wick_pct),
    lower_wick_pct: numOr(raw.lowerWickPct ?? raw.lower_wick_pct),
    dist_swing_high_pct: numOr(raw.distToSwingHighPct ?? raw.dist_swing_high_pct),
    dist_swing_low_pct: numOr(raw.distToSwingLowPct ?? raw.dist_swing_low_pct),
    entry_hour_utc: numOr(raw.entryHourUtc ?? raw.entry_hour_utc),
    entry_weekday: WEEKDAY_MAP[wd] ?? numOr(raw.entry_weekday, 0),
    session: SESSION_MAP[sess] ?? numOr(raw.session, 5),
    side: sideU === "SELL" ? -1 : 1,
  };
}

/**
 * @param {Record<string, unknown>} features encoded dict
 * @returns {number[]}
 */
export function supertrendXgbFeatureVector(features) {
  return SUPERTREND_XGB_FEATURE_KEYS.map((k) => numOr(features?.[k]));
}

/** Strategies eligible for ST XGB train/gate in the backtest panel. */
export function isSupertrendXgbStrategy(manualOrKey) {
  const k = String(manualOrKey || "").toUpperCase();
  return (
    k === "SUPERTREND" ||
    k === "SUPERTREND_ELITE" ||
    k === "UNIFIED_ELITE" ||
    k.includes("SUPERTREND")
  );
}

/**
 * RR label from a mapped trade row (post-cost). Prefer RR column; else Net vs risk.
 * @returns {0|1|null}
 */
export function labelTradeRrPositive(trade) {
  const rr = Number(trade.rr ?? trade.RR);
  if (Number.isFinite(rr)) return rr > 0 ? 1 : 0;
  const net = Number(trade.netPnl ?? trade.net);
  if (!Number.isFinite(net)) return null;
  return net > 0 ? 1 : 0;
}
