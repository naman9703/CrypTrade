/**
 * INTRADAY_PRO / SR_INTRADAY — multi-technique confluence intraday.
 *
 * Techniques: liquidity sweep, session S/R, Fibonacci, volume profile POC/VA,
 * order-flow delta/CVD, HTF trend, regime filter (skip chop).
 *
 * Targets: ~1+ trade/day, high confluence, adaptive SL/TP per symbol volatility.
 */

import { rankSmcCandidate } from "./smcCandidateRank.js";
import { ema, rsi as computeRsi, atr as computeAtr, adx as computeAdx } from "./indicators.js";
import { computeAdaptiveIntradayParams } from "./adaptiveIntraday.js";
import { buildVolumeProfile, scoreVolumeProfile, volumeProfileBias } from "./techniques/volumeProfile.js";
import {
  swingHighLow,
  fibLevels,
  nearFibLevel,
  evaluateFibRetraceSetup,
} from "./techniques/fibonacci.js";
import { buildCvdSeries } from "./techniques/orderFlow.js";
import { applyOrderFlowGate, evaluateOrderFlowSoloSetup } from "./techniques/orderFlowPatterns.js";
import { buildSessionVwapSeries } from "./techniques/sessionVwap.js";
import {
  evaluateSessionLiquiditySweep,
  listSessionLiquiditySetups,
  rejectionWickRatio,
  sweepReclaim,
} from "./techniques/liquidity.js";
import {
  evaluateTrendContinuationSetup,
  vetoCounterTrendLiqSetup,
  vetoClassicalLiqOnTrendDay,
  isBreakdownDay,
  isBreakoutDay,
} from "./techniques/liquidityTrendContinuation.js";
import { buildIntradayEntryContext } from "./intradayEntryContext.js";
import { applyIntradayVetoes } from "./intradayLearnedRules.js";
import { fillLiqSoloPresetDefaults, fillSmcSoloPresetDefaults, materializeIntradayEngineCfgSync } from "./presets/srIntradayOptimized.js";
import { materializeIntradayPanelOnCfg } from "./intradayPanelKeys.js";
import {
  getCachedIntradaySeries,
  intradayAdapterCacheKey,
  setCachedIntradaySeries,
} from "../backtest/engine/intradayAdapterCache.js";
import {
  resolveIntradayGates,
  resolveIntradayEntryRequirements,
  resolveIntradayMinScore,
  countGatedTechniques,
} from "./intradayGates.js";
import {
  evaluateInstitutionalSrSetup,
  isInstitutionalSrMode,
} from "./evaluateInstitutionalSr.js";
import {
  evaluateSmcIctSetup,
  isSmcIctMode,
} from "./evaluateSmcIctSetup.js";
import { attachSmcHtfToPre } from "./techniques/htfBias.js";

const WARMUP = 100;
const DEFAULT_MAX_PER_DAY = 8;
const DEFAULT_MIN_BAR_GAP = 6;

function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

function utcWeekId(ts) {
  return Math.floor(ts / (7 * 86_400_000));
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
      cur = { ts: hourTs, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
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

function buildSessionLevels(candles) {
  const n = candles.length;
  const prevDayHigh = new Array(n).fill(null);
  const prevDayLow = new Array(n).fill(null);
  const prevWeekHigh = new Array(n).fill(null);
  const prevWeekLow = new Array(n).fill(null);
  const asianHigh = new Array(n).fill(null);
  const asianLow = new Array(n).fill(null);

  let curDay = null;
  let curHigh = -Infinity;
  let curLow = Infinity;
  let asianH = -Infinity;
  let asianL = Infinity;
  let pDayHigh = null;
  let pDayLow = null;

  let curWeek = null;
  let curWeekHigh = -Infinity;
  let curWeekLow = Infinity;
  let pWeekHigh = null;
  let pWeekLow = null;

  for (let i = 0; i < n; i++) {
    prevDayHigh[i] = pDayHigh;
    prevDayLow[i] = pDayLow;
    prevWeekHigh[i] = pWeekHigh;
    prevWeekLow[i] = pWeekLow;
    asianHigh[i] = asianH > -Infinity ? asianH : null;
    asianLow[i] = asianL < Infinity ? asianL : null;

    const c = candles[i];
    const d = utcDayId(c.ts);
    const w = utcWeekId(c.ts);
    const h = utcHour(c.ts);

    if (curWeek === null) curWeek = w;
    if (w !== curWeek) {
      pWeekHigh = curWeekHigh > -Infinity ? curWeekHigh : null;
      pWeekLow = curWeekLow < Infinity ? curWeekLow : null;
      curWeek = w;
      curWeekHigh = c.high;
      curWeekLow = c.low;
    } else {
      curWeekHigh = Math.max(curWeekHigh, c.high);
      curWeekLow = Math.min(curWeekLow, c.low);
    }

    if (curDay === null) curDay = d;
    if (d !== curDay) {
      pDayHigh = curHigh;
      pDayLow = curLow;
      curDay = d;
      curHigh = c.high;
      curLow = c.low;
      asianH = -Infinity;
      asianL = Infinity;
      if (h < 8) {
        asianH = c.high;
        asianL = c.low;
      }
      continue;
    }
    curHigh = Math.max(curHigh, c.high);
    curLow = Math.min(curLow, c.low);
    if (h < 8) {
      asianH = asianH === -Infinity ? c.high : Math.max(asianH, c.high);
      asianL = asianL === Infinity ? c.low : Math.min(asianL, c.low);
    }
  }
  return { prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow, asianHigh, asianLow };
}

const _precomputeCache = new WeakMap();

export function precomputeIntraday(candles) {
  if (candles && typeof candles === "object") {
    const cached = _precomputeCache.get(candles);
    if (cached && cached._len === candles.length) return cached;
  }
  const result = _precomputeIntradayImpl(candles);
  if (candles && typeof candles === "object") {
    try {
      result._len = candles.length;
      _precomputeCache.set(candles, result);
    } catch {
      /* non-extensible array; skip caching */
    }
  }
  return result;
}

function _precomputeIntradayImpl(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);
  const adxSeries = computeAdx(candles, 14);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const cvd = buildCvdSeries(candles);
  const session = buildSessionLevels(candles);
  const sessionVwap = buildSessionVwapSeries(candles);

  const hourly = aggregateToHourly(candles);
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const htfUp = new Array(n).fill(false);
  const htfDown = new Array(n).fill(false);
  const htfSep = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const hIdx = hourIndexForBar(candles[i].ts, hourly);
    if (hIdx >= 50) {
      const e21 = hEma21[hIdx];
      const e50 = hEma50[hIdx];
      if (Number.isFinite(e21) && Number.isFinite(e50) && e50 !== 0) {
        const sep = Math.abs(e21 - e50) / Math.abs(e50);
        htfSep[i] = sep;
        if (sep >= 0.0004) {
          htfUp[i] = e21 > e50;
          htfDown[i] = e21 < e50;
        }
      }
    }
  }

  const adaptive = computeAdaptiveIntradayParams(candles);
  const base = {
    rsiSeries,
    atrSeries,
    adxSeries,
    ema9,
    ema21,
    cvd,
    sessionVwap,
    volumes,
    htfUp,
    htfDown,
    htfSep,
    ...session,
    adaptive,
  };
  attachSmcHtfToPre(candles, base);
  return base;
}

/** Chop / bad-market filter */
export function isTradeableRegime(candles, idx, pre) {
  const adxVal = pre.adxSeries[idx];
  const atrVal = pre.atrSeries[idx];
  const bar = candles[idx];
  if (!Number.isFinite(adxVal) || adxVal < 22) return false;
  if (!Number.isFinite(atrVal) || atrVal <= 0 || bar.close <= 0) return false;

  const atrPct = atrVal / bar.close;
  if (atrPct < 0.0015 || atrPct > 0.04) return false;

  const look = 14;
  const start = Math.max(0, idx - look + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = start; j <= idx; j++) {
    hi = Math.max(hi, candles[j].high);
    lo = Math.min(lo, candles[j].low);
  }
  const range = hi - lo;
  if (range / atrVal < 0.85) return false;

  const volSlice = pre.volumes.slice(Math.max(0, idx - 20), idx);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (volAvg > 0 && pre.volumes[idx] / volAvg < 0.75) return false;

  return true;
}

/**
 * @returns {{ action: string, reason: string, score: number, techniques: string[] } | null}
 */
export function evaluateIntradayBar(candles, idx, opts = {}, pre = null) {
  if (idx < WARMUP) return null;

  const hour = utcHour(candles[idx].ts);
  const start = Number(opts.sessionStartHour ?? 7);
  const end = Number(opts.sessionEndHour ?? 22);
  if (hour < start || hour >= end) return null;

  const gates = resolveIntradayGates(opts);
  const req = resolveIntradayEntryRequirements(opts, gates);
  const fibStrict = opts.intradayFibStrictMode !== false;
  const fibSolo =
    gates.fib &&
    !gates.liquidity &&
    !gates.session &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  const liqStackSolo =
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  const instSoloStack =
    isInstitutionalSrMode(opts) &&
    gates.institutionalSr &&
    gates.liquidity &&
    gates.session &&
    gates.htfRegime &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.smcIct;
  const smcSoloStack = isSmcIctMode(opts) && gates.smcIct;
  const ofSoloStack =
    gates.orderFlow &&
    !gates.liquidity &&
    !gates.session &&
    !gates.fib &&
    !gates.vp &&
    !gates.htfRegime &&
    !gates.institutionalSr &&
    !gates.smcIct;

  const P = pre || precomputeIntraday(candles);
  if (gates.htfRegime && !instSoloStack && !smcSoloStack && !isTradeableRegime(candles, idx, P)) {
    return null;
  }

  const liqStrict = opts.intradayLiqStrictMode !== false;

  if (smcSoloStack) {
    let bestSmc = null;
    for (const side of ["BUY", "SELL"]) {
      const s = evaluateSmcIctSetup(candles, idx, side, P, opts);
      if (!s) continue;
      if (!bestSmc || (s.liqQuality ?? 0) > (bestSmc.liqQuality ?? 0)) bestSmc = s;
    }
    if (bestSmc) {
      const minScore = Number(opts.intradaySmcMinScore ?? opts.intradayLiqMinScore ?? 7);
      if (bestSmc.score >= minScore) return smcSoloSignalFromSetup(bestSmc, minScore);
    }
    return null;
  }

  if ((liqStackSolo || instSoloStack) && liqStrict) {
    const instMode = isInstitutionalSrMode(opts);
    let bestLiq = null;
    for (const side of ["BUY", "SELL"]) {
      const liqSig = instMode
        ? evaluateInstitutionalSrSetup(candles, idx, side, P, opts)
        : evaluateSessionLiquiditySweep(candles, idx, side, P, opts);
      if (!liqSig) continue;
      if (!bestLiq || liqSig.liqQuality > bestLiq.liqQuality) bestLiq = liqSig;
    }
    if (bestLiq) {
      const minScore = Number(opts.intradayLiqMinScore ?? opts.intradaySoloGateMinScore ?? 5);
      if (bestLiq.score >= minScore) return liqSoloSignalFromSetup(bestLiq, minScore);
    }
    return null;
  }

  if (fibSolo) {
    const fibSig = evaluateFibRetraceSetup(candles, idx, opts, P);
    if (!fibSig) return null;
    const minFibScore = Number(opts.intradayFibMinScore ?? 10);
    if (fibSig.score < minFibScore) return null;
    return fibSoloSignalFromSetup(fibSig, minFibScore);
  }

  if (ofSoloStack) {
    const liveCtx = { orderBookSnapshot: opts.orderBookSnapshot ?? opts._orderBookSnapshot };
    const ofSig = evaluateOrderFlowSoloSetup(candles, idx, P, opts, liveCtx);
    if (ofSig) return ofSig;
    return null;
  }

  /** Fib anchor: strict fib setup can fire without RSI/session/liq on the same bar (multi-gate intraday). */
  if (gates.fib && fibStrict && opts.intradayFibAnchorEntry !== false && !fibSolo) {
    const fibSig = evaluateFibRetraceSetup(candles, idx, opts, P);
    const minFibScore = Number(opts.intradayFibMinScore ?? 8);
    if (fibSig && fibSig.score >= minFibScore) {
      return fibSoloSignalFromSetup(fibSig, minFibScore);
    }
  }

  const bar = candles[idx];
  const prev = candles[idx - 1];
  const i = idx;
  const sweepPct = Number(opts.sweepPct ?? P.adaptive.sweepPct);
  const minWick = Number(opts.minWickRatio ?? 0.32);

  const techniques = [];
  let side = null;

  const rsiNow = P.rsiSeries[i];
  const recentRsi = P.rsiSeries.slice(Math.max(0, i - 6), i + 1);
  const e9 = P.ema9[i];

  if (gates.htfRegime) {
    if (P.htfUp[i]) side = "BUY";
    else if (P.htfDown[i]) side = "SELL";
    else return null;
  } else {
    const wasOs = recentRsi.some((r) => r <= 42);
    const wasOb = recentRsi.some((r) => r >= 58);
    if (wasOs && rsiNow >= 32 && rsiNow <= 52 && bar.close >= e9 * 0.997) side = "BUY";
    else if (wasOb && rsiNow <= 68 && rsiNow >= 48 && bar.close <= e9 * 1.003) side = "SELL";
    else return null;
  }

  const wick = rejectionWickRatio(bar, side);
  const relaxBase = req.soloGateTest && req.enabledGateCount === 1;

  if (!relaxBase) {
    if (side === "BUY") {
      if (bar.close < e9 * 0.997) return null;
      const wasOs = recentRsi.some((r) => r <= 42);
      if (!wasOs || rsiNow < 30) return null;
      if (bar.close <= bar.open && wick < minWick) return null;
    } else {
      if (bar.close > e9 * 1.003) return null;
      const wasOb = recentRsi.some((r) => r >= 58);
      if (!wasOb || rsiNow > 70) return null;
      if (bar.close >= bar.open && wick < minWick) return null;
    }
  } else if (side === "BUY" && bar.close < e9 * 0.995) return null;
  else if (side === "SELL" && bar.close > e9 * 1.005) return null;

  let score = 0;

  if (gates.htfRegime) {
    techniques.push("htf");
    if (P.htfSep[i] >= 0.0007) {
      score += 2;
      techniques.push("htf_strong");
    } else score += 1;
  }

  let hasLiq = false;
  let hasSession = false;
  /** @type {object | null} */
  let liqBrackets = null;

  if (liqStrict && (gates.liquidity || gates.session)) {
    const liqSetup = evaluateSessionLiquiditySweep(candles, i, side, P, opts);
    if (liqSetup) {
      if (gates.liquidity) {
        score += 4;
        hasLiq = true;
        for (const t of liqSetup.techniques) {
          if (!techniques.includes(t)) techniques.push(t);
        }
      }
      if (gates.session && (liqSetup.levelType === "pdl" || liqSetup.levelType === "pdh")) {
        score += 4;
        hasSession = true;
      }
      liqBrackets = liqBracketsFromSetup(liqSetup);
    }
  } else {
    if (gates.liquidity) {
      const sweep =
        sweepReclaim(bar, side === "BUY" ? P.prevDayLow[i] : P.prevDayHigh[i], side, sweepPct) ||
        (prev &&
          sweepReclaim(
            prev,
            side === "BUY" ? P.prevDayLow[i] : P.prevDayHigh[i],
            side,
            sweepPct,
          ));
      if (sweep) {
        score += 3;
        techniques.push("liq_sweep");
        hasLiq = true;
      }
    }

    if (gates.session) {
      const pdl =
        side === "BUY" &&
        (sweepReclaim(bar, P.prevDayLow[i], "BUY", sweepPct) ||
          (prev && sweepReclaim(prev, P.prevDayLow[i], "BUY", sweepPct)));
      const pdh =
        side === "SELL" &&
        (sweepReclaim(bar, P.prevDayHigh[i], "SELL", sweepPct) ||
          (prev && sweepReclaim(prev, P.prevDayHigh[i], "SELL", sweepPct)));
      const asian =
        side === "BUY"
          ? sweepReclaim(bar, P.asianLow[i], "BUY", sweepPct)
          : sweepReclaim(bar, P.asianHigh[i], "SELL", sweepPct);

      if (pdl || pdh) {
        score += 4;
        techniques.push(pdl ? "pdl" : "pdh");
        hasSession = true;
      } else if (asian) {
        score += 3;
        techniques.push("asian");
        hasSession = true;
      }
    }
  }

  if (gates.fib) {
    if (fibStrict) {
      const fibSig = evaluateFibRetraceSetup(
        candles,
        idx,
        {
          ...opts,
          intradayFibRequireHtfAlign: gates.htfRegime ? opts.intradayFibRequireHtfAlign !== false : true,
        },
        P,
      );
      if (!fibSig || fibSig.side !== side) return null;
      score += fibSig.score >= 10 ? 5 : 4;
      techniques.push(...fibSig.techniques);
    } else {
      const swing = swingHighLow(candles, i, 48);
      const fibDir = side === "BUY" ? "up" : "down";
      const fibs = fibLevels(swing, fibDir);
      const fibHit = nearFibLevel(bar.close, fibs, sweepPct * 2.5);
      if (fibHit) {
        score += 3;
        techniques.push(`fib_${fibHit.ratio}`);
      }
    }
  }

  let vpScore = { score: 0, blocked: false, setup: null, brackets: null, penalty: 0 };
  if (gates.vp) {
    const vpLookback = Number(opts.vpLookbackBars ?? 192);
    const vp = buildVolumeProfile(candles, i, { lookback: vpLookback, bins: opts.vpBins ?? 50 });
    vpScore = scoreVolumeProfile(candles, i, side, vp, opts);
    if (vpScore.blocked) return null;

    if (vpScore.setup) {
      score += Math.min(12, vpScore.score);
      techniques.push(`vp_${vpScore.setup}`);
    } else if (vp) {
      const vpBias = volumeProfileBias(bar, vp, side);
      if (vpBias.ok) {
        score += Math.min(6, vpScore.score || 3);
        techniques.push(vpBias.tag);
      }
    }
    if (vpScore.penalty > 0 && vpScore.warnings?.length) {
      techniques.push(`vp_warn_${vpScore.warnings[0]}`);
    }
  }

  let ofResult = null;
  if (gates.orderFlow) {
    const liveCtx = { orderBookSnapshot: opts.orderBookSnapshot ?? opts._orderBookSnapshot };
    const ofGateCfg = {
      ...opts,
      intradayOfConfluenceMode: opts.intradayOfConfluenceMode ?? "layer3",
      intradayOfAllowCvdOnly: opts.intradayOfAllowCvdOnly === true,
    };
    ofResult = applyOrderFlowGate(candles, i, side, P, ofGateCfg, liveCtx);
    if (!ofResult.ok) return null;
    score += Math.min(8, ofResult.score);
    for (const t of ofResult.techniques) {
      if (!techniques.includes(t)) techniques.push(t);
    }
    if (ofResult.ofBrackets) {
      liqBrackets = {
        slPct: ofResult.ofBrackets.slPct,
        tpPct: ofResult.ofBrackets.tp2Pct,
        rr: ofResult.ofBrackets.rr,
        partialTp: ofResult.ofBrackets.partialTp,
      };
    } else if (ofResult.ofMeta?.stopBeyond && !liqBrackets) {
      const slPct = Math.abs(bar.close - ofResult.ofMeta.stopBeyond) / bar.close;
      if (slPct > 0) liqBrackets = { slPct, tpPct: null, rr: null };
    }
  }

  if (wick >= 0.38) {
    score += 2;
    techniques.push("wick");
  } else if (wick >= 0.28) score += 1;

  const volSlice = P.volumes.slice(Math.max(0, i - 20), idx);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (volAvg > 0 && P.volumes[i] / volAvg >= 1.15) {
    score += 1;
    techniques.push("vol");
  }

  const gatedCount = countGatedTechniques(techniques, gates);
  if (gatedCount < req.minTechniqueCount) return null;

  if (req.soloGateTest && req.enabledGateCount === 1) {
    if (gates.liquidity && !hasLiq) return null;
    if (
      gates.orderFlow &&
      !techniques.some((t) => t.startsWith("of_") || t === "cvd_long" || t === "cvd_short")
    ) {
      return null;
    }
    if (gates.htfRegime && !techniques.includes("htf")) return null;
  }

  if (req.requireSessionReclaim && !hasSession) return null;

  const hasFib = techniques.some((t) => t.startsWith("fib_"));
  const hasVp = techniques.some((t) => t.startsWith("vp"));
  if (req.requireFibOrVp && !(hasFib || hasVp)) return null;
  if (req.requireLiqOrSession && !hasSession && !hasLiq) return null;

  const draft = {
    action: side,
    reason: `ipro_${techniques.slice(0, 4).join("+")}`,
    score,
    techniques,
    vpSetup: vpScore.setup ?? null,
    vpRr: vpScore.brackets?.rr ?? null,
    vpBrackets:
      opts.intradayVpBrackets === true && vpScore.brackets?.slPct > 0
        ? { slPct: vpScore.brackets.slPct, tpPct: vpScore.brackets.tpPct, rr: vpScore.brackets.rr }
        : null,
    liqBrackets,
    sizeMult: vpScore.setup === "lvn_vacuum" && opts.intradayLvnSizeMult ? Number(opts.intradayLvnSizeMult) : 1,
    ofMeta: ofResult?.ofMeta,
    ofBrackets: ofResult?.ofBrackets,
    entryIdx: ofResult?.ofMeta?.entryIdx ?? i,
  };

  if (gates.htfRegime && opts.intradayLearnedRulesEnabled !== false) {
    const ctx = buildIntradayEntryContext(candles, i, P, draft, opts);
    const veto = applyIntradayVetoes(ctx, { ...opts.regimeCfg, ...opts });
    if (!veto.allow) return null;
    return {
      ...draft,
      tier: veto.bigMove ? "A" : "B",
      vetoPassed: true,
    };
  }

  return {
    ...draft,
    tier: score >= Number(opts.intradayBigMoveMinScore ?? 11) ? "A" : "B",
    vetoPassed: true,
  };
}

function fibSoloSignalFromSetup(fibSig, minFibScore = 8) {
  return {
    action: fibSig.side,
    reason: `ipro_${fibSig.techniques.join("+")}`,
    score: fibSig.score,
    techniques: fibSig.techniques,
    tier: fibSig.score >= minFibScore ? "A" : "B",
    vetoPassed: true,
    fibBrackets: {
      slPct: fibSig.slPct,
      tpPct: fibSig.tpPct,
      slPrice: fibSig.slPrice,
      tpPrice: fibSig.tpPrice,
      tpMode: fibSig.tpMode,
      ratio: fibSig.ratio,
      rr: fibSig.rr,
    },
  };
}

/** Flatten liquidity bracket legs from setup (SMC nests them under liqBrackets). */
function setupBracketsPayload(sig) {
  const nested = sig.liqBrackets && typeof sig.liqBrackets === "object" ? sig.liqBrackets : {};
  return {
    ...sig,
    ...nested,
    opposingLevel: nested.opposingLevel ?? sig.opposing ?? sig.opposingLevel,
    sweepWick: nested.sweepWick ?? sig.sweepWick ?? sig.wick,
    level: nested.level ?? sig.level,
    levelType: nested.levelType ?? sig.levelType,
    reclaimIdx: nested.reclaimIdx ?? sig.reclaimIdx ?? sig.sweepReclaimIdx,
    liqQuality: nested.liqQuality ?? sig.liqQuality ?? 0,
  };
}

function liqBracketsFromSetup(liqSig) {
  const s = setupBracketsPayload(liqSig);
  return {
    slPct: s.slPct,
    tpPct: s.tpPct,
    tp1Pct: s.tp1Pct,
    slPrice: s.slPrice,
    tpPrice: s.tp2Price ?? s.tpPrice,
    tp1Price: s.tp1Price,
    tp2Price: s.tp2Price ?? s.tpPrice,
    tpMode: s.tpMode,
    rr: s.rr,
    sweepWick: s.sweepWick,
    opposingLevel: s.opposingLevel,
    level: s.level,
    levelType: s.levelType,
    partialTp: s.partialTp !== false,
    tp2Enabled: s.tp2Enabled !== false,
    partialFrac: s.partialFrac ?? 0.5,
    liqQuality: s.liqQuality ?? 0,
    reclaimIdx: s.reclaimIdx,
  };
}

function liqSoloSignalFromSetup(liqSig, minScore = 5) {
  return {
    action: liqSig.action,
    reason: `ipro_${liqSig.techniques.join("+")}`,
    score: liqSig.score,
    techniques: liqSig.techniques,
    tier: liqSig.score >= minScore ? "A" : "B",
    vetoPassed: true,
    liqBrackets: liqBracketsFromSetup(liqSig),
  };
}

function smcSoloSignalFromSetup(smcSig, minScore = 7) {
  return {
    action: smcSig.action,
    reason: `smc_${smcSig.techniques.join("+")}`,
    score: smcSig.score,
    techniques: smcSig.techniques,
    tier: smcSig.score >= minScore ? "A" : "B",
    vetoPassed: true,
    liqBrackets: liqBracketsFromSetup(smcSig),
    smcMeta: smcSig.smcMeta,
  };
}

export function selectIntradayPicks(candles, opts = {}) {
  const pre = precomputeIntraday(candles);
  const o = { ...buildIntradayOptsFromCfg(opts), ...opts };
  const maxPerDay = Number(o.maxTradesPerDay ?? DEFAULT_MAX_PER_DAY);
  const minScore = Number(o.minScore ?? pre.adaptive.minScore ?? resolveIntradayMinScore(o));
  const minGap = Number(o.minBarGap ?? DEFAULT_MIN_BAR_GAP);
  const gates = resolveIntradayGates(o);
  const liqStackSolo =
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  const instSoloStack =
    isInstitutionalSrMode(o) &&
    gates.institutionalSr &&
    gates.liquidity &&
    gates.session &&
    gates.htfRegime &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.smcIct;
  const smcSoloStack = isSmcIctMode(o) && gates.smcIct;
  const ofSoloStack =
    gates.orderFlow &&
    !gates.liquidity &&
    !gates.session &&
    !gates.fib &&
    !gates.vp &&
    !gates.htfRegime &&
    !gates.institutionalSr &&
    !gates.smcIct;
  const liqSoloFastPath =
    !smcSoloStack && !ofSoloStack && o.intradayLiqStrictMode !== false && (liqStackSolo || instSoloStack);
  const smcSoloFastPath = smcSoloStack;
  const ofSoloFastPath = ofSoloStack;

  /** Liquidity / SMC / OF solo: full-day scan only (skip O(bars) evaluateIntradayBar loop). */
  let candidates = [];
  if (!liqSoloFastPath && !smcSoloFastPath && !ofSoloFastPath) {
    for (let i = WARMUP; i < candles.length; i++) {
      const sig = evaluateIntradayBar(candles, i, { ...o, sweepPct: o.sweepPct ?? pre.adaptive.sweepPct }, pre);
      if (!sig || sig.score < minScore) continue;
      const entryIdx = sig.entryIdx ?? sig.ofMeta?.entryIdx ?? i;
      if (entryIdx >= candles.length) continue;
      candidates.push({ idx: entryIdx, day: utcDayId(candles[entryIdx].ts), score: sig.score, sig });
    }
  }

  let pool = candidates;
  if (smcSoloFastPath) {
    const smcMinScore = Number(o.intradaySmcMinScore ?? o.intradayLiqMinScore ?? 7);
    const smcOpts = { ...o, _liqPre: pre };
    pool = [];
    for (let i = WARMUP; i < candles.length; i++) {
      for (const side of ["BUY", "SELL"]) {
        const setup = evaluateSmcIctSetup(candles, i, side, pre, smcOpts);
        const entryBar = setup?.entryIdx ?? setup?.reclaimIdx;
        if (!setup || entryBar !== i || setup.score < smcMinScore) continue;
        pool.push({
          idx: i,
          day: utcDayId(candles[i].ts),
          score: setup.score,
          sig: smcSoloSignalFromSetup(setup, smcMinScore),
        });
      }
    }
  } else if (liqSoloFastPath) {
    const liqMinScore = Number(o.intradayLiqMinScore ?? o.intradaySoloGateMinScore ?? 5);
    const liqSweep = o.sweepPct ?? pre.adaptive.sweepPct;
    const liqOpts = { ...o, sweepPct: liqSweep, _liqPre: pre };
    const instMode = isInstitutionalSrMode(o);
    pool = [];
    for (let i = WARMUP; i < candles.length; i++) {
      for (const side of ["BUY", "SELL"]) {
        const setups = instMode
          ? [evaluateInstitutionalSrSetup(candles, i, side, pre, liqOpts)].filter(Boolean)
          : listSessionLiquiditySetups(candles, i, side, pre, liqOpts);
        for (const setup of setups) {
          if (setup.reclaimIdx !== i || setup.score < liqMinScore) continue;
          if (liqOpts.intradayLiqClassicEnabled === false) continue;
          if (vetoCounterTrendLiqSetup(setup, candles, i, pre, liqOpts)) continue;
          if (vetoClassicalLiqOnTrendDay(setup, candles, i, pre, liqOpts)) continue;
          pool.push({
            idx: i,
            day: utcDayId(candles[i].ts),
            score: setup.score,
            sig: liqSoloSignalFromSetup(setup, liqMinScore),
          });
        }
        if (liqOpts.intradayLiqTrendContinuation === true) {
          const trend = evaluateTrendContinuationSetup(candles, i, side, pre, liqOpts);
          if (trend && trend.reclaimIdx === i && trend.score >= liqMinScore) {
            pool.push({
              idx: i,
              day: utcDayId(candles[i].ts),
              score: trend.score,
              sig: liqSoloSignalFromSetup(trend, liqMinScore),
            });
          }
        }
      }
    }
  } else if (ofSoloFastPath) {
    const ofMinScore = Number(o.intradayOfSoloMinScore ?? o.srIntradayMinScore ?? resolveIntradayMinScore(o));
    const ofOpts = {
      ...o,
      intradayOfConfluenceMode: o.intradayOfConfluenceMode ?? "full",
      intradayOfAllowCvdOnly: false,
    };
    const liveCtx = { orderBookSnapshot: o.orderBookSnapshot ?? o._orderBookSnapshot };
    pool = [];
    for (let i = WARMUP; i < candles.length; i++) {
      const sig = evaluateOrderFlowSoloSetup(candles, i, pre, ofOpts, liveCtx);
      if (!sig || sig.score < ofMinScore) continue;
      const entryIdx = sig.entryIdx ?? sig.ofMeta?.entryIdx ?? i;
      if (entryIdx >= candles.length) continue;
      pool.push({
        idx: entryIdx,
        day: utcDayId(candles[entryIdx].ts),
        score: sig.score,
        sig,
      });
    }
  }

  const byDay = new Map();
  for (const c of pool) {
    const list = byDay.get(c.day) || [];
    list.push(c);
    byDay.set(c.day, list);
  }

  const picked = new Set();
  const tierMode = opts.intradayTierMode ?? "all";
  const maxPerSide = Number(o.intradayLiqMaxTradesPerSidePerDay ?? 1);
  const smcPickMode = String(o.intradaySmcPickMode ?? "").toLowerCase();
  const smcDailySniper =
    smcSoloFastPath &&
    (smcPickMode === "daily_sniper" ||
      smcPickMode === "daily_best" ||
      o.intradaySmcOneTradePerDay === true);

  function smcCandidateRank(c) {
    return rankSmcCandidate(c, candles);
  }

  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.sig.tier === "A" && b.sig.tier !== "A") return -1;
      if (b.sig.tier === "A" && a.sig.tier !== "A") return 1;
      return b.score - a.score;
    });
    const dayPool = tierMode === "A" ? list.filter((c) => c.sig.tier === "A") : list;
    const chosen = [];
    const sideCount = { BUY: 0, SELL: 0 };
    if (smcDailySniper && dayPool.length > 0) {
      const best = [...dayPool].sort((a, b) => smcCandidateRank(b) - smcCandidateRank(a))[0];
      if (best) {
        chosen.push(best);
        picked.add(best.idx);
      }
      continue;
    }
    if ((liqSoloFastPath || smcSoloFastPath) && o.intradayLiqOnePickPerDay === true && dayPool.length > 0) {
      let sides = ["BUY", "SELL"];
      if (liqSoloFastPath && o.intradayLiqBreakdownDayBias !== false && dayPool.length > 0) {
        const ref = dayPool[0];
        if (isBreakdownDay(candles, ref.idx, pre)) sides = ["SELL"];
        else if (isBreakoutDay(candles, ref.idx, pre)) sides = ["BUY"];
      }
      for (const side of sides) {
        const sidePool = dayPool
          .filter((c) => c.sig?.action === side)
          .sort(
            (a, b) =>
              Number(b.sig?.liqBrackets?.liqQuality ?? b.score ?? 0) -
              Number(a.sig?.liqBrackets?.liqQuality ?? a.score ?? 0),
          );
        if (!sidePool.length) continue;
        const sideCap =
          liqSoloFastPath && sides.length === 1 ? Math.max(1, maxPerSide) : 1;
        let taken = 0;
        for (const best of sidePool) {
          if (taken >= sideCap) break;
          if (chosen.some((x) => Math.abs(x.idx - best.idx) < minGap)) continue;
          chosen.push(best);
          picked.add(best.idx);
          taken++;
        }
      }
      continue;
    }
    for (const c of dayPool) {
      if (chosen.length >= maxPerDay) break;
      const side = c.sig?.action;
      if (side === "BUY" || side === "SELL") {
        if (sideCount[side] >= maxPerSide) continue;
      }
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < minGap)) continue;
      chosen.push(c);
      picked.add(c.idx);
      if (side === "BUY" || side === "SELL") sideCount[side] += 1;
    }
  }

  const series = new Array(candles.length).fill(null);
  for (const idx of picked) {
    const c = pool.find((x) => x.idx === idx);
    if (c) series[idx] = c.sig;
  }
  return {
    series,
    pickedCount: picked.size,
    candidateCount: candidates.length,
    adaptive: pre.adaptive,
  };
}

export function buildIntradayOptsFromCfg(cfg = {}) {
  const gates = resolveIntradayGates(cfg);
  const req = resolveIntradayEntryRequirements(cfg, gates);
  return {
    maxTradesPerDay: Number(cfg.srIntradayMaxTradesPerDay ?? cfg.intradayMaxTradesPerDay ?? DEFAULT_MAX_PER_DAY),
    minScore: resolveIntradayMinScore(cfg, gates, req),
    minBarGap: Number(cfg.srIntradayMinBarGap ?? cfg.intradayMinBarGap ?? DEFAULT_MIN_BAR_GAP),
    sweepPct: cfg.srIntradaySweepPct ?? cfg.intradaySweepPct,
    sessionStartHour: Number(cfg.srIntradaySessionStartHour ?? 7),
    sessionEndHour: Number(cfg.srIntradaySessionEndHour ?? 22),
    minTechniqueCount: Number(cfg.intradayMinTechniqueCount ?? 3),
    requireSessionReclaim: cfg.intradayRequireSessionReclaim !== false,
    requireLiqOrSession: cfg.intradayRequireLiqOrSession === true,
    requireFibOrVp: cfg.intradayRequireFibOrVp !== false,
    intradaySurgicalFilter: cfg.intradaySurgicalFilter === true,
    intradayLearnedRulesEnabled: cfg.intradayLearnedRulesEnabled !== false,
    intradayBigMoveMinScore: cfg.intradayBigMoveMinScore,
    intradayTierMode: cfg.intradayTierMode,
    customVetoRules: cfg.intradayCustomVetoRules,
    regimeCfg: cfg,
    timeframe: cfg.timeframe,
    volumeProfileEnabled: cfg.volumeProfileEnabled,
    volumeProfileGatesEnabled: cfg.volumeProfileGatesEnabled,
    volumeProfileSoftGates: cfg.volumeProfileSoftGates,
    volumeProfileGateMode: cfg.volumeProfileGateMode,
    intradayVpBrackets: cfg.intradayVpBrackets,
    intradayLvnSizeMult: cfg.intradayLvnSizeMult,
    vpLookbackBars: cfg.vpLookbackBars,
    vpBins: cfg.vpBins,
    vpMinRR: cfg.vpMinRR,
    vpMinRunPct: cfg.vpMinRunPct,
    vpSoftBlockPenalty: cfg.vpSoftBlockPenalty,
    requireVpSetup: cfg.requireVpSetup,
    vpCeilingTolPct: cfg.vpCeilingTolPct,
    intradayGateLiquidity: cfg.intradayGateLiquidity,
    intradayGateSession: cfg.intradayGateSession,
    intradayGateFib: cfg.intradayGateFib,
    intradayGateVp: cfg.intradayGateVp,
    intradayGateOrderFlow: cfg.intradayGateOrderFlow,
    intradayGateHtfRegime: cfg.intradayGateHtfRegime,
    intradaySoloGateTest: cfg.intradaySoloGateTest,
    intradayFibStrictMode: cfg.intradayFibStrictMode,
    intradayFibLookback: cfg.intradayFibLookback,
    intradayFibPivotLeft: cfg.intradayFibPivotLeft,
    intradayFibPivotRight: cfg.intradayFibPivotRight,
    intradayFibMinLegAtrMult: cfg.intradayFibMinLegAtrMult,
    intradayFibAllowedRatios: cfg.intradayFibAllowedRatios,
    intradayFibTolPct: cfg.intradayFibTolPct,
    intradayFibMinRetraceRatio: cfg.intradayFibMinRetraceRatio,
    intradayFibMaxRetraceRatio: cfg.intradayFibMaxRetraceRatio,
    intradayFibMaxBarsSinceSwing: cfg.intradayFibMaxBarsSinceSwing,
    intradayFibMinWickRatio: cfg.intradayFibMinWickRatio,
    intradayFibMinAdx: cfg.intradayFibMinAdx,
    intradayFibRequireHtfAlign: cfg.intradayFibRequireHtfAlign,
    intradayFibMinRr: cfg.intradayFibMinRr,
    intradayFibMaxSlPct: cfg.intradayFibMaxSlPct,
    intradayFibMaxTpPct: cfg.intradayFibMaxTpPct,
    intradayFibMinScore: cfg.intradayFibMinScore,
    intradayFibTpMode: cfg.intradayFibTpMode,
    intradayFibBracketSource: cfg.intradayFibBracketSource,
    intradayFibScalpTpPct: cfg.intradayFibScalpTpPct,
    intradayFibScalpSlPct: cfg.intradayFibScalpSlPct,
    intradayFibPartialLegFrac: cfg.intradayFibPartialLegFrac,
    intradayFibExtensionFrac: cfg.intradayFibExtensionFrac,
    intradayFibHtfAlignMode: cfg.intradayFibHtfAlignMode,
    intradayFibProfile: cfg.intradayFibProfile,
    intradayFibAnchorEntry: cfg.intradayFibAnchorEntry,
    intradayFibSessionStartHour: cfg.intradayFibSessionStartHour,
    intradayFibSessionEndHour: cfg.intradayFibSessionEndHour,
    intradayFibRequireRsiAlign: cfg.intradayFibRequireRsiAlign,
    intradayFibMinHtfSep: cfg.intradayFibMinHtfSep,
    intradayFibSessionStartHour: cfg.intradayFibSessionStartHour,
    intradayFibSessionEndHour: cfg.intradayFibSessionEndHour,
    intradayFibLearnedRulesEnabled: cfg.intradayFibLearnedRulesEnabled,
    intradayFibCustomVetoRules: cfg.intradayFibCustomVetoRules,
    intradayFibConfirmNextBar: cfg.intradayFibConfirmNextBar,
    intradayFibRequireRetraceCoherence: cfg.intradayFibRequireRetraceCoherence,
    intradayFibGoldenRetraceMin: cfg.intradayFibGoldenRetraceMin,
    intradayFibGoldenRetraceMax: cfg.intradayFibGoldenRetraceMax,
    intradayFibMidRetraceMin: cfg.intradayFibMidRetraceMin,
    intradayFibMidRetraceMax: cfg.intradayFibMidRetraceMax,
    intradayFibGoldenScalpTpPct: cfg.intradayFibGoldenScalpTpPct,
    intradayFibGoldenScalpSlPct: cfg.intradayFibGoldenScalpSlPct,
    intradayFibMidScalpTpPct: cfg.intradayFibMidScalpTpPct,
    intradayFibMidScalpSlPct: cfg.intradayFibMidScalpSlPct,
    intradayLiqStrictMode: cfg.intradayLiqStrictMode,
    intradayLiqMinScore: cfg.intradayLiqMinScore,
    intradayLiqMinQuality: cfg.intradayLiqMinQuality,
    intradayLiqMinWickRatio: cfg.intradayLiqMinWickRatio,
    intradayLiqRejectSameBarReclaim: cfg.intradayLiqRejectSameBarReclaim,
    intradayLiqMinRr: cfg.intradayLiqMinRr,
    intradayLiqMaxSlPct: cfg.intradayLiqMaxSlPct,
    intradayLiqMaxSweepBars: cfg.intradayLiqMaxSweepBars,
    intradayLiqSlBufferPct: cfg.intradayLiqSlBufferPct,
    intradayLiqMinSweepExtensionPct: cfg.intradayLiqMinSweepExtensionPct,
    intradayLiqSessionExtreme: cfg.intradayLiqSessionExtreme,
    intradayLiqSessionExtremeMinTouches: cfg.intradayLiqSessionExtremeMinTouches,
    intradayLiqPartialTp: cfg.intradayLiqPartialTp,
    intradayLiqTp1Enabled: cfg.intradayLiqTp1Enabled,
    intradayLiqTp2Enabled: cfg.intradayLiqTp2Enabled,
    intradayLiqPartialFrac: cfg.intradayLiqPartialFrac,
    intradayLiqMaxTradesPerSidePerDay: cfg.intradayLiqMaxTradesPerSidePerDay,
    intradayLiqOnePickPerDay: cfg.intradayLiqOnePickPerDay,
    intradayLiqEntryAtSignalClose: cfg.intradayLiqEntryAtSignalClose,
    intradayLiqBreakevenAfterPartial: cfg.intradayLiqBreakevenAfterPartial,
    intradayLiqRequireHtfAlign: cfg.intradayLiqRequireHtfAlign,
    intradayLiqMinHtfSep: cfg.intradayLiqMinHtfSep,
    intradayLiqFirstCycleOnly: cfg.intradayLiqFirstCycleOnly,
    intradayLiqMinReclaimClosePct: cfg.intradayLiqMinReclaimClosePct,
    intradayLiqMinReclaimBodyRatio: cfg.intradayLiqMinReclaimBodyRatio,
    intradayLiqSessionExtremeMinExtensionPct: cfg.intradayLiqSessionExtremeMinExtensionPct,
    intradayLiqSessionExtremeSweepPct: cfg.intradayLiqSessionExtremeSweepPct,
    intradayLiqSweepMinVolRatio: cfg.intradayLiqSweepMinVolRatio,
    intradayLiqSweepVolLookback: cfg.intradayLiqSweepVolLookback,
    intradayLiqMaxSweepMinutes: cfg.intradayLiqMaxSweepMinutes,
    intradayLiqSameBarPinbarWickBody: cfg.intradayLiqSameBarPinbarWickBody,
    intradayGateInstitutionalSr: cfg.intradayGateInstitutionalSr,
    intradaySrAPlusMode: cfg.intradaySrAPlusMode,
    intradaySrMinVolRatio: cfg.intradaySrMinVolRatio,
    intradaySrMinHtfSep: cfg.intradaySrMinHtfSep,
    intradaySrZoneWidthPct: cfg.intradaySrZoneWidthPct,
    intradaySrZoneWidthAtrMult: cfg.intradaySrZoneWidthAtrMult,
    intradaySrBosMaxBarsAfterReclaim: cfg.intradaySrBosMaxBarsAfterReclaim,
    intradaySrBosSwingLookback: cfg.intradaySrBosSwingLookback,
    intradaySrMinConfirmWick: cfg.intradaySrMinConfirmWick,
    intradaySrRequireBos: cfg.intradaySrRequireBos,
    intradaySrRequireConfirm: cfg.intradaySrRequireConfirm,
    intradaySrRequireVolume: cfg.intradaySrRequireVolume,
    intradaySrRequireHtfTrend: cfg.intradaySrRequireHtfTrend,
    intradaySrUseSwingClusters: cfg.intradaySrUseSwingClusters,
    intradayGateSmcIct: cfg.intradayGateSmcIct,
    intradaySmcIctMode: cfg.intradaySmcIctMode,
    intradaySmcMinScore: cfg.intradaySmcMinScore,
    intradaySmcSwingLeft: cfg.intradaySmcSwingLeft,
    intradaySmcSwingRight: cfg.intradaySmcSwingRight,
    intradaySmcSwingConfirmBars: cfg.intradaySmcSwingConfirmBars,
    intradaySmcRequireChoch: cfg.intradaySmcRequireChoch,
    intradaySmcRequireBos: cfg.intradaySmcRequireBos,
    intradaySmcRequireConfirm: cfg.intradaySmcRequireConfirm,
    intradaySmcBosMaxBars: cfg.intradaySmcBosMaxBars,
    intradaySmcChochMaxBars: cfg.intradaySmcChochMaxBars,
    intradaySmcChochRequireTrend: cfg.intradaySmcChochRequireTrend,
    intradaySmcEntryZoneMode: cfg.intradaySmcEntryZoneMode,
    intradaySmcRequireFvgRetrace: cfg.intradaySmcRequireFvgRetrace,
    intradaySmcFvgMinGapPct: cfg.intradaySmcFvgMinGapPct,
    intradaySmcFvgMaxAgeBars: cfg.intradaySmcFvgMaxAgeBars,
    intradaySmcObLookback: cfg.intradaySmcObLookback,
    intradaySmcObMinDisplacementAtr: cfg.intradaySmcObMinDisplacementAtr,
    intradaySmcRequireObRetrace: cfg.intradaySmcRequireObRetrace,
    intradaySmcDisplacementBodyMult: cfg.intradaySmcDisplacementBodyMult,
    intradaySmcKillzoneMode: cfg.intradaySmcKillzoneMode,
    intradaySmcKillzoneEnabled: cfg.intradaySmcKillzoneEnabled,
    intradaySmcKillzoneStartUtc: cfg.intradaySmcKillzoneStartUtc,
    intradaySmcKillzoneEndUtc: cfg.intradaySmcKillzoneEndUtc,
    intradaySmcMinAdx: cfg.intradaySmcMinAdx,
    intradaySmcMinAtrPct: cfg.intradaySmcMinAtrPct,
    intradaySmcMaxAtrPct: cfg.intradaySmcMaxAtrPct,
    intradaySmcVolFilterEnabled: cfg.intradaySmcVolFilterEnabled,
    intradaySmcHtfStrictness: cfg.intradaySmcHtfStrictness,
    intradaySmcMinHtfSep: cfg.intradaySmcMinHtfSep,
    intradaySmcRequireHtfBias: cfg.intradaySmcRequireHtfBias,
    intradaySmcSlMode: cfg.intradaySmcSlMode,
    intradaySmcMinRr: cfg.intradaySmcMinRr,
    intradaySmcUseOrderFlow: cfg.intradaySmcUseOrderFlow,
    intradaySmcUseMarketIntel: cfg.intradaySmcUseMarketIntel,
    intradaySmcRequireMss: cfg.intradaySmcRequireMss,
    intradaySmcRequireRetrace: cfg.intradaySmcRequireRetrace,
    intradaySmcLookbackBars: cfg.intradaySmcLookbackBars,
    intradaySmcIctProfile: cfg.intradaySmcIctProfile,
    intradaySmcPickMode: cfg.intradaySmcPickMode,
    intradaySmcOneTradePerDay: cfg.intradaySmcOneTradePerDay,
    intradaySmcChochStrict: cfg.intradaySmcChochStrict,
    intradaySmcHtfBiasMode: cfg.intradaySmcHtfBiasMode,
    intradaySmcMaxTpRr: cfg.intradaySmcMaxTpRr,
    intradaySmcMaxHoldBars: cfg.intradaySmcMaxHoldBars,
    intradaySmcMaxBarsAfterReclaim: cfg.intradaySmcMaxBarsAfterReclaim,
    intradaySmcFvgEntryMode: cfg.intradaySmcFvgEntryMode,
    intradaySmcTp2Mode: cfg.intradaySmcTp2Mode,
    intradaySmcRegimeFilterEnabled: cfg.intradaySmcRegimeFilterEnabled,
    intradaySmcRegimeAtrPctMin: cfg.intradaySmcRegimeAtrPctMin,
    intradaySmcRegimeAtrPctMax: cfg.intradaySmcRegimeAtrPctMax,
    intradaySmcRegimeAtrLookbackBars: cfg.intradaySmcRegimeAtrLookbackBars,
    intradayLiqMaxTpRr: cfg.intradayLiqMaxTpRr,
    intradayLiqMaxHoldBars: cfg.intradayLiqMaxHoldBars,
    intradayLiqTrendContinuation: cfg.intradayLiqTrendContinuation,
    intradayLiqVetoCounterTrend: cfg.intradayLiqVetoCounterTrend,
    intradayLiqBreakdownDayBias: cfg.intradayLiqBreakdownDayBias,
    intradayLiqClassicOnTrendDays: cfg.intradayLiqClassicOnTrendDays,
    intradayLiqTrendOnlyBreakdownDays: cfg.intradayLiqTrendOnlyBreakdownDays,
    intradayLiqTrendFadeEma: cfg.intradayLiqTrendFadeEma,
    intradayLiqTrendFadeMinRvol: cfg.intradayLiqTrendFadeMinRvol,
    intradayLiqTrendRsiMinShort: cfg.intradayLiqTrendRsiMinShort,
    intradayLiqTrendRsiMaxShort: cfg.intradayLiqTrendRsiMaxShort,
    intradayLiqTrendDayHighBuffer: cfg.intradayLiqTrendDayHighBuffer,
    intradayLiqTrendRequireHtf: cfg.intradayLiqTrendRequireHtf,
    intradayLiqTrendMinAdx: cfg.intradayLiqTrendMinAdx,
    intradayLiqTrendMinRvol: cfg.intradayLiqTrendMinRvol,
    intradayLiqTrendMinBarsBeyondLevel: cfg.intradayLiqTrendMinBarsBeyondLevel,
    intradayLiqTrendMinBodyRatio: cfg.intradayLiqTrendMinBodyRatio,
    intradayLiqTrendMinDispAtr: cfg.intradayLiqTrendMinDispAtr,
    intradayLiqTrendSwingLookback: cfg.intradayLiqTrendSwingLookback,
    intradayOfKillzoneMode: cfg.intradayOfKillzoneMode,
    intradayOfRequireKeyLevel: cfg.intradayOfRequireKeyLevel,
    intradayOfRequireConfirmation: cfg.intradayOfRequireConfirmation,
    intradayOfMinStackBars: cfg.intradayOfMinStackBars,
    intradayOfMinConfluence: cfg.intradayOfMinConfluence,
    intradayOfUseOrderBook: cfg.intradayOfUseOrderBook,
    intradayOfAllowProxy: cfg.intradayOfAllowProxy,
    intradayOfLevelProximityPct: cfg.intradayOfLevelProximityPct,
    intradayOfDivergenceLookback: cfg.intradayOfDivergenceLookback,
    intradayOfAbsorptionVolMult: cfg.intradayOfAbsorptionVolMult,
    intradayOfAbsorptionRangeAtrMult: cfg.intradayOfAbsorptionRangeAtrMult,
    intradayOfStackDeltaRatio: cfg.intradayOfStackDeltaRatio,
    intradayOfBookImbalanceMin: cfg.intradayOfBookImbalanceMin,
    intradayOfSoloMinScore: cfg.intradayOfSoloMinScore,
    intradayOfVetoMode: cfg.intradayOfVetoMode,
    intradayOfMinPartialScore: cfg.intradayOfMinPartialScore,
    intradayOfConfluenceMode: cfg.intradayOfConfluenceMode,
    intradayOfAllowCvdOnly: cfg.intradayOfAllowCvdOnly,
    intradayOfRequirePremiumDiscount: cfg.intradayOfRequirePremiumDiscount,
    intradayOfTp1Enabled: cfg.intradayOfTp1Enabled,
    intradayOfTp2Enabled: cfg.intradayOfTp2Enabled,
    intradayOfPartialFrac: cfg.intradayOfPartialFrac,
    intradayOfMinRr: cfg.intradayOfMinRr,
    intradayOfBreakevenAfterPartial: cfg.intradayOfBreakevenAfterPartial,
    intradayOfApproachLookback: cfg.intradayOfApproachLookback,
    intradayOfEntryAtSignalClose: cfg.intradayOfEntryAtSignalClose,
    intradayOfExitOnDeltaAgainst: cfg.intradayOfExitOnDeltaAgainst,
    intradayOfExitGraceBars: cfg.intradayOfExitGraceBars,
    intradayOfExitMinDeltaRatio: cfg.intradayOfExitMinDeltaRatio,
    intradayOfMaxHoldBars: cfg.intradayOfMaxHoldBars,
    orderBookSnapshot: cfg.orderBookSnapshot ?? cfg._orderBookSnapshot,
  };
}

function minutesPerBar(tf) {
  return { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 }[String(tf || "5m").toLowerCase()] ?? 5;
}

export function buildIntradayBacktestAdapter(candles, opts = {}, tf = "5m") {
  const cfg = materializeIntradayEngineCfgSync(opts, materializeIntradayPanelOnCfg);
  const o = { ...cfg, ...buildIntradayOptsFromCfg({ ...cfg, timeframe: tf }), timeframe: tf };
  const cacheKey = intradayAdapterCacheKey(candles, o, tf);
  let series = getCachedIntradaySeries(cacheKey);
  if (!series) {
    ({ series } = selectIntradayPicks(candles, o));
    setCachedIntradaySeries(cacheKey, series);
  }
  const mpb = minutesPerBar(tf);
  const cooldownBars = Math.max(3, Math.ceil(45 / mpb));
  const maxPerDay = o.maxTradesPerDay ?? DEFAULT_MAX_PER_DAY;

  let lastSignalIdx = -1;
  let tradesToday = 0;
  let curDay = null;

  return function intradayAdapter(bar, idx) {
    const day = utcDayId(bar.ts);
    if (day !== curDay) {
      curDay = day;
      tradesToday = 0;
    }
    if (tradesToday >= maxPerDay) return null;

    const sig = series[idx];
    if (!sig) return null;
    if (lastSignalIdx >= 0 && idx - lastSignalIdx < cooldownBars) return null;

    lastSignalIdx = idx;
    tradesToday += 1;
    const out = { action: sig.action, reason: sig.reason };
    if (sig.vpBrackets) out.vpBrackets = sig.vpBrackets;
    if (sig.fibBrackets) out.fibBrackets = sig.fibBrackets;
    if (sig.liqBrackets) out.liqBrackets = sig.liqBrackets;
    if (sig.ofBrackets) out.ofBrackets = sig.ofBrackets;
    if (sig.ofMeta) out.ofMeta = sig.ofMeta;
    if (sig.smcMeta) out.smcMeta = sig.smcMeta;
    if (sig.techniques) out.techniques = sig.techniques;
    if (sig.sizeMult > 1) out.sizeMult = sig.sizeMult;
    if (sig.vpSetup) out.vpSetup = sig.vpSetup;
    return out;
  };
}

/** Apply adaptive SL/TP from candle history into cfg clone */
export function mergeAdaptiveCfg(cfg, candles) {
  const adaptive = computeAdaptiveIntradayParams(candles);
  const useAdaptiveBrackets = cfg.intradayAdaptiveBrackets === true;
  return {
    ...cfg,
    supertrendFuturesFixedSlPct: useAdaptiveBrackets
      ? (cfg.supertrendFuturesFixedSlPct ?? adaptive.slPct)
      : cfg.supertrendFuturesFixedSlPct,
    supertrendFuturesFixedTpPct: useAdaptiveBrackets
      ? (cfg.supertrendFuturesFixedTpPct ?? adaptive.tpPct)
      : cfg.supertrendFuturesFixedTpPct,
    srIntradaySweepPct: cfg.srIntradaySweepPct ?? adaptive.sweepPct,
    srIntradayMinScore: cfg.srIntradayMinScore ?? adaptive.minScore,
    _intradayAdaptive: adaptive,
  };
}

function isSmcSoloStack(opts) {
  const gates = resolveIntradayGates(opts);
  return isSmcIctMode(opts) && gates.smcIct;
}

export function signal({ candles, timeframe, cfg, state } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const raw = cfg && typeof cfg === "object" ? cfg : state && typeof state === "object" ? state : {};
  const opts = materializeIntradayEngineCfgSync(
    { ...raw, timeframe: timeframe ?? raw.timeframe ?? "5m" },
    materializeIntradayPanelOnCfg,
  );
  const tf = timeframe ?? raw.timeframe ?? "5m";

  if (isSmcSoloStack(opts)) {
    const cfgFilled = fillSmcSoloPresetDefaults(fillLiqSoloPresetDefaults(opts));
    const o = { ...cfgFilled, ...buildIntradayOptsFromCfg({ ...cfgFilled, timeframe: tf }), timeframe: tf };
    const idx = candles.length - 1;
    const cacheKey = intradayAdapterCacheKey(candles, o, tf);
    let series = getCachedIntradaySeries(cacheKey);
    if (!series) {
      ({ series } = selectIntradayPicks(candles, o));
      setCachedIntradaySeries(cacheKey, series);
    }
    return series[idx] || { action: "HOLD", reason: "no_setup" };
  }

  const pre = precomputeIntraday(candles);
  const sig = evaluateIntradayBar(candles, candles.length - 1, opts, pre);
  return sig || { action: "HOLD", reason: "no_setup" };
}

export const INTRADAY_PRO = {
  name: "Intraday Pro — sweep + fib + VP + order flow + session S/R",
  signal,
};

export const SR_INTRADAY = {
  name: "SR Intraday Pro — multi-technique confluence (alias INTRADAY_PRO)",
  signal,
};
