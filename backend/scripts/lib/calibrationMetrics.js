/**
 * Calibration metrics for distributional estimates.
 */
import { mean, num } from "./liqResearchStats.js";

export function brierScore(predictions, actuals) {
  const pairs = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = num(predictions[i]);
    const a = num(actuals[i]);
    if (p == null || a == null) continue;
    pairs.push([(p - a) ** 2, 1]);
  }
  if (!pairs.length) return { score: null, n: 0 };
  return { score: mean(pairs.map(([s]) => s)), n: pairs.length };
}

/**
 * Reliability curve — predicted probability vs observed frequency per bin.
 */
export function reliabilityCurve(predictions, actuals, nBins = 10) {
  const pairs = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = num(predictions[i]);
    const a = num(actuals[i]);
    if (p == null || a == null) continue;
    pairs.push({ p, a });
  }
  if (pairs.length < nBins * 3) return { bins: [], sufficient: false };

  pairs.sort((a, b) => a.p - b.p);
  const binSize = Math.ceil(pairs.length / nBins);
  const bins = [];
  for (let i = 0; i < pairs.length; i += binSize) {
    const slice = pairs.slice(i, i + binSize);
    if (!slice.length) continue;
    bins.push({
      bin: bins.length + 1,
      n: slice.length,
      meanPredicted: mean(slice.map((x) => x.p)),
      observedFreq: mean(slice.map((x) => x.a)),
      calibrationError: Math.abs(mean(slice.map((x) => x.p)) - mean(slice.map((x) => x.a))),
    });
  }

  const ece = mean(bins.map((b) => b.calibrationError));
  return { bins, expectedCalibrationError: ece, sufficient: bins.length >= 3 };
}

function rankCorrelation(pred, actual) {
  const pairs = pred
    .map((p, i) => ({ p: num(p), a: num(actual[i]) }))
    .filter((x) => x.p != null && x.a != null);
  if (pairs.length < 20) return null;
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array(arr.length);
    sorted.forEach((x, ri) => (r[x.i] = ri + 1));
    return r;
  };
  const rp = rank(pairs.map((x) => x.p));
  const ra = rank(pairs.map((x) => x.a));
  const mr = mean(rp);
  const ma = mean(ra);
  let nume = 0;
  let dp = 0;
  let da = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = rp[i] - mr;
    const b = ra[i] - ma;
    nume += a * b;
    dp += a * a;
    da += b * b;
  }
  return dp > 0 && da > 0 ? nume / Math.sqrt(dp * da) : null;
}

/**
 * Full calibration report for distributional estimates on holdout.
 */
export function evaluateDistributionalCalibration(estimates) {
  const sufficient = estimates.length >= 30;
  const brier1R = brierScore(
    estimates.map((e) => e.pHit1R),
    estimates.map((e) => e.actualHit1R),
  );
  const brier2R = brierScore(
    estimates.map((e) => e.pHit2R),
    estimates.map((e) => e.actualHit2R),
  );
  const brierSl = brierScore(
    estimates.map((e) => e.pSlFirst),
    estimates.map((e) => e.actualSlFirst),
  );
  const rel1R = reliabilityCurve(
    estimates.map((e) => e.pHit1R),
    estimates.map((e) => e.actualHit1R),
  );
  const relSl = reliabilityCurve(
    estimates.map((e) => e.pSlFirst),
    estimates.map((e) => e.actualSlFirst),
  );

  const erPairs = estimates.filter((e) => e.expectedR != null && e.actualR != null);
  const meanError = mean(erPairs.map((e) => e.expectedR - e.actualR));
  const rankCorr = rankCorrelation(
    erPairs.map((e) => e.expectedR),
    erPairs.map((e) => e.actualR),
  );

  return {
    sufficient,
    n: estimates.length,
    brier: { pHit1R: brier1R, pHit2R: brier2R, pSlFirst: brierSl },
    reliability: { pHit1R: rel1R, pSlFirst: relSl },
    expectedR: {
      meanError,
      rankCorrelation: rankCorr,
      avgPredicted: mean(erPairs.map((e) => e.expectedR)),
      avgActual: mean(erPairs.map((e) => e.actualR)),
    },
  };
}
