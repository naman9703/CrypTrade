/**
 * Liquidity sweep — session PDH/PDL + optional session extreme clusters.
 *
 * Strict rules:
 * - Sweep pierces named liquidity (PDH/PDL or established session high/low)
 * - Deepest wick tracked per cycle; failed breakdowns start a new cycle
 * - Entry on reclaim close; SL beyond wick; TP1 @ 1R partial, TP2 @ opposing session liquidity
 */

export const DEFAULT_LIQ_SWEEP_PCT = 0.001;
export const DEFAULT_LIQ_SL_BUFFER_PCT = 0.0015;

/** Which liquidity exit legs are active (UI checkboxes / preset). */
export function resolveLiqExitStages(opts = {}) {
  const tp1On = opts.intradayLiqTp1Enabled !== false && opts.intradayLiqPartialTp !== false;
  const tp2On = opts.intradayLiqTp2Enabled !== false;
  const beOn = opts.intradayLiqBreakevenAfterPartial !== false;
  return {
    tp1On,
    tp2On,
    beOn,
    /** BE at 1R on full size when TP1 is off but BE + TP2 are on. */
    beAt1RWithoutPartial: !tp1On && beOn && tp2On,
  };
}

/** Fee-buffered breakeven stop from entry. */
export function liqBreakevenStopPx(entryFill, isLong, feeBuf = 0.001) {
  const fill = Number(entryFill);
  const buf = Number(feeBuf) || 0.001;
  if (!Number.isFinite(fill) || fill <= 0) return 0;
  return isLong ? fill * (1 + buf) : fill * (1 - buf);
}

export function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

/** @deprecated Use evaluateSessionLiquiditySweep — 15-bar swing causes false signals. */
export function liquiditySweep(candles, idx, side, lookback = 15) {
  const bar = candles[idx];
  const prior = candles.slice(Math.max(0, idx - lookback), idx);
  if (prior.length < 5) return false;
  if (side === "BUY") {
    const swingLow = Math.min(...prior.map((c) => c.low));
    return bar.low < swingLow && bar.close > swingLow;
  }
  const swingHigh = Math.max(...prior.map((c) => c.high));
  return bar.high > swingHigh && bar.close < swingHigh;
}

export function sweepReclaim(bar, level, side, sweepPct = 0.0006) {
  if (!Number.isFinite(level) || level <= 0) return false;
  if (side === "BUY") return bar.low < level * (1 - sweepPct) && bar.close > level;
  return bar.high > level * (1 + sweepPct) && bar.close < level;
}

export function rejectionWickRatio(bar, side) {
  const range = bar.high - bar.low || 1e-12;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBot = Math.min(bar.open, bar.close);
  if (side === "BUY") return (bodyBot - bar.low) / range;
  return (bar.high - bodyTop) / range;
}

export function dayStartIndex(candles, idx) {
  const d = utcDayId(candles[idx].ts);
  for (let j = idx; j >= 0; j--) {
    if (utcDayId(candles[j].ts) !== d) return j + 1;
  }
  return 0;
}

function sweepExtension(side, level, wick) {
  if (!level || level <= 0) return 0;
  return side === "BUY" ? (level - wick) / level : (wick - level) / level;
}

function isSessionClusterLevel(levelType) {
  return levelType === "session_low" || levelType === "session_high";
}

function sweepPoked(side, bar, level, sweepPct, levelType) {
  if (isSessionClusterLevel(levelType)) {
    return side === "BUY" ? bar.low <= level : bar.high >= level;
  }
  return side === "BUY" ? bar.low < level * (1 - sweepPct) : bar.high > level * (1 + sweepPct);
}

function passesSweepFilters(side, level, wick, sweepStartIdx, reclaimIdx, opts, levelType = "") {
  let minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.003);
  if (isSessionClusterLevel(levelType)) {
    minExt = Math.min(minExt, Number(opts.intradayLiqSessionExtremeMinExtensionPct ?? 0.0005));
  }
  const ext = sweepExtension(side, level, wick);
  if (minExt > 0 && ext + 1e-6 < minExt) {
    if (!isSessionClusterLevel(levelType)) return false;
    if (side === "BUY" && wick > level) return false;
    if (side === "SELL" && wick < level) return false;
  }
  const maxBars = Number(opts.intradayLiqMaxSweepBars ?? 40);
  if (maxBars > 0 && reclaimIdx - sweepStartIdx > maxBars) return false;
  return true;
}

/**
 * Scan same UTC day for all completed sweep→reclaim cycles (with failed-breakdown reset).
 * @returns {Array<{ reclaimIdx: number, wick: number, sweepStartIdx: number, level: number, levelType: string, opposing: number, extension: number }>}
 */
export function scanSessionLiquidityCycles(candles, idx, side, level, opposing, levelType, sweepPct, dayStart, opts = {}) {
  if (!level || level <= 0 || !opposing || opposing <= 0) return [];

  const cycles = [];
  let sweepActive = false;
  let extreme = side === "BUY" ? Infinity : -Infinity;
  let sweepStartIdx = -1;
  let awaitingFailure = false;

  for (let j = dayStart; j <= idx; j++) {
    const b = candles[j];

    if (side === "BUY") {
      if (sweepPoked(side, b, level, sweepPct, levelType)) {
        sweepActive = true;
        awaitingFailure = false;
        if (sweepStartIdx < 0) sweepStartIdx = j;
        extreme = Math.min(extreme, b.low);
      }
      if (sweepActive) extreme = Math.min(extreme, b.low);

      if (sweepActive && b.close > level) {
        if (passesSweepFilters(side, level, extreme, sweepStartIdx, j, opts, levelType)) {
          cycles.push({
            reclaimIdx: j,
            wick: extreme,
            sweepStartIdx,
            level,
            levelType,
            opposing,
            extension: sweepExtension(side, level, extreme),
          });
        }
        sweepActive = false;
        awaitingFailure = true;
        extreme = Infinity;
        sweepStartIdx = -1;
      } else if (awaitingFailure && b.close < level * (1 - sweepPct * 0.5)) {
        awaitingFailure = false;
      }
    } else {
      if (sweepPoked(side, b, level, sweepPct, levelType)) {
        sweepActive = true;
        awaitingFailure = false;
        if (sweepStartIdx < 0) sweepStartIdx = j;
        extreme = Math.max(extreme, b.high);
      }
      if (sweepActive) extreme = Math.max(extreme, b.high);

      if (sweepActive && b.close < level) {
        if (passesSweepFilters(side, level, extreme, sweepStartIdx, j, opts, levelType)) {
          cycles.push({
            reclaimIdx: j,
            wick: extreme,
            sweepStartIdx,
            level,
            levelType,
            opposing,
            extension: sweepExtension(side, level, extreme),
          });
        }
        sweepActive = false;
        awaitingFailure = true;
        extreme = -Infinity;
        sweepStartIdx = -1;
      } else if (awaitingFailure && b.close > level * (1 + sweepPct * 0.5)) {
        awaitingFailure = false;
      }
    }
  }
  return cycles;
}

/**
 * Established session high/low cluster (multi-touch equal highs/lows) for sweeps
 * that pierce intraday liquidity away from PDH/PDL.
 */
export function resolveSessionExtremeLevel(candles, idx, side, dayStart, opts = {}) {
  if (opts.intradayLiqSessionExtreme !== true && opts.intradayLiqSessionExtreme !== "true") {
    return null;
  }
  const minTouches = Math.max(2, Number(opts.intradayLiqSessionExtremeMinTouches ?? 2));
  const touchTol = Number(opts.intradayLiqSessionExtremeTouchTol ?? 0.0005);
  const minDistFromRef = Number(opts.intradayLiqSessionExtremeMinDistPct ?? 0.003);
  const strongClusterTouches = minTouches + 3;

  /** @type {Array<{ level: number, touches: number }>} */
  const clusters = [];
  const addCluster = (price) => {
    if (!Number.isFinite(price) || price <= 0) return;
    for (const c of clusters) {
      if (Math.abs(price - c.level) / c.level <= touchTol) {
        c.touches++;
        c.level = side === "BUY" ? Math.min(c.level, price) : Math.max(c.level, price);
        return;
      }
    }
    clusters.push({ level: price, touches: 1 });
  };

  for (let j = dayStart; j < idx; j++) {
    const b = candles[j];
    if (side === "BUY") addCluster(b.low);
    else addCluster(b.high);
  }

  const viable = clusters.filter((c) => c.touches >= minTouches);
  if (!viable.length) return null;

  viable.sort((a, b) => {
    if (side === "BUY") return a.level - b.level || b.touches - a.touches;
    return b.level - a.level || b.touches - a.touches;
  });
  const best = viable[0];
  const refPrice = candles[idx]?.close ?? candles[dayStart]?.open;
  if (
    refPrice > 0 &&
    best.touches < strongClusterTouches &&
    Math.abs(best.level - refPrice) / refPrice < minDistFromRef
  ) {
    return null;
  }

  return {
    level: best.level,
    levelType: side === "BUY" ? "session_low" : "session_high",
    opposing: null,
  };
}

/** HTF gate on session clusters; PDH/PDL sweeps use structure levels, not trend filter. */
function passesLiqHtfAlign(side, reclaimIdx, pre, opts = {}, levelType = "") {
  if (opts.intradayLiqRequireHtfAlign !== true || !pre) return true;
  if (levelType === "pdh" || levelType === "pdl") return true;
  const minSep = Number(opts.intradayLiqMinHtfSep ?? 0.0008);
  const sep = pre.htfSep?.[reclaimIdx] ?? 0;
  if (sep < minSep) return true;
  if (side === "BUY" && pre.htfDown?.[reclaimIdx]) return false;
  if (side === "SELL" && pre.htfUp?.[reclaimIdx]) return false;
  return true;
}

function cycleQualityScore(cycle, brackets, dayStart = 0, opts = {}) {
  const ext = cycle.extension * 1000;
  const rr = (brackets?.rr ?? 0) * 100;
  let q = ext + rr;
  if (cycle.levelType === "pdh" || cycle.levelType === "pdl") q += 20;
  if (cycle.reclaimIdx === cycle.sweepStartIdx) q -= 40;
  const minExtQ = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  if (cycle.extension + 1e-6 < minExtQ) q -= 25;
  const barsIntoDay = cycle.reclaimIdx - dayStart;
  q += Math.min(Math.max(0, barsIntoDay) * 0.25, 12);
  return q;
}

function passesReclaimStrength(bar, cycle, side, opts = {}) {
  const minClosePct = Number(opts.intradayLiqMinReclaimClosePct ?? 0);
  if (minClosePct > 0) {
    const closeDelta =
      side === "BUY"
        ? (bar.close - cycle.level) / Math.max(cycle.level, 1e-9)
        : (cycle.level - bar.close) / Math.max(cycle.level, 1e-9);
    if (closeDelta + 1e-6 < minClosePct) return false;
  }

  const minBodyRatio = Number(opts.intradayLiqMinReclaimBodyRatio ?? 0);
  if (minBodyRatio > 0) {
    const range = Math.max(1e-9, bar.high - bar.low);
    const bodyRatio = Math.abs(bar.close - bar.open) / range;
    if (bodyRatio + 1e-6 < minBodyRatio) return false;
    if (side === "BUY" && bar.close <= bar.open) return false;
    if (side === "SELL" && bar.close >= bar.open) return false;
  }

  return true;
}

/**
 * Structure brackets with optional partial @ 1R (tp1) + full TP at session liquidity (tp2).
 */
export function computeLiquidityBrackets(side, entry, sweepWick, opposingLevel, opts = {}) {
  const fill = Number(entry);
  const wick = Number(sweepWick);
  const tpLevel = Number(opposingLevel);
  if (!Number.isFinite(fill) || fill <= 0 || !Number.isFinite(wick) || !Number.isFinite(tpLevel) || tpLevel <= 0) {
    return null;
  }

  const buf = Number(opts.slBufferPct ?? opts.intradayLiqSlBufferPct ?? DEFAULT_LIQ_SL_BUFFER_PCT);
  const tradeSide = side === "BUY" || side === "long" ? "BUY" : "SELL";
  const { tp1On, tp2On } = resolveLiqExitStages(opts);
  const slOnly = !tp1On && !tp2On;

  const partialFrac = Math.min(0.75, Math.max(0.25, Number(opts.intradayLiqPartialFrac ?? 0.5)));

  let slPrice;
  let tp2Price = tp2On ? tpLevel : 0;
  if (tradeSide === "BUY") {
    slPrice = wick * (1 - buf);
    if (!(slPrice < fill)) return null;
    if (tp2On && !(tp2Price > fill)) return null;
  } else {
    slPrice = wick * (1 + buf);
    if (!(slPrice > fill)) return null;
    if (tp2On && !(tp2Price < fill)) return null;
  }

  const risk = Math.abs(fill - slPrice);
  let tp1Price = tp1On ? (tradeSide === "BUY" ? fill + risk : fill - risk) : 0;
  if (!tp2On) tp2Price = 0;

  // Intraday TP cap: target the nearer of (opposing liquidity, fill ± maxTpRr·risk).
  // Without this, TP sits at the far daily pool, holds run for days/weeks, and a
  // single ride blocks all subsequent intraday entries (kills trade frequency).
  const maxTpRr = Number(opts.intradayLiqMaxTpRr ?? opts.intradaySmcMaxTpRr ?? 0);
  if (tp2On && maxTpRr > 0 && risk > 0) {
    if (tradeSide === "BUY") {
      const capped = fill + maxTpRr * risk;
      if (capped < tp2Price) tp2Price = capped;
    } else {
      const capped = fill - maxTpRr * risk;
      if (capped > tp2Price) tp2Price = capped;
    }
  }

  let slPct;
  let tpPct;
  let tp1Pct;
  if (tradeSide === "BUY") {
    slPct = Math.max(0.002, (fill - slPrice) / fill);
    tp1Pct = tp1On ? Math.max(slPct * 0.98, (tp1Price - fill) / fill) : 0;
    tpPct = tp2On ? Math.max(slPct * 1.2, (tp2Price - fill) / fill) : 0;
  } else {
    slPct = Math.max(0.002, (slPrice - fill) / fill);
    tp1Pct = tp1On ? Math.max(slPct * 0.98, (fill - tp1Price) / fill) : 0;
    tpPct = tp2On ? Math.max(slPct * 1.2, (fill - tp2Price) / fill) : 0;
  }

  const rr = slPct > 0 && tp2On ? tpPct / slPct : 0;
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  if (minRr > 0 && tp2On && rr < minRr) return null;

  const maxSl = Number(opts.intradayLiqMaxSlPct ?? 0);
  if (maxSl > 0 && slPct > maxSl) return null;

  return {
    slPct,
    tpPct,
    tp1Pct,
    slPrice,
    tpPrice: tp2On ? tp2Price : 0,
    tp1Price: tp1On ? tp1Price : 0,
    tp2Price: tp2On ? tp2Price : 0,
    tpMode: slOnly
      ? "session_liquidity_sl_only"
      : tp1On && tp2On
        ? "session_liquidity_partial"
        : tp1On
          ? "session_liquidity_tp1"
          : "session_liquidity",
    rr,
    sweepWick: wick,
    opposingLevel: tpLevel,
    partialTp: tp1On,
    tp2Enabled: tp2On,
    slOnly,
    partialFrac,
  };
}

/** Map resolved liquidity brackets + runtime cfg to backtest/live entry legs. */
export function mapLiquidityEntryLegs(liqBr, cfg = {}) {
  if (!liqBr || !(Number(liqBr.slPrice) > 0)) return null;
  const stages = resolveLiqExitStages(cfg);
  const tp1On = stages.tp1On && liqBr.partialTp !== false && Number(liqBr.tp1Price) > 0;
  const tp2On =
    stages.tp2On &&
    liqBr.tp2Enabled !== false &&
    (Number(liqBr.tp2Price) > 0 || Number(liqBr.tpPrice) > 0);
  const beAt1R = stages.beAt1RWithoutPartial && Number(liqBr.beTriggerPx) > 0;
  return {
    slPrice: Number(liqBr.slPrice),
    tp: tp2On ? Number(liqBr.tp2Price ?? liqBr.tpPrice) : 0,
    tp1: tp1On ? Number(liqBr.tp1Price) : 0,
    partialTp: tp1On,
    partialFrac: liqBr.partialFrac ?? 0.5,
    beTriggerPx: beAt1R ? Number(liqBr.beTriggerPx) : 0,
    beAt1R,
    stages,
  };
}

function buildSetupFromCycle(candles, cycle, side, opts, dayStart = 0) {
  const pre = opts._liqPre;
  const setupOpts = { ...opts, intradayLiqMinSweepExtensionPct: opts.intradayLiqMinSweepExtensionPct ?? 0.008 };
  if (!passesLiqHtfAlign(side, cycle.reclaimIdx, pre, setupOpts, cycle.levelType)) return null;
  const bar = candles[cycle.reclaimIdx];

  if (opts.intradayLiqRejectSameBarReclaim === true && cycle.reclaimIdx === cycle.sweepStartIdx) {
    return null;
  }

  if (!passesReclaimStrength(bar, cycle, side, opts)) return null;

  const minWick = Number(opts.intradayLiqMinWickRatio ?? 0);
  if (minWick > 0) {
    const wickRatio = rejectionWickRatio(bar, side);
    if (wickRatio < minWick) return null;
    if (side === "BUY" && bar.close <= bar.open) return null;
    if (side === "SELL" && bar.close >= bar.open) return null;
  }

  const brackets = computeLiquidityBrackets(side, bar.close, cycle.wick, cycle.opposing, opts);
  if (!brackets) return null;

  const q = cycleQualityScore(cycle, brackets, dayStart, setupOpts);
  const minQ = Number(opts.intradayLiqMinQuality ?? 0);
  if (minQ > 0 && q < minQ) return null;
  const techniques = ["liq_sweep", cycle.levelType];

  return {
    side,
    action: side,
    level: cycle.level,
    levelType: cycle.levelType,
    wick: cycle.wick,
    sweepWick: cycle.wick,
    sweepStartIdx: cycle.sweepStartIdx,
    reclaimIdx: cycle.reclaimIdx,
    entry: bar.close,
    extension: cycle.extension,
    liqQuality: q,
    ...brackets,
    techniques,
    score: Math.min(12, Math.round(6 + q / 50)),
  };
}

/**
 * All valid liquidity setups at bar `idx` (PDH/PDL + optional session extreme).
 */
export function listSessionLiquiditySetups(candles, idx, side, pre, opts = {}) {
  if (!candles?.length || idx < 1) return [];

  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? DEFAULT_LIQ_SWEEP_PCT);
  const i = idx;
  const pdh = pre.prevDayHigh?.[i];
  const pdl = pre.prevDayLow?.[i];
  const dayStart = dayStartIndex(candles, idx);
  const setups = [];

  const sessionLevel = side === "BUY" ? pdl : pdh;
  const sessionOpposing = side === "BUY" ? pdh : pdl;
  const sessionType = side === "BUY" ? "pdl" : "pdh";

  if (sessionLevel > 0 && sessionOpposing > 0) {
    const cycles = scanSessionLiquidityCycles(
      candles,
      idx,
      side,
      sessionLevel,
      sessionOpposing,
      sessionType,
      sweepPct,
      dayStart,
      opts,
    );
    for (let cycIdx = 0; cycIdx < cycles.length; cycIdx++) {
      const c = cycles[cycIdx];
      if (c.reclaimIdx !== idx) continue;
      if (opts.intradayLiqFirstCycleOnly === true && cycIdx > 0) continue;
      const s = buildSetupFromCycle(candles, c, side, opts, dayStart);
      if (s) setups.push(s);
    }
  }

  const extreme = resolveSessionExtremeLevel(candles, idx, side, dayStart, opts);
  if (
    extreme &&
    sessionLevel > 0 &&
    Math.abs(extreme.level - sessionLevel) / sessionLevel >
      Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005)
  ) {
    const opp = side === "BUY" ? pdh : pdl;
    if (opp > 0) {
      const cycles = scanSessionLiquidityCycles(
        candles,
        idx,
        side,
        extreme.level,
        opp,
        extreme.levelType,
        sweepPct,
        dayStart,
        opts,
      );
      for (let cycIdx = 0; cycIdx < cycles.length; cycIdx++) {
        const c = cycles[cycIdx];
        if (c.reclaimIdx !== idx) continue;
        if (opts.intradayLiqFirstCycleOnly === true && cycIdx > 0) continue;
        const s = buildSetupFromCycle(candles, c, side, opts, dayStart);
        if (s) setups.push(s);
      }
    }
  }

  return setups;
}

/** Best setup at bar (highest quality score). */
export function evaluateSessionLiquiditySweep(candles, idx, side, pre, opts = {}) {
  const list = listSessionLiquiditySetups(candles, idx, side, pre, opts);
  if (!list.length) return null;

  const sessionSetups = list.filter((s) => s.levelType === "pdh" || s.levelType === "pdl");
  const clusterSetups = list.filter((s) => s.levelType === "session_low" || s.levelType === "session_high");

  if (sessionSetups.length && clusterSetups.length) {
    sessionSetups.sort((a, b) => b.liqQuality - a.liqQuality);
    clusterSetups.sort((a, b) => b.liqQuality - a.liqQuality);
    const bestSession = sessionSetups[0];
    const bestCluster = clusterSetups[0];
    const extBias = Number(opts.intradayLiqSessionExtremeExtensionBias ?? 1.35);
    if (
      bestCluster.extension > bestSession.extension * extBias &&
      bestCluster.liqQuality > bestSession.liqQuality
    ) {
      return bestCluster;
    }
    return bestSession;
  }

  list.sort((a, b) => b.liqQuality - a.liqQuality);
  return list[0];
}

function preferLaterComparableCycle(next, prev) {
  if (!prev) return true;
  if (next.extension > prev.extension * 1.25) return true;
  if (prev.extension > next.extension * 1.25) return false;
  if (next.reclaimIdx !== prev.reclaimIdx) {
    if (Math.abs(next.extension - prev.extension) / Math.max(prev.extension, 1e-9) < 0.15) {
      return next.reclaimIdx < prev.reclaimIdx;
    }
    return next.reclaimIdx > prev.reclaimIdx;
  }
  return next.liqQuality > prev.liqQuality;
}

function bestFromCycles(candles, idx, side, level, opposing, levelType, sweepPct, dayStart, opts) {
  const cycles = scanSessionLiquidityCycles(
    candles,
    idx,
    side,
    level,
    opposing,
    levelType,
    sweepPct,
    dayStart,
    opts,
  );
  let best = null;
  for (const c of cycles) {
    const s = buildSetupFromCycle(candles, c, side, opts, dayStart);
    if (!s) continue;
    if (preferLaterComparableCycle(s, best)) best = s;
  }
  return best;
}

/** Best cycle for a full day up to idx — used for pick deduplication. */
export function bestSessionLiquidityForDaySide(candles, idx, side, pre, opts = {}) {
  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? DEFAULT_LIQ_SWEEP_PCT);
  const dayStart = dayStartIndex(candles, idx);
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];

  let bestSession = null;
  if (side === "BUY" && pdl > 0 && pdh > 0) {
    bestSession = bestFromCycles(candles, idx, side, pdl, pdh, "pdl", sweepPct, dayStart, opts);
  } else if (side === "SELL" && pdh > 0 && pdl > 0) {
    bestSession = bestFromCycles(candles, idx, side, pdh, pdl, "pdh", sweepPct, dayStart, opts);
  }

  const extreme = resolveSessionExtremeLevel(candles, idx, side, dayStart, opts);
  const sessionLevel = side === "BUY" ? pdl : pdh;
  let bestCluster = null;
  if (
    extreme &&
    sessionLevel > 0 &&
    Math.abs(extreme.level - sessionLevel) / sessionLevel >
      Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005)
  ) {
    const opp = side === "BUY" ? pdh : pdl;
    if (opp > 0) {
      bestCluster = bestFromCycles(
        candles,
        idx,
        side,
        extreme.level,
        opp,
        extreme.levelType,
        sweepPct,
        dayStart,
        opts,
      );
    }
  }

  if (bestSession && bestCluster) {
    const extBias = Number(opts.intradayLiqSessionExtremeExtensionBias ?? 1.35);
    if (
      bestCluster.extension > bestSession.extension * extBias &&
      bestCluster.liqQuality > bestSession.liqQuality
    ) {
      return bestCluster;
    }
    return bestSession;
  }
  return bestSession || bestCluster;
}

/**
 * Reprice structure brackets to actual fill (same pattern as fib).
 */
export function resolveLiquidityEntryBrackets(_cfg = {}, barSignal = null, entryFill = null, side = null) {
  const baked = barSignal?.liqBrackets;
  if (!baked || !(Number(baked.slPct) > 0)) return null;

  const tradeSide = side || barSignal?.action;
  const fill = Number(entryFill);
  if (!Number.isFinite(fill) || fill <= 0) return null;

  let slPct = baked.slPct;
  let tpPct = baked.tpPct;
  let tp1Pct = baked.tp1Pct;
  let slPrice = Number(baked.slPrice);
  let tpPrice = Number(baked.tp2Price ?? baked.tpPrice);
  let tp1Price = Number(baked.tp1Price);

  const risk = Math.abs(fill - slPrice);
  const stages = resolveLiqExitStages(_cfg);
  const { tp1On, tp2On } = stages;
  const bakedTp1 = baked.partialTp !== false;
  const bakedTp2 = baked.tp2Enabled !== false;
  let beTriggerPx = 0;
  if (stages.beAt1RWithoutPartial && risk > 0) {
    beTriggerPx = tradeSide === "BUY" ? fill + risk : fill - risk;
  }

  if (bakedTp1 && tp1On && Number.isFinite(tp1Price) && risk > 0) {
    if (tradeSide === "BUY") {
      tp1Price = fill + risk;
      tp1Pct = (tp1Price - fill) / fill;
    } else {
      tp1Price = fill - risk;
      tp1Pct = (fill - tp1Price) / fill;
    }
  } else {
    tp1Price = 0;
    tp1Pct = 0;
  }

  if (!tp2On || !bakedTp2) {
    tpPrice = 0;
    tpPct = 0;
  }

  if (Number.isFinite(slPrice) && slPrice > 0) {
    if (tradeSide === "BUY") {
      slPct = Math.max(0.002, (fill - slPrice) / fill);
      if (tp2On && bakedTp2 && tpPrice > 0) {
        tpPct = Math.max(slPct * 1.2, (tpPrice - fill) / fill);
      }
      if (tp1On && bakedTp1 && tp1Price > 0) {
        tp1Pct = Math.max(slPct * 0.98, (tp1Price - fill) / fill);
      }
    } else {
      slPct = Math.max(0.002, (slPrice - fill) / fill);
      if (tp2On && bakedTp2 && tpPrice > 0) {
        tpPct = Math.max(slPct * 1.2, (fill - tpPrice) / fill);
      }
      if (tp1On && bakedTp1 && tp1Price > 0) {
        tp1Pct = Math.max(slPct * 0.98, (fill - tp1Price) / fill);
      }
    }
  }

  return {
    slPct,
    tpPct,
    tp1Pct,
    slPrice,
    tpPrice,
    tp1Price,
    tp2Price: tpPrice,
    tpMode: baked.tpMode ?? "session_liquidity_partial",
    rr: slPct > 0 && tpPrice > 0 ? tpPct / slPct : baked.rr ?? 0,
    sweepWick: baked.sweepWick,
    opposingLevel: baked.opposingLevel,
    partialTp: bakedTp1 && tp1On,
    tp2Enabled: bakedTp2 && tp2On,
    beTriggerPx,
    beAt1RWithoutPartial: stages.beAt1RWithoutPartial && beTriggerPx > 0,
    partialFrac: baked.partialFrac ?? 0.5,
    level: baked.level,
    levelType: baked.levelType,
  };
}
