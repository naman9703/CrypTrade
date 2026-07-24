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

/**
 * Should classical LIQ scan/run on this bar? (bar-level, side-agnostic)
 * Killzone can apply independently of the full market-state gate (LIQ_CORE).
 */
export function passesLiqMarketActivation(candles, idx, pre, opts = {}) {
  const ctx = buildLiqMarketContext(candles, idx, pre, opts);
  if (opts.intradayLiqRequireKillzone === true && !ctx.killzoneOk) return false;

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
  if (opts.intradayLiqDaySituationBias === true) {
    if (ctx.daySituation === "breakdown" && side === "BUY") return false;
    if (ctx.daySituation === "breakout" && side === "SELL") return false;
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
