/**
 * ELITE_HTF — Production confluence strategy for BNB 15m.
 *
 * Combines HTF_RSI pullback entries (high-quality mean reversion in trend)
 * with macro regime gate + structural filters that eliminated H2 2025 losses:
 * - Block immature HTF (recent EMA cross)
 * - Block sideways + shrinking HTF separation
 * - Require HTF sep rising on entry
 * - CHOP_SEASON uses wider TP; TREND_SEASON uses standard TP
 *
 * Target: maximize win rate while preserving trend-leg capture.
 */

import { buildHtfRsiSignalSeries } from "./htfRsi.js";
import { dirStore } from "./adapterPersisted.js";
import { evaluateTrendHtfStRegime } from "./trendHtfStRegime.js";

const WARMUP = 80;

/** Regime gate for HTF_RSI entries (optional extra strict flags via cfg). */
export function passesEliteHtfFilters(candles, signalIdx, direction, cfg = {}) {
  const regime = evaluateTrendHtfStRegime(candles, signalIdx, direction, cfg);
  if (!regime) return { allow: false, regime: null, reason: "no_regime" };
  if (!regime.allowEntry) return { allow: false, regime, reason: regime.blockReasons?.[0] || "blocked" };
  if (cfg.eliteTrendOkOnly === true && regime.structuralRisk !== "TREND_OK") {
    return { allow: false, regime, reason: "not_trend_ok" };
  }
  if (cfg.eliteSkipChopSeason === true && regime.macroMode === "CHOP_SEASON") {
    return { allow: false, regime, reason: "chop_season" };
  }
  return { allow: true, regime, reason: "elite_ok" };
}

export function buildEliteHtfSignalSeries(candles, cfg = {}) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < WARMUP) return out;

  const htfRsi = buildHtfRsiSignalSeries(candles, cfg.timeframe ?? "15m", cfg);
  const regimeCfg = {
    trendHtfStRegimeGate: cfg.trendHtfStRegimeGate !== false,
    ...cfg,
  };

  for (let i = WARMUP; i < n; i++) {
    const sig = htfRsi[i];
    if (!sig || sig.action === "HOLD") continue;
    const check = passesEliteHtfFilters(candles, i, sig.action, regimeCfg);
    if (!check.allow) continue;
    out[i] = { action: sig.action, reason: `elite_${sig.reason}` };
  }
  return out;
}

export function buildEliteHtfBacktestAdapter(candles, cfg = {}) {
  const series = buildEliteHtfSignalSeries(candles, cfg);
  const local = { lastDir: 0 };
  return function eliteHtfAdapter(bar, idx, ctx) {
    const sig = series[idx];
    if (!sig) return null;
    const d = dirStore(ctx, local);
    if (sig.action === "BUY" && d.lastDir !== 1) {
      d.lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && d.lastDir !== -1) {
      d.lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

export const ELITE_HTF = {
  name: "ELITE HTF (RSI pullback + regime gate)",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
