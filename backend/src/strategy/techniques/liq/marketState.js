/**
 * Market context for classical LIQ — regime, day situation, session narrative, activation.
 */
import { REGIMES, buildRegimeSeries, classifyRegimeAt } from "../../regimeEngine.js";
import { isBreakdownDay, isBreakoutDay } from "../liquidityTrendContinuation.js";
import { inSmcKillzone, utcHourFromTs } from "../sessionKillzones.js";

const EXTERNAL_LEVEL_TYPES = new Set([
  "pdh",
  "pdl",
  "prev_week_high",
  "prev_week_low",
  "asian_high",
  "asian_low",
]);

export function isExternalLiquidityLevel(levelType) {
  return EXTERNAL_LEVEL_TYPES.has(String(levelType ?? ""));
}

/**
 * @param {number} ts
 * @returns {"asia_accum"|"london_sweep"|"ny_continuation"|"off_hours"}
 */
export function resolveSessionNarrative(ts, opts = {}) {
  const h = utcHourFromTs(ts);
  if (h >= 0 && h < 7) return "asia_accum";
  if (h >= 7 && h < 12) return "london_sweep";
  if (h >= 12 && h < 20) return "ny_continuation";
  return "off_hours";
}

/**
 * @returns {{ regime: string, confidence: number, daySituation: string|null, sessionNarrative: string, killzoneOk: boolean }}
 */
export function buildLiqMarketContext(candles, idx, pre, opts = {}) {
  const bar = candles?.[idx];
  const regimeRow =
    opts._regimeSeries?.[idx] ??
    classifyRegimeAt(candles, idx, { _series: opts._regimeSeries, ...opts.regimeCfg });
  const regime = regimeRow?.regime ?? REGIMES.RANGE;
  const confidence = Number(regimeRow?.confidence ?? 0);

  let daySituation = "range";
  if (pre) {
    if (isBreakdownDay(candles, idx, pre)) daySituation = "breakdown";
    else if (isBreakoutDay(candles, idx, pre)) daySituation = "breakout";
  }

  const sessionNarrative = bar ? resolveSessionNarrative(bar.ts, opts) : "off_hours";
  const killzoneOk = bar ? inSmcKillzone(bar.ts, opts) : true;

  return {
    regime,
    confidence,
    daySituation,
    sessionNarrative,
    killzoneOk,
    adx: regimeRow?.adx ?? null,
    atrPct: regimeRow?.atrPct ?? null,
  };
}

/**
 * Precompute regime series once per candle batch (attach to opts._regimeSeries).
 */
export function ensureLiqRegimeSeries(candles, opts = {}) {
  if (opts._regimeSeries?.length === candles.length) return opts._regimeSeries;
  return buildRegimeSeries(candles, opts.regimeCfg ?? {});
}

// Completed-day range series cache (per candle batch). Each day's hi/lo/close are
// only read for days strictly BEFORE the current bar's day, so no look-ahead.
const DAY_MS = 86_400_000;
const dayRangeCache = new WeakMap();

function getCompletedDaySeries(candles) {
  let rec = dayRangeCache.get(candles);
  if (rec && rec.n === candles.length) return rec;
  const days = [];
  let cur = null;
  for (const c of candles) {
    const d = Math.floor(Number(c.ts) / DAY_MS);
    if (!cur || cur.day !== d) {
      if (cur) days.push(cur);
      cur = { day: d, hi: Number(c.high), lo: Number(c.low), close: Number(c.close) };
    } else {
      cur.hi = Math.max(cur.hi, Number(c.high));
      cur.lo = Math.min(cur.lo, Number(c.low));
      cur.close = Number(c.close);
    }
  }
  if (cur) days.push(cur);
  rec = { n: candles.length, days };
  dayRangeCache.set(candles, rec);
  return rec;
}

/**
 * Rolling range-compression ratio at a bar: mean(daily range % last 14 completed
 * days) / mean(last 100 completed days). Returns null while history < 30 days.
 * Low values = compressed regime where sweep→reclaim lacks follow-through fuel.
 */
export function liqRangeCompressionAt(candles, idx) {
  if (!candles?.length || idx < 0) return null;
  const curDay = Math.floor(Number(candles[idx].ts) / DAY_MS);
  const { days } = getCompletedDaySeries(candles);
  // last index with day < curDay (binary search)
  let lo = 0;
  let hi = days.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid].day < curDay) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (last < 29) return null;
  const meanRange = (n) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, last - n + 1); k <= last; k++) {
      if (days[k].close > 0) {
        s += (days[k].hi - days[k].lo) / days[k].close;
        c++;
      }
    }
    return c ? s / c : null;
  };
  const r14 = meanRange(14);
  const r100 = meanRange(100);
  return r14 != null && r100 != null && r100 > 0 ? r14 / r100 : null;
}

/** Calendar days of candle history LIQ activation needs before the signal window. */
export const LIQ_INTRADAY_PAD_DAYS = 150;

/**
 * Warmup pad so range-compression (100d), ADX/regime, PDH/PDL, and session state
 * are causal from bar one of the backtest window. Without this, short UI windows
 * (e.g. 2026-01→07) start with null compression and take false-reclaim fades that
 * research runs with pad correctly stand down.
 */
export function liqIntradayPadFromMs(fromMs, _tf = "15m", _cfg = {}) {
  return Number(fromMs) - LIQ_INTRADAY_PAD_DAYS * 86_400_000;
}

/** True when cfg is classical LIQ / LIQ research (needs the pad above). */
export function needsLiqIntradayPad(cfg = {}) {
  if (cfg.intradayGateLiquidity === true) return true;
  const playbook = String(cfg.intradayLiqPlaybook ?? "").toUpperCase();
  if (playbook === "LIQ_CORE" || playbook === "LIQ_ACCEPT" || playbook.startsWith("LIQ")) return true;
  if (Number(cfg.intradayLiqRangeCompressionMin ?? 0) > 0) return true;
  if (Number(cfg.intradayLiqMaxAdx ?? 0) > 0) return true;
  if (cfg.intradayLiqMitigationEntry === true) return true;
  if (cfg.intradayLiqRequireDisplacementV2 === true) return true;
  return false;
}

/**
 * Should classical LIQ scan/run on this bar? (bar-level, side-agnostic)
 * Killzone can apply independently of the full market-state gate (LIQ_CORE).
 */
export function passesLiqMarketActivation(candles, idx, pre, opts = {}) {
  const ctx = buildLiqMarketContext(candles, idx, pre, opts);
  if (opts.intradayLiqRequireKillzone === true && !ctx.killzoneOk) return false;

  // Range-compression stand-down: in compressed regimes (14d avg daily range well
  // below the 100d norm) sweeps lack follow-through fuel → false reclaims dominate
  // (Phase 4 top root cause). Relative, causal, side-agnostic. 0/unset = off.
  const compMin = Number(opts.intradayLiqRangeCompressionMin ?? 0);
  if (compMin > 0) {
    const ratio = liqRangeCompressionAt(candles, idx);
    if (ratio != null && ratio < compMin) return false;
  }

  // Strong-trend stand-down: high ADX → never-green fade SLs concentrate (BUYBD
  // residual autopsy 2026-07-25). 0/unset = off.
  const maxAdx = Number(opts.intradayLiqMaxAdx ?? 0);
  if (maxAdx > 0 && ctx.adx != null && Number(ctx.adx) > maxAdx) return false;

  // Guide active-session gate (LIQ-native). Outer srIntradaySession* is skipped on
  // LIQ solo fast path — this is the real hour filter for classical LIQ.
  const hStart = Number(opts.intradayLiqActiveHourStart);
  const hEnd = Number(opts.intradayLiqActiveHourEnd);
  if (Number.isFinite(hStart) && Number.isFinite(hEnd) && hEnd > hStart) {
    const bar = candles?.[idx];
    if (bar) {
      const h = utcHourFromTs(bar.ts);
      if (h < hStart || h >= hEnd) return false;
    }
  }

  if (opts.intradayLiqMarketStateGate !== true) return true;
  if (ctx.regime === REGIMES.VOLATILE_AVOID) return false;
  return true;
}

/**
 * Side-aware activation for a specific setup candidate.
 */
export function passesLiqMarketActivationForSetup(candles, idx, side, pre, opts = {}, levelType = "") {
  if (!passesLiqMarketActivation(candles, idx, pre, opts)) return false;
  const ctx = buildLiqMarketContext(candles, idx, pre, opts);
  const external = isExternalLiquidityLevel(levelType);

  if (ctx.regime === REGIMES.TREND_UP) {
    if (side === "SELL" && !external) return false;
  } else if (ctx.regime === REGIMES.TREND_DOWN) {
    if (side === "BUY" && !external) return false;
  }

  // Toxic fade abstain: do not fade against an accepted day-break (any pool type).
  // BUY after SSL sweep on a breakdown day = fighting continuation; SELL on breakout same.
  // Mode: true|"both" = both sides; "buy_breakdown" / "sell_breakout" = one-sided (freq restore).
  const dayBias = opts.intradayLiqDaySituationBias;
  if (dayBias === true || dayBias === "both" || dayBias === "buy_breakdown" || dayBias === "sell_breakout") {
    const mode = dayBias === true ? "both" : dayBias;
    if ((mode === "both" || mode === "buy_breakdown") && ctx.daySituation === "breakdown" && side === "BUY") {
      return false;
    }
    if ((mode === "both" || mode === "sell_breakout") && ctx.daySituation === "breakout" && side === "SELL") {
      return false;
    }
  }

  // Macro-align fade (VP-style relative rule): abstain counter-macro fades.
  // SELL into strong 60d bull / BUY into strong 60d bear = unprepared fade physics.
  if (opts.intradayLiqMacroAlignFade === true && candles?.length && idx >= 0) {
    const bullFloor = Number(opts.intradayLiqMacroBullPrior60 ?? 0.15);
    const bearCeil = Number(opts.intradayLiqMacroBearPrior60 ?? -0.15);
    const barsPerDay = Math.max(1, Math.round(86_400_000 / Math.max(1, Number(candles[1]?.ts ?? 0) - Number(candles[0]?.ts ?? 0) || 900_000)));
    const lookback = Math.max(1, Math.round(60 * barsPerDay));
    if (idx >= lookback) {
      const a = Number(candles[idx - lookback]?.close);
      const b = Number(candles[idx]?.close);
      if (a > 0 && b > 0) {
        const prior60 = (b - a) / a;
        if (side === "SELL" && prior60 > bullFloor) return false;
        if (side === "BUY" && prior60 < bearCeil) return false;
      }
    }
  }

  // Session narrative allow-list (e.g. asia_accum only). Empty / unset = all.
  const narrAllow = opts.intradayLiqSessionNarratives;
  if (Array.isArray(narrAllow) && narrAllow.length > 0) {
    if (!narrAllow.includes(ctx.sessionNarrative)) return false;
  }

  // Premium/discount align vs today's range so far (ICT dealing-range idea on day auction).
  // Long fades prefer discount (SSL sweep); short fades prefer premium (BSL sweep).
  // Block loc-against: BUY in premium / SELL in discount. Equilibrium always allowed.
  if (opts.intradayLiqRequirePremiumDiscountAlign === true && candles?.length && idx >= 0) {
    const bar = candles[idx];
    const day0 = Math.floor(Number(bar.ts) / 86_400_000) * 86_400_000;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = idx; j >= 0 && Number(candles[j].ts) >= day0; j--) {
      hi = Math.max(hi, Number(candles[j].high));
      lo = Math.min(lo, Number(candles[j].low));
    }
    const rng = hi - lo;
    const px = Number(bar.close);
    if (rng > 0 && px > 0) {
      const pos = (px - lo) / rng;
      const discountHi = Number(opts.intradayLiqDiscountMaxPos ?? 0.3);
      const premiumLo = Number(opts.intradayLiqPremiumMinPos ?? 0.7);
      if (side === "BUY" && pos > premiumLo) return false;
      if (side === "SELL" && pos < discountHi) return false;
    }
  }

  return true;
}

/** Session narrative alignment score 0–10 for entryScoreV2. */
export function scoreSessionNarrative(sessionNarrative, side, levelType) {
  let pts = 5;
  if (sessionNarrative === "london_sweep") pts += 2;
  if (sessionNarrative === "ny_continuation") pts += 1;
  if (sessionNarrative === "asia_accum" && (levelType === "asian_low" || levelType === "asian_high")) pts += 3;
  if (sessionNarrative === "off_hours") pts -= 2;
  if (side === "BUY" && sessionNarrative === "ny_continuation") pts += 1;
  if (side === "SELL" && sessionNarrative === "london_sweep") pts += 1;
  return Math.max(0, Math.min(10, pts));
}
