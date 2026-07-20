/**
 * Transparent expected-outcome estimator — not a black box.
 * Maps feature vector → E[R], E[MAE], P(+1R), uncertainty via calibrated buckets.
 */
import { bucketExpectancy, mutualInformation, num, mean, bootstrapMeanCI } from "./liqResearchStats.js";

const CALIBRATION_FEATURES = [
  "cont_score",
  "cont_opposingR",
  "sweep_velocityAtr",
  "level_importance",
  "marketState_adx",
  "scoreV2_total",
  "weightedQuality",
];

/**
 * Build transparent bucket calibrators from training candidates (no future labels in features).
 */
export function trainExpectedOutcomeEstimator(trainRows, outcome = "fwd_closeR_20") {
  const calibrators = {};
  for (const feat of CALIBRATION_FEATURES) {
    const bucket = bucketExpectancy(trainRows, feat, outcome, 10);
    if (!bucket?.buckets?.length) continue;
    calibrators[feat] = {
      feature: feat,
      buckets: bucket.buckets,
      monotonicity: bucket.monotonicity,
      spread: bucket.spread,
      mutualInfo: mutualInformation(
        trainRows.map((r) => num(r[feat])),
        trainRows.map((r) => num(r[outcome])),
      ),
    };
  }
  return { calibrators, outcome, trainedOn: trainRows.length };
}

function lookupBucket(calibrator, value) {
  if (value == null || !calibrator?.buckets?.length) return null;
  for (const b of calibrator.buckets) {
    if (value >= b.featureMin && value <= b.featureMax) return b;
  }
  const sorted = [...calibrator.buckets].sort(
    (a, b) => Math.abs((a.featureMid ?? 0) - value) - Math.abs((b.featureMid ?? 0) - value),
  );
  return sorted[0] ?? null;
}

/**
 * Estimate expected outcome for one candidate (fully inspectable).
 */
export function estimateCandidateOutcome(candidate, model, opts = {}) {
  const contributions = [];
  let weightSum = 0;
  let erSum = 0;

  for (const [feat, cal] of Object.entries(model.calibrators)) {
    const v = num(candidate[feat]);
    if (v == null) continue;
    const bucket = lookupBucket(cal, v);
    if (!bucket || bucket.avgR == null) continue;
    const w = Math.max(0.01, cal.mutualInfo ?? 0.01);
    contributions.push({
      feature: feat,
      value: v,
      bucket: bucket.bucket,
      bucketRange: [bucket.featureMin, bucket.featureMax],
      expectedR: bucket.avgR,
      weight: w,
      winPct: bucket.winPct,
    });
    erSum += bucket.avgR * w;
    weightSum += w;
  }

  const expectedR = weightSum > 0 ? erSum / weightSum : null;
  const maeR = num(candidate.maeR);
  const mfeR = num(candidate.mfeR);
  const hit1R = num(candidate.hit1R_flag);
  const hit2R = num(candidate.hit2R_flag);
  const timeToMfe = num(candidate.timeToMfeBars);

  const spread = contributions.length
    ? Math.max(...contributions.map((c) => c.expectedR)) -
      Math.min(...contributions.map((c) => c.expectedR))
    : 0;
  const uncertainty = Math.max(0.05, spread * 0.5);

  const riskAversion = Number(opts.riskAversion ?? 0.5);
  const expectedUtility =
    expectedR != null ? expectedR - riskAversion * uncertainty - (maeR != null ? maeR * 0.15 : 0) : null;

  return {
    expectedR: expectedR != null ? Number(expectedR.toFixed(4)) : null,
    expectedMaeR: maeR,
    expectedMfeR: mfeR,
    pHit1R: hit1R,
    pHit2R: hit2R,
    expectedHoldBars: timeToMfe,
    uncertainty: Number(uncertainty.toFixed(4)),
    expectedUtility: expectedUtility != null ? Number(expectedUtility.toFixed(4)) : null,
    contributions,
    explanation:
      contributions.length > 0
        ? contributions
            .sort((a, b) => b.weight * Math.abs(b.expectedR) - a.weight * Math.abs(a.expectedR))
            .slice(0, 4)
            .map((c) => `${c.feature}@${c.bucket}→${c.expectedR?.toFixed(2)}R`)
            .join("; ")
        : "insufficient_calibration",
  };
}

/**
 * Batch estimate for all candidates.
 */
export function estimateAll(candidates, model, opts = {}) {
  return candidates.map((c) => ({
    ...c,
    candidateKey: c.candidateKey ?? `${c.entryTs}|${c.side}`,
    actualR: num(c[model.outcome ?? "fwd_closeR_20"]),
    scorePick: num(c.weightedQuality ?? c.scoreV2_total),
    ...estimateCandidateOutcome(c, model, opts),
  }));
}

/**
 * Evaluate estimator on holdout: predicted E[R] vs actual R.
 */
export function evaluateEstimator(estimates) {
  const pairs = estimates.filter((e) => e.expectedR != null && e.actualR != null);
  if (pairs.length < 20) return { n: pairs.length, sufficient: false };

  const pred = pairs.map((p) => p.expectedR);
  const actual = pairs.map((p) => p.actualR);
  const meanErr = mean(pred.map((p, i) => p - actual[i]));
  const ci = bootstrapMeanCI(actual.map((a, i) => a - pred[i]));

  let rankCorr = 0;
  const n = pairs.length;
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array(arr.length);
    sorted.forEach((x, ri) => (r[x.i] = ri + 1));
    return r;
  };
  const rp = rank(pred);
  const ra = rank(actual);
  const mr = mean(rp);
  const ma = mean(ra);
  let nume = 0;
  let dp = 0;
  let da = 0;
  for (let i = 0; i < n; i++) {
    const a = rp[i] - mr;
    const b = ra[i] - ma;
    nume += a * b;
    dp += a * a;
    da += b * b;
  }
  rankCorr = dp > 0 && da > 0 ? nume / Math.sqrt(dp * da) : 0;

  return {
    n: pairs.length,
    sufficient: true,
    meanError: meanErr,
    errorCI: ci,
    rankCorrelation: rankCorr,
    avgPredictedR: mean(pred),
    avgActualR: mean(actual),
  };
}
