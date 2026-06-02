/**
 * Institutional A+ S/R — HTF trend + zone + liquidity sweep + BOS + confirmation + volume.
 */

import { listSessionLiquiditySetups } from "./techniques/liquidity.js";
import {
  passesHtfTrend,
  passesHtfZoneAlignment,
  passesVolumeExpansion,
} from "./techniques/supportResistance.js";
import { detectStructureShift } from "./techniques/structureShift.js";
import { passesConfirmationCandle } from "./techniques/confirmationCandles.js";

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {object} opts
 */
export function evaluateInstitutionalSrSetup(candles, idx, side, pre, opts = {}) {
  if (idx < 1 || !candles?.length) return null;

  if (opts.intradaySrRequireHtfTrend !== false && !passesHtfTrend(side, pre, idx, opts)) {
    return null;
  }

  const liqOpts = { ...opts, _liqPre: pre };
  const setups = listSessionLiquiditySetups(candles, idx, side, pre, liqOpts);
  if (!setups.length) return null;

  const requireBos = opts.intradaySrRequireBos !== false;
  const requireConfirm = opts.intradaySrRequireConfirm !== false;
  const requireVol = opts.intradaySrRequireVolume !== false;

  let best = null;

  for (const setup of setups) {
    if (setup.reclaimIdx !== idx) continue;

    const bar = candles[idx];
    if (!passesHtfZoneAlignment(side, bar, pre, idx, setup, opts)) continue;

    const cycle = {
      reclaimIdx: setup.reclaimIdx,
      sweepStartIdx: setup.sweepStartIdx,
      wick: setup.wick,
      level: setup.level,
      levelType: setup.levelType,
    };

    const bos = detectStructureShift(candles, cycle, side, opts);
    if (requireBos && !bos.ok) continue;

    const confirmIdx = bos.ok ? bos.bosIdx : idx;
    const confirmBar = candles[confirmIdx];
    const confirmPrev = confirmIdx > 0 ? candles[confirmIdx - 1] : null;
    const reclaimBar = candles[idx];
    const reclaimPrev = idx > 0 ? candles[idx - 1] : null;
    const confirmOk =
      passesConfirmationCandle(confirmBar, confirmPrev, side, opts) ||
      (confirmIdx !== idx && passesConfirmationCandle(reclaimBar, reclaimPrev, side, opts));
    if (requireConfirm && !confirmOk) {
      continue;
    }

    if (
      requireVol &&
      !passesVolumeExpansion(pre, confirmIdx, opts) &&
      !passesVolumeExpansion(pre, idx, opts)
    ) {
      continue;
    }

    const techniques = ["sr_htf_zone", "liq_sweep", setup.levelType];
    if (bos.ok) techniques.push("sr_bos");
    techniques.push("sr_confirm");
    techniques.push("vol");

    const enriched = {
      ...setup,
      techniques,
      bosIdx: bos.bosIdx,
      bosLevel: bos.bosLevel,
      confirmIdx,
      score: Math.min(14, Math.round(8 + (setup.liqQuality ?? 0) / 40)),
    };

    if (!best || (enriched.liqQuality ?? 0) > (best.liqQuality ?? 0)) {
      best = enriched;
    }
  }

  return best;
}

/**
 * Best institutional setup across both sides at bar idx.
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre
 * @param {object} opts
 */
export function evaluateBestInstitutionalSrAtBar(candles, idx, pre, opts = {}) {
  let best = null;
  for (const side of ["BUY", "SELL"]) {
    const s = evaluateInstitutionalSrSetup(candles, idx, side, pre, opts);
    if (!s) continue;
    if (!best || (s.liqQuality ?? 0) > (best.liqQuality ?? 0)) {
      best = s;
    }
  }
  return best;
}

/** True when A+ institutional path should be used. */
export function isInstitutionalSrMode(opts = {}) {
  return opts.intradaySrAPlusMode === true || opts.intradayGateInstitutionalSr === true;
}
