/**
 * LIQUIDITY_MAP per-symbol auto-calibration.
 *
 * Uses warmup bars only, with no symbol lookup and no future outcomes, to convert
 * the BTC-derived ATR fractions into a small profile-based adjustment.
 */

import { adx as computeAdx, atr as computeAtr, ema } from "./indicators.js";
import { detectRollingLiquiditySweeps } from "./techniques/liquidityMap.js";

export const LIQ_MAP_AUTO_DEFAULTS = Object.freeze({
  profileBars: 200,
  referenceAtrPct: 0.0046,
  sweepAtrFrac: 0.13,
  equalTolAtrFrac: 0.18,
  sweepAtrFracFloor: 0.1,
  sweepAtrFracCeil: 0.32,
  equalTolAtrFracFloor: 0.12,
  equalTolAtrFracCeil: 0.36,
  atrSlMultFloor: 0.75,
  atrSlMultCeil: 1.4,
  minQualityScore: 6.2,
  minQualityScoreFloor: 5.6,
  minQualityScoreCeil: 7.8,
});

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function median(arr) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, pct) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.floor(s.length * (clamp(pct, 1, 99) / 100));
  return s[Math.min(Math.max(0, idx), s.length - 1)];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function buildLiqMapCoinProfile(candles = [], opts = {}) {
  const o = { ...LIQ_MAP_AUTO_DEFAULTS, ...opts };
  const profileBars = Math.max(40, Math.min(200, Math.round(Number(o.profileBars ?? LIQ_MAP_AUTO_DEFAULTS.profileBars))));
  const end = Math.min(candles.length, profileBars);
  if (end < 30) {
    return {
      profileBars: end,
      medianAtrPct: o.referenceAtrPct,
      p70AtrPct: o.referenceAtrPct,
      p90AtrPct: o.referenceAtrPct,
      atrSpread: 1,
      medianAdx: 22,
      medianVolRatio: 1,
      medianRangeAtr: 1.5,
      medianBodyRange: 0.35,
      setupDensityPerDay: 0,
      weakReclaimRate: 0,
      medianFollowAtr: 1,
    };
  }

  const slice = candles.slice(0, end);
  const atrSeries = computeAtr(slice, 14);
  const adxSeries = computeAdx(slice, 14);
  const volumes = slice.map((c) => Number(c.volume) || 0);
  const volEma20 = ema(volumes, 20);

  const atrPcts = [];
  const adxVals = [];
  const volRatios = [];
  const rangeAtrs = [];
  const bodyRanges = [];
  const followAtrs = [];
  let setupCount = 0;
  let weakReclaimCount = 0;
  for (let i = 14; i < slice.length; i++) {
    const close = num(slice[i]?.close);
    const atr = num(atrSeries[i]);
    if (close > 0 && atr > 0) atrPcts.push(atr / close);

    const adx = num(adxSeries[i]);
    if (adx > 0) adxVals.push(adx);

    const ve = num(volEma20[i]);
    const volume = Number(volumes[i]) || 0;
    if (ve > 0 && volume > 0) volRatios.push(volume / ve);

    const high = num(slice[i]?.high);
    const low = num(slice[i]?.low);
    const open = num(slice[i]?.open);
    const range = high > low ? high - low : 0;
    if (range > 0 && atr > 0) rangeAtrs.push(range / atr);
    if (range > 0 && Number.isFinite(open) && Number.isFinite(close)) bodyRanges.push(Math.abs(close - open) / range);

    if (i >= 40 && i + 4 < slice.length && close > 0 && atr > 0) {
      const events = detectRollingLiquiditySweeps(slice, i, {
        liqMapLookbackBars: 72,
        liqMapMaxAgeBars: 72,
        liqMapMinTouches: 1,
        liqMapMinWickRatio: 0.2,
        liqMapMinRvol: 0,
        liqMapNormalizeThresholds: true,
        liqMapSweepAtrFrac: Number(o.sweepAtrFrac ?? LIQ_MAP_AUTO_DEFAULTS.sweepAtrFrac),
        liqMapEqualTolAtrFrac: Number(o.equalTolAtrFrac ?? LIQ_MAP_AUTO_DEFAULTS.equalTolAtrFrac),
        refAtrPct: atr / close,
        liqMapRequireUnresolved: true,
        liqMapRequireDirectionalClose: false,
      });
      const event = events?.[0];
      if (event) {
        setupCount += 1;
        if (Number(event.wickRatio ?? 0) < 0.3 || Number(event.bodyRatio ?? 0) < 0.18 || Number(event.rvol ?? 1) < 0.9) {
          weakReclaimCount += 1;
        }
        let fav = 0;
        for (let j = i + 1; j <= i + 4; j++) {
          const b = slice[j];
          if (event.side === "BUY") fav = Math.max(fav, num(b?.high) - close);
          else fav = Math.max(fav, close - num(b?.low));
        }
        if (fav >= 0) followAtrs.push(fav / atr);
      }
    }
  }

  const medianAtrPct = median(atrPcts) ?? o.referenceAtrPct;
  const p70AtrPct = percentile(atrPcts, 70) ?? medianAtrPct;
  const p90AtrPct = percentile(atrPcts, 90) ?? p70AtrPct;

  return {
    profileBars: end,
    medianAtrPct,
    p70AtrPct,
    p90AtrPct,
    atrSpread: medianAtrPct > 0 ? p90AtrPct / medianAtrPct : 1,
    medianAdx: median(adxVals) ?? 22,
    medianVolRatio: median(volRatios) ?? 1,
    medianRangeAtr: median(rangeAtrs) ?? 1.5,
    medianBodyRange: median(bodyRanges) ?? 0.35,
    setupDensityPerDay: setupCount / Math.max(1, (end * 15) / (60 * 24)),
    weakReclaimRate: setupCount > 0 ? weakReclaimCount / setupCount : 0,
    medianFollowAtr: median(followAtrs) ?? 1,
  };
}

export function resolveLiqMapDynamicTuning(profile = {}, opts = {}) {
  const o = { ...LIQ_MAP_AUTO_DEFAULTS, ...opts };
  const baseSweep = Number(opts.sweepAtrFrac ?? o.sweepAtrFrac);
  const baseEqual = Number(opts.equalTolAtrFrac ?? o.equalTolAtrFrac);
  const baseSl = Number(opts.atrSlMult ?? 1);
  const baseQuality = Number(opts.minQualityScore ?? o.minQualityScore);
  const atr = Number(profile.medianAtrPct ?? o.referenceAtrPct);
  const adx = Number(profile.medianAdx ?? 22);
  const vol = Number(profile.medianVolRatio ?? 1);
  const volScale = atr > 0 ? atr / o.referenceAtrPct : 1;
  const atrSpread = Number(profile.atrSpread ?? 1);
  const rangeAtr = Number(profile.medianRangeAtr ?? 1.5);
  const bodyRange = Number(profile.medianBodyRange ?? 0.35);
  const setupDensity = Number(profile.setupDensityPerDay ?? 0);
  const weakReclaimRate = Number(profile.weakReclaimRate ?? 0);
  const followAtr = Number(profile.medianFollowAtr ?? 1);

  // Higher-vol/noisier coins need a larger pierce and wider equal-level cluster
  // to avoid classifying normal wick noise as a liquidity sweep.
  const wickNoise = (Math.max(0, atrSpread - 1) * 0.35) + (rangeAtr > 2 && bodyRange < 0.35 ? 0.1 : 0);
  const noiseScale = clamp(0.9 + (volScale - 1) * 0.28 + (vol < 0.95 ? 0.04 : 0) + wickNoise, 0.75, 1.7);
  const trendScale = adx >= 30 ? 0.94 : adx <= 18 ? 1.06 : 1;
  const sweepAtrFrac = clamp(baseSweep * noiseScale * trendScale, o.sweepAtrFracFloor, o.sweepAtrFracCeil);
  const equalTolAtrFrac = clamp(
    baseEqual * (0.92 + (volScale - 1) * 0.18 + Math.max(0, atrSpread - 1) * 0.12),
    o.equalTolAtrFracFloor,
    o.equalTolAtrFracCeil,
  );

  // Keep risk geometry bounded: high-vol coins already get wider absolute stops
  // from ATR, so only make small multiplier changes.
  const atrSlMult = clamp(baseSl * (volScale > 1.4 ? 0.92 : volScale < 0.8 ? 1.08 : 1), o.atrSlMultFloor, o.atrSlMultCeil);
  const qualityBump =
    (volScale > 1.35 ? 0.45 : volScale > 1.1 ? 0.18 : volScale < 0.8 ? -0.12 : 0) +
    (adx < 18 ? 0.45 : adx < 22 ? 0.18 : adx > 30 ? -0.12 : 0) +
    (vol < 0.95 ? 0.2 : vol > 1.08 ? -0.05 : 0) +
    (atrSpread > 1.35 ? 0.3 : atrSpread > 1.2 ? 0.15 : 0) +
    (rangeAtr > 2.2 && bodyRange < 0.32 ? 0.25 : 0) +
    (weakReclaimRate > 0.65 ? 0.2 : weakReclaimRate > 0.4 ? 0.15 : weakReclaimRate > 0.25 ? 0.1 : 0) +
    (followAtr < 0.3 && weakReclaimRate > 0.25 ? 0.1 : followAtr < 0.35 && weakReclaimRate > 0.4 ? 0.05 : followAtr > 1.6 ? -0.1 : 0) +
    (setupDensity >= 3 && followAtr < 0.3 && weakReclaimRate <= 0.5 ? 0.45 : 0) +
    (setupDensity > 5 && weakReclaimRate > 0.6 ? 0.05 : 0);
  const minQualityScore = clamp(baseQuality + qualityBump, o.minQualityScoreFloor, o.minQualityScoreCeil);
  const dynamicExitQualityMid = clamp(minQualityScore - 0.35 + (adx > 28 ? -0.1 : 0), 0, 12);
  const dynamicExitQualityHi = clamp(minQualityScore + 0.35 + (atrSpread > 1.25 ? 0.15 : 0), 0, 12);
  const dynamicExitRrMid = clamp(1.7 + (rangeAtr > 2.2 ? 0.15 : 0) + (adx < 20 ? 0.15 : 0), 1.3, 2.4);
  const dynamicExitRrHi = clamp(dynamicExitRrMid + 0.9 + (adx < 20 ? 0.2 : 0), 2.0, 3.6);
  const requireDirectionalClose = followAtr < 0.3 && setupDensity >= 3 && weakReclaimRate <= 0.5;

  return {
    sweepAtrFrac,
    equalTolAtrFrac,
    atrSlMult,
    minQualityScore,
    dynamicExitQualityMid,
    dynamicExitQualityHi,
    dynamicExitRrMid,
    dynamicExitRrHi,
    requireDirectionalClose,
    profileFeatures: { atr, adx, vol, volScale, atrSpread, rangeAtr, bodyRange, setupDensity, weakReclaimRate, followAtr },
    tuneSource: "liq_map_profile_rules",
  };
}

/**
 * Per-coin dynamic runner trail buffers. High follow-through / expansion coins
 * get wider chandelier + more MFE giveback so runners can catch larger moves.
 * Choppy / weak-reclaim coins fall back to fixed TP (hybrid exit) because
 * partial+trail underperforms capped structural targets on those profiles.
 */
export function resolveLiqMapTrailTuning(profile = {}, opts = {}) {
  const followAtr = Number(profile.medianFollowAtr ?? 1);
  const atrSpread = Number(profile.atrSpread ?? 1);
  const weakReclaimRate = Number(profile.weakReclaimRate ?? 0);
  const rangeAtr = Number(profile.medianRangeAtr ?? 1.5);
  const adx = Number(profile.medianAdx ?? 22);
  const setupDensity = Number(profile.setupDensityPerDay ?? 0);

  const baseHwm = Number(opts.trailAtrHwmMult ?? 2.5);
  const baseGiveback = Number(opts.trailMfeGiveback ?? 0.18);
  const baseMfeMinR = Number(opts.trailMfeMinR ?? 1.2);
  const baseStep = Number(opts.trailStepAtrMult ?? 0.6);
  const basePartial = Number(opts.partialFrac ?? 0.45);
  const baseBufferAtr = Number(opts.trailBufferAtrMult ?? 0.28);

  const cleanTrendFollow =
    followAtr > 0.9 && weakReclaimRate < 0.4 && adx >= 24;
  const structuralScalp =
    (cleanTrendFollow && followAtr < 1.3) ||
    (setupDensity < 1.8 && followAtr < 1.2 && weakReclaimRate < 0.45);
  const chopDefensive =
    followAtr < 0.9 ||
    (weakReclaimRate > 0.45 && followAtr < 1.15) ||
    (setupDensity >= 1.8 && followAtr < 1.05 && weakReclaimRate > 0.3);
  const highFollowExpander =
    followAtr >= 1.2 &&
    !structuralScalp &&
    !chopDefensive &&
    (atrSpread > 1.15 || rangeAtr > 1.85);

  let trailAtrHwmMult = baseHwm;
  let trailMfeGiveback = baseGiveback;
  let trailMfeMinR = baseMfeMinR;
  let trailStepAtrMult = baseStep;
  let trailMergeSt = opts.trailMergeSt !== false;
  let partialFrac = basePartial;
  let trailBufferAtrMult = baseBufferAtr;
  let dynamicRunnerMaxTpRr = Number(opts.dynamicRunnerMaxTpRr ?? 15);
  let dynamicRunnerMinTpRr = Number(opts.dynamicRunnerMinTpRr ?? 2);
  let trailTier = "BALANCED";
  let useFixedExit = false;

  if (highFollowExpander) {
    trailTier = "EXPANDER";
    trailAtrHwmMult = clamp(baseHwm * 1.25 + 0.75 + (followAtr > 1.35 ? 0.35 : 0), 3.2, 4.8);
    trailMfeGiveback = clamp(baseGiveback + 0.08 + (atrSpread > 1.35 ? 0.04 : 0), 0.18, 0.32);
    trailMfeMinR = clamp(baseMfeMinR - 0.35, 0.85, 1.4);
    trailStepAtrMult = clamp(baseStep + 0.12, 0.55, 1.1);
    trailMergeSt = false;
    partialFrac = clamp(basePartial - 0.14 - (followAtr > 1.3 ? 0.04 : 0), 0.26, 0.36);
    trailBufferAtrMult = clamp(
      baseBufferAtr + 0.22 + (atrSpread > 1.3 ? 0.12 : 0) + (followAtr > 1.25 ? 0.08 : 0),
      0.42,
      0.7,
    );
    dynamicRunnerMaxTpRr = clamp(dynamicRunnerMaxTpRr + 6, 16, 28);
    dynamicRunnerMinTpRr = clamp(dynamicRunnerMinTpRr - 0.2, 1.6, 3.5);
  } else if (chopDefensive || structuralScalp) {
    trailTier = structuralScalp && !chopDefensive ? "STRUCTURAL_SCALP" : "DEFENSIVE";
    useFixedExit = true;
    trailAtrHwmMult = clamp(baseHwm * 0.8, 1.6, 2.6);
    trailMfeGiveback = clamp(baseGiveback - 0.06, 0.08, 0.14);
    trailMfeMinR = clamp(baseMfeMinR + 0.4, 1.5, 3.2);
    trailStepAtrMult = clamp(baseStep - 0.12, 0.2, 0.65);
    trailMergeSt = true;
    partialFrac = clamp(basePartial + 0.1, 0.5, 0.65);
    trailBufferAtrMult = clamp(baseBufferAtr - 0.08, 0.12, 0.24);
    dynamicRunnerMaxTpRr = clamp(dynamicRunnerMaxTpRr - 4, 8, 12);
    dynamicRunnerMinTpRr = clamp(dynamicRunnerMinTpRr + 0.4, 2.0, 4.5);
  } else {
    trailTier = "BALANCED";
    useFixedExit = true;
    partialFrac = clamp(basePartial - 0.06, 0.34, 0.42);
    trailBufferAtrMult = clamp(baseBufferAtr + 0.06, 0.3, 0.45);
    trailAtrHwmMult = clamp(baseHwm + 0.35, 2.6, 3.6);
    trailMfeGiveback = clamp(baseGiveback + 0.03, 0.16, 0.22);
    trailMfeMinR = clamp(baseMfeMinR - 0.1, 1.0, 1.8);
  }

  return {
    trailTier,
    useFixedExit,
    trailAtrHwmMult,
    trailMfeGiveback,
    trailMfeMinR,
    trailStepAtrMult,
    trailMergeSt,
    partialFrac,
    trailBufferAtrMult,
    trailBufferMode: "ATR",
    dynamicRunnerMaxTpRr,
    dynamicRunnerMinTpRr,
    profileFeatures: { followAtr, atrSpread, weakReclaimRate, rangeAtr, adx, setupDensity },
    tuneSource: "liq_map_trail_profile",
  };
}

export function applyLiqMapAutoCalibrateCfg(cfg = {}, candles = []) {
  const out = { ...cfg };
  if (out.liqMapAutoCalibrate !== true || !candles?.length) return out;

  const profileBars = Math.max(40, Math.min(200, Math.round(Number(out.liqMapAutoProfileBars ?? LIQ_MAP_AUTO_DEFAULTS.profileBars))));
  const profile = buildLiqMapCoinProfile(candles, { profileBars });
  const tuning = resolveLiqMapDynamicTuning(profile, {
    sweepAtrFrac: out.liqMapSweepAtrFrac ?? LIQ_MAP_AUTO_DEFAULTS.sweepAtrFrac,
    equalTolAtrFrac: out.liqMapEqualTolAtrFrac ?? LIQ_MAP_AUTO_DEFAULTS.equalTolAtrFrac,
    atrSlMult: out.liqMapAtrSlMult ?? 1,
    minQualityScore: out.liqMapMinQualityScore ?? LIQ_MAP_AUTO_DEFAULTS.minQualityScore,
  });

  out.liqMapNormalizeThresholds = out.liqMapNormalizeThresholds !== false;
  out.liqMapSweepAtrFrac = tuning.sweepAtrFrac;
  out.liqMapEqualTolAtrFrac = tuning.equalTolAtrFrac;
  out.liqMapAtrSlMult = tuning.atrSlMult;
  const f = tuning.profileFeatures || {};
  const highFollowNoisy =
    Number(f.followAtr) > 1.2 &&
    Number(f.weakReclaimRate) > 0.65 &&
    Number(f.atrSpread) > 1.5;
  const weakFollowTrend =
    Number(f.followAtr) < 0.9 &&
    Number(f.weakReclaimRate) >= 0.35 &&
    Number(f.adx) >= 29;

  if (highFollowNoisy) {
    // BTC/DOGE-like: wick-heavy but follow-through exists. Keep OB/FVG flexibility
    // and do not reject farther opposing pools; otherwise we filter out the actual winners.
    out.liqMapEntryZoneMode = "EITHER";
    out.liqMapRequireDirectionalClose = false;
    out.liqMapMaxOpposingRr = 0;
  } else if (weakFollowTrend) {
    // BNB/LINK/ADA-like: reversal attempts need trend-side HTF confirmation.
    out.liqMapHtfMode = "with";
  }
  if (tuning.requireDirectionalClose === true) out.liqMapRequireDirectionalClose = true;
  if (out.liqMapQualityAuto !== false) {
    out.liqMapMinQualityScore = tuning.minQualityScore;
    if (out.liqMapDynamicExitPolicy === true) {
      out.liqMapDynExitQualityMid = tuning.dynamicExitQualityMid;
      out.liqMapDynExitQualityHi = tuning.dynamicExitQualityHi;
      out.liqMapDynExitRrMid = tuning.dynamicExitRrMid;
      out.liqMapDynExitRrHi = tuning.dynamicExitRrHi;
    }
  }

  const runnerMode = String(out.liqMapExitMode ?? "").toUpperCase() === "PARTIAL_RUNNER";
  const dynamicTrail = String(out.liqMapTrailMode ?? "").toUpperCase() === "DYNAMIC_ATR";
  const hybridExit = out.liqMapHybridExit !== false;
  if (runnerMode && dynamicTrail && out.liqMapAutoTrailTune !== false) {
    const trail = resolveLiqMapTrailTuning(profile, {
      trailAtrHwmMult: out.liqMapTrailAtrHwmMult ?? 2.5,
      trailMfeGiveback: out.liqMapTrailMfeGiveback ?? 0.18,
      trailMfeMinR: out.liqMapTrailMfeMinR ?? 1.2,
      trailStepAtrMult: out.liqMapTrailStepAtrMult ?? 0.6,
      trailMergeSt: out.liqMapTrailMergeSt !== false,
      partialFrac: out.liqMapPartialFrac ?? out.intradayLiqPartialFrac ?? 0.45,
      trailBufferAtrMult: out.trailBufferAtrMult ?? 0.28,
      dynamicRunnerMaxTpRr: out.liqMapDynamicRunnerMaxTpRr ?? 15,
      dynamicRunnerMinTpRr: out.liqMapDynamicRunnerMinTpRr ?? 2,
    });
    if (hybridExit && trail.useFixedExit === true) {
      out.liqMapExitMode = "SCALED_FIXED";
      out.liqMapMaxOpposingRr = 2;
      out.liqMapMinTp2Rr = 1.2;
      out.liqMapFallbackTpRr = 1.6;
      out.liqMapDynamicExitPolicy = false;
      out._liqMapTrailTuning = { ...trail, appliedExitMode: "SCALED_FIXED" };
    } else {
      out.liqMapTrailAtrHwmMult = trail.trailAtrHwmMult;
      out.liqMapTrailMfeGiveback = trail.trailMfeGiveback;
      out.liqMapTrailMfeMinR = trail.trailMfeMinR;
      out.liqMapTrailStepAtrMult = trail.trailStepAtrMult;
      out.liqMapTrailMergeSt = trail.trailMergeSt;
      out.liqMapPartialFrac = trail.partialFrac;
      out.intradayLiqPartialFrac = trail.partialFrac;
      out.trailBufferMode = trail.trailBufferMode;
      out.trailBufferAtrMult = trail.trailBufferAtrMult;
      out.liqMapDynamicRunnerMaxTpRr = trail.dynamicRunnerMaxTpRr;
      out.liqMapDynamicRunnerMinTpRr = trail.dynamicRunnerMinTpRr;
      out.trailDynamicAdvAtrHwmMult = trail.trailAtrHwmMult;
      out.trailDynamicAdvMfeGivebackFrac = trail.trailMfeGiveback;
      out.trailDynamicAdvMfeMinR = trail.trailMfeMinR;
      out.trailDynamicAdvPostT02StepAtrMult = trail.trailStepAtrMult;
      out.trailDynamicAdvMergeSupertrend = trail.trailMergeSt;
      out._liqMapTrailTuning = { ...trail, appliedExitMode: "PARTIAL_RUNNER" };
    }
  }

  out._liqMapCoinProfile = profile;
  out._liqMapDynamicTuning = tuning;
  return out;
}
