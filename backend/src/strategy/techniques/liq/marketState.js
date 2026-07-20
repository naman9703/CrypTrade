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
 */
export function passesLiqMarketActivation(candles, idx, pre, opts = {}) {
  if (opts.intradayLiqMarketStateGate !== true) return true;
  const ctx = buildLiqMarketContext(candles, idx, pre, opts);
  if (ctx.regime === REGIMES.VOLATILE_AVOID) return false;
  if (opts.intradayLiqRequireKillzone === true && !ctx.killzoneOk) return false;
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

  if (opts.intradayLiqDaySituationBias === true) {
    if (ctx.daySituation === "breakdown" && side === "BUY" && levelType === "pdl") return false;
    if (ctx.daySituation === "breakout" && side === "SELL" && levelType === "pdh") return false;
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
