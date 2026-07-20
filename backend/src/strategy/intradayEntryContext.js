/**
 * Rich entry context for one bar — used for loss autopsy & learned vetoes.
 */

import { detectTrendHtfStMacroMode } from "./trendHtfStRegime.js";
import { evaluateTrendHtfStRegime } from "./trendHtfStRegime.js";
import {
  buildVolumeProfile,
  volumeProfileBias,
  scoreVolumeProfile,
  pathToNextHvn,
} from "./techniques/volumeProfile.js";
import { swingHighLow, fibLevels, nearFibLevel } from "./techniques/fibonacci.js";
import { cvdMomentum, deltaImbalance } from "./techniques/orderFlow.js";
import {
  evaluateSessionLiquiditySweep,
  sweepReclaim,
  rejectionWickRatio,
} from "./techniques/liquidity.js";

function utcHour(ts) {
  return Math.floor((ts % 86_400_000) / 3_600_000);
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre — from precomputeIntraday
 * @param {object} sig — evaluateIntradayBar result
 */
export function buildIntradayEntryContext(candles, idx, pre, sig, opts = {}) {
  const bar = candles[idx];
  const i = idx;
  const side = sig.action;
  const sweepPct = Number(opts.sweepPct ?? pre.adaptive?.sweepPct ?? 0.0006);
  const atrVal = pre.atrSeries[i];
  const atrPct = bar.close > 0 && Number.isFinite(atrVal) ? atrVal / bar.close : 0;
  const range = bar.high - bar.low;
  const rangeAtr = atrVal > 0 ? range / atrVal : 0;

  const volSlice = pre.volumes.slice(Math.max(0, i - 20), i);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  const volRatio = volAvg > 0 ? pre.volumes[i] / volAvg : 1;

  const prev = candles[i - 1];
  const pdl =
    side === "BUY" &&
    (sweepReclaim(bar, pre.prevDayLow[i], "BUY", sweepPct) ||
      (prev && sweepReclaim(prev, pre.prevDayLow[i], "BUY", sweepPct)));
  const pdh =
    side === "SELL" &&
    (sweepReclaim(bar, pre.prevDayHigh[i], "SELL", sweepPct) ||
      (prev && sweepReclaim(prev, pre.prevDayHigh[i], "SELL", sweepPct)));
  const asian =
    side === "BUY"
      ? sweepReclaim(bar, pre.asianLow[i], "BUY", sweepPct)
      : sweepReclaim(bar, pre.asianHigh[i], "SELL", sweepPct);

  const swing = swingHighLow(candles, i, 48);
  const fibHit = nearFibLevel(bar.close, fibLevels(swing, side === "BUY" ? "up" : "down"), sweepPct * 2.5);
  const vp = buildVolumeProfile(candles, i, {
    mode: opts.vpProfileMode ?? "composite_utc",
    lookback: Number(opts.vpLookbackBars ?? 192),
    bins: opts.vpBins ?? 50,
    distribute: opts.vpVolumeDistribute ?? "close_weighted",
    valueAreaPct: opts.vpValueAreaPct,
    vpCompositeDays: opts.vpCompositeDays ?? 5,
  });
  const vpScored = scoreVolumeProfile(candles, i, side, vp, opts);
  const vpOk = vpScored.blocked ? false : volumeProfileBias(bar, vp, side).ok || Boolean(vpScored.setup);
  const vpPath = vp ? pathToNextHvn(bar.close, side, vp) : null;
  const cvdM = cvdMomentum(pre.cvd, i, 6);
  const delta = deltaImbalance(candles, i, 5);
  const cvdAligned =
    (side === "BUY" && cvdM.bullish && delta.buyPct >= 0.55) ||
    (side === "SELL" && cvdM.bearish && delta.sellPct >= 0.55);

  const macroMode = detectTrendHtfStMacroMode(candles, i);
  const regime = evaluateTrendHtfStRegime(candles, i, side, opts.regimeCfg ?? {});

  return {
    idx: i,
    ts: bar.ts,
    hour: utcHour(bar.ts),
    side,
    score: sig.score,
    techniques: sig.techniques ?? [],
    reason: sig.reason,
    adx: pre.adxSeries[i],
    rsi: pre.rsiSeries[i],
    htfSep: pre.htfSep[i],
    htfUp: pre.htfUp[i],
    htfDown: pre.htfDown[i],
    atrPct,
    rangeAtr,
    volRatio,
    wick: rejectionWickRatio(bar, side),
    hasLiqSweep: Boolean(
      evaluateSessionLiquiditySweep(candles, i, side, pre, {
        ...opts,
        sweepPct,
      }),
    ),
    hasSession: Boolean(pdl || pdh || asian),
    pdl: Boolean(pdl),
    pdh: Boolean(pdh),
    asian: Boolean(asian),
    hasFib: Boolean(fibHit),
    fibRatio: fibHit?.ratio ?? null,
    hasVp: vpOk,
    vpSetup: sig.vpSetup ?? vpScored.setup ?? null,
    vpRr: sig.vpRr ?? vpScored.brackets?.rr ?? null,
    vpRunPct: vpPath?.distPct ?? null,
    vpBlocked: vpScored.blocked,
    cvdAligned,
    macroMode,
    regimeAllow: regime?.allowEntry !== false,
    structuralRisk: regime?.structuralRisk ?? "MIXED",
    regimeFlags: regime?.flags ?? [],
  };
}

/** Classify closed trade for learning */
export function classifyTradeOutcome(trade) {
  const net = Number(trade.netPnl ?? 0);
  const mfe = Number(trade.mfePct ?? 0) * 100;
  const mae = Number(trade.maePct ?? 0) * 100;
  const bars = Number(trade.barsHeld ?? 0);
  const exit = trade.exitReason ?? "";

  if (net > 0 && mfe >= 1.2) return "BIG_WIN";
  if (net > 0) return "WIN";
  if (net <= 0 && mfe >= 0.8) return "GAVE_BACK";
  if (exit === "sl" && bars <= 4 && mae <= -0.35) return "INSTANT_LOSS";
  return "LOSS";
}
