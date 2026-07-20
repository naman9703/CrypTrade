/**
 * VOLUME_PROFILE — standalone strategy driven by VP structure (POC / VA / HVN / LVN).
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";
import { dayStore } from "./adapterPersisted.js";
import {
  buildVolumeProfile,
  detectVolumeProfileSetup,
  applyVolumeProfileGates,
  resolveVolumeProfileGateMode,
  volumeProfileBrackets,
  pathToNextHvn,
  passesVpRegimeImmunity,
  VP_SETUP_TIERS,
} from "./techniques/volumeProfile.js";
import {
  describeVpConditionCell,
  classifyVpMacro,
  classifyVpPath,
  vpMacroBullAt,
} from "./vpConditionCell.js";
import { decideVpNovelty } from "./vpNoveltyMonitor.js";

const WARMUP = 120;
const DEFAULT_MAX_PER_DAY = 2;
const DEFAULT_MIN_BAR_GAP = 12;
const DEFAULT_MIN_SCORE = 10;

const DEFAULT_ALLOWED_SETUPS = ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"];

function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

function utcHour(ts) {
  return Math.floor((ts % 86_400_000) / 3_600_000);
}

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3_600_000) * 3_600_000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = { ts: hourTs, close: c.close };
    } else {
      cur.close = c.close;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3_600_000) * 3_600_000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function precomputeVolumeProfile(candles) {
  const n = candles.length;
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const adxSeries = computeAdx(candles, 14);
  const atrSeries = computeAtr(candles, 14);
  const closes = candles.map((c) => c.close);
  const sampleMs =
    n > 1
      ? Math.max(60_000, Number(candles[1]?.ts ?? 0) - Number(candles[0]?.ts ?? 0))
      : 15 * 60_000;
  const barsPerDay = Math.max(1, Math.round(86_400_000 / sampleMs));

  const hourly = aggregateToHourly(candles);
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const htfUp = new Array(n).fill(false);
  const htfDown = new Array(n).fill(false);
  const htfSep = new Array(n).fill(0);

  // Macro context for adaptive SELL HTF + BUY chase filters.
  const ema20d = ema(closes, barsPerDay * 20);
  const ema5d = ema(closes, barsPerDay * 5);
  const macroAboveEma20d = new Array(n).fill(false);
  const macroEma5dSlope = new Array(n).fill(0);
  const macroPrior20d = new Array(n).fill(0);
  const macroPrior5d = new Array(n).fill(0);
  const macroPrior60d = new Array(n).fill(0);
  const slopeLag = barsPerDay; // ~1d change of 5d EMA
  const prior20Lb = barsPerDay * 20;
  const prior5Lb = barsPerDay * 5;
  const prior60Lb = barsPerDay * 60;

  const minSep = 0.0006;
  for (let i = 0; i < n; i++) {
    const hIdx = hourIndexForBar(candles[i].ts, hourly);
    if (hIdx >= 50) {
      const e21 = hEma21[hIdx];
      const e50 = hEma50[hIdx];
      if (Number.isFinite(e21) && Number.isFinite(e50) && e50 !== 0) {
        const sep = Math.abs(e21 - e50) / Math.abs(e50);
        htfSep[i] = sep;
        if (sep >= minSep) {
          htfUp[i] = e21 > e50;
          htfDown[i] = e21 < e50;
        }
      }
    }
    const px = closes[i];
    const e20 = ema20d[i];
    if (Number.isFinite(px) && Number.isFinite(e20) && e20 > 0) {
      macroAboveEma20d[i] = px > e20;
    }
    if (i >= slopeLag) {
      const a = ema5d[i - slopeLag];
      const b = ema5d[i];
      if (Number.isFinite(a) && Number.isFinite(b) && a !== 0) {
        macroEma5dSlope[i] = (b - a) / a;
      }
    }
    if (i >= prior20Lb) {
      const a = closes[i - prior20Lb];
      if (Number.isFinite(a) && a > 0 && Number.isFinite(px)) {
        macroPrior20d[i] = (px - a) / a;
      }
    }
    if (i >= prior5Lb) {
      const a = closes[i - prior5Lb];
      if (Number.isFinite(a) && a > 0 && Number.isFinite(px)) {
        macroPrior5d[i] = (px - a) / a;
      }
    }
    if (i >= prior60Lb) {
      const a = closes[i - prior60Lb];
      if (Number.isFinite(a) && a > 0 && Number.isFinite(px)) {
        macroPrior60d[i] = (px - a) / a;
      }
    }
  }

  return {
    volumes,
    adxSeries,
    atrSeries,
    htfUp,
    htfDown,
    htfSep,
    macroAboveEma20d,
    macroEma5dSlope,
    macroPrior20d,
    macroPrior5d,
    macroPrior60d,
  };
}

function isTradeableBar(candles, idx, pre, opts = {}) {
  const adxVal = pre.adxSeries[idx];
  const atrVal = pre.atrSeries[idx];
  const bar = candles[idx];
  const minAdx = Number(opts.vpMinAdx ?? 22);
  // vpMinAdx <= 0 disables the ADX gate (frequency research).
  if (minAdx > 0 && (!Number.isFinite(adxVal) || adxVal < minAdx)) return false;
  if (!Number.isFinite(atrVal) || atrVal <= 0 || bar.close <= 0) return false;
  const atrPct = atrVal / bar.close;
  const minAtrPct = Number(opts.vpMinAtrPct ?? 0.0012);
  const maxAtrPct = Number(opts.vpMaxAtrPct ?? 0.04);
  if (minAtrPct > 0 && atrPct < minAtrPct) return false;
  if (maxAtrPct > 0 && atrPct > maxAtrPct) return false;
  const minBarVol = Number(opts.vpMinBarVolRatio ?? 0.85);
  if (minBarVol > 0) {
    const volSlice = pre.volumes.slice(Math.max(0, idx - 20), idx);
    const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
    if (volAvg > 0 && pre.volumes[idx] / volAvg < minBarVol) return false;
  }
  return true;
}

/**
 * Effective min HTF sep for SELL under optional macro-adaptive gate.
 * Bull macro (above 20d EMA / rising 5d EMA / +20d return) needs a stronger
 * 1h EMA separation so pullback "htfDown" flips in uptrends are blocked.
 *
 * @param {object} pre
 * @param {number} idx
 * @param {Record<string, unknown>} opts
 * @returns {number}
 */
export function resolveVpSellMinHtfSep(pre, idx, opts = {}) {
  const buySep = Number(opts.vpMinHtfSepPct ?? 0.0035);
  const soft = Number(opts.vpSellMinHtfSepPct ?? buySep);
  if (opts.vpSellMacroAdapt !== true) {
    const legacy = Number(opts.vpSellBreakdownMinHtfSep ?? 0);
    return legacy > 0 ? legacy : soft;
  }
  const hard = Number(opts.vpSellMacroBullMinHtfSepPct ?? Math.max(soft, 0.005));
  const priorThresh = Number(opts.vpSellMacroPrior20dBullPct ?? 0.02);
  const above = pre?.macroAboveEma20d?.[idx] === true;
  const slope = Number(pre?.macroEma5dSlope?.[idx] ?? 0);
  const prior20 = Number(pre?.macroPrior20d?.[idx] ?? 0);
  const macroBull = above || slope > 0 || prior20 > priorThresh;
  let minSep = macroBull ? hard : soft;
  // Bull-grind / non-bear: shallow 1h flips inside uptrends or chop lose (2023–24).
  // Sustained bear (deep prior60d) keeps soft sep so 2022 breakdown shorts still fire.
  const nonBearMin = Number(opts.vpSellNonBearMinHtfSepPct ?? 0);
  if (nonBearMin > 0) {
    const bearFloor = Number(opts.vpSellBearPrior60dPct ?? -0.05);
    const prior60 = Number(pre?.macroPrior60d?.[idx] ?? 0);
    if (prior60 > bearFloor) minSep = Math.max(minSep, nonBearMin);
  }
  // Some remaining bad shorts are only mildly bearish on the 20d drift after pullbacks.
  // Treat these as weak-bear / transition states and demand stronger HTF separation.
  const weakBearMin = Number(opts.vpSellWeakBearMinHtfSepPct ?? 0);
  if (weakBearMin > 0 && !macroBull) {
    const weakBearFloor = Number(opts.vpSellWeakBearPrior20dFloorPct ?? -0.1);
    if (prior20 > weakBearFloor) minSep = Math.max(minSep, weakBearMin);
  }
  return minSep;
}

/**
 * Block BUY vah_breakout after a sharp ~5d rally (relief / short-covering chase).
 * Independent of vpRegimeImmunity so FREQ can use it without enabling the full stack.
 *
 * @param {object} pre
 * @param {number} idx
 * @param {"BUY"|"SELL"} side
 * @param {string} setup
 * @param {Record<string, unknown>} opts
 * @returns {boolean}
 */
export function passesVpBuyChaseFilter(pre, idx, side, setup, opts = {}) {
  if (opts.vpBuyChaseFilter !== true) return true;
  if (side !== "BUY" || setup !== "vah_breakout") return true;
  const maxPrior5d = Number(opts.vpBuyChaseMaxPrior5dPct ?? 0.08);
  if (!(maxPrior5d > 0)) return true;
  if (opts.vpBuyChaseNonBullOnly === true) {
    const bullFloor = Number(opts.vpBuyChaseBullPrior60dPct ?? 0.05);
    const prior60 = Number(pre?.macroPrior60d?.[idx] ?? 0);
    if (prior60 > bullFloor) return true;
  }
  const prior5d = Number(pre?.macroPrior5d?.[idx] ?? 0);
  return !(Number.isFinite(prior5d) && prior5d > maxPrior5d);
}

/**
 * VAL short macro filters (coin-specific).
 *
 * BTC:
 * - `vpValSellBearOnly` / `vpValSellRequirePrior60dBear`
 *
 * ETH-native (2021–22 autopsy on restored ABC lock — NOT a BTC copy):
 * - `vpValSellBlockBull60Dump`: abstain VAL short when prior60d > +5% AND
 *   prior20d ≤ −5% (shorting a 20d dump inside a 60d bull — dead-cat). Multi-year
 *   −$26 on that slice; 2025–26 almost untouched.
 * - `vpValSellBlockBull60NonVac`: abstain non-vacuum VAL when prior60d > +5%
 *   (structured/tight bull60 VAL −$13.8 multi-year; vacuum bull60 is the 2025–26 edge).
 * - `vpValSellRequireBearTrend`: abstain VAL unless macro cell is `bear_trend`
 *   (prior60d≤−5% and not macroBull). Root cause of 2021–22 bleed: shorts into
 *   bull_trend / weak_bear / residual blow-off — not prepared ETH conditions.
 * - `vpBuyRejectionBlockUnpreparedMacro`: abstain BUY va_rejection outside
 *   bear_trend / bull_chop (blow-off bull_trend rej was thin unproven bleed).
 */
export function passesVpValSellMacroFilter(pre, idx, side, setup, opts = {}) {
  if (side !== "SELL" || setup !== "val_breakdown") return true;

  if (opts.vpValSellRequirePrior60dBear === true) {
    const floor = Number(opts.vpValSellPrior60dBearPct ?? -0.05);
    const prior60 = Number(pre?.macroPrior60d?.[idx] ?? 0);
    if (!(Number.isFinite(prior60) && prior60 <= floor)) return false;
  }

  if (opts.vpValSellBlockBull60 === true) {
    const ceil = Number(opts.vpValSellBull60Pct ?? 0.05);
    const prior60 = Number(pre?.macroPrior60d?.[idx] ?? 0);
    if (Number.isFinite(prior60) && prior60 > ceil) return false;
  }

  const prior60 = Number(pre?.macroPrior60d?.[idx] ?? NaN);
  const prior20 = Number(pre?.macroPrior20d?.[idx] ?? NaN);
  const bull60Ceil = Number(opts.vpValSellBull60Pct ?? 0.05);
  const dumpFloor = Number(opts.vpValSellBull60DumpPrior20dPct ?? -0.05);
  const inBull60 = Number.isFinite(prior60) && prior60 > bull60Ceil;

  if (opts.vpValSellBlockBull60Dump === true && inBull60) {
    if (Number.isFinite(prior20) && prior20 <= dumpFloor) return false;
  }

  if (opts.vpValSellBlockBull60NonVac === true && inBull60) {
    const pathPct = Number(opts.path?.distPct ?? opts.pathPct ?? 0);
    const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
    if (!(pathPct >= vacuumPct)) return false;
  }

  // Relative: in residual 60d bull, abstain when 20d is still *extending* the 60d
  // move (prior20/prior60 > ratio). Blow-off residue shorts fail; brief squeeze
  // shorts with mean-reverting 20d vs 60d still allowed. No-op outside bull60.
  if (opts.vpValSellBlockBull60Extending === true && inBull60) {
    const ratioMin = Number(opts.vpValSellBull60ExtendRatio ?? 0.5);
    if (
      Number.isFinite(prior20) &&
      Number.isFinite(prior60) &&
      Math.abs(prior60) > 0.01 &&
      prior20 / prior60 > ratioMin
    ) {
      return false;
    }
  }

  if (opts.vpValSellBearOnly === true) {
    const priorThresh = Number(opts.vpSellMacroPrior20dBullPct ?? 0.02);
    const above = pre?.macroAboveEma20d?.[idx] === true;
    const slope = Number(pre?.macroEma5dSlope?.[idx] ?? 0);
    const prior20b = Number(pre?.macroPrior20d?.[idx] ?? 0);
    const macroBull = above || slope > 0 || prior20b > priorThresh;
    if (macroBull) return false;
  }

  if (opts.vpValSellRequireBearTrend === true) {
    const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
    const macroBull = vpMacroBullAt(pre, idx, opts);
    const prior60n = Number.isFinite(prior60) ? prior60 : null;
    const macro = classifyVpMacro(prior60n, macroBull, bearFloor);
    if (macro !== "bear_trend") return false;
  }

  // Transition / weak-bear vacuum VAL: local HTF looks shortable but macro is not
  // a clean bear_trend — 2021–22 residual 5t/−$5.7 WR20%. Keep structured weak_bear.
  if (opts.vpValSellBlockWeakBearVacuum === true) {
    const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
    const macroBull = vpMacroBullAt(pre, idx, opts);
    const prior60n = Number.isFinite(prior60) ? prior60 : null;
    const macro = classifyVpMacro(prior60n, macroBull, bearFloor);
    const pathPct = Number(opts.path?.distPct ?? opts.pathPct ?? 0);
    const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
    if (macro === "weak_bear" && pathPct >= vacuumPct) return false;
  }

  // Extreme residual: local HTF is NOT bull (weak_bear cell) but prior60d still
  // elevated → shorting leftover bull into vacuum. Blanket weak_bear vacuum
  // REJECTED (kills lock +42 runner). High prior60 only keeps that runner.
  if (opts.vpValSellBlockWeakBearVacuumHighPrior60 === true) {
    const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
    const ceil = Number(opts.vpValSellWeakBearVacPrior60Pct ?? 0.4);
    const macroBull = vpMacroBullAt(pre, idx, opts);
    const prior60n = Number.isFinite(prior60) ? prior60 : null;
    const macro = classifyVpMacro(prior60n, macroBull, bearFloor);
    const pathPct = Number(opts.path?.distPct ?? opts.pathPct ?? 0);
    const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
    if (macro === "weak_bear" && pathPct >= vacuumPct && prior60n != null && prior60n > ceil) {
      return false;
    }
  }

  // BNB-native (2026-07-20 autopsy): flat prior60 VAL shorts grind in chop/transition.
  if (opts.vpValSellBlockFlatPrior60 === true) {
    const lo = Number(opts.vpValSellFlatPrior60LoPct ?? -0.05);
    const hi = Number(opts.vpValSellFlatPrior60HiPct ?? 0.05);
    if (Number.isFinite(prior60) && prior60 >= lo && prior60 <= hi) return false;
  }

  // BNB-native: shorting VAL after a sharp ~5d rally (squeeze / relief bounce).
  if (opts.vpValSellChaseFilter === true) {
    const maxPrior5d = Number(opts.vpValSellChaseMaxPrior5dPct ?? 0.05);
    if (maxPrior5d > 0) {
      const prior5d = Number(pre?.macroPrior5d?.[idx] ?? NaN);
      if (Number.isFinite(prior5d) && prior5d > maxPrior5d) return false;
    }
  }

  return true;
}

/**
 * BUY va_rejection — abstain outside macros the ETH stack is prepared for.
 * Research-only knobs: bull_trend blanket rejected on full-sim (lock winners).
 * Prefer vpBuyRejectionMinCloseStrength (setup quality) over macro blankets.
 */
export function passesVpBuyRejectionMacroFilter(pre, idx, side, setup, opts = {}) {
  if (side !== "BUY" || setup !== "va_rejection") return true;
  const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
  const prior60 = Number(pre?.macroPrior60d?.[idx]);
  const prior60n = Number.isFinite(prior60) ? prior60 : null;
  const macroBull = vpMacroBullAt(pre, idx, opts);
  const macro = classifyVpMacro(prior60n, macroBull, bearFloor);

  if (opts.vpBuyRejectionBlockBullTrend === true && macro === "bull_trend") return false;

  // Structured path into bull_trend: expansion already in the VA; rejection is thin.
  // Tight-path bull rej still pays on lock. Harvest under H6+H5: early −$6.2 / lock 0.
  if (opts.vpBuyRejectionBlockBullStructured === true) {
    const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
    const pathL = classifyVpPath(opts.path?.distPct ?? opts.pathPct ?? null, vacuumPct);
    if (macro === "bull_trend" && pathL === "structured") return false;
  }

  if (opts.vpBuyRejectionBlockUnpreparedMacro === true) {
    // Prepared-ish for ETH rej: bull_chop / bear_trend. Abstain bull_trend + weak_bear.
    if (macro === "bull_trend" || macro === "weak_bear") return false;
  }
  return true;
}

/**
 * BUY vah_breakout into bull_trend with tight path (no room to next HVN).
 * Physics: expansion already priced; tight path = trapped breakout.
 * Harvest: 2021–22 2t/−$5.4; lock 0t — zero trained-year cost.
 */
export function passesVpBuyBreakoutTightBullFilter(pre, idx, side, setup, path, opts = {}) {
  if (opts.vpBuyBreakoutBlockBullTight !== true) return true;
  if (side !== "BUY" || setup !== "vah_breakout") return true;
  const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
  const pathL = classifyVpPath(path?.distPct ?? null, vacuumPct);
  if (pathL !== "tight") return true;
  const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
  const prior60 = Number(pre?.macroPrior60d?.[idx]);
  const prior60n = Number.isFinite(prior60) ? prior60 : null;
  const macro = classifyVpMacro(prior60n, vpMacroBullAt(pre, idx, opts), bearFloor);
  return macro !== "bull_trend";
}

/**
 * BUY vah_breakout into bull_trend with vacuum path (room to HVN but fake expansion).
 * Physics: bull macro + vacuum breakout = chase into already-extended auction.
 * Harvest under H1–H4: lock −$26 on this cell; weak_bear vacuum VAH kept (pays).
 * Not the same as BTC `vpPreparedBlockVacuumVah` (that also kills ETH weak_bear edge).
 */
export function passesVpBuyBreakoutBullVacuumFilter(pre, idx, side, setup, path, opts = {}) {
  if (opts.vpBuyBreakoutBlockBullVacuum !== true) return true;
  if (side !== "BUY" || setup !== "vah_breakout") return true;
  const vacuumPct = Number(opts.vpVacuumPathPct ?? 0.02);
  const pathL = classifyVpPath(path?.distPct ?? null, vacuumPct);
  if (pathL !== "vacuum") return true;
  const bearFloor = Number(opts.vpValSellPrior60dBearPct ?? opts.vpSellBearPrior60dPct ?? -0.05);
  const prior60 = Number(pre?.macroPrior60d?.[idx]);
  const prior60n = Number.isFinite(prior60) ? prior60 : null;
  const macro = classifyVpMacro(prior60n, vpMacroBullAt(pre, idx, opts), bearFloor);
  return macro !== "bull_trend";
}

/**
 * Prepared-regime authorization (deny-by-default for known bleed cells).
 *
 * Doctrine: live invents new regimes. We do NOT year-hardcode. We encode
 * measurable cells with validated multi-year bleed as unprepared → abstain.
 * Unknown/thin cells are left alone unless `vpPreparedAllowlistOnly` is set.
 *
 * Matrix evidence (BTC FREQ 2021-07→2026-05):
 * - BUY vah_breakout + vacuum (esp. bull) → unprepared bleed
 * - SELL val_breakdown + vacuum + bear_trend → unprepared bleed (−$35 / 26t)
 * Prepared positives are mostly structured VAH/VAL (non-vacuum path).
 *
 * @param {object} pre
 * @param {number} idx
 * @param {"BUY"|"SELL"} side
 * @param {string} setup
 * @param {{ distPct?: number }|null} path
 * @param {Record<string, unknown>} opts
 * @returns {boolean}
 */
export function passesVpPreparedRegimeFilter(pre, idx, side, setup, path, opts = {}) {
  const hasAllow = opts.vpPreparedAllowlistOnly === true;
  const hasDeny =
    opts.vpPreparedRegimeOnly === true ||
    (Array.isArray(opts.vpPreparedBlockCellKeys) && opts.vpPreparedBlockCellKeys.length > 0);
  if (!hasAllow && !hasDeny) return true;

  const cell = describeVpConditionCell(pre, idx, side, setup, path, opts);

  // Layer 3 — allowlist-only: trade only matrix-prepared cells (unknown/novel → abstain).
  if (hasAllow) {
    const allow = Array.isArray(opts.vpPreparedCellKeys)
      ? opts.vpPreparedCellKeys.map(String)
      : [];
    if (allow.length && !allow.includes(cell.key)) return false;
  }

  // Layer 1 — explicit cell deny list (coin-native unprepared bleed keys).
  if (Array.isArray(opts.vpPreparedBlockCellKeys) && opts.vpPreparedBlockCellKeys.length) {
    if (opts.vpPreparedBlockCellKeys.map(String).includes(cell.key)) return false;
  }

  if (opts.vpPreparedRegimeOnly !== true) return true;

  const pathPct = Number(path?.distPct ?? 0);
  const vacuumPct = Number(opts.vpPreparedVacuumPathPct ?? opts.vpVacuumPathPct ?? 0.02);
  const isVacuum = pathPct >= vacuumPct;

  // Unprepared long cell family: vacuum VAH (blow-off / fake expansion).
  // BTC default; ETH may disable and use vpPreparedBlockCellKeys instead
  // (ETH weak_bear vacuum VAH is prepared-positive).
  if (opts.vpPreparedBlockVacuumVah !== false) {
    if (side === "BUY" && setup === "vah_breakout" && isVacuum) return false;
  }

  // Unprepared short cell: vacuum VAL inside bear_trend (deep prior60 + not macroBull).
  // BTC default; ETH must leave OFF — bear vacuum VAL is ETH's largest edge.
  if (opts.vpPreparedBlockVacuumValBear === true) {
    if (side === "SELL" && setup === "val_breakdown" && isVacuum) {
      const priorThresh = Number(opts.vpSellMacroPrior20dBullPct ?? 0.02);
      const bearFloor = Number(opts.vpPreparedBearPrior60dPct ?? opts.vpValSellPrior60dBearPct ?? -0.05);
      const above = pre?.macroAboveEma20d?.[idx] === true;
      const slope = Number(pre?.macroEma5dSlope?.[idx] ?? 0);
      const prior20 = Number(pre?.macroPrior20d?.[idx] ?? 0);
      const prior60 = Number(pre?.macroPrior60d?.[idx] ?? 0);
      const macroBull = above || slope > 0 || prior20 > priorThresh;
      const bearTrend = !macroBull && Number.isFinite(prior60) && prior60 <= bearFloor;
      if (bearTrend) return false;
    }
  }

  return true;
}

function htfAllows(side, pre, idx, opts) {
  if (opts.vpRequireHtfAlign === false) return true;
  const minSep = Number(opts.vpMinHtfSepPct ?? 0.0035);
  if (side === "BUY") {
    if (pre.htfSep[idx] < minSep) return false;
    return pre.htfUp[idx];
  }
  const sellMin = resolveVpSellMinHtfSep(pre, idx, opts);
  if (pre.htfSep[idx] < sellMin) return false;
  return pre.htfDown[idx];
}

function normalizeAllowedSetups(opts) {
  if (Array.isArray(opts.vpAllowedSetups) && opts.vpAllowedSetups.length) return opts.vpAllowedSetups;
  return DEFAULT_ALLOWED_SETUPS;
}

export function evaluateVolumeProfileBar(candles, idx, opts = {}, pre = null) {
  const profileMode = String(opts.vpProfileMode ?? opts.mode ?? "rolling").toLowerCase();
  const lookback = Number(opts.vpLookbackBars ?? 384);
  const minIdx =
    profileMode === "rolling"
      ? Math.max(WARMUP, lookback)
      : Math.max(WARMUP, Math.floor(Number(opts.vpCompositeDays ?? 5)) * 96);
  if (idx < minIdx) return null;

  const hour = utcHour(candles[idx].ts);
  const start = Number(opts.vpSessionStartHour ?? opts.sessionStartHour ?? 7);
  const end = Number(opts.vpSessionEndHour ?? opts.sessionEndHour ?? 22);
  if (hour < start || hour >= end) return null;

  const P = pre || precomputeVolumeProfile(candles);
  if (!isTradeableBar(candles, idx, P, opts)) return null;

  const vpOpts = {
    ...opts,
    vpAllowedSetups: normalizeAllowedSetups(opts),
    volumeProfileEnabled: true,
  };

  const vp = buildVolumeProfile(candles, idx, {
    mode: profileMode,
    lookback,
    bins: opts.vpBins ?? 50,
    valueAreaPct: opts.vpValueAreaPct,
    distribute: opts.vpVolumeDistribute,
    includePriorSession: opts.vpIncludePriorSession !== false,
    vpCompositeDays: opts.vpCompositeDays,
  });
  if (!vp) return null;

  const gateMode = resolveVolumeProfileGateMode(vpOpts);
  let best = null;

  for (const side of ["BUY", "SELL"]) {
    if (!htfAllows(side, P, idx, opts)) continue;

    const setup = detectVolumeProfileSetup(candles, idx, side, vp, vpOpts);
    if (!setup) continue;

    if (opts.vpTierAOnly === true && setup.tier !== "A" && VP_SETUP_TIERS[setup.setup] !== "A") continue;

    if (!passesVpBuyChaseFilter(P, idx, side, setup.setup, { ...vpOpts, ...opts })) continue;

    const pathPreview = pathToNextHvn(candles[idx].close, side, vp);
    if (!passesVpBuyRejectionMacroFilter(P, idx, side, setup.setup, { ...vpOpts, ...opts, path: pathPreview })) continue;

    if (!passesVpValSellMacroFilter(P, idx, side, setup.setup, { ...vpOpts, ...opts, path: pathPreview })) {
      continue;
    }
    if (!passesVpBuyBreakoutTightBullFilter(P, idx, side, setup.setup, pathPreview, { ...vpOpts, ...opts })) {
      continue;
    }
    if (!passesVpBuyBreakoutBullVacuumFilter(P, idx, side, setup.setup, pathPreview, { ...vpOpts, ...opts })) {
      continue;
    }
    if (!passesVpPreparedRegimeFilter(P, idx, side, setup.setup, pathPreview, { ...vpOpts, ...opts })) {
      continue;
    }
    if (!passesVpRegimeImmunity(candles, idx, side, setup.setup, vp, P, pathPreview, { ...vpOpts, ...opts })) {
      continue;
    }

    const cell = describeVpConditionCell(P, idx, side, setup.setup, pathPreview, { ...vpOpts, ...opts });
    let noveltySizeMult = 1;
    if (opts.vpNoveltyMonitor) {
      const nov = decideVpNovelty(opts.vpNoveltyMonitor, cell.key);
      if (!nov.allow) continue;
      noveltySizeMult = Number(nov.sizeMult ?? 1);
    }

    const gates = applyVolumeProfileGates(candles, idx, side, vp, vpOpts);
    if (gateMode === "strict" && !gates.allow) continue;
    if (gateMode === "soft" && gates.hardBlock) continue;

    const minRR = Number(opts.vpMinRR ?? 1.5);
    if (gates.brackets?.rr > 0 && gates.brackets.rr < minRR) continue;

    let score = setup.score;
    if (gates.brackets?.rr >= 2) score += 2;
    if (gates.penalty > 0) score = Math.max(0, score - Math.min(5, gates.penalty));

    const minScore = Number(opts.vpMinScore ?? DEFAULT_MIN_SCORE);
    if (score < minScore) continue;

    const baseSize =
      setup.setup === "lvn_vacuum" && opts.vpLvnSizeMult ? Number(opts.vpLvnSizeMult) : 1;

    if (!best || score > best.score || (setup.tier === "A" && best.tier !== "A")) {
      best = {
        action: side,
        reason: `vp_${setup.setup}`,
        score,
        tier: setup.tier ?? VP_SETUP_TIERS[setup.setup] ?? "B",
        setup: setup.setup,
        vpSetup: setup.setup,
        brackets: gates.brackets,
        path: gates.path,
        warnings: gates.warnings,
        sizeMult: baseSize * noveltySizeMult,
        vpConditionCell: cell,
        vpConditionCellKey: cell.key,
      };
    }
  }

  if (!best) return null;

  const brackets = best.brackets ?? volumeProfileBrackets(candles[idx].close, best.action, vp, vpOpts);
  return {
    ...best,
    path: best.path ?? pathToNextHvn(candles[idx].close, best.action, vp),
    /** Level used for vacuum retest routing (prior-session VA when available). */
    vacuumLevel:
      best.action === "BUY"
        ? (vp.priorSession?.vah > 0 ? vp.priorSession.vah : vp.vah)
        : (vp.priorSession?.val > 0 ? vp.priorSession.val : vp.val),
    vpBrackets:
      opts.intradayVpBrackets === true && brackets?.slPct > 0
        ? { slPct: brackets.slPct, tpPct: brackets.tpPct, rr: brackets.rr }
        : null,
  };
}

/**
 * Vacuum vs structured breakout routing.
 * path ≥ vpVacuumPathPct → large room to next HVN ("vacuum"). Immediate breakout
 * entry is net-negative in both bull and bear years; retest mode waits for return
 * to VA level then reclaim — auction-correct behaviour for that scenario.
 *
 * @param {object[]} candles
 * @param {object[]} candidates  { idx, day, score, tier, sig }
 * @param {Record<string, unknown>} opts
 * @returns {object[]}
 */
export function applyVpVacuumRetestRouting(candles, candidates, opts = {}) {
  const mode = String(opts.vpVacuumEntryMode ?? "breakout").toLowerCase();
  if (mode !== "retest") return candidates;

  const thresh = Number(opts.vpVacuumPathPct ?? 0.02);
  const window = Math.max(1, Math.round(Number(opts.vpVacuumRetestBars ?? 8)));
  const tol = Number(opts.vpVacuumRetestTolPct ?? 0.0015);
  const byIdx = new Map(candidates.map((c) => [c.idx, c]));
  const out = [];
  let pending = null;

  const startIdx = candidates.length ? Math.min(...candidates.map((c) => c.idx)) : candles.length;
  const endIdx = candles.length;

  for (let i = Math.max(0, startIdx - window); i < endIdx; i++) {
    if (pending && i > pending.expireIdx) pending = null;

    if (pending && i > pending.armIdx) {
      const bar = candles[i];
      const lvl = pending.level;
      const side = pending.sig.action;
      let filled = false;
      if (side === "BUY") {
        filled = bar.low <= lvl * (1 + tol) && bar.close > lvl;
      } else {
        filled = bar.high >= lvl * (1 - tol) && bar.close < lvl;
      }
      if (filled) {
        const sig = {
          ...pending.sig,
          reason: pending.sig.reason,
          vacuumEntry: "retest",
          // Rebuild brackets from retest price so SL/TP sit on current structure.
          vpBrackets: pending.sig.vpBrackets
            ? {
                ...pending.sig.vpBrackets,
                // Cap TP: vacuum moves rarely travel full HVN distance after retest.
                tpPct: Math.min(
                  Number(pending.sig.vpBrackets.tpPct ?? 0.03),
                  Number(opts.vpVacuumRetestMaxTpPct ?? 0.015),
                ),
              }
            : pending.sig.vpBrackets,
        };
        out.push({
          idx: i,
          day: utcDayId(bar.ts),
          score: sig.score,
          tier: sig.tier,
          sig,
        });
        pending = null;
        // Do not also take a fresh breakout on the fill bar.
        continue;
      }
    }

    const c = byIdx.get(i);
    if (!c) continue;

    const setup = c.sig.setup || c.sig.vpSetup;
    const isBreak = setup === "vah_breakout" || setup === "val_breakdown";
    const pathPct = Number(c.sig.path?.distPct ?? 0);
    if (isBreak && pathPct >= thresh && c.sig.vacuumLevel > 0) {
      // Arm retest; suppress immediate vacuum breakout entry.
      pending = {
        armIdx: i,
        expireIdx: i + window,
        level: c.sig.vacuumLevel,
        sig: c.sig,
      };
      continue;
    }
    out.push(c);
  }
  return out;
}

export function selectVolumeProfilePicks(candles, opts = {}) {
  const pre = precomputeVolumeProfile(candles);
  const maxPerDay = Number(opts.vpMaxTradesPerDay ?? opts.maxTradesPerDay ?? DEFAULT_MAX_PER_DAY);
  const minScore = Number(opts.vpMinScore ?? DEFAULT_MIN_SCORE);
  const minGap = Number(opts.vpMinBarGap ?? opts.minBarGap ?? DEFAULT_MIN_BAR_GAP);
  const profileMode = String(opts.vpProfileMode ?? opts.mode ?? "rolling").toLowerCase();
  const lookback = Number(opts.vpLookbackBars ?? 384);
  const startIdx =
    profileMode === "rolling"
      ? Math.max(WARMUP, lookback)
      : Math.max(WARMUP, Math.floor(Number(opts.vpCompositeDays ?? 5)) * 96);
  const tierAOnly = opts.vpTierAOnly === true;

  let candidates = [];
  for (let i = startIdx; i < candles.length; i++) {
    const sig = evaluateVolumeProfileBar(candles, i, opts, pre);
    if (!sig || sig.score < minScore) continue;
    if (tierAOnly && sig.tier !== "A") continue;
    candidates.push({ idx: i, day: utcDayId(candles[i].ts), score: sig.score, tier: sig.tier, sig });
  }

  candidates = applyVpVacuumRetestRouting(candles, candidates, opts);

  const byDay = new Map();
  for (const c of candidates) {
    const list = byDay.get(c.day) || [];
    list.push(c);
    byDay.set(c.day, list);
  }

  const picked = new Set();
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.tier === "A" && b.tier !== "A") return -1;
      if (b.tier === "A" && a.tier !== "A") return 1;
      return b.score - a.score;
    });
    const chosen = [];
    for (const c of list) {
      if (chosen.length >= maxPerDay) break;
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < minGap)) continue;
      chosen.push(c);
      picked.add(c.idx);
    }
  }

  const series = new Array(candles.length).fill(null);
  for (const c of candidates) {
    if (picked.has(c.idx)) series[c.idx] = c.sig;
  }

  return {
    series,
    pickedCount: picked.size,
    candidateCount: candidates.length,
  };
}

export function buildVolumeProfileOptsFromCfg(cfg = {}) {
  return {
    vpProfileMode: cfg.vpProfileMode ?? cfg.mode,
    vpCompositeDays: cfg.vpCompositeDays,
    vpValueAreaPct: cfg.vpValueAreaPct,
    vpVolumeDistribute: cfg.vpVolumeDistribute,
    vpIncludePriorSession: cfg.vpIncludePriorSession,
    vpEnableNakedPoc: cfg.vpEnableNakedPoc,
    vpLookbackBars: cfg.vpLookbackBars,
    vpBins: cfg.vpBins,
    vpMinRR: cfg.vpMinRR,
    vpMinRunPct: cfg.vpMinRunPct,
    minLvnRunPct: cfg.minLvnRunPct ?? cfg.vpMinRunPct,
    vpMinScore: cfg.vpMinScore,
    vpMaxTradesPerDay: cfg.vpMaxTradesPerDay,
    vpMinBarGap: cfg.vpMinBarGap,
    vpSessionStartHour: cfg.vpSessionStartHour,
    vpSessionEndHour: cfg.vpSessionEndHour,
    vpRequireHtfAlign: cfg.vpRequireHtfAlign,
    vpMinAdx: cfg.vpMinAdx,
    vpMinBarVolRatio: cfg.vpMinBarVolRatio,
    vpMinAtrPct: cfg.vpMinAtrPct,
    vpMaxAtrPct: cfg.vpMaxAtrPct,
    vpMinHtfSepPct: cfg.vpMinHtfSepPct,
    vpMinCloseBeyondPct: cfg.vpMinCloseBeyondPct,
    vpMinBreakoutBody: cfg.vpMinBreakoutBody,
    vpMinBreakoutCloseStrength: cfg.vpMinBreakoutCloseStrength,
    nearTolPct: cfg.vpNearTolPct ?? cfg.nearTolPct,
    vpNearTolPct: cfg.vpNearTolPct ?? cfg.nearTolPct,
    vpRejectionMinVolRatio: cfg.vpRejectionMinVolRatio,
    vpRejectionSpikePct: cfg.vpRejectionSpikePct,
    vpRejectionMinWickRatio: cfg.vpRejectionMinWickRatio,
    vpRejectionMinCloseDepth: cfg.vpRejectionMinCloseDepth,
    vpRejectionDepthExtendedOnly: cfg.vpRejectionDepthExtendedOnly,
    vpRejectionExtendedPriorPct: cfg.vpRejectionExtendedPriorPct,
    vpRejectionPriorLookback: cfg.vpRejectionPriorLookback,
    vpBuyBreakoutMaxPathPct: cfg.vpBuyBreakoutMaxPathPct,
    vpBuyBreakoutMaxPathNonBullOnly: cfg.vpBuyBreakoutMaxPathNonBullOnly,
    vpSellBreakdownMaxPathPct: cfg.vpSellBreakdownMaxPathPct,
    vpBuyVacuumBullPriorPct: cfg.vpBuyVacuumBullPriorPct,
    vpBuyVacuumPriorLookback: cfg.vpBuyVacuumPriorLookback,
    vpBuyVacuumMaxPrior5dPct: cfg.vpBuyVacuumMaxPrior5dPct,
    vpBuyVacuumPrior5dLookback: cfg.vpBuyVacuumPrior5dLookback,
    vpOutsideVaLookback: cfg.vpOutsideVaLookback,
    vpRegimeImmunity: cfg.vpRegimeImmunity,
    vpMaxPriorTrendPct: cfg.vpMaxPriorTrendPct,
    vpPriorTrendLookback: cfg.vpPriorTrendLookback,
    vpBuyBreakoutMinHtfSep: cfg.vpBuyBreakoutMinHtfSep,
    vpBuyRelaxedMinHtfSep: cfg.vpBuyRelaxedMinHtfSep,
    vpBuyHighPathMinPct: cfg.vpBuyHighPathMinPct,
    vpSellBreakdownMinHtfSep: cfg.vpSellBreakdownMinHtfSep,
    vpSellMacroAdapt: cfg.vpSellMacroAdapt,
    vpSellMinHtfSepPct: cfg.vpSellMinHtfSepPct,
    vpSellMacroBullMinHtfSepPct: cfg.vpSellMacroBullMinHtfSepPct,
    vpSellMacroPrior20dBullPct: cfg.vpSellMacroPrior20dBullPct,
    vpSellNonBearMinHtfSepPct: cfg.vpSellNonBearMinHtfSepPct,
    vpSellBearPrior60dPct: cfg.vpSellBearPrior60dPct,
    vpSellWeakBearMinHtfSepPct: cfg.vpSellWeakBearMinHtfSepPct,
    vpSellWeakBearPrior20dFloorPct: cfg.vpSellWeakBearPrior20dFloorPct,
    vpRejectionSellBlockExtendedDown: cfg.vpRejectionSellBlockExtendedDown,
    vpBuyChaseFilter: cfg.vpBuyChaseFilter,
    vpBuyChaseMaxPrior5dPct: cfg.vpBuyChaseMaxPrior5dPct,
    vpBuyChaseNonBullOnly: cfg.vpBuyChaseNonBullOnly,
    vpBuyChaseBullPrior60dPct: cfg.vpBuyChaseBullPrior60dPct,
    vpValSellBearOnly: cfg.vpValSellBearOnly,
    vpValSellRequirePrior60dBear: cfg.vpValSellRequirePrior60dBear,
    vpValSellPrior60dBearPct: cfg.vpValSellPrior60dBearPct,
    vpValSellBlockBull60: cfg.vpValSellBlockBull60,
    vpValSellBull60Pct: cfg.vpValSellBull60Pct,
    vpValSellBlockBull60Dump: cfg.vpValSellBlockBull60Dump,
    vpValSellBull60DumpPrior20dPct: cfg.vpValSellBull60DumpPrior20dPct,
    vpValSellBlockBull60NonVac: cfg.vpValSellBlockBull60NonVac,
    vpValSellBlockBull60Extending: cfg.vpValSellBlockBull60Extending,
    vpValSellBull60ExtendRatio: cfg.vpValSellBull60ExtendRatio,
    vpValSellRequireBearTrend: cfg.vpValSellRequireBearTrend,
    vpValSellBlockWeakBearVacuum: cfg.vpValSellBlockWeakBearVacuum,
    vpValSellBlockWeakBearVacuumHighPrior60: cfg.vpValSellBlockWeakBearVacuumHighPrior60,
    vpValSellWeakBearVacPrior60Pct: cfg.vpValSellWeakBearVacPrior60Pct,
    vpValSellBlockFlatPrior60: cfg.vpValSellBlockFlatPrior60,
    vpValSellFlatPrior60LoPct: cfg.vpValSellFlatPrior60LoPct,
    vpValSellFlatPrior60HiPct: cfg.vpValSellFlatPrior60HiPct,
    vpValSellChaseFilter: cfg.vpValSellChaseFilter,
    vpValSellChaseMaxPrior5dPct: cfg.vpValSellChaseMaxPrior5dPct,
    vpBuyRejectionBlockBullTrend: cfg.vpBuyRejectionBlockBullTrend,
    vpBuyRejectionBlockBullStructured: cfg.vpBuyRejectionBlockBullStructured,
    vpBuyRejectionBlockUnpreparedMacro: cfg.vpBuyRejectionBlockUnpreparedMacro,
    vpBuyRejectionMinCloseStrength: cfg.vpBuyRejectionMinCloseStrength,
    vpBuyRejectionMinBody: cfg.vpBuyRejectionMinBody,
    vpBuyRejectionBlockPrior120: cfg.vpBuyRejectionBlockPrior120,
    vpBuyRejectionPrior120Pct: cfg.vpBuyRejectionPrior120Pct,
    vpBuyBreakoutBlockBullTight: cfg.vpBuyBreakoutBlockBullTight,
    vpBuyBreakoutBlockBullVacuum: cfg.vpBuyBreakoutBlockBullVacuum,
    vpNoveltyEnabled: cfg.vpNoveltyEnabled,
    vpPreparedRegimeOnly: cfg.vpPreparedRegimeOnly,
    vpPreparedAllowlistOnly: cfg.vpPreparedAllowlistOnly,
    vpPreparedCellKeys: cfg.vpPreparedCellKeys,
    vpPreparedBlockCellKeys: cfg.vpPreparedBlockCellKeys,
    vpPreparedBlockVacuumVah: cfg.vpPreparedBlockVacuumVah,
    vpPreparedBlockVacuumValBear: cfg.vpPreparedBlockVacuumValBear,
    vpPreparedVacuumPathPct: cfg.vpPreparedVacuumPathPct,
    vpPreparedBearPrior60dPct: cfg.vpPreparedBearPrior60dPct,
    vpNoveltyMonitor: cfg.vpNoveltyMonitor,
    vpVacuumEntryMode: cfg.vpVacuumEntryMode,
    vpVacuumPathPct: cfg.vpVacuumPathPct,
    vpVacuumRetestBars: cfg.vpVacuumRetestBars,
    vpVacuumRetestTolPct: cfg.vpVacuumRetestTolPct,
    vpVacuumRetestMaxTpPct: cfg.vpVacuumRetestMaxTpPct,
    vpHardBlockCeilingFloor: cfg.vpHardBlockCeilingFloor,
    vpTierAOnly: cfg.vpTierAOnly,
    vpAllowedSetups: cfg.vpAllowedSetups,
    vpAllowHvnFlip: cfg.vpAllowHvnFlip,
    requireVpSetup: cfg.requireVpSetup,
    volumeProfileSoftGates: cfg.volumeProfileSoftGates,
    volumeProfileGatesEnabled: cfg.volumeProfileGatesEnabled,
    volumeProfileGateMode: cfg.volumeProfileGateMode,
    intradayVpBrackets: cfg.intradayVpBrackets ?? cfg.vpStructureBrackets,
    vpLvnSizeMult: cfg.vpLvnSizeMult ?? cfg.intradayLvnSizeMult,
    nearTolPct: cfg.vpNearTolPct,
    vpCeilingTolPct: cfg.vpCeilingTolPct,
    vpSoftBlockPenalty: cfg.vpSoftBlockPenalty,
    vpBreakoutMinVolRatio: cfg.vpBreakoutMinVolRatio,
    vpValBreakdownMinVolRatio: cfg.vpValBreakdownMinVolRatio,
    vpBreakoutMinPathPct: cfg.vpBreakoutMinPathPct,
    vpLvnMinVolRatio: cfg.vpLvnMinVolRatio,
    vpMinWickRatio: cfg.vpMinWickRatio,
    vpMaxSlPct: cfg.vpMaxSlPct,
    vpMaxTpPct: cfg.vpMaxTpPct,
  };
}

function minutesPerBar(tf) {
  return { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 }[String(tf || "15m").toLowerCase()] ?? 15;
}

export function buildVolumeProfileBacktestAdapter(candles, opts = {}, tf = "15m") {
  const o = { ...buildVolumeProfileOptsFromCfg(opts), timeframe: tf };
  const { series } = selectVolumeProfilePicks(candles, o);
  const mpb = minutesPerBar(tf);
  const cooldownBars = Math.max(o.vpMinBarGap ?? DEFAULT_MIN_BAR_GAP, Math.ceil(60 / mpb));
  const maxPerDay = o.vpMaxTradesPerDay ?? DEFAULT_MAX_PER_DAY;

  let lastSignalIdx = -1;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -1, tradesToday: 0, curDay: null };

  return function volumeProfileAdapter(bar, idx, ctx) {
    const dDay = dayStore(ctx, dayLocal);
    const day = utcDayId(bar.ts);
    if (day !== (ctx?.persisted ? dDay.curDay : curDay)) {
      if (ctx?.persisted) {
        dDay.curDay = day;
        dDay.tradesToday = 0;
      } else {
        curDay = day;
        tradesToday = 0;
      }
    }
    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;
    if (tradesCount >= maxPerDay) return null;

    const sig = series[idx];
    if (!sig) return null;
    const lastIdx = ctx?.persisted ? dDay.lastSignalIdx : lastSignalIdx;
    if (lastIdx >= 0 && idx - lastIdx < cooldownBars) return null;

    if (ctx?.persisted) {
      dDay.lastSignalIdx = idx;
      dDay.tradesToday = tradesCount + 1;
    } else {
      lastSignalIdx = idx;
      tradesToday += 1;
    }
    const out = { action: sig.action, reason: sig.reason };
    if (sig.vpBrackets) out.vpBrackets = sig.vpBrackets;
    if (sig.sizeMult != null && sig.sizeMult !== 1) out.sizeMult = sig.sizeMult;
    if (sig.vpSetup) out.vpSetup = sig.vpSetup;
    if (sig.vpConditionCellKey) out.vpConditionCellKey = sig.vpConditionCellKey;
    if (sig.vpConditionCell) out.vpConditionCell = sig.vpConditionCell;
    return out;
  };
}

export function signal({ candles, timeframe } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const pre = precomputeVolumeProfile(candles);
  const sig = evaluateVolumeProfileBar(candles, candles.length - 1, { timeframe }, pre);
  return sig || { action: "HOLD", reason: "no_vp_setup" };
}

export const VOLUME_PROFILE = {
  name: "Volume Profile — POC / VAH / VAL / HVN / LVN structure setups",
  signal,
  evaluateVolumeProfileBar,
  selectVolumeProfilePicks,
  buildVolumeProfileBacktestAdapter,
  buildVolumeProfileOptsFromCfg,
  passesVpPreparedRegimeFilter,
  passesVpValSellMacroFilter,
  passesVpBuyRejectionMacroFilter,
  passesVpBuyBreakoutTightBullFilter,
  passesVpBuyBreakoutBullVacuumFilter,
  passesVpBuyChaseFilter,
  resolveVpSellMinHtfSep,
};

export {
  describeVpConditionCell,
} from "./vpConditionCell.js";

