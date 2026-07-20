/**
 * Family D — Volatility expansion harvest at L0–L1.
 * Captures squeeze breaks, regime expansion transitions, and ATR expansion crosses.
 */
import { buildRegimeSeries, REGIMES } from "../../regimeEngine.js";
import { scanSqueezeBreak } from "../../situation/setupScanners.js";
import { ema, atr as computeAtr } from "../../indicators.js";
import { computeForwardLabels, computeReach1RBeforeSl, estimateOutcomeDistribution } from "../liq/forwardLabels.js";
import { markDayPickerSelection, slFromAtr, utcDayId } from "./candidateHarvestShared.js";
import { observableFeaturesAt } from "../../../backtest/data/observableFeatures.js";

const WARMUP = 210;

function rvolAt(pre, idx, bar) {
  const vol = Number(bar.volume) || 0;
  const avg = pre?.volEma20?.[idx] ?? pre?.volAvg?.[idx];
  if (avg > 0) return vol / avg;
  return 1;
}

/**
 * @param {object[]} candles
 * @param {object} pre — precomputeIntraday output
 * @param {object} opts
 */
export function harvestVolExpansionCandidates(candles, pre, opts = {}) {
  if (!candles?.length) return [];

  const regimeSeries = buildRegimeSeries(candles);
  const atrSeries = pre?.atrSeries ?? computeAtr(candles, 14);
  const atrEma = ema(atrSeries, 12);
  const harvestOpts = { squeezeMinAdx: 0, squeezeMinRvol: 0, donchLookback: 20, ...opts };

  const raw = [];
  const seen = new Set();

  const addCandidate = (i, side, trigger, extra = {}) => {
    const key = `${candles[i].ts}|${side}|${trigger}`;
    if (seen.has(key)) return;
    seen.add(key);

    const entryPx = Number(candles[i].close);
    const atr = Number(atrSeries[i] ?? 0);
    if (!(entryPx > 0) || !(atr > 0)) return;

    const slPrice = Number(extra.slPrice) > 0 ? Number(extra.slPrice) : slFromAtr(entryPx, side, atr);
    const forward = computeForwardLabels(candles, i, side, entryPx, slPrice, pre, opts);
    if (!forward) return;

    const reach1R = computeReach1RBeforeSl(candles, i, side, entryPx, slPrice);
    const outcomeDist = estimateOutcomeDistribution({ ...forward, probReach1R: reach1R });
    const regime = regimeSeries[i] ?? {};
    const atrNow = atrSeries[i] ?? 0;
    const atrAvg = atrEma[i] ?? 0;
    const atrExpansionRatio = atrAvg > 0 ? atrNow / atrAvg : 1;
    const rv = rvolAt(pre, i, candles[i]);

    raw.push({
      candidateKey: key,
      familyId: "D",
      familyName: "volatility_expansion",
      trigger,
      symbol: opts.symbol ?? "",
      entryTs: candles[i].ts,
      entryYear: new Date(candles[i].ts).getUTCFullYear(),
      entryBarIdx: i,
      dayId: utcDayId(candles[i].ts),
      side,
      entryPx,
      slPrice,
      marketState_regime: regime.regime ?? "",
      marketState_confidence: regime.confidence ?? null,
      marketState_adx: regime.adx ?? pre?.adxSeries?.[i] ?? null,
      marketState_atrPct: regime.atrPct ?? (atr > 0 ? atr / entryPx : null),
      vol_bb_pctile: regime.bbPctile ?? null,
      vol_atr_expansion: atrExpansionRatio,
      vol_rvol: rv,
      vol_prev_regime: extra.prevRegime ?? "",
      vol_expansion_score: (atrExpansionRatio > 1.15 ? 2 : atrExpansionRatio > 1.05 ? 1 : 0) + (rv > 1.5 ? 1 : 0),
      ...(opts.observableSeries ? observableFeaturesAt(opts.observableSeries, candles[i].ts) : {}),
      ...extra,
      ...forward,
      ...outcomeDist,
      probReach1R: reach1R,
      compositeScore:
        (atrExpansionRatio > 1.15 ? 2 : 0) + (rv > 1.5 ? 1 : 0) + (regime.adx >= 20 ? 1 : 0),
      candidateTier: "minimal",
    });
  };

  for (let i = WARMUP; i < candles.length; i++) {
    const regime = regimeSeries[i];
    const prev = regimeSeries[i - 1];
    const atrNow = atrSeries[i] ?? 0;
    const atrAvg = atrEma[i] ?? 0;
    const atrRatio = atrAvg > 0 ? atrNow / atrAvg : 1;
    const prevRatio =
      i > 0 && atrEma[i - 1] > 0 ? (atrSeries[i - 1] ?? 0) / atrEma[i - 1] : 1;

    // Squeeze break (Donchian expansion)
    const squeezeSetup = scanSqueezeBreak(candles, i, pre, null, harvestOpts);
    if (squeezeSetup) {
      addCandidate(i, squeezeSetup.side, "squeeze_break", {
        slPrice: squeezeSetup.slPrice,
        vol_setup_quality: squeezeSetup.score ?? null,
      });
    }

    // Regime transition: SQUEEZE → directional trend
    if (
      prev?.regime === REGIMES.SQUEEZE &&
      (regime?.regime === REGIMES.TREND_UP || regime?.regime === REGIMES.TREND_DOWN)
    ) {
      const side = regime.regime === REGIMES.TREND_UP ? "BUY" : "SELL";
      addCandidate(i, side, "regime_expansion", { prevRegime: prev.regime });
    }

    // ATR expansion cross (compression → expansion)
    if (prevRatio < 1.05 && atrRatio >= 1.15) {
      const side = candles[i].close >= candles[i].open ? "BUY" : "SELL";
      addCandidate(i, side, "atr_expansion_cross", { prevAtrRatio: prevRatio });
    }
  }

  return markDayPickerSelection(raw, {
    dayPickerScoreKey: "compositeScore",
    maxTradesPerSidePerDay: opts.maxTradesPerSidePerDay ?? 1,
  });
}
