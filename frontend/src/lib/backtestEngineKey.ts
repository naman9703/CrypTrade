/**
 * Backtest engine key — must match backend `pickStrategyKeyFromCfg` / live bar-close.
 */

const PANEL_MANUAL_BAR_CLOSE_KEYS = new Set([
  "SUPERTREND",
  "CONFLUENCE",
  "EMA_CROSS",
  "RSI_MEAN",
  "BREAKOUT_VOL",
  "MOMENTUM_SURGE",
  "ENSEMBLE",
  "SURF_PULSE_ML",
  "TREND_PULLBACK",
  "HTF_RSI",
  "HTF_LEG_RIDER",
  "TREND_HTF_ST",
  "SMART_REVERSAL",
  "BTC_CONSENSUS",
  "APEX_TREND",
  "SUPERTREND_ELITE",
  "SAFE_INTRADAY",
  "SR_INTRADAY",
  "SITUATION_INTRADAY",
  "VOLUME_PROFILE",
  "REGIME_ADAPTIVE",
  "CRT_TBS",
  "LIQ_CASCADE",
  "MLCTS",
  "SCALP_MR",
  "TOKYO_SESSION",
  "UNIFIED_ELITE",
  "LIQUIDITY_MAP",
]);

function pickBot(cfgRaw: unknown): Record<string, unknown> {
  if (!cfgRaw || typeof cfgRaw !== "object") return {};
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  return bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
}

/** Resolve backtest/live engine from saved strategy cfg snapshot. */
export function effectiveBacktestEngineKey(cfgRaw: unknown): string {
  const b = pickBot(cfgRaw);
  const mmUp = String(b.marketMode || b.market || "").toUpperCase();
  const stratMode = String(b.strategyMode ?? "").toUpperCase();
  const manual = String(b.manualStrategy ?? "").trim().toUpperCase();

  if (
    stratMode === "MANUAL" &&
    manual &&
    manual !== "MANUAL" &&
    manual !== "AUTO" &&
    manual !== "SUPERTREND" &&
    PANEL_MANUAL_BAR_CLOSE_KEYS.has(manual)
  ) {
    return manual;
  }

  const stSpot = Boolean(b.supertrendSpotAuto);
  const stFut = Boolean(b.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";

  if (stratMode === "MANUAL") {
    if (manual && manual !== "MANUAL" && manual !== "AUTO") return manual;
    return "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";
  return "SUPERTREND";
}

export function manualStrategyFromCfgRaw(cfgRaw: unknown): string {
  return String(pickBot(cfgRaw).manualStrategy ?? "").toUpperCase();
}
