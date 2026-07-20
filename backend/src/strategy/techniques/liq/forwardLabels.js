/**
 * Forward path labels for LIQ candidate research (not executed-trade outcomes).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_HORIZONS = [5, 10, 20, 50];

/**
 * Walk forward from entry bar and compute R-multiple path statistics.
 */
export function computeForwardLabels(candles, entryBarIdx, side, entryPx, slPrice, pre, opts = {}) {
  const entry = num(entryPx);
  const sl = num(slPrice);
  const entryIdx = Number(entryBarIdx);
  const opposingLevel = num(opts.opposingLevel);
  if (!candles?.length || entry == null || sl == null || entryIdx < 0 || entryIdx >= candles.length) {
    return null;
  }

  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;

  const atr = num(pre?.atrSeries?.[entryIdx] ?? pre?.atr?.[entryIdx]) ?? risk;
  const maxBars = Number(opts.intradayLiqHarvestMaxForwardBars ?? 96);
  const horizons = opts.forwardHorizons ?? DEFAULT_HORIZONS;
  const rTargets = opts.rTargets ?? [1, 2, 3];

  let mfeR = 0;
  let maeR = 0;
  let mfeBar = null;
  let maeBar = null;
  const hitRAtBar = Object.fromEntries(rTargets.map((r) => [`hit${r}R`, null]));
  const horizonSnap = Object.fromEntries(horizons.map((h) => [h, { mfeR: 0, maeR: 0 }]));
  const labels = {};

  let firstHit = "neither";
  let opposingLiquidityReached = 0;
  let opposingLiquidityBar = null;

  for (let j = entryIdx + 1; j < candles.length && j <= entryIdx + maxBars; j++) {
    const bar = candles[j];
    if (!bar) continue;
    const barsSince = j - entryIdx;

    let favorableR = 0;
    let adverseR = 0;
    if (side === "BUY") {
      favorableR = (Number(bar.high) - entry) / risk;
      adverseR = (entry - Number(bar.low)) / risk;
    } else {
      favorableR = (entry - Number(bar.low)) / risk;
      adverseR = (Number(bar.high) - entry) / risk;
    }

    const hitSl = side === "BUY" ? Number(bar.low) <= sl : Number(bar.high) >= sl;
    const hit1R = favorableR >= 1;

    if (firstHit === "neither") {
      if (hitSl && hit1R) firstHit = "ambiguous";
      else if (hitSl) firstHit = "sl_first";
      else if (hit1R) firstHit = "plus1R_first";
    }

    if (favorableR > mfeR) {
      mfeR = favorableR;
      mfeBar = barsSince;
    }
    if (adverseR > maeR) {
      maeR = adverseR;
      maeBar = barsSince;
    }

    if (opposingLevel != null && opposingLiquidityReached === 0) {
      const hitOpp = side === "BUY" ? Number(bar.high) >= opposingLevel : Number(bar.low) <= opposingLevel;
      if (hitOpp) {
        opposingLiquidityReached = 1;
        opposingLiquidityBar = barsSince;
      }
    }

    for (const r of rTargets) {
      const key = `hit${r}R`;
      if (hitRAtBar[key] == null && favorableR >= r) hitRAtBar[key] = barsSince;
    }

    for (const h of horizons) {
      if (barsSince <= h) {
        horizonSnap[h].mfeR = Math.max(horizonSnap[h].mfeR, favorableR);
        horizonSnap[h].maeR = Math.max(horizonSnap[h].maeR, adverseR);
      }
      if (barsSince === h) {
        const closeR =
          side === "BUY" ? (Number(bar.close) - entry) / risk : (entry - Number(bar.close)) / risk;
        labels[`fwd_closeR_${h}`] = Number(closeR.toFixed(4));
        labels[`fwd_mfeR_${h}`] = Number(horizonSnap[h].mfeR.toFixed(4));
        labels[`fwd_maeR_${h}`] = Number(horizonSnap[h].maeR.toFixed(4));
        labels[`fwd_mfeAtr_${h}`] =
          atr > 0 ? Number(((horizonSnap[h].mfeR * risk) / atr).toFixed(4)) : null;
        labels[`fwd_maeAtr_${h}`] =
          atr > 0 ? Number(((horizonSnap[h].maeR * risk) / atr).toFixed(4)) : null;
      }
    }
  }

  const endIdx = Math.min(candles.length - 1, entryIdx + maxBars);
  const endBar = candles[endIdx];
  const endCloseR =
    endBar && side === "BUY"
      ? (Number(endBar.close) - entry) / risk
      : endBar
        ? (entry - Number(endBar.close)) / risk
        : null;

  return {
    riskR: 1,
    mfeR: Number(mfeR.toFixed(4)),
    maeR: Number(maeR.toFixed(4)),
    mfeAtr: atr > 0 ? Number(((mfeR * risk) / atr).toFixed(4)) : null,
    maeAtr: atr > 0 ? Number(((maeR * risk) / atr).toFixed(4)) : null,
    timeToMfeBars: mfeBar,
    timeToMaeBars: maeBar,
    firstHit,
    firstHit_plus1R: firstHit === "plus1R_first" ? 1 : 0,
    firstHit_sl: firstHit === "sl_first" ? 1 : 0,
    opposingLiquidityReached,
    opposingLiquidityBar,
    endCloseR: endCloseR != null ? Number(endCloseR.toFixed(4)) : null,
    maxForwardBars: endIdx - entryIdx,
    hit1R: hitRAtBar.hit1R,
    hit2R: hitRAtBar.hit2R,
    hit3R: hitRAtBar.hit3R,
    hit1R_flag: hitRAtBar.hit1R != null ? 1 : 0,
    hit2R_flag: hitRAtBar.hit2R != null ? 1 : 0,
    hit3R_flag: hitRAtBar.hit3R != null ? 1 : 0,
    ...labels,
  };
}

/** Did price reach +1R before SL within forward window? */
export function computeReach1RBeforeSl(candles, entryBarIdx, side, entryPx, slPrice, maxBars = 96) {
  const entry = num(entryPx);
  const sl = num(slPrice);
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  for (let j = entryBarIdx + 1; j < candles.length && j <= entryBarIdx + maxBars; j++) {
    const bar = candles[j];
    if (!bar) continue;
    const hitSl = side === "BUY" ? Number(bar.low) <= sl : Number(bar.high) >= sl;
    const hit1R =
      side === "BUY" ? Number(bar.high) >= entry + risk : Number(bar.low) <= entry - risk;
    if (hitSl && hit1R) return 0;
    if (hitSl) return 0;
    if (hit1R) return 1;
  }
  return null;
}

/**
 * Full outcome distribution (probability estimation inputs, not a black-box score).
 */
export function estimateOutcomeDistribution(labels) {
  if (!labels) return null;
  return {
    pHit1R: labels.hit1R_flag ?? 0,
    pHit2R: labels.hit2R_flag ?? 0,
    pHit3R: labels.hit3R_flag ?? 0,
    pReach1RBeforeSl: labels.probReach1R ?? null,
    pPlus1RFirst: labels.firstHit_plus1R ?? 0,
    pSlFirst: labels.firstHit_sl ?? 0,
    expectedMfeR: labels.mfeR ?? null,
    expectedMaeR: labels.maeR ?? null,
    expectedCloseR20: labels.fwd_closeR_20 ?? null,
    timeToMfeBars: labels.timeToMfeBars ?? null,
    opposingLiquidityReached: labels.opposingLiquidityReached ?? 0,
  };
}
