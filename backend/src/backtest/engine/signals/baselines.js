/**
 * Signal adapters for the backtest engine. Each adapter is invoked once per
 * closed bar with `(bar, idx, ctx)` and returns a `{ action, reason }` flip
 * event or null. Logic matches `backend/src/strategy/strategies.js` (same as
 * live) unless a path needs async ML (SurfPulse XGBoost when enabled in cfg).
 */

import {
  computeIndicators,
  buildPerBarIndicatorSnapshots,
  rsi as computeRsi,
  atr as computeAtr,
} from "../../../strategy/indicators.js";
import { detectRegime, resetRegimeState } from "../../../strategy/regime.js";
import { strategies } from "../../../strategy/strategies.js";
import { pickStrategyAuto } from "../../../strategy/selector.js";
import { buildHtfRsiBacktestAdapter } from "../../../strategy/htfRsi.js";
import {
  buildTrendHtfStBacktestAdapter,
  buildTrendHtfStQualityOpts,
} from "../../../strategy/trendHtfSt.js";
import { buildHtfLegRiderBacktestAdapter } from "../../../strategy/htfLegRider.js";
import { buildApexTrendBacktestAdapter } from "../../../strategy/apexTrend.js";
import { buildEliteHtfBacktestAdapter } from "../../../strategy/eliteHtf.js";
import {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
} from "../../../strategy/supertrendElite.js";
import { buildSafeIntradayBacktestAdapter } from "../../../strategy/safeIntraday.js";
import {
  buildIntradayBacktestAdapter,
  buildIntradayOptsFromCfg,
  mergeAdaptiveCfg,
} from "../../../strategy/intradayPro.js";
import { buildVolumeProfileBacktestAdapter } from "../../../strategy/volumeProfileStrategy.js";
import { buildRegimeAdaptiveBacktestAdapter } from "../../../strategy/regimeAdaptive.js";
import {
  buildSituationIntradayBacktestAdapter,
  resolveSituationRouterCfg,
} from "../../../strategy/situationIntraday.js";
import { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg } from "../../../strategy/crtTbsIntraday.js";
import {
  buildTokyoSessionBacktestAdapter,
  resolveTokyoSessionCfg,
} from "../../../strategy/tokyoSessionIntraday.js";
import {
  buildUnifiedEliteBacktestAdapter,
  buildUnifiedEliteOptsFromCfg,
} from "../../../strategy/unifiedElite.js";

const WARMUP_BARS = 60;

export function buildBaselineAdapters() {
  return {
    EMA_CROSS: makeAdapter("EMA_CROSS"),
    RSI_MEAN: makeAdapter("RSI_MEAN"),
    BREAKOUT_VOL: makeAdapter("BREAKOUT_VOL"),
    MOMENTUM_SURGE: makeAdapter("MOMENTUM_SURGE"),
    ENSEMBLE: makeAdapter("ENSEMBLE"),
    CONFLUENCE: makeAdapter("CONFLUENCE"),
    /** Rules-only SurfPulse path (same as `SURF_PULSE_ML.signal` without live ML HTTP). */
    SURF_PULSE_ML: makeAdapter("SURF_PULSE_ML"),
    TREND_PULLBACK: makePullbackAdapter(),
    SMART_REVERSAL: makeSmartReversalAdapter(),
    HTF_RSI: makeAdapter("HTF_RSI"),
    TREND_HTF_ST: makeAdapter("TREND_HTF_ST"),
    HTF_LEG_RIDER: makeAdapter("HTF_LEG_RIDER"),
    BTC_CONSENSUS: makeAdapter("BTC_CONSENSUS"),
    APEX_TREND: makeAdapter("APEX_TREND"),
    ELITE_HTF: makeAdapter("ELITE_HTF"),
    SUPERTREND_ELITE: makeAdapter("SUPERTREND_ELITE"),
    SAFE_INTRADAY: makeAdapter("SAFE_INTRADAY"),
    SR_INTRADAY: makeAdapter("SR_INTRADAY"),
    INTRADAY_PRO: makeAdapter("INTRADAY_PRO"),
    VOLUME_PROFILE: makeAdapter("VOLUME_PROFILE"),
    UNIFIED_ELITE: makeAdapter("UNIFIED_ELITE"),
    SITUATION_INTRADAY: makeAdapter("SITUATION_INTRADAY"),
    CRT_TBS: makeAdapter("CRT_TBS"),
    TOKYO_SESSION: makeAdapter("TOKYO_SESSION"),
  };
}

/**
 * Assemble adapters for a run from saved `cfg` and `strategyKey`.
 * SurfPulse XGBoost is applied only when `surfPulseMlGateEnabled` is true in cfg
 * (same default as live). Otherwise the rules adapter above is used.
 */
export async function buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs }) {
  let adapters = {};
  try {
    adapters = { ...buildBaselineAdapters() };
  } catch {
    /* ignore */
  }

  if (strategyKey === "AUTO") {
    try {
      adapters.AUTO = buildAutoAdapter();
    } catch {
      /* ignore */
    }
  }

  const surfGateOn = cfg?.surfPulseMlGateEnabled !== false;
  if (strategyKey === "SURF_PULSE_ML" && surfGateOn) {
    const { buildSurfPulseMlGateAdapter } = await import("./surfPulseMl.js").catch(() => ({}));
    if (typeof buildSurfPulseMlGateAdapter === "function") {
      try {
        adapters.SURF_PULSE_ML = await buildSurfPulseMlGateAdapter({ symbol, tf, candles, cfg, fromMs });
      } catch {
        /* ignore — runner falls back to missing adapter */
      }
    }
  }

  if (strategyKey === "HTF_RSI" && typeof buildHtfRsiBacktestAdapter === "function") {
    adapters.HTF_RSI = buildHtfRsiBacktestAdapter(candles, tf);
  }

  if (strategyKey === "TREND_HTF_ST" && typeof buildTrendHtfStBacktestAdapter === "function") {
    const period = Number(cfg?.supertrendPeriod ?? 10);
    const mult = Number(cfg?.supertrendMultiplier ?? 2.5);
    adapters.TREND_HTF_ST = buildTrendHtfStBacktestAdapter(candles, {
      period,
      multiplier: mult,
      ...buildTrendHtfStQualityOpts(cfg),
    });
  }

  if (strategyKey === "HTF_LEG_RIDER" && typeof buildHtfLegRiderBacktestAdapter === "function") {
    const lookback = Number(cfg?.htfLegRiderLookback ?? 32);
    adapters.HTF_LEG_RIDER = buildHtfLegRiderBacktestAdapter(candles, { lookback });
  }

  if (strategyKey === "BTC_CONSENSUS") {
    const { buildBtcConsensusAdapter } = await import("./btcConsensus.js").catch(() => ({}));
    if (typeof buildBtcConsensusAdapter === "function") {
      adapters.BTC_CONSENSUS = buildBtcConsensusAdapter(candles, { tf, cfg });
    }
  }

  if (strategyKey === "APEX_TREND" && typeof buildApexTrendBacktestAdapter === "function") {
    adapters.APEX_TREND = buildApexTrendBacktestAdapter(candles, {
      adxMin: Number(cfg?.apexAdxMin ?? 22),
      htf1hSep: Number(cfg?.apexHtf1hSep ?? 0.0012),
      htf4hSep: Number(cfg?.apexHtf4hSep ?? 0.0008),
      flipOnly: cfg?.apexFlipOnly !== false,
    });
  }

  if (strategyKey === "ELITE_HTF" && typeof buildEliteHtfBacktestAdapter === "function") {
    adapters.ELITE_HTF = buildEliteHtfBacktestAdapter(candles, { timeframe: tf, ...cfg });
  }

  if (strategyKey === "SUPERTREND_ELITE" && typeof buildEliteStBacktestAdapter === "function") {
    adapters.SUPERTREND_ELITE = buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(cfg));
  }

  if (strategyKey === "SAFE_INTRADAY" && typeof buildSafeIntradayBacktestAdapter === "function") {
    adapters.SAFE_INTRADAY = buildSafeIntradayBacktestAdapter(candles, cfg);
  }

  if (
    (strategyKey === "SR_INTRADAY" || strategyKey === "INTRADAY_PRO") &&
    typeof buildIntradayBacktestAdapter === "function"
  ) {
    const merged = mergeAdaptiveCfg(cfg, candles);
    const adapter = buildIntradayBacktestAdapter(candles, merged, tf);
    adapters.SR_INTRADAY = adapter;
    adapters.INTRADAY_PRO = adapter;
  }

  if (strategyKey === "VOLUME_PROFILE" && typeof buildVolumeProfileBacktestAdapter === "function") {
    adapters.VOLUME_PROFILE = buildVolumeProfileBacktestAdapter(candles, cfg, tf);
  }

  if (strategyKey === "REGIME_ADAPTIVE" && typeof buildRegimeAdaptiveBacktestAdapter === "function") {
    // Signals fire on the CLOSED signal bar; structure SL/TP ride on liqBrackets.
    adapters.REGIME_ADAPTIVE = buildRegimeAdaptiveBacktestAdapter(candles, cfg, tf);
  }

  if (strategyKey === "SITUATION_INTRADAY" && typeof buildSituationIntradayBacktestAdapter === "function") {
    const sitCfg = resolveSituationRouterCfg(cfg);
    adapters.SITUATION_INTRADAY = buildSituationIntradayBacktestAdapter(candles, sitCfg, tf);
  }

  if (strategyKey === "CRT_TBS" && typeof buildCrtTbsBacktestAdapter === "function") {
    const crtCfg = resolveCrtTbsCfg(cfg);
    adapters.CRT_TBS = buildCrtTbsBacktestAdapter(candles, crtCfg, tf);
  }

  if (strategyKey === "TOKYO_SESSION" && typeof buildTokyoSessionBacktestAdapter === "function") {
    const tokyoCfg = resolveTokyoSessionCfg(cfg);
    adapters.TOKYO_SESSION = buildTokyoSessionBacktestAdapter(candles, tokyoCfg, tf);
  }

  if (strategyKey === "UNIFIED_ELITE" && typeof buildUnifiedEliteBacktestAdapter === "function") {
    adapters.UNIFIED_ELITE = buildUnifiedEliteBacktestAdapter(candles, buildUnifiedEliteOptsFromCfg(cfg));
  }

  return adapters;
}

/**
 * AUTO — same as live `strategyMode === "AUTO"`: regime → pickStrategyAuto → that path's signal.
 */
export function buildAutoAdapter() {
  const baseAdapters = buildBaselineAdapters();
  let lastDir = 0;

  return function autoAdapter(bar, idx, ctx) {
    if (idx < WARMUP_BARS) return null;

    const slice = ctx.candles.slice(0, idx + 1);
    const indicators = computeIndicators(slice);
    const regime = detectRegime({ candles: slice, indicators });
    const stratKey = pickStrategyAuto({ regime, stats: null });

    const sub = baseAdapters[stratKey];
    if (!sub) return null;
    const sig = sub(bar, idx, ctx);

    if (!sig || sig.action === "HOLD") return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: `AUTO:${stratKey}:${sig.reason ?? ""}` };
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: `AUTO:${stratKey}:${sig.reason ?? ""}` };
    }
    return null;
  };
}

/**
 * Stateful pullback adapter with price-aware exits via EXIT action.
 *
 * State machine:
 *   IDLE → BUY/SELL on valid setup → IN_POSITION
 *   IN_POSITION → EXIT only when:
 *     (a) Price is at profit AND RSI recovered (take profit)
 *     (b) Bounce clearly failed (RSI drops much deeper — reversal confirmed)
 *     (c) Max hold exceeded
 *   COOLDOWN → IDLE after N bars
 *
 * Max-hold is scaled to ~similar wall-clock on each TF (1m needs far more *bars*
 * than 5m). Otherwise 1m hits max_hold in ~18m while still underwater → many
 * `signal_exit` losses and bad WR.
 */
function makePullbackAdapter() {
  const MIN_PROFIT_PCT = 0.0015;

  let state = "IDLE";
  let entryIdx = -1;
  let entryPrice = 0;
  let cooldownUntil = -1;

  return function pullbackAdapter(bar, idx, ctx) {
    if (idx < WARMUP_BARS) return null;

    const tf = String(ctx.timeframe || ctx.cfg?.timeframe || "5m").toLowerCase();
    const minutesPerBar =
      { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "1d": 1440 }[tf] ?? 5;
    /** Wall-clock horizon before time-stop (noisy TFs need longer). */
    const targetHoldMin = tf === "1m" ? 200 : tf === "5m" ? 150 : 120;
    const maxHoldBars = Math.min(400, Math.max(28, Math.ceil(targetHoldMin / minutesPerBar)));
    const cooldownBars = tf === "1m" ? 12 : tf === "5m" ? 8 : 6;

    const slice = ctx.candles.slice(0, idx + 1);

    // ── Exit logic ──
    if (state === "IN_LONG" || state === "IN_SHORT") {
      const barsHeld = idx - entryIdx;
      const closes = slice.map(c => c.close);
      const rsiSeries = computeRsi(closes, 14);
      const rsiNow = rsiSeries[rsiSeries.length - 1];

      const isLong = state === "IN_LONG";
      const pricePnl = isLong
        ? (bar.close - entryPrice) / entryPrice
        : (entryPrice - bar.close) / entryPrice;
      const inProfit = pricePnl >= MIN_PROFIT_PCT;

      let shouldExit = false;
      let reason = "";

      // (a) Profit-taking: in profit AND RSI has recovered from extreme
      if (inProfit && isLong && Number.isFinite(rsiNow) && rsiNow >= 42) {
        shouldExit = true;
        reason = "profit_rsi_recovered";
      } else if (inProfit && !isLong && Number.isFinite(rsiNow) && rsiNow <= 58) {
        shouldExit = true;
        reason = "profit_rsi_recovered";
      }

      // (b) Quick profit: price moved significantly in our favor (> 0.3%)
      if (!shouldExit && pricePnl >= 0.003) {
        shouldExit = true;
        reason = "quick_profit";
      }

      // (c) Bounce failed: RSI drops much deeper (reversal confirmed)
      if (!shouldExit && isLong && Number.isFinite(rsiNow) && rsiNow < 20) {
        shouldExit = true;
        reason = "bounce_failed";
      } else if (!shouldExit && !isLong && Number.isFinite(rsiNow) && rsiNow > 80) {
        shouldExit = true;
        reason = "bounce_failed";
      }

      // (d) Time stop — prefer not to crystallize a *large* loss here; SL exists for that.
      // If still underwater at maxHold, allow up to 1.5× more bars unless bounce_failed already fired.
      const softCap = maxHoldBars;
      const hardCap = Math.floor(maxHoldBars * 1.5);
      if (!shouldExit && barsHeld >= softCap && pricePnl >= -0.0025) {
        shouldExit = true;
        reason = "max_hold";
      } else if (!shouldExit && barsHeld >= hardCap) {
        shouldExit = true;
        reason = "max_hold";
      }

      if (shouldExit) {
        state = "COOLDOWN";
        cooldownUntil = idx + cooldownBars;
        return { action: "EXIT", reason };
      }
      return null;
    }

    // ── Cooldown ──
    if (state === "COOLDOWN") {
      if (idx >= cooldownUntil) state = "IDLE";
      else return null;
    }

    // ── Entry logic ──
    const sig = strategies.TREND_PULLBACK?.signal?.({ candles: slice, timeframe: tf });
    if (!sig || sig.action === "HOLD") return null;

    if (sig.action === "BUY") {
      state = "IN_LONG";
      entryIdx = idx;
      entryPrice = bar.close;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL") {
      state = "IN_SHORT";
      entryIdx = idx;
      entryPrice = bar.close;
      return { action: "SELL", reason: sig.reason };
    }

    return null;
  };
}

/**
 * Stateful adapter for SMART_REVERSAL.
 * Lets the runner's configured SL/TP handle exits (no early EXIT action).
 * Tracks last signal direction to prevent same-direction spam after entry.
 * Cooldown prevents re-entries too soon after a position would have closed.
 */
function makeSmartReversalAdapter() {
  let lastDir = 0;        // 1 = long, -1 = short, 0 = flat
  let lastSignalIdx = -1;

  return function smartReversalAdapter(bar, idx, ctx) {
    if (idx < 100) return null;

    const tf = String(ctx.timeframe || ctx.cfg?.timeframe || "15m").toLowerCase();
    const minutesPerBar = { "1m":1,"5m":5,"15m":15,"30m":30,"1h":60 }[tf] ?? 15;
    // Minimum bars between same-direction signals (prevents churning)
    const cooldownBars = Math.ceil(60 / minutesPerBar); // 1h cooldown

    if (lastDir !== 0 && idx - lastSignalIdx < cooldownBars) return null;

    const slice = ctx.candles.slice(0, idx + 1);
    const sig = strategies.SMART_REVERSAL?.signal?.({ candles: slice, timeframe: tf });
    if (!sig || sig.action === "HOLD") return null;

    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      lastSignalIdx = idx;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      lastSignalIdx = idx;
      return { action: "SELL", reason: sig.reason };
    }
    // Allow same direction again after cooldown
    if (sig.action === "BUY" && lastDir === 1 && idx - lastSignalIdx >= cooldownBars) {
      lastSignalIdx = idx;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && lastDir === -1 && idx - lastSignalIdx >= cooldownBars) {
      lastSignalIdx = idx;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

/** Flip-only signals; warmup matches strategy needs (SurfPulse rules need ~200 bars). */
function makeAdapter(strategyKey) {
  const warmupBars = strategyKey === "SURF_PULSE_ML" ? 200 : WARMUP_BARS;
  let lastDir = 0;
  let snapshots = null;
  let snapshotLen = 0;
  return function adapter(bar, idx, ctx) {
    if (idx < warmupBars) return null;
    if (!snapshots || snapshotLen !== ctx.candles.length) {
      resetRegimeState();
      snapshots = buildPerBarIndicatorSnapshots(ctx.candles);
      snapshotLen = ctx.candles.length;
    }
    const indicators = snapshots[idx];
    if (!indicators) return null;
    const lookback =
      strategyKey === "SURF_PULSE_ML" ? 220 : strategyKey === "BREAKOUT_VOL" || strategyKey === "MOMENTUM_SURGE" ? 30 : 5;
    const tail = ctx.candles.slice(Math.max(0, idx - lookback + 1), idx + 1);
    const regime = detectRegime({ candles: tail, indicators });

    const sig =
      strategyKey === "SURF_PULSE_ML"
        ? strategies.SURF_PULSE_ML?.signal?.({ candles: tail, surfPulse: {} })
        : strategies[strategyKey]?.signal?.({ candles: tail, indicators, regime });

    if (!sig) return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}
