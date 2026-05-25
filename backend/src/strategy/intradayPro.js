/**
 * INTRADAY_PRO / SR_INTRADAY — multi-technique confluence intraday.
 *
 * Techniques: liquidity sweep, session S/R, Fibonacci, volume profile POC/VA,
 * order-flow delta/CVD, HTF trend, regime filter (skip chop).
 *
 * Targets: ~1+ trade/day, high confluence, adaptive SL/TP per symbol volatility.
 */

import { ema, rsi as computeRsi, atr as computeAtr, adx as computeAdx } from "./indicators.js";
import { computeAdaptiveIntradayParams } from "./adaptiveIntraday.js";
import { buildVolumeProfile, scoreVolumeProfile, volumeProfileBias } from "./techniques/volumeProfile.js";
import { swingHighLow, fibLevels, nearFibLevel } from "./techniques/fibonacci.js";
import { buildCvdSeries, cvdMomentum, deltaImbalance } from "./techniques/orderFlow.js";
import {
  liquiditySweep,
  sweepReclaim,
  rejectionWickRatio,
} from "./techniques/liquidity.js";
import { buildIntradayEntryContext } from "./intradayEntryContext.js";
import { applyIntradayVetoes } from "./intradayLearnedRules.js";

const WARMUP = 100;
const DEFAULT_MAX_PER_DAY = 8;
const DEFAULT_MIN_SCORE = 9;
const DEFAULT_MIN_BAR_GAP = 6;

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
  const asianHigh = new Array(n).fill(null);
  const asianLow = new Array(n).fill(null);

  let curDay = null;
  let curHigh = -Infinity;
  let curLow = Infinity;
  let asianH = -Infinity;
  let asianL = Infinity;
  let pDayHigh = null;
  let pDayLow = null;

  for (let i = 0; i < n; i++) {
    prevDayHigh[i] = pDayHigh;
    prevDayLow[i] = pDayLow;
    asianHigh[i] = asianH > -Infinity ? asianH : null;
    asianLow[i] = asianL < Infinity ? asianL : null;

    const c = candles[i];
    const d = utcDayId(c.ts);
    const h = utcHour(c.ts);
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
  return { prevDayHigh, prevDayLow, asianHigh, asianLow };
}

export function precomputeIntraday(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);
  const adxSeries = computeAdx(candles, 14);
  const ema9 = ema(closes, 9);
  const cvd = buildCvdSeries(candles);
  const session = buildSessionLevels(candles);

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
  return {
    rsiSeries,
    atrSeries,
    adxSeries,
    ema9,
    cvd,
    volumes,
    htfUp,
    htfDown,
    htfSep,
    ...session,
    adaptive,
  };
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

  const P = pre || precomputeIntraday(candles);
  if (!isTradeableRegime(candles, idx, P)) return null;

  const bar = candles[idx];
  const prev = candles[idx - 1];
  const i = idx;
  const sweepPct = Number(opts.sweepPct ?? P.adaptive.sweepPct);
  const minWick = Number(opts.minWickRatio ?? 0.32);

  const techniques = [];
  let side = null;

  if (P.htfUp[i]) side = "BUY";
  else if (P.htfDown[i]) side = "SELL";
  else return null;

  const rsiNow = P.rsiSeries[i];
  const recentRsi = P.rsiSeries.slice(Math.max(0, i - 6), i + 1);
  const e9 = P.ema9[i];
  const wick = rejectionWickRatio(bar, side);

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

  let score = 0;
  techniques.push("htf");

  if (P.htfSep[i] >= 0.0007) {
    score += 2;
    techniques.push("htf_strong");
  } else score += 1;

  const sweep = liquiditySweep(candles, i, side, 15);
  if (sweep) {
    score += 3;
    techniques.push("liq_sweep");
  }

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
  } else if (asian) {
    score += 3;
    techniques.push("asian");
  }

  const swing = swingHighLow(candles, i, 48);
  const fibDir = side === "BUY" ? "up" : "down";
  const fibs = fibLevels(swing, fibDir);
  const fibHit = nearFibLevel(bar.close, fibs, sweepPct * 2.5);
  if (fibHit) {
    score += 3;
    techniques.push(`fib_${fibHit.ratio}`);
  }

  const vpEnabled = opts.volumeProfileEnabled !== false;
  let vpScore = { score: 0, blocked: false, setup: null, brackets: null, penalty: 0 };
  if (vpEnabled) {
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

  const cvdM = cvdMomentum(P.cvd, i, 6);
  const delta = deltaImbalance(candles, i, 5);
  if (side === "BUY" && cvdM.bullish && delta.buyPct >= 0.55) {
    score += 2;
    techniques.push("cvd_long");
  } else if (side === "SELL" && cvdM.bearish && delta.sellPct >= 0.55) {
    score += 2;
    techniques.push("cvd_short");
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

  const minTechniques = Number(opts.minTechniqueCount ?? 3);
  if (techniques.length < minTechniques) return null;

  const hasSession = pdl || pdh || asian;
  const needSession =
    opts.intradayRequireSessionReclaim !== false || opts.requireSessionReclaim !== false;
  if (needSession && !hasSession) return null;

  const hasFib = techniques.some((t) => t.startsWith("fib_"));
  const hasVp = techniques.some((t) => t.startsWith("vp"));
  const hasLiq = techniques.includes("liq_sweep");
  if (opts.requireFibOrVp !== false && !(hasFib || hasVp)) return null;
  if (opts.requireLiqOrSession === true && !hasSession && !hasLiq) return null;

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
    sizeMult: vpScore.setup === "lvn_vacuum" && opts.intradayLvnSizeMult ? Number(opts.intradayLvnSizeMult) : 1,
  };

  const ctx = buildIntradayEntryContext(candles, i, P, draft, opts);
  const veto = applyIntradayVetoes(ctx, { ...opts.regimeCfg, ...opts });
  if (!veto.allow) return null;

  return {
    ...draft,
    tier: veto.bigMove ? "A" : "B",
    vetoPassed: true,
  };
}

export function selectIntradayPicks(candles, opts = {}) {
  const pre = precomputeIntraday(candles);
  const maxPerDay = Number(opts.maxTradesPerDay ?? DEFAULT_MAX_PER_DAY);
  const minScore = Number(opts.minScore ?? pre.adaptive.minScore ?? DEFAULT_MIN_SCORE);
  const minGap = Number(opts.minBarGap ?? DEFAULT_MIN_BAR_GAP);

  const candidates = [];
  for (let i = WARMUP; i < candles.length; i++) {
    const sig = evaluateIntradayBar(candles, i, { ...opts, sweepPct: opts.sweepPct ?? pre.adaptive.sweepPct }, pre);
    if (!sig || sig.score < minScore) continue;
    candidates.push({ idx: i, day: utcDayId(candles[i].ts), score: sig.score, sig });
  }

  const byDay = new Map();
  for (const c of candidates) {
    const list = byDay.get(c.day) || [];
    list.push(c);
    byDay.set(c.day, list);
  }

  const picked = new Set();
  const tierMode = opts.intradayTierMode ?? "all";
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.sig.tier === "A" && b.sig.tier !== "A") return -1;
      if (b.sig.tier === "A" && a.sig.tier !== "A") return 1;
      return b.score - a.score;
    });
    const pool = tierMode === "A" ? list.filter((c) => c.sig.tier === "A") : list;
    const chosen = [];
    for (const c of pool) {
      if (chosen.length >= maxPerDay) break;
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < minGap)) continue;
      chosen.push(c);
      picked.add(c.idx);
    }
  }

  const series = new Array(candles.length).fill(null);
  for (const idx of picked) {
    const c = candidates.find((x) => x.idx === idx);
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
  return {
    maxTradesPerDay: Number(cfg.srIntradayMaxTradesPerDay ?? cfg.intradayMaxTradesPerDay ?? DEFAULT_MAX_PER_DAY),
    minScore: Number(cfg.srIntradayMinScore ?? cfg.intradayMinScore ?? DEFAULT_MIN_SCORE),
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
  };
}

function minutesPerBar(tf) {
  return { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 }[String(tf || "5m").toLowerCase()] ?? 5;
}

export function buildIntradayBacktestAdapter(candles, opts = {}, tf = "5m") {
  const o = { ...buildIntradayOptsFromCfg({ ...opts, timeframe: tf }), timeframe: tf };
  const { series } = selectIntradayPicks(candles, o);
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

export function signal({ candles, timeframe } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const pre = precomputeIntraday(candles);
  const sig = evaluateIntradayBar(candles, candles.length - 1, { timeframe }, pre);
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
