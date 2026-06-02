/**
 * Entry context for strict fib gate — used for loss autopsy and fib-specific vetoes.
 */

import { rejectionWickRatio } from "./techniques/liquidity.js";
import { findImpulseLeg, FIB_RATIOS } from "./techniques/fibonacci.js";
import { cvdMomentum, deltaImbalance } from "./techniques/orderFlow.js";
import { detectTrendHtfStMacroMode } from "./trendHtfStRegime.js";
import { evaluateTrendHtfStRegime } from "./trendHtfStRegime.js";

function utcHour(ts) {
  return Math.floor((ts % 86_400_000) / 3_600_000);
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre
 * @param {object} fibSig — evaluateFibRetraceSetup result
 * @param {object} opts
 */
export function buildFibEntryContext(candles, idx, pre, fibSig, opts = {}) {
  const bar = candles[idx];
  const side = fibSig.side;
  const leg = fibSig.leg;
  const atrVal = pre.atrSeries[idx];
  const range = bar.high - bar.low;
  const rangeAtr = atrVal > 0 ? range / atrVal : 0;
  const volSlice = pre.volumes.slice(Math.max(0, idx - 20), idx);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  const volRatio = volAvg > 0 ? pre.volumes[idx] / volAvg : 1;
  const cvdM = cvdMomentum(pre.cvd, idx, 6);
  const delta = deltaImbalance(candles, idx, 5);
  const cvdAligned =
    (side === "BUY" && cvdM.bullish && delta.buyPct >= 0.55) ||
    (side === "SELL" && cvdM.bearish && delta.sellPct >= 0.55);
  const macroMode = detectTrendHtfStMacroMode(candles, idx);
  const regime = evaluateTrendHtfStRegime(candles, idx, side, opts.regimeCfg ?? {});

  const barsSinceSwing = leg
    ? idx - (leg.direction === "up" ? leg.highIdx : leg.lowIdx)
    : null;

  const retrace = fibSig.retrace ?? null;
  const ratio = fibSig.ratio ?? null;
  const golden = ratio != null && Math.abs(ratio - FIB_RATIOS.golden) < 0.001;
  const mid = ratio != null && Math.abs(ratio - FIB_RATIOS.mid) < 0.001;

  return {
    idx,
    ts: bar.ts,
    hour: utcHour(bar.ts),
    side,
    score: fibSig.score,
    techniques: fibSig.techniques ?? [],
    reason: `ipro_${(fibSig.techniques ?? []).join("+")}`,
    adx: pre.adxSeries[idx],
    rsi: pre.rsiSeries[idx],
    htfSep: pre.htfSep[idx],
    htfUp: pre.htfUp[idx],
    htfDown: pre.htfDown[idx],
    atrPct: bar.close > 0 && Number.isFinite(atrVal) ? atrVal / bar.close : 0,
    rangeAtr,
    volRatio,
    wick: rejectionWickRatio(bar, side),
    fibRatio: ratio,
    fibGolden: golden,
    fibMid: mid,
    fibRetrace: retrace,
    barsSinceSwing,
    legRangeAtr: leg && atrVal > 0 ? leg.range / atrVal : null,
    hasConfirm: (fibSig.techniques ?? []).includes("fib_confirm"),
    cvdAligned,
    macroMode,
    structuralRisk: regime?.structuralRisk ?? "MIXED",
    regimeFlags: regime?.flags ?? [],
    slPct: fibSig.slPct,
    tpPct: fibSig.tpPct,
    rr: fibSig.rr,
  };
}

/** @param {object} trade */
export function classifyFibTradeOutcome(trade) {
  const net = Number(trade.netPnl ?? 0);
  const mfe = Number(trade.mfePct ?? 0);
  const mae = Number(trade.maePct ?? 0);
  const bars = Number(trade.barsHeld ?? 0);
  const exit = String(trade.exitReason ?? "");

  if (net > 0 && mfe >= 0.008) return "BIG_WIN";
  if (net > 0) return "WIN";
  if (net <= 0 && mfe >= 0.003) return "GAVE_BACK";
  if (exit === "sl" && bars <= 3 && mae <= -0.0025) return "INSTANT_LOSS";
  if (exit === "sl" && mfe < 0.001) return "NO_RUN";
  return "LOSS";
}
