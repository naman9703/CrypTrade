/**
 * Liquidity sweep — session PDH/PDL + optional session extreme clusters.
 *
 * Strict rules:
 * - Sweep pierces named liquidity (PDH/PDL or established session high/low)
 * - Deepest wick tracked per cycle; failed breakdowns start a new cycle
 * - Entry on reclaim close; SL beyond wick; TP1 @ 1R partial, TP2 @ opposing session liquidity
 */

import { resolveLiquidityCandidates } from "./liq/liquidityLevels.js";
import {
  buildLiqMarketContext,
  passesLiqMarketActivationForSetup,
} from "./liq/marketState.js";
import { computeSweepQuality, passesSweepQualityGate } from "./liq/sweepQuality.js";
import { computeDisplacementV2, passesDisplacementV2Gate } from "./liq/displacementV2.js";
import {
  evaluateContinuationRoom,
  passesContinuationRoomGate,
} from "./liq/continuationRoom.js";
import { computeEntryScoreV2 } from "./liq/entryScoreV2.js";
import { buildLiqFeatureVector } from "./liq/featureVector.js";
import { detectChochInRange } from "./bosChoch.js";

export const DEFAULT_LIQ_SWEEP_PCT = 0.001;
export const DEFAULT_LIQ_SL_BUFFER_PCT = 0.0015;

/** Trail-only LIQ: no partial ladder — exit is supertrend trail, not opposing-pool TP. */
export function isLiqTrailOnlyExit(opts = {}) {
  return (
    opts.intradayLiqAllowTrailOnlyExit === true &&
    opts.trailingStopLossAuto === true &&
    opts.intradayLiqPartialTp === false &&
    opts.intradayLiqTp1Enabled === false &&
    opts.intradayLiqTp2Enabled === false
  );
}

/** Displacement gate opts — trail-only defaults on unless explicitly disabled. */
export function resolveLiqDisplacementGateOpts(opts = {}) {
  const trailOnly = isLiqTrailOnlyExit(opts);
  const explicitOff = opts.intradayLiqRequireSweepDisplacement === false;
  const explicitMult = Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 0);
  const required =
    !explicitOff &&
    (opts.intradayLiqRequireSweepDisplacement === true ||
      explicitMult > 0 ||
      (trailOnly && opts.intradayLiqTrailRequireDisplacement !== false));
  if (!required) return { required: false, opts };
  const minMult =
    explicitMult > 0
      ? explicitMult
      : Number(opts.intradayLiqDisplacementBarAtrMult ?? (trailOnly ? 1.2 : 1.5));
  return {
    required: true,
    opts: {
      ...opts,
      intradayLiqRequireSweepDisplacement: true,
      intradayLiqSweepDisplacementMinAtrMult: minMult,
    },
  };
}

/** Trail-only uses context score (0–100); classic partial-TP uses cycleQuality or explicit entry score. */
export function resolveLiqEntryScoreMode(opts = {}) {
  const trailOnly = isLiqTrailOnlyExit(opts);
  if (trailOnly) {
    if (opts.intradayLiqTrailUseContextScore === false) return false;
    return true;
  }
  return opts.intradayLiqUseEntryScore === true;
}

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

/**
 * Backtest/live runner: which liquidity TP legs can fire on this bar.
 * TP2 partial ladder (tp2PartialFrac) only applies when TP1 partial is on;
 * with TP1 off, full-size TP2 uses `hitTP` even if tp2PartialFrac is set in cfg.
 */
export function resolveLiqRunnerTpHits(pos, bar, isLong, liqStages = null) {
  const stages = liqStages ?? pos?.liqExitStages ?? {};
  const tp2PartialLadder = Number(pos?.tp2PartialFrac) > 0 && pos?.partialTp === true;
  const hitTp1 =
    stages.tp1On !== false &&
    pos?.partialTp &&
    !pos?.partialTaken &&
    Number(pos?.tp1) > 0 &&
    (isLong ? bar.high >= pos.tp1 : bar.low <= pos.tp1);
  const hitTp2 =
    stages.tp2On !== false &&
    pos?.partialTaken &&
    !pos?.tp2PartialTaken &&
    Number(pos?.tp2PartialFrac) > 0 &&
    Number(pos?.tp) > 0 &&
    (isLong ? bar.high >= pos.tp : bar.low <= pos.tp);
  const hitTP =
    stages.tp2On !== false &&
    Number(pos?.tp) > 0 &&
    (pos?.partialTaken || !pos?.partialTp) &&
    !tp2PartialLadder &&
    (isLong ? bar.high >= pos.tp : bar.low <= pos.tp);
  return { hitTp1, hitTp2, hitTP, tp2PartialLadder };
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

/**
 * Guide-style rejection: rejection wick / body (not wick/range).
 * Body==0 → fail when gate is on (doji is not a clear rejection).
 */
export function rejectionWickBodyRatio(bar, side) {
  const body = Math.abs(Number(bar.close) - Number(bar.open));
  if (!(body > 0)) return 0;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBot = Math.min(bar.open, bar.close);
  const wick = side === "BUY" ? bodyBot - Number(bar.low) : Number(bar.high) - bodyTop;
  return Math.max(0, wick) / body;
}

/** Sweep poke bar must show real rejection into the level (filters shallow stop-runs). */
export function passesSweepPokeRejection(candles, cycle, side, opts = {}) {
  const minWick = Number(opts.intradayLiqMinSweepPokeWickRatio ?? 0);
  const minBody = Number(opts.intradayLiqMinSweepWickBodyRatio ?? 0);
  if (!(minWick > 0) && !(minBody > 0)) return true;
  const idx = Number(cycle.sweepStartIdx);
  const bar = candles[idx];
  if (!bar) return false;
  if (minWick > 0 && rejectionWickRatio(bar, side) + 1e-6 < minWick) return false;
  if (minBody > 0 && rejectionWickBodyRatio(bar, side) + 1e-6 < minBody) return false;
  return true;
}

/** Entry bar must still hold beyond the swept level (reclaim not already failing). */
export function passesEntryLevelHold(bar, cycle, side, opts = {}) {
  if (!bar) return false;
  const minClosePct = Number(opts.intradayLiqMinEntryClosePct ?? opts.intradayLiqMinReclaimClosePct ?? 0);
  if (!(minClosePct > 0)) {
    if (side === "BUY") return bar.close > cycle.level;
    return bar.close < cycle.level;
  }
  const closeDelta =
    side === "BUY"
      ? (bar.close - cycle.level) / Math.max(cycle.level, 1e-9)
      : (cycle.level - bar.close) / Math.max(cycle.level, 1e-9);
  return closeDelta + 1e-6 >= minClosePct;
}

/** Cap repeated sweeps of the same pool without enabling the full sweep-quality gate stack. */
export function passesSweepAttemptCap(cycle, opts = {}) {
  if (opts.intradayLiqSweepQualityGate === true) return true;
  const maxAttempts = Number(opts.intradayLiqMaxSweepAttempts ?? 0);
  if (!(maxAttempts > 0)) return true;
  return Number(cycle.attemptCount ?? 1) <= maxAttempts;
}

export function dayStartIndex(candles, idx) {
  const d = utcDayId(candles[idx].ts);
  for (let j = idx; j >= 0; j--) {
    if (utcDayId(candles[j].ts) !== d) return j + 1;
  }
  return 0;
}

/** Intraday range as % of mid-price from UTC day open through `idx`. */
export function intradayDayRangePct(candles, idx, dayStart = 0) {
  if (!candles?.length || idx < dayStart) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = dayStart; j <= idx; j++) {
    const b = candles[j];
    if (!b) continue;
    hi = Math.max(hi, Number(b.high));
    lo = Math.min(lo, Number(b.low));
  }
  const mid = (hi + lo) / 2;
  return mid > 0 ? (hi - lo) / mid : 0;
}

/** Bars since the last displacement candle (range ≥ ATR × mult) on the current UTC day. */
export function barsSinceDisplacement(candles, idx, dayStart, pre, opts = {}) {
  const atrMult = Number(opts.intradayLiqDisplacementBarAtrMult ?? 2);
  if (atrMult <= 0) return Infinity;
  for (let j = idx; j >= dayStart; j--) {
    const bar = candles[j];
    const atr = Number(pre?.atr?.[j] ?? 0);
    const range = Number(bar?.high) - Number(bar?.low);
    if (atr > 0 && range >= atr * atrMult) return idx - j;
  }
  return Infinity;
}

/**
 * Entry routing for trail / big-move setups.
 * - fade (default): classical sweep+reclaim mean reversion
 * - trend_pullback: only WITH HTF — buy dips after low sweeps, sell rips after high sweeps
 */
export function passesLiqEntryMode(side, idx, pre, opts = {}, levelType = "") {
  if (opts.intradayLiqPdhPdlOnly === true && levelType !== "pdh" && levelType !== "pdl") {
    return false;
  }
  const mode = String(opts.intradayLiqEntryMode ?? "fade").toLowerCase();
  if (mode !== "trend_pullback" && mode !== "trend_aligned") return true;
  if (side === "BUY" && !pre?.htfUp?.[idx]) return false;
  if (side === "SELL" && !pre?.htfDown?.[idx]) return false;
  return true;
}

/** Require trending but not exhausted conditions (ADX band). */
export function passesLiqAdxEntry(idx, pre, opts = {}) {
  const adx = pre?.adxSeries?.[idx];
  const minAdx = Number(opts.intradayLiqMinAdx ?? 0);
  const maxAdx = Number(opts.intradayLiqMaxAdx ?? 0);
  if (minAdx > 0 && (!Number.isFinite(adx) || adx < minAdx)) return false;
  if (maxAdx > 0 && Number.isFinite(adx) && adx > maxAdx) return false;
  return true;
}

/** Veto liquidity fades on wide-range or post-displacement days (crypto regime filter). */
export function passesLiqRegimeFilters(candles, idx, dayStart, pre, opts = {}) {
  const maxDayRange = Number(opts.intradayLiqMaxFadeDayRangePct ?? 0);
  if (maxDayRange > 0 && intradayDayRangePct(candles, idx, dayStart) > maxDayRange) return false;

  const cooldown = Number(opts.intradayLiqPostDisplacementCooldownBars ?? 0);
  if (cooldown > 0 && barsSinceDisplacement(candles, idx, dayStart, pre, opts) < cooldown) {
    return false;
  }
  return true;
}

function sweepExtension(side, level, wick) {
  if (!level || level <= 0) return 0;
  return side === "BUY" ? (level - wick) / level : (wick - level) / level;
}

function isSessionClusterLevel(levelType) {
  return levelType === "session_low" || levelType === "session_high";
}

/**
 * A poke requires price to pierce BEYOND the level. PDH/PDL use `sweepPct`;
 * session clusters (EQH/EQL) use their own `clusterPct` — equal highs/lows are
 * at least as significant as PDH/PDL, so they require a real (small) pierce too,
 * not a bare touch, which otherwise fires on spread alone in ranges.
 */
function sweepPoked(side, bar, level, sweepPct, levelType, clusterPct = 0) {
  if (isSessionClusterLevel(levelType)) {
    const cp = clusterPct > 0 ? clusterPct : 0;
    return side === "BUY" ? bar.low < level * (1 - cp) : bar.high > level * (1 + cp);
  }
  return side === "BUY" ? bar.low < level * (1 - sweepPct) : bar.high > level * (1 + sweepPct);
}

/** Mean volume over the `lookback` bars before idx (excludes idx). 0 → unknown. */
function trailingAvgVolume(candles, idx, lookback) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = Number(candles[j]?.volume);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Genuine stop-hunts usually spike volume at the sweep candle itself. When
 * `minVolRatio > 0`, require the poke bar's volume to exceed `minVolRatio` × the
 * trailing average. Missing/zero volume data → pass (don't block backtests that
 * lack volume). Default off, so this never changes existing behaviour.
 */
function sweepBarVolumeOk(candles, idx, minVolRatio, lookback) {
  if (!(minVolRatio > 0)) return true;
  const v = Number(candles[idx]?.volume);
  if (!Number.isFinite(v) || v <= 0) return true;
  const avg = trailingAvgVolume(candles, idx, lookback);
  if (avg <= 0) return true;
  return v >= minVolRatio * avg;
}

function passesSweepFilters(side, level, wick, sweepStartIdx, reclaimIdx, opts, levelType = "") {
  let minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.003);
  if (isSessionClusterLevel(levelType)) {
    minExt = Math.min(minExt, Number(opts.intradayLiqSessionExtremeMinExtensionPct ?? 0.0005));
  }
  const ext = sweepExtension(side, level, wick);
  if (minExt > 0 && ext + 1e-6 < minExt) {
    if (!isSessionClusterLevel(levelType)) return false;
    // Opt-in hard floor: default soft-pass still allows directional shallow pokes
    // (BTC SMC autopsy: ~45% of sweep entries had extension < 0.3% via this path).
    if (opts.intradayLiqSessionExtremeHardMinExt === true) return false;
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

  const clusterPct = Number(opts.intradayLiqSessionExtremeSweepPct ?? 0.0005);
  const minSweepVol = Number(opts.intradayLiqSweepMinVolRatio ?? 0);
  const volLookback = Math.max(2, Number(opts.intradayLiqSweepVolLookback ?? 20));
  const poked = (j) =>
    sweepPoked(side, candles[j], level, sweepPct, levelType, clusterPct) &&
    sweepBarVolumeOk(candles, j, minSweepVol, volLookback);

  // Optional timeframe-proportional reclaim window: express the limit in minutes
  // (independent of bar count) so 40 bars doesn't mean 40m on 1m and 10h on 15m.
  let scanOpts = opts;
  const maxMinutes = Number(opts.intradayLiqMaxSweepMinutes ?? 0);
  if (maxMinutes > 0 && candles.length > 1) {
    const barMs = Math.abs(candles[1].ts - candles[0].ts) || 900_000;
    scanOpts = { ...opts, intradayLiqMaxSweepBars: Math.max(1, Math.round((maxMinutes * 60_000) / barMs)) };
  }

  const cycles = [];
  let sweepActive = false;
  let extreme = side === "BUY" ? Infinity : -Infinity;
  let sweepStartIdx = -1;
  let awaitingFailure = false;
  let cycleAttempts = 0;

  for (let j = dayStart; j <= idx; j++) {
    const b = candles[j];

    if (side === "BUY") {
      if (poked(j)) {
        cycleAttempts++;
        sweepActive = true;
        awaitingFailure = false;
        if (sweepStartIdx < 0) sweepStartIdx = j;
        extreme = Math.min(extreme, b.low);
      }
      if (sweepActive) extreme = Math.min(extreme, b.low);

      if (sweepActive && b.close > level) {
        if (passesSweepFilters(side, level, extreme, sweepStartIdx, j, scanOpts, levelType)) {
          cycles.push({
            reclaimIdx: j,
            wick: extreme,
            sweepStartIdx,
            level,
            levelType,
            opposing,
            extension: sweepExtension(side, level, extreme),
            attemptCount: Math.max(1, cycleAttempts),
          });
        }
        sweepActive = false;
        awaitingFailure = true;
        extreme = Infinity;
        sweepStartIdx = -1;
        cycleAttempts = 0;
      } else if (awaitingFailure && b.close < level * (1 - sweepPct * 0.5)) {
        awaitingFailure = false;
      }
    } else {
      if (poked(j)) {
        cycleAttempts++;
        sweepActive = true;
        awaitingFailure = false;
        if (sweepStartIdx < 0) sweepStartIdx = j;
        extreme = Math.max(extreme, b.high);
      }
      if (sweepActive) extreme = Math.max(extreme, b.high);

      if (sweepActive && b.close < level) {
        if (passesSweepFilters(side, level, extreme, sweepStartIdx, j, scanOpts, levelType)) {
          cycles.push({
            reclaimIdx: j,
            wick: extreme,
            sweepStartIdx,
            level,
            levelType,
            opposing,
            extension: sweepExtension(side, level, extreme),
            attemptCount: Math.max(1, cycleAttempts),
          });
        }
        sweepActive = false;
        awaitingFailure = true;
        extreme = -Infinity;
        sweepStartIdx = -1;
        cycleAttempts = 0;
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

/** HTF gate on session clusters; PDH/PDL skip trend filter only when counter-trend veto is off
 * and explicit pdh/pdl HTF align is not requested (LIQ_CORE may set intradayLiqHtfAlignPdhPdl). */
function passesLiqHtfAlign(side, reclaimIdx, pre, opts = {}, levelType = "") {
  if (opts.intradayLiqRequireHtfAlign !== true || !pre) return true;
  const vetoCt = opts.intradayLiqVetoCounterTrend === true;
  const alignPdhPdl = opts.intradayLiqHtfAlignPdhPdl === true;
  if ((levelType === "pdh" || levelType === "pdl") && !vetoCt && !alignPdhPdl) return true;
  const minSep = Number(opts.intradayLiqMinHtfSep ?? 0.0008);
  const sep = pre.htfSep?.[reclaimIdx] ?? 0;
  if (sep < minSep) return true;
  if (side === "BUY" && pre.htfDown?.[reclaimIdx]) return false;
  if (side === "SELL" && pre.htfUp?.[reclaimIdx]) return false;
  return true;
}

function cycleQualityScore(cycle, brackets, dayStart = 0, opts = {}, reclaimBar = null, side = "BUY") {
  const ext = cycle.extension * 1000;
  // Trail-only exits don't use opposing-pool RR — structural RR inflates quality and bypasses minQuality.
  const rr = isLiqTrailOnlyExit(opts) ? 0 : (brackets?.rr ?? 0) * 100;
  let q = ext + rr;
  if (cycle.levelType === "pdh" || cycle.levelType === "pdl") q += 20;
  if (cycle.reclaimIdx === cycle.sweepStartIdx) {
    // Same-bar sweep+reclaim is usually low quality — UNLESS it's a genuine
    // stop-hunt pinbar (long rejection wick vs tiny body), which is a textbook
    // high-quality setup. Waive the penalty when wick ≥ ratio × body.
    const pinRatio = Number(opts.intradayLiqSameBarPinbarWickBody ?? 2.5);
    let waive = false;
    if (reclaimBar && pinRatio > 0) {
      const body = Math.abs(Number(reclaimBar.close) - Number(reclaimBar.open)) || 1e-9;
      const wick =
        side === "BUY"
          ? Math.min(reclaimBar.open, reclaimBar.close) - reclaimBar.low
          : reclaimBar.high - Math.max(reclaimBar.open, reclaimBar.close);
      if (wick / body >= pinRatio) waive = true;
    }
    if (!waive) q -= 40;
  }
  const minExtQ = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  if (cycle.extension + 1e-6 < minExtQ) q -= 25;
  const barsIntoDay = cycle.reclaimIdx - dayStart;
  q += Math.min(Math.max(0, barsIntoDay) * 0.25, 12);
  return q;
}

/** Close must remain on the reclaimed side of the swept level. */
export function reclaimHeldOnBar(candles, barIdx, side, level) {
  const bar = candles[barIdx];
  const lv = Number(level);
  if (!bar || !(lv > 0)) return false;
  return side === "BUY" ? Number(bar.close) > lv : Number(bar.close) < lv;
}

/** Reclaim through entry bar must hold — filters immediate re-break (fake reclaim). */
function resolveLiqChochOpts(opts = {}) {
  return {
    ...opts,
    intradaySmcChochRequireTrend: opts.intradayLiqChochRequireTrend === true,
  };
}

/** Require CHoCH/MSS between sweep start and entry bar (literature: reclaim alone is insufficient). */
export function passesLiqChochGate(candles, cycle, side, entryBarIdx, opts = {}) {
  if (opts.intradayLiqRequireChoch !== true || !cycle) return true;
  const choch = detectChochInRange(
    candles,
    cycle.sweepStartIdx,
    entryBarIdx,
    side,
    resolveLiqChochOpts(opts),
  );
  return choch.ok;
}

export function reclaimHeldThrough(candles, reclaimIdx, entryIdx, side, level) {
  if (reclaimIdx < 0 || entryIdx < reclaimIdx) return false;
  for (let j = reclaimIdx; j <= entryIdx; j++) {
    if (!reclaimHeldOnBar(candles, j, side, level)) return false;
  }
  return true;
}

function liqReclaimHoldBars(opts = {}) {
  return Math.max(0, Math.min(3, Math.round(Number(opts.intradayLiqReclaimHoldBars ?? 0))));
}

export { liqReclaimHoldBars };

function liqAcceptHoldBars(opts = {}) {
  const raw = opts.intradayLiqAcceptHoldBars ?? opts.intradayLiqReclaimHoldBars ?? 2;
  return Math.max(0, Math.min(3, Math.round(Number(raw))));
}

export { liqAcceptHoldBars };

/** Close must remain on the acceptance side (failed reclaim / hold-beyond pool). */
export function acceptHeldOnBar(candles, barIdx, poolSide, level) {
  const bar = candles[barIdx];
  const lv = Number(level);
  if (!bar || !(lv > 0)) return false;
  return poolSide === "BUY" ? Number(bar.close) < lv : Number(bar.close) > lv;
}

export function acceptHeldThrough(candles, acceptIdx, entryIdx, poolSide, level) {
  if (acceptIdx < 0 || entryIdx < acceptIdx) return false;
  for (let j = acceptIdx; j <= entryIdx; j++) {
    if (!acceptHeldOnBar(candles, j, poolSide, level)) return false;
  }
  return true;
}

function poolReclaimedOnBar(candles, barIdx, poolSide, level) {
  const bar = candles[barIdx];
  const lv = Number(level);
  if (!bar || !(lv > 0)) return false;
  return poolSide === "BUY" ? Number(bar.close) > lv : Number(bar.close) < lv;
}

/**
 * Brackets for sweep-acceptance (trade WITH the sweep after failed reclaim).
 * SL sits back inside the swept pool; TP at opposing session liquidity.
 */
export function computeAcceptanceBrackets(tradeSide, entry, level, opposingLevel, opts = {}) {
  const fill = Number(entry);
  const lv = Number(level);
  const tpLevel = Number(opposingLevel);
  if (!Number.isFinite(fill) || fill <= 0 || !Number.isFinite(lv) || lv <= 0 || !Number.isFinite(tpLevel) || tpLevel <= 0) {
    return null;
  }

  const buf = Number(opts.slBufferPct ?? opts.intradayLiqSlBufferPct ?? DEFAULT_LIQ_SL_BUFFER_PCT);
  const { tp1On, tp2On } = resolveLiqExitStages(opts);
  const slOnly = !tp1On && !tp2On;
  const trade = tradeSide === "BUY" || tradeSide === "long" ? "BUY" : "SELL";

  let slPrice;
  let tp2Price = tp2On ? tpLevel : 0;
  if (trade === "SELL") {
    slPrice = lv * (1 + buf);
    if (!(slPrice > fill)) return null;
    if (tp2On && !(tp2Price < fill)) return null;
  } else {
    slPrice = lv * (1 - buf);
    if (!(slPrice < fill)) return null;
    if (tp2On && !(tp2Price > fill)) return null;
  }

  const slPct = Math.abs(fill - slPrice) / fill;
  const maxTpRr = Number(opts.intradayLiqMaxTpRr ?? 0);
  let tpPct = 0;
  let tp1Pct = 0;
  let tp1Price = 0;

  if (tp2On && maxTpRr > 0 && slPct > 0) {
    const cap = slPct * maxTpRr;
    const rawTp =
      trade === "BUY" ? Math.max(0, (tp2Price - fill) / fill) : Math.max(0, (fill - tp2Price) / fill);
    tpPct = Math.min(rawTp, cap);
    tp2Price = trade === "BUY" ? fill * (1 + tpPct) : fill * (1 - tpPct);
  } else if (tp2On) {
    tpPct = trade === "BUY" ? Math.max(0, (tp2Price - fill) / fill) : Math.max(0, (fill - tp2Price) / fill);
  }

  const structuralTpPct =
    trade === "BUY" ? Math.max(0, (tpLevel - fill) / fill) : Math.max(0, (fill - tpLevel) / fill);
  const structuralRr = slPct > 0 ? structuralTpPct / slPct : 0;
  const rr = slPct > 0 && tp2On ? tpPct / slPct : structuralRr;
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  if (minRr > 0 && rr + 1e-9 < minRr) return null;

  const maxSl = Number(opts.intradayLiqMaxSlPct ?? 0);
  if (maxSl > 0 && slPct > maxSl) return null;
  const minSl = Number(opts.intradayLiqMinSlPct ?? 0);
  if (minSl > 0 && slPct + 1e-12 < minSl) return null;

  return {
    slPct,
    tpPct,
    tp1Pct,
    slPrice,
    tpPrice: tp2On ? tp2Price : 0,
    tp1Price,
    tp2Price: tp2On ? tp2Price : 0,
    tpMode: slOnly
      ? "accept_liquidity_sl_only"
      : tp1On && tp2On
        ? "accept_liquidity_partial"
        : tp2On
          ? "accept_liquidity"
          : "accept_liquidity_sl_only",
    rr,
    sweepWick: trade === "SELL" ? fill : fill,
    opposingLevel: tpLevel,
    partialTp: tp1On,
    tp2Enabled: tp2On,
    slOnly,
    acceptMode: true,
  };
}

/**
 * Max bar range / ATR between sweep start and reclaim (inclusive).
 * ICT: reclaim after sweep should follow displacement, not a slow drift in chop.
 */
export function maxSweepCycleImpulseAtr(candles, sweepStartIdx, reclaimIdx, pre) {
  if (!candles?.length || sweepStartIdx < 0 || reclaimIdx < sweepStartIdx) return 0;
  let best = 0;
  for (let j = sweepStartIdx; j <= reclaimIdx; j++) {
    const atr = Number(pre?.atrSeries?.[j] ?? 0);
    if (!(atr > 0)) continue;
    const range = Number(candles[j]?.high) - Number(candles[j]?.low);
    if (!Number.isFinite(range)) continue;
    best = Math.max(best, range / atr);
  }
  return best;
}

/** Require at least one impulsive bar in the sweep→reclaim (or entry) window. */
export function passesLiqSweepDisplacement(cycle, candles, pre, opts = {}, entryBarIdx = null) {
  const required =
    opts.intradayLiqRequireSweepDisplacement === true ||
    Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 0) > 0;
  if (!required) return true;
  const minMult = Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 0);
  const threshold =
    minMult > 0 ? minMult : Number(opts.intradayLiqDisplacementBarAtrMult ?? 1.5);
  if (!(threshold > 0)) return true;
  const endIdx =
    Number.isFinite(entryBarIdx) && entryBarIdx >= cycle.reclaimIdx
      ? entryBarIdx
      : cycle.reclaimIdx;
  const impulse = maxSweepCycleImpulseAtr(candles, cycle.sweepStartIdx, endIdx, pre);
  return impulse + 1e-9 >= threshold;
}

/**
 * ICT-style confirmation after reclaim: require at least one displacement candle
 * (body >= ATR × mult, close aligned with trade) between reclaim and entry.
 * Filters slow drifts and fake reclaims that never show institutional force.
 */
export function passesPostReclaimDisplacement(candles, cycle, side, pre, opts = {}, entryBarIdx = null) {
  if (opts.intradayLiqRequirePostReclaimDisplacement !== true) return true;
  const mult = Number(opts.intradayLiqPostReclaimDispAtrMult ?? 1.0);
  if (!(mult > 0)) return true;
  const start = Number(cycle.reclaimIdx);
  const end = Number.isFinite(entryBarIdx) ? entryBarIdx : start;
  if (start < 0 || end < start) return false;

  for (let j = start; j <= end; j++) {
    const b = candles[j];
    const atr = Number(pre?.atrSeries?.[j] ?? pre?.atr?.[j] ?? 0);
    if (!b || !(atr > 0)) continue;
    const body = Math.abs(b.close - b.open);
    const aligned = side === "BUY" ? b.close > b.open : b.close < b.open;
    if (!aligned) continue;
    if (body + 1e-9 >= atr * mult) return true;
  }
  return false;
}

/**
 * Resolve follow-through ATR mult / lookback bars.
 * Modes (opts.intradayLiqFollowThroughMode):
 *   fixed   — base mult/bars (default)
 *   atrPct  — quiet ATR% → higher mult; busy → lower
 *   volSpike — weak sweep vol → higher mult
 *   regime  — range vs breakout/breakdown (mult, bars)
 *
 * @param {object} opts
 * @param {{ atrPct?: number, volSpike?: number, daySituation?: string }} ctx
 */
export function resolveFollowThroughParams(opts = {}, ctx = {}) {
  const mode = String(opts.intradayLiqFollowThroughMode ?? "fixed").toLowerCase();
  let mult = Number(opts.intradayLiqFollowThroughAtrMult ?? 0.5);
  let lookBars = Math.max(1, Math.floor(Number(opts.intradayLiqFollowThroughBars ?? 2)));
  const atrPct = Number(ctx.atrPct ?? 0);
  const volSpike = Number(ctx.volSpike ?? 1);
  const daySituation = String(ctx.daySituation ?? "range");

  if (mode === "atrpct") {
    const quietThresh = Number(opts.intradayLiqFtQuietAtrPct ?? 0.004);
    const busyThresh = Number(opts.intradayLiqFtBusyAtrPct ?? 0.01);
    const quietMult = Number(opts.intradayLiqFtQuietMult ?? 1.0);
    const busyMult = Number(opts.intradayLiqFtBusyMult ?? 0.4);
    if (atrPct > 0 && atrPct <= quietThresh) mult = quietMult;
    else if (atrPct >= busyThresh) mult = busyMult;
    else if (atrPct > 0) {
      const t = (atrPct - quietThresh) / Math.max(1e-9, busyThresh - quietThresh);
      mult = quietMult + t * (busyMult - quietMult);
    }
  } else if (mode === "volspike") {
    const weakVol = Number(opts.intradayLiqFtWeakVol ?? 1.2);
    const weakMult = Number(opts.intradayLiqFtWeakVolMult ?? 1.0);
    const strongMult = Number(opts.intradayLiqFtStrongVolMult ?? 0.4);
    mult = volSpike < weakVol ? weakMult : strongMult;
  } else if (mode === "regime") {
    const rangeMult = Number(opts.intradayLiqFtRangeMult ?? 0.5);
    const rangeBars = Math.max(1, Math.floor(Number(opts.intradayLiqFtRangeBars ?? 2)));
    const breakMult = Number(opts.intradayLiqFtBreakMult ?? 1.0);
    const breakBars = Math.max(1, Math.floor(Number(opts.intradayLiqFtBreakBars ?? 3)));
    if (daySituation === "breakout" || daySituation === "breakdown") {
      mult = breakMult;
      lookBars = breakBars;
    } else {
      mult = rangeMult;
      lookBars = rangeBars;
    }
  }

  return { mult, lookBars, mode };
}

/**
 * Measure post-sweep displacement in ATR units (research + gate helper).
 * @returns {{ atrMoved: number, atr: number, ratio: number, ok: boolean }}
 */
export function measureGuideFollowThrough(candles, cycle, side, pre, lookBars = 2) {
  const sweepIdx = Number(cycle?.sweepStartIdx);
  const empty = { atrMoved: 0, atr: 0, ratio: 0, ok: false };
  if (!(sweepIdx >= 0) || !candles?.length || sweepIdx >= candles.length - 1) return empty;
  const atr = Number(pre?.atrSeries?.[sweepIdx] ?? pre?.atr?.[sweepIdx] ?? 0);
  const bars = Math.max(1, Math.floor(Number(lookBars) || 2));
  const end = Math.min(candles.length - 1, sweepIdx + bars);
  const sweepBar = candles[sweepIdx];
  if (!sweepBar) return empty;
  let atrMoved = 0;
  if (side === "BUY") {
    let hi = -Infinity;
    for (let j = sweepIdx + 1; j <= end; j++) hi = Math.max(hi, Number(candles[j].high));
    atrMoved = hi - Number(sweepBar.low);
  } else {
    let lo = Infinity;
    for (let j = sweepIdx + 1; j <= end; j++) lo = Math.min(lo, Number(candles[j].low));
    atrMoved = Number(sweepBar.high) - lo;
  }
  const ratio = atr > 0 ? atrMoved / atr : 0;
  return {
    atrMoved,
    atr,
    ratio: Number(ratio.toFixed(4)),
    ok: atr > 0 ? atrMoved + 1e-12 >= atr * 0.01 : false,
  };
}

function followThroughContext(candles, cycle, side, pre, opts = {}) {
  const sweepIdx = Number(cycle?.sweepStartIdx);
  const atr = Number(pre?.atrSeries?.[sweepIdx] ?? pre?.atr?.[sweepIdx] ?? 0);
  const close = Number(candles?.[sweepIdx]?.close ?? 0);
  const atrPct = atr > 0 && close > 0 ? atr / close : Number(opts._ftAtrPct ?? 0);
  let volSpike = Number(opts._ftVolSpike ?? NaN);
  if (!(volSpike > 0)) {
    const look = Math.max(5, Math.floor(Number(opts.intradayLiqSweepVolLookback ?? 20)));
    const v0 = Number(candles?.[sweepIdx]?.volume ?? 0);
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, sweepIdx - look); j < sweepIdx; j++) {
      sum += Number(candles[j]?.volume ?? 0);
      n += 1;
    }
    const avg = n > 0 ? sum / n : 0;
    volSpike = avg > 0 ? v0 / avg : 1;
  }
  let daySituation = String(opts._ftDaySituation ?? opts._liqMarketContext?.daySituation ?? "");
  if (!daySituation && candles?.length && Number.isFinite(sweepIdx) && sweepIdx >= 0) {
    const entryIdx = Number(cycle?.reclaimIdx ?? sweepIdx);
    daySituation = buildLiqMarketContext(candles, entryIdx, pre, opts)?.daySituation ?? "range";
  }
  if (!daySituation) daySituation = "range";
  return { atrPct, volSpike, daySituation };
}

/**
 * Reference-guide follow-through: after the sweep candle, the next 1–N bars must
 * move away from the sweep extreme by ≥ ATR × mult before the setup is tradable.
 * Distinct from impulse-in-window / post-reclaim body×ATR gates.
 * Supports relative modes via intradayLiqFollowThroughMode (fixed|atrPct|volSpike|regime).
 */
export function passesGuideFollowThrough(candles, cycle, side, pre, opts = {}) {
  if (opts.intradayLiqRequireFollowThrough !== true) return true;
  const ctx = followThroughContext(candles, cycle, side, pre, opts);
  const { mult, lookBars } = resolveFollowThroughParams(opts, ctx);
  if (!(mult > 0)) return true;
  const sweepIdx = Number(cycle.sweepStartIdx);
  if (!(sweepIdx >= 0) || sweepIdx >= candles.length - 1) return false;
  const atr = Number(pre?.atrSeries?.[sweepIdx] ?? pre?.atr?.[sweepIdx] ?? 0);
  if (!(atr > 0)) return true;
  const m = measureGuideFollowThrough(candles, cycle, side, pre, lookBars);
  return m.atrMoved + 1e-12 >= atr * mult;
}

function scoreFromImpulseAtr(impulse) {
  if (impulse >= 2.5) return 25;
  if (impulse >= 2.0) return 20;
  if (impulse >= 1.5) return 14;
  if (impulse >= 1.2) return 8;
  if (impulse >= 1.0) return 4;
  return 0;
}

/**
 * Context-aware 0–100 entry score — displacement, reclaim, hold, HTF/level, extension.
 * Replaces brittle binary threshold stacks when intradayLiqUseEntryScore is on.
 */
export function computeLiqEntryContextScore(candles, cycle, side, pre, opts, entryBarIdx, reclaimBar) {
  const breakdown = {};
  const impulse = maxSweepCycleImpulseAtr(candles, cycle.sweepStartIdx, cycle.reclaimIdx, pre);
  breakdown.displacement = scoreFromImpulseAtr(impulse);

  const range = Math.max(1e-9, Number(reclaimBar.high) - Number(reclaimBar.low));
  const bodyRatio = Math.abs(Number(reclaimBar.close) - Number(reclaimBar.open)) / range;
  let reclaimPts = Math.min(20, Math.round(bodyRatio * 25));
  if (side === "BUY" && reclaimBar.close <= reclaimBar.open) reclaimPts = Math.max(0, reclaimPts - 8);
  if (side === "SELL" && reclaimBar.close >= reclaimBar.open) reclaimPts = Math.max(0, reclaimPts - 8);
  breakdown.reclaim = reclaimPts;

  const held = reclaimHeldThrough(candles, cycle.reclaimIdx, entryBarIdx, side, cycle.level);
  let holdPts = 0;
  if (held && entryBarIdx > cycle.reclaimIdx) holdPts = 15;
  else if (held) holdPts = 10;
  if (cycle.reclaimIdx === cycle.sweepStartIdx && entryBarIdx === cycle.reclaimIdx) holdPts = Math.max(0, holdPts - 8);
  breakdown.hold = holdPts;

  const htfUp = pre?.htfUp?.[entryBarIdx];
  const htfDown = pre?.htfDown?.[entryBarIdx];
  const sep = Number(pre?.htfSep?.[entryBarIdx] ?? 0);
  let htfPts = 8;
  if (side === "BUY" && htfUp) htfPts = 16;
  if (side === "SELL" && htfDown) htfPts = 16;
  if (sep >= 0.001) htfPts = Math.min(20, htfPts + 4);
  if (side === "BUY" && cycle.levelType === "pdl" && !htfUp) htfPts = Math.max(0, htfPts - 12);
  if (side === "SELL" && cycle.levelType === "pdh" && !htfDown) htfPts = Math.max(0, htfPts - 6);
  breakdown.htfLevel = htfPts;

  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  breakdown.extension = Math.min(10, Math.round((cycle.extension / Math.max(minExt, 1e-6)) * 5));

  breakdown.level =
    cycle.levelType === "pdh" || cycle.levelType === "pdl"
      ? 10
      : cycle.levelType === "session_high" || cycle.levelType === "session_low"
        ? 7
        : 5;

  const reclaimBars = entryBarIdx - cycle.sweepStartIdx;
  if (reclaimBars <= 2 && impulse < 1.2) breakdown.fastReclaimPenalty = -8;
  else breakdown.fastReclaimPenalty = 0;

  const score = Math.min(
    100,
    Math.max(
      0,
      breakdown.displacement +
        breakdown.reclaim +
        breakdown.hold +
        breakdown.htfLevel +
        breakdown.extension +
        breakdown.level +
        breakdown.fastReclaimPenalty,
    ),
  );
  return { score, breakdown, impulse };
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

  const bufPct = Number(opts.slBufferPct ?? opts.intradayLiqSlBufferPct ?? DEFAULT_LIQ_SL_BUFFER_PCT);
  const atrBufMult = Number(opts.intradayLiqSlBufferAtrMult ?? 0);
  const atr = Number(opts._entryAtr ?? opts.entryAtr ?? 0);
  // Absolute buffer: max(% of price, ATR×mult). Guide uses ATR×0.2; CORE default is % only.
  let bufAbs = Number.isFinite(bufPct) && bufPct > 0 ? fill * bufPct : 0;
  if (atrBufMult > 0 && atr > 0) bufAbs = Math.max(bufAbs, atr * atrBufMult);
  const tradeSide = side === "BUY" || side === "long" ? "BUY" : "SELL";
  const { tp1On, tp2On } = resolveLiqExitStages(opts);
  const slOnly = !tp1On && !tp2On;

  const partialFrac = Math.min(0.75, Math.max(0.1, Number(opts.intradayLiqPartialFrac ?? 0.5)));
  const tp2PartialFrac = Math.min(0.75, Math.max(0, Number(opts.intradayLiqTp2PartialFrac ?? 0)));

  let slPrice;
  let tp2Price = tp2On ? tpLevel : 0;
  if (tradeSide === "BUY") {
    slPrice = bufAbs > 0 ? wick - bufAbs : wick * (1 - Math.max(bufPct, 0));
    if (!(slPrice < fill)) return null;
    if (tp2On && !(tp2Price > fill)) return null;
  } else {
    slPrice = bufAbs > 0 ? wick + bufAbs : wick * (1 + Math.max(bufPct, 0));
    if (!(slPrice > fill)) return null;
    if (tp2On && !(tp2Price < fill)) return null;
  }

  // Research exit geometry overrides (opt-in). Default remains structural wick SL + opposing TP.
  // Fixed % / ATR replace structural distances from fill; invalid distances → null setup.
  const fixedSlPct = Number(opts.intradayLiqFixedSlPct ?? 0);
  const slAtrMult = Number(opts.intradayLiqSlAtrMult ?? 0);
  if (fixedSlPct > 0) {
    slPrice = tradeSide === "BUY" ? fill * (1 - fixedSlPct) : fill * (1 + fixedSlPct);
  } else if (slAtrMult > 0 && atr > 0) {
    slPrice = tradeSide === "BUY" ? fill - slAtrMult * atr : fill + slAtrMult * atr;
  }
  if (tradeSide === "BUY" ? !(slPrice < fill) : !(slPrice > fill)) return null;

  const fixedTpPct = Number(opts.intradayLiqFixedTpPct ?? 0);
  const tpAtrMult = Number(opts.intradayLiqTpAtrMult ?? 0);
  if (tp2On && fixedTpPct > 0) {
    tp2Price = tradeSide === "BUY" ? fill * (1 + fixedTpPct) : fill * (1 - fixedTpPct);
  } else if (tp2On && tpAtrMult > 0 && atr > 0) {
    tp2Price = tradeSide === "BUY" ? fill + tpAtrMult * atr : fill - tpAtrMult * atr;
  }
  if (tp2On && (tradeSide === "BUY" ? !(tp2Price > fill) : !(tp2Price < fill))) return null;

  const risk = Math.abs(fill - slPrice);
  const tp1RrMult = Math.min(2, Math.max(0.25, Number(opts.intradayLiqTp1Rr ?? 1)));
  let tp1Price = tp1On
    ? tradeSide === "BUY"
      ? fill + risk * tp1RrMult
      : fill - risk * tp1RrMult
    : 0;
  if (!tp2On) tp2Price = 0;

  const tp2RrMult = Number(opts.intradayLiqTp2Rr ?? 0);
  if (tp2On && tp2RrMult > 0 && risk > 0) {
    tp2Price = tradeSide === "BUY" ? fill + tp2RrMult * risk : fill - tp2RrMult * risk;
  }

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

  const structuralTpPct =
    tradeSide === "BUY"
      ? Math.max(0, (tpLevel - fill) / fill)
      : Math.max(0, (fill - tpLevel) / fill);
  const structuralRr = slPct > 0 ? structuralTpPct / slPct : 0;
  const rr = slPct > 0 && tp2On ? tpPct / slPct : structuralRr;
  const minRr = Number(opts.intradayLiqMinRr ?? 0);
  if (minRr > 0 && rr + 1e-9 < minRr) return null;

  const maxSl = Number(opts.intradayLiqMaxSlPct ?? 0);
  if (maxSl > 0 && slPct > maxSl) return null;
  const minSl = Number(opts.intradayLiqMinSlPct ?? 0);
  if (minSl > 0 && slPct + 1e-12 < minSl) return null;

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
    tp2PartialFrac,
    tp1Rr: tp1On ? tp1RrMult : 0,
    tp2Rr: tp2On && tp2RrMult > 0 ? tp2RrMult : 0,
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
    tp2PartialFrac: liqBr.tp2PartialFrac ?? 0,
    beTriggerPx: beAt1R ? Number(liqBr.beTriggerPx) : 0,
    beAt1R,
    stages,
  };
}

function buildSetupFromCycle(candles, cycle, side, opts, dayStart = 0, entryIdx = null, levelMeta = null) {
  const pre = opts._liqPre;
  const harvest = opts.intradayLiqHarvestMode === true;
  const setupOpts = { ...opts, intradayLiqMinSweepExtensionPct: opts.intradayLiqMinSweepExtensionPct ?? 0.008 };
  const entryBarIdx = entryIdx ?? cycle.reclaimIdx;
  if (!harvest && !passesLiqMarketActivationForSetup(candles, entryBarIdx, side, pre, setupOpts, cycle.levelType)) {
    return null;
  }
  if (!harvest && !passesLiqHtfAlign(side, entryBarIdx, pre, setupOpts, cycle.levelType)) return null;
  if (!harvest && !passesLiqEntryMode(side, entryBarIdx, pre, setupOpts, cycle.levelType)) return null;
  if (!harvest && !passesLiqAdxEntry(entryBarIdx, pre, setupOpts)) return null;
  const reclaimBar = candles[cycle.reclaimIdx];
  const entryBar = candles[entryBarIdx];
  if (!reclaimBar || !entryBar) return null;

  if (opts.intradayLiqRejectSameBarReclaim === true && cycle.reclaimIdx === cycle.sweepStartIdx) {
    return null;
  }
  // Opposite gate: require pin-bar reclaim (sweep+reclaim same bar). Y2025 BNB soft:
  // same-bar was the only positive cell; multi-bar bled — research opt-in only.
  if (opts.intradayLiqRequireSameBarReclaim === true && cycle.reclaimIdx !== cycle.sweepStartIdx) {
    return null;
  }

  if (!harvest && !passesReclaimStrength(reclaimBar, cycle, side, opts)) return null;
  if (!harvest && !passesSweepPokeRejection(candles, cycle, side, opts)) return null;
  if (!harvest && !passesSweepAttemptCap(cycle, opts)) return null;
  if (!harvest && !passesEntryLevelHold(entryBar, cycle, side, opts)) return null;
  if (!harvest && !passesSweepQualityGate(candles, cycle, side, pre, opts)) return null;
  if (!harvest && !passesDisplacementV2Gate(candles, cycle.sweepStartIdx, entryBarIdx, side, pre, opts)) return null;
  if (!harvest && !passesGuideFollowThrough(candles, cycle, side, pre, opts)) return null;

  const trailOnly = isLiqTrailOnlyExit(opts);
  const useEntryScore = resolveLiqEntryScoreMode(opts);
  const useEntryScoreV2 = opts.intradayLiqUseEntryScoreV2 === true;
  const dispGate = resolveLiqDisplacementGateOpts(opts);
  if (!harvest && dispGate.required && !passesLiqSweepDisplacement(cycle, candles, pre, dispGate.opts, entryBarIdx)) {
    return null;
  }
  if (!harvest && !passesPostReclaimDisplacement(candles, cycle, side, pre, opts, entryBarIdx)) {
    return null;
  }
  if (!harvest && !passesLiqChochGate(candles, cycle, side, entryBarIdx, setupOpts)) return null;

  const minWick = Number(opts.intradayLiqMinWickRatio ?? 0);
  if (!harvest && minWick > 0) {
    const wickRatio = rejectionWickRatio(reclaimBar, side);
    if (wickRatio < minWick) return null;
    if (side === "BUY" && reclaimBar.close <= reclaimBar.open) return null;
    if (side === "SELL" && reclaimBar.close >= reclaimBar.open) return null;
  }

  const bracketOpts = trailOnly
    ? { ...opts, intradayLiqMinRr: 0 }
    : harvest
      ? { ...opts, intradayLiqMinRr: 0 }
      : opts;
  const entryAtr = Number(pre?.atrSeries?.[entryBarIdx] ?? pre?.atr?.[entryBarIdx] ?? 0);
  const brackets = computeLiquidityBrackets(side, entryBar.close, cycle.wick, cycle.opposing, {
    ...bracketOpts,
    _entryAtr: entryAtr,
  });
  if (!brackets) return null;

  // Mitigation / limit-at-pool entry: wait for pullback toward swept level after reclaim.
  // Frac 0 = signal close (market), 1 = at level, 0.5 = midpoint (soft BNB A/B winner).
  const mitFrac = Number(opts.intradayLiqMitigationFrac ?? 0);
  const mitOn =
    opts.intradayLiqMitigationEntry === true ||
    Number(opts.intradayLiqMitigationWaitBars ?? 0) > 0 ||
    mitFrac > 0;
  if (mitOn && mitFrac > 0) {
    const frac = Math.min(1, Math.max(0, mitFrac));
    const limitPx = Number(entryBar.close) + frac * (Number(cycle.level) - Number(entryBar.close));
    if (Number.isFinite(limitPx) && limitPx > 0) {
      const mitBrackets = computeLiquidityBrackets(side, limitPx, cycle.wick, cycle.opposing, bracketOpts);
      if (mitBrackets) {
        Object.assign(brackets, mitBrackets);
        brackets.limitEntryPrice = limitPx;
        brackets.mitigationEntry = true;
        brackets.mitigationFrac = frac;
      }
    }
  }

  if (
    !harvest &&
    !passesContinuationRoomGate(
      candles,
      entryBarIdx,
      side,
      entryBar.close,
      brackets.slPrice,
      cycle.opposing,
      pre,
      opts,
    )
  ) {
    return null;
  }

  const marketContext = buildLiqMarketContext(candles, entryBarIdx, pre, opts);
  const sweepQuality = computeSweepQuality(candles, cycle, side, pre, opts);
  const displacementV2 = computeDisplacementV2(
    candles,
    cycle.sweepStartIdx,
    entryBarIdx,
    side,
    pre,
    opts,
  );
  const continuationRoom = evaluateContinuationRoom(
    candles,
    entryBarIdx,
    side,
    entryBar.close,
    brackets.slPrice,
    cycle.opposing,
    pre,
    opts,
  );

  const q = cycleQualityScore(cycle, brackets, dayStart, setupOpts, reclaimBar, side);
  let entryCtx = null;
  if (useEntryScoreV2) {
    entryCtx = computeEntryScoreV2({
      candles,
      cycle,
      side,
      pre,
      opts,
      entryBarIdx,
      reclaimBar,
      sweepQuality,
      displacementV2,
      continuationRoom,
      marketContext,
    });
  } else if (useEntryScore) {
    entryCtx = computeLiqEntryContextScore(candles, cycle, side, pre, opts, entryBarIdx, reclaimBar);
  }

  if ((useEntryScoreV2 || useEntryScore) && !harvest) {
    const minES = Number(opts.intradayLiqMinEntryScore ?? 45);
    const isSession =
      cycle.levelType === "session_high" || cycle.levelType === "session_low";
    const sessionBump = Number(opts.intradayLiqSessionMinEntryScoreBump ?? 8);
    const floor = isSession ? minES + sessionBump : minES;
    if ((entryCtx?.score ?? 0) < floor) return null;
  } else {
    const minQ = Number(opts.intradayLiqMinQuality ?? 0);
    if (minQ > 0 && q < minQ) return null;
  }

  const importance = levelMeta?.importance ?? cycle.levelImportance ?? 1;
  const weightedQuality = (entryCtx?.score ?? q) * importance;

  const features = buildLiqFeatureVector({
    candles,
    cycle,
    side,
    pre,
    opts,
    entryBarIdx,
    reclaimBar,
    entryPx: entryBar.close,
    slPrice: brackets.slPrice,
    opposingLevel: cycle.opposing,
    entryScore: entryCtx?.score ?? null,
    entryBreakdown: entryCtx?.breakdown ?? null,
    levelMeta: levelMeta ?? {
      importance,
      source: cycle.levelSource,
      touches: levelMeta?.touches,
    },
  });

  const techniques = ["liq_sweep", cycle.levelType];
  if (entryBarIdx > cycle.reclaimIdx) techniques.push("liq_reclaim_hold");
  if (useEntryScoreV2) techniques.push("liq_entry_score_v2");
  else if (useEntryScore) techniques.push("liq_entry_score");
  if (trailOnly) techniques.push("liq_trail_only");
  if (dispGate.required) techniques.push("liq_sweep_displacement");
  if (opts.intradayLiqRequirePostReclaimDisplacement === true) techniques.push("liq_post_reclaim_disp");
  if (opts.intradayLiqMarketStateGate === true) techniques.push("liq_market_state");
  if (opts.intradayLiqContinuationGate === true) techniques.push("liq_continuation_room");
  if (opts.intradayLiqRequireChoch === true) techniques.push("liq_choch");

  return {
    side,
    action: side,
    level: cycle.level,
    levelType: cycle.levelType,
    levelImportance: importance,
    levelSource: levelMeta?.source ?? cycle.levelSource ?? null,
    wick: cycle.wick,
    sweepWick: cycle.wick,
    sweepStartIdx: cycle.sweepStartIdx,
    reclaimIdx: cycle.reclaimIdx,
    entry: entryBar.close,
    extension: cycle.extension,
    liqQuality: entryCtx?.score ?? q,
    weightedQuality,
    entryContextScore: entryCtx?.score ?? null,
    entryContextBreakdown: entryCtx?.breakdown ?? null,
    liqFeatures: features,
    htfTrend: pre?.htfUp?.[entryBarIdx] ? "up" : pre?.htfDown?.[entryBarIdx] ? "down" : "flat",
    ...brackets,
    techniques,
    score: useEntryScoreV2 || useEntryScore
      ? Math.min(12, Math.round(6 + (entryCtx?.score ?? 0) / 12))
      : Math.min(12, Math.round(6 + q / 50)),
  };
}

function collectSetupsFromCycles(candles, idx, side, cycles, opts, dayStart, levelMeta = null) {
  const holdBars = liqReclaimHoldBars(opts);
  const setups = [];
  for (let cycIdx = 0; cycIdx < cycles.length; cycIdx++) {
    const c = cycles[cycIdx];
    if (c.reclaimIdx !== idx - holdBars) continue;
    if (holdBars > 0 && !reclaimHeldThrough(candles, c.reclaimIdx, idx, side, c.level)) continue;
    if (opts.intradayLiqFirstCycleOnly === true && cycIdx > 0) continue;
    const s = buildSetupFromCycle(
      candles,
      c,
      side,
      opts,
      dayStart,
      holdBars > 0 ? idx : null,
      levelMeta,
    );
    if (s) setups.push(s);
  }
  return setups;
}

/**
 * Scan same UTC day for sweep→failed-reclaim (hold-beyond) acceptance cycles.
 * `poolSide` is the liquidity pool being swept (BUY = SSL, SELL = BSL).
 */
export function scanAcceptanceCycles(candles, idx, poolSide, level, opposing, levelType, sweepPct, dayStart, opts = {}) {
  if (!level || level <= 0 || !opposing || opposing <= 0) return [];

  const holdBars = liqAcceptHoldBars(opts);
  const acceptIdx = idx - holdBars;
  if (acceptIdx < dayStart) return [];
  if (holdBars > 0 && !acceptHeldThrough(candles, acceptIdx, idx, poolSide, level)) return [];

  const clusterPct = Number(opts.intradayLiqSessionExtremeSweepPct ?? 0.0005);
  const minSweepVol = Number(opts.intradayLiqSweepMinVolRatio ?? 0);
  const volLookback = Math.max(2, Number(opts.intradayLiqSweepVolLookback ?? 20));
  const poked = (j) =>
    sweepPoked(poolSide, candles[j], level, sweepPct, levelType, clusterPct) &&
    sweepBarVolumeOk(candles, j, minSweepVol, volLookback);

  let scanOpts = opts;
  const maxMinutes = Number(opts.intradayLiqMaxSweepMinutes ?? 0);
  if (maxMinutes > 0 && candles.length > 1) {
    const barMs = Math.abs(candles[1].ts - candles[0].ts) || 900_000;
    scanOpts = { ...opts, intradayLiqMaxSweepBars: Math.max(1, Math.round((maxMinutes * 60_000) / barMs)) };
  }

  let sweepStartIdx = -1;
  let extreme = poolSide === "BUY" ? Infinity : -Infinity;
  let lastSweep = null;

  for (let j = dayStart; j <= acceptIdx; j++) {
    if (poked(j)) {
      if (sweepStartIdx < 0) sweepStartIdx = j;
      extreme = poolSide === "BUY" ? Math.min(extreme, candles[j].low) : Math.max(extreme, candles[j].high);
    } else if (sweepStartIdx >= 0) {
      extreme =
        poolSide === "BUY"
          ? Math.min(extreme, candles[j].low)
          : Math.max(extreme, candles[j].high);
    }

    if (sweepStartIdx >= 0 && poolReclaimedOnBar(candles, j, poolSide, level)) {
      sweepStartIdx = -1;
      extreme = poolSide === "BUY" ? Infinity : -Infinity;
      lastSweep = null;
      continue;
    }

    if (sweepStartIdx >= 0) {
      lastSweep = {
        sweepStartIdx,
        wick: extreme,
        extension: sweepExtension(poolSide, level, extreme),
      };
    }
  }

  if (!lastSweep || lastSweep.sweepStartIdx < 0) return [];

  for (let j = lastSweep.sweepStartIdx; j <= idx; j++) {
    if (poolReclaimedOnBar(candles, j, poolSide, level)) return [];
  }

  if (
    !passesSweepFilters(
      poolSide,
      level,
      lastSweep.wick,
      lastSweep.sweepStartIdx,
      acceptIdx,
      scanOpts,
      levelType,
    )
  ) {
    return [];
  }

  return [
    {
      acceptIdx,
      wick: lastSweep.wick,
      sweepStartIdx: lastSweep.sweepStartIdx,
      level,
      levelType,
      opposing,
      extension: lastSweep.extension,
      poolSide,
    },
  ];
}

function buildSetupFromAcceptanceCycle(candles, cycle, tradeSide, opts, dayStart = 0, entryIdx = null, levelMeta = null) {
  const pre = opts._liqPre;
  const harvest = opts.intradayLiqHarvestMode === true;
  const poolSide = cycle.poolSide ?? (tradeSide === "SELL" ? "BUY" : "SELL");
  const entryBarIdx = entryIdx ?? cycle.acceptIdx;
  const entryBar = candles[entryBarIdx];
  if (!entryBar) return null;

  if (!harvest && !passesLiqMarketActivationForSetup(candles, entryBarIdx, tradeSide, pre, opts, cycle.levelType)) {
    return null;
  }
  if (!harvest && !passesLiqHtfAlign(tradeSide, entryBarIdx, pre, opts, cycle.levelType)) return null;
  if (!harvest && !passesLiqAdxEntry(entryBarIdx, pre, opts)) return null;
  // Guide displacement after sweep (opt-in). Was classic-only — STOPRUN needs it on ACCEPT.
  if (!harvest && !passesGuideFollowThrough(candles, cycle, tradeSide, pre, opts)) return null;

  const brackets = computeAcceptanceBrackets(tradeSide, entryBar.close, cycle.level, cycle.opposing, opts);
  if (!brackets) return null;

  const q = cycleQualityScore(cycle, brackets, dayStart, opts, entryBar, tradeSide);
  const minQ = Number(opts.intradayLiqMinQuality ?? 0);
  if (!harvest && minQ > 0 && q < minQ) return null;

  const importance = levelMeta?.importance ?? cycle.levelImportance ?? 1;
  const features = buildLiqFeatureVector({
    candles,
    cycle: { ...cycle, reclaimIdx: cycle.acceptIdx },
    side: tradeSide,
    pre,
    opts,
    entryBarIdx,
    reclaimBar: entryBar,
    sweepQuality: null,
    displacementV2: null,
    continuationRoom: null,
    marketContext: null,
  });

  const techniques = ["liq_accept"];
  if (cycle.levelType === "pdh" || cycle.levelType === "pdl") techniques.push("liq_pdh_pdl");
  else if (cycle.levelType === "session_high" || cycle.levelType === "session_low") {
    techniques.push("liq_session_extreme");
  }

  return {
    side: tradeSide,
    action: tradeSide,
    playbook: "accept",
    level: cycle.level,
    levelType: cycle.levelType,
    levelImportance: importance,
    levelSource: levelMeta?.source ?? cycle.levelSource ?? null,
    wick: cycle.wick,
    sweepWick: cycle.wick,
    sweepStartIdx: cycle.sweepStartIdx,
    acceptIdx: cycle.acceptIdx,
    reclaimIdx: cycle.acceptIdx,
    entry: entryBar.close,
    extension: cycle.extension,
    liqQuality: q,
    weightedQuality: q * importance,
    liqFeatures: features,
    htfTrend: pre?.htfUp?.[entryBarIdx] ? "up" : pre?.htfDown?.[entryBarIdx] ? "down" : "flat",
    ...brackets,
    techniques,
    score: Math.min(12, Math.round(6 + q / 50)),
  };
}

function collectAcceptanceSetupsFromCycles(candles, idx, tradeSide, cycles, opts, dayStart, levelMeta = null) {
  const holdBars = liqAcceptHoldBars(opts);
  const poolSide = tradeSide === "SELL" ? "BUY" : "SELL";
  const setups = [];
  for (let cycIdx = 0; cycIdx < cycles.length; cycIdx++) {
    const c = cycles[cycIdx];
    if (c.acceptIdx !== idx - holdBars) continue;
    if (holdBars > 0 && !acceptHeldThrough(candles, c.acceptIdx, idx, poolSide, c.level)) continue;
    if (opts.intradayLiqFirstCycleOnly === true && cycIdx > 0) continue;
    const s = buildSetupFromAcceptanceCycle(
      candles,
      c,
      tradeSide,
      opts,
      dayStart,
      holdBars > 0 ? idx : null,
      levelMeta,
    );
    if (s) setups.push(s);
  }
  return setups;
}

/** Continuation TP: next liquidity pool in trade direction (not fade opposing extreme). */
function resolveAcceptanceOpposing(candles, idx, tradeSide, sweptLevel, pre, opts, dayStart) {
  const entry = Number(candles[idx]?.close ?? 0);
  const pdh = Number(pre?.prevDayHigh?.[idx] ?? 0);
  const pdl = Number(pre?.prevDayLow?.[idx] ?? 0);
  const pwh = Number(pre?.prevWeekHigh?.[idx] ?? 0);
  const pwl = Number(pre?.prevWeekLow?.[idx] ?? 0);
  const lv = Number(sweptLevel);
  if (!(entry > 0) || !(lv > 0)) return 0;

  if (tradeSide === "SELL") {
    const sess = resolveSessionExtremeLevel(candles, idx, "BUY", dayStart, opts);
    if (sess?.level > 0 && sess.level < entry) return sess.level;
    if (pwl > 0 && pwl < entry) return pwl;
    if (pdl > 0 && pdl < entry && Math.abs(pdl - lv) / lv > 0.001) return pdl;
    const range = pdh > 0 && pdl > 0 ? pdh - pdl : lv * 0.012;
    return Math.max(lv * 0.95, lv - Math.max(range, lv * 0.006));
  }

  const sess = resolveSessionExtremeLevel(candles, idx, "SELL", dayStart, opts);
  if (sess?.level > 0 && sess.level > entry) return sess.level;
  if (pwh > 0 && pwh > entry) return pwh;
  if (pdh > 0 && pdh > entry && Math.abs(pdh - lv) / lv > 0.001) return pdh;
  const range = pdh > 0 && pdl > 0 ? pdh - pdl : lv * 0.012;
  return lv + Math.max(range, lv * 0.006);
}

/**
 * Sweep-acceptance setups at bar `idx` — enter WITH the sweep after hold-beyond confirms failed reclaim.
 */
export function listAcceptanceSetups(candles, idx, tradeSide, pre, opts = {}) {
  if (!candles?.length || idx < 1) return [];
  if (opts.intradayLiqAcceptEnabled === false) return [];

  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? DEFAULT_LIQ_SWEEP_PCT);
  const dayStart = dayStartIndex(candles, idx);
  const poolSide = tradeSide === "SELL" ? "BUY" : "SELL";

  const setups = [];
  const candidates = resolveLiquidityCandidates(candles, idx, poolSide, pre, opts);

  for (const cand of candidates) {
    if (!(cand.level > 0)) continue;
    const opposingLevel = resolveAcceptanceOpposing(
      candles,
      idx,
      tradeSide,
      cand.level,
      pre,
      opts,
      dayStart,
    );
    if (!(opposingLevel > 0)) continue;
    const minDist = Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005);
    const pdh = pre.prevDayHigh?.[idx];
    const pdl = pre.prevDayLow?.[idx];
    const sessionLevel = poolSide === "BUY" ? pdl : pdh;
    if (
      sessionLevel > 0 &&
      cand.levelType !== "pdh" &&
      cand.levelType !== "pdl" &&
      Math.abs(cand.level - sessionLevel) / sessionLevel <= minDist
    ) {
      continue;
    }

    const cycles = scanAcceptanceCycles(
      candles,
      idx,
      poolSide,
      cand.level,
      opposingLevel,
      cand.levelType,
      sweepPct,
      dayStart,
      opts,
    );
    for (const c of cycles) {
      c.levelImportance = cand.importance;
      c.levelSource = cand.source;
      c.opposing = opposingLevel;
    }
    setups.push(
      ...collectAcceptanceSetupsFromCycles(candles, idx, tradeSide, cycles, opts, dayStart, {
        ...cand,
        opposingLevel,
      }),
    );
  }

  return setups;
}

/**
 * All valid liquidity setups at bar `idx` (ranked liquidity hierarchy).
 */
export function listSessionLiquiditySetups(candles, idx, side, pre, opts = {}) {
  if (!candles?.length || idx < 1) return [];

  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? DEFAULT_LIQ_SWEEP_PCT);
  const dayStart = dayStartIndex(candles, idx);
  if (!opts.intradayLiqHarvestMode && !passesLiqRegimeFilters(candles, idx, dayStart, pre, opts)) return [];

  const setups = [];
  const candidates = resolveLiquidityCandidates(candles, idx, side, pre, opts);

  for (const cand of candidates) {
    if (!(cand.level > 0) || !(cand.opposingLevel > 0)) continue;
    const minDist = Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005);
    const pdh = pre.prevDayHigh?.[idx];
    const pdl = pre.prevDayLow?.[idx];
    const sessionLevel = side === "BUY" ? pdl : pdh;
    if (
      sessionLevel > 0 &&
      cand.levelType !== "pdh" &&
      cand.levelType !== "pdl" &&
      Math.abs(cand.level - sessionLevel) / sessionLevel <= minDist
    ) {
      continue;
    }

    const cycles = scanSessionLiquidityCycles(
      candles,
      idx,
      side,
      cand.level,
      cand.opposingLevel,
      cand.levelType,
      sweepPct,
      dayStart,
      opts,
    );
    for (const c of cycles) {
      c.levelImportance = cand.importance;
      c.levelSource = cand.source;
    }
    setups.push(
      ...collectSetupsFromCycles(candles, idx, side, cycles, opts, dayStart, cand),
    );
  }

  return setups;
}

/** Best setup at bar (highest weighted quality score). */
export function evaluateSessionLiquiditySweep(candles, idx, side, pre, opts = {}) {
  const list = listSessionLiquiditySetups(candles, idx, side, pre, opts);
  if (!list.length) return null;

  list.sort((a, b) => {
    const qa = Number(a.weightedQuality ?? a.liqQuality ?? 0);
    const qb = Number(b.weightedQuality ?? b.liqQuality ?? 0);
    return qb - qa;
  });
  return list[0];
}

function preferLaterComparableCycle(next, prev) {
  if (!prev) return true;
  if (next.extension > prev.extension * 1.25) return true;
  if (prev.extension > next.extension * 1.25) return false;
  if (next.reclaimIdx !== prev.reclaimIdx) {
    if (Math.abs(next.extension - prev.extension) / Math.max(prev.extension, 1e-9) < 0.15) {
      return next.reclaimIdx > prev.reclaimIdx;
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
  let beTriggerPx = Number(baked.beTriggerPx) || 0;
  if (stages.beAt1RWithoutPartial && risk > 0 && !beTriggerPx) {
    beTriggerPx = tradeSide === "BUY" ? fill + risk : fill - risk;
  }

  const preserveTp1 =
    baked.tpMode === "situation_structure" ||
    String(baked.tpMode ?? "").startsWith("tokyo_dynamic") ||
    baked.tpMode === "tokyo_sweep_fade";
  const bakedTp1Rr = Number(baked.tp1Rr);
  const tp1Rr = Number.isFinite(bakedTp1Rr) && bakedTp1Rr > 0 ? Math.min(2, Math.max(0.25, bakedTp1Rr)) : 1;
  if (bakedTp1 && tp1On && Number.isFinite(tp1Price) && risk > 0 && !preserveTp1) {
    if (tradeSide === "BUY") {
      tp1Price = fill + risk * tp1Rr;
      tp1Pct = (tp1Price - fill) / fill;
    } else {
      tp1Price = fill - risk * tp1Rr;
      tp1Pct = (fill - tp1Price) / fill;
    }
  } else if (preserveTp1 && bakedTp1 && tp1On && Number.isFinite(tp1Price) && risk > 0) {
    if (tradeSide === "BUY") {
      tp1Pct = (tp1Price - fill) / fill;
    } else {
      tp1Pct = (fill - tp1Price) / fill;
    }
  } else {
    tp1Price = 0;
    tp1Pct = 0;
  }

  if (!tp2On || !bakedTp2) {
    tpPrice = 0;
    tpPct = 0;
  } else {
    const bakedTp2Rr = Number(baked.tp2Rr);
    const tp2Rr = Number.isFinite(bakedTp2Rr) && bakedTp2Rr > 0 ? Math.min(20, Math.max(0.5, bakedTp2Rr)) : 0;
    if (tp2Rr > 0 && risk > 0) {
      tpPrice = tradeSide === "BUY" ? fill + risk * tp2Rr : fill - risk * tp2Rr;
    }
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
    tp2PartialFrac: baked.tp2PartialFrac ?? 0,
    level: baked.level,
    levelType: baked.levelType,
  };
}
