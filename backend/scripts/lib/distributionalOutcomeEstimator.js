/**
 * Distributional outcome estimator — predicts outcome distribution, not just E[R].
 *
 * Outputs: P(+1R), P(+2R), P(+3R), P(SL first), E[MFE], E[MAE], E[hold time], uncertainty.
 */
import { bucketExpectancy, mutualInformation, num, mean, std } from "./liqResearchStats.js";

const CALIBRATION_FEATURES = [
  "cont_score",
  "cont_opposingR",
  "sweep_velocityAtr",
  "level_importance",
  "marketState_adx",
  "scoreV2_total",
  "weightedQuality",
];

const DISTRIBUTION_LABELS = {
  pHit1R: "hit1R_flag",
  pHit2R: "hit2R_flag",
  pHit3R: "hit3R_flag",
  pSlFirst: "firstHit_sl",
  expectedMfeR: "fwd_mfeR_20",
  expectedMaeR: "fwd_maeR_20",
  expectedHoldBars: "timeToMfeBars",
  expectedR: "fwd_closeR_20",
};

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

function bucketDistribution(trainRows, feat, label, nBuckets = 10) {
  const bucket = bucketExpectancy(trainRows, feat, label, nBuckets);
  if (!bucket?.buckets?.length) return null;

  const enriched = bucket.buckets.map((b) => {
    const inBucket = trainRows.filter((r) => {
      const v = num(r[feat]);
      return v != null && v >= b.featureMin && v <= b.featureMax;
    });
    const outcomes = inBucket.map((r) => num(r.fwd_closeR_20)).filter((v) => v != null);
    return {
      ...b,
      pHit1R: mean(inBucket.map((r) => num(r.hit1R_flag))),
      pHit2R: mean(inBucket.map((r) => num(r.hit2R_flag))),
      pHit3R: mean(inBucket.map((r) => num(r.hit3R_flag))),
      pSlFirst: mean(inBucket.map((r) => num(r.firstHit_sl))),
      expectedMfeR: mean(inBucket.map((r) => num(r.fwd_mfeR_20))),
      expectedMaeR: mean(inBucket.map((r) => num(r.fwd_maeR_20))),
      expectedHoldBars: mean(inBucket.map((r) => num(r.timeToMfeBars))),
      outcomeStd: std(outcomes),
      n: inBucket.length,
    };
  });

  return {
    feature: feat,
    buckets: enriched,
    monotonicity: bucket.monotonicity,
    spread: bucket.spread,
    mutualInfo: mutualInformation(
      trainRows.map((r) => num(r[feat])),
      trainRows.map((r) => num(r.fwd_closeR_20)),
    ),
  };
}

/**
 * Train distributional calibrators from training data only.
 */
export function trainDistributionalEstimator(trainRows, outcome = "fwd_closeR_20") {
  const calibrators = {};
  for (const feat of CALIBRATION_FEATURES) {
    const cal = bucketDistribution(trainRows, feat, outcome, 10);
    if (cal?.buckets?.length) calibrators[feat] = cal;
  }
  return { calibrators, outcome, trainedOn: trainRows.length, type: "distributional_v1" };
}

function weightedBlend(contributions, key) {
  let sum = 0;
  let wSum = 0;
  for (const c of contributions) {
    const v = c[key];
    if (v == null) continue;
    sum += v * c.weight;
    wSum += c.weight;
  }
  return wSum > 0 ? sum / wSum : null;
}

/**
 * Estimate full outcome distribution for one candidate (inspectable).
 */
export function estimateDistributionalOutcome(candidate, model, opts = {}) {
  const contributions = [];

  for (const [feat, cal] of Object.entries(model.calibrators)) {
    const v = num(candidate[feat]);
    if (v == null) continue;
    const bucket = lookupBucket(cal, v);
    if (!bucket) continue;
    const w = Math.max(0.01, cal.mutualInfo ?? 0.01);
    contributions.push({
      feature: feat,
      value: v,
      bucket: bucket.bucket,
      bucketRange: [bucket.featureMin, bucket.featureMax],
      weight: w,
      expectedR: bucket.avgR,
      pHit1R: bucket.pHit1R,
      pHit2R: bucket.pHit2R,
      pHit3R: bucket.pHit3R,
      pSlFirst: bucket.pSlFirst,
      expectedMfeR: bucket.expectedMfeR,
      expectedMaeR: bucket.expectedMaeR,
      expectedHoldBars: bucket.expectedHoldBars,
      outcomeStd: bucket.outcomeStd,
    });
  }

  const distribution = {
    pHit1R: weightedBlend(contributions, "pHit1R"),
    pHit2R: weightedBlend(contributions, "pHit2R"),
    pHit3R: weightedBlend(contributions, "pHit3R"),
    pSlFirst: weightedBlend(contributions, "pSlFirst"),
    expectedMfeR: weightedBlend(contributions, "expectedMfeR"),
    expectedMaeR: weightedBlend(contributions, "expectedMaeR"),
    expectedHoldBars: weightedBlend(contributions, "expectedHoldBars"),
    expectedR: weightedBlend(contributions, "expectedR"),
    outcomeStd: weightedBlend(contributions, "outcomeStd"),
  };

  const uncertainty = Math.max(
    0.05,
    distribution.outcomeStd ?? 0,
    contributions.length
      ? Math.max(...contributions.map((c) => c.expectedR ?? 0)) -
          Math.min(...contributions.map((c) => c.expectedR ?? 0))
      : 0,
  );

  const utility = computeUtilityFromDistribution(distribution, uncertainty, opts);

  return {
    ...distribution,
    expectedR: distribution.expectedR != null ? Number(distribution.expectedR.toFixed(4)) : null,
    pHit1R: distribution.pHit1R != null ? Number(distribution.pHit1R.toFixed(4)) : null,
    pHit2R: distribution.pHit2R != null ? Number(distribution.pHit2R.toFixed(4)) : null,
    pHit3R: distribution.pHit3R != null ? Number(distribution.pHit3R.toFixed(4)) : null,
    pSlFirst: distribution.pSlFirst != null ? Number(distribution.pSlFirst.toFixed(4)) : null,
    uncertainty: Number(uncertainty.toFixed(4)),
    expectedUtility: utility != null ? Number(utility.toFixed(4)) : null,
    contributions,
    explanation: buildExplanation(contributions, distribution),
  };
}

export function computeUtilityFromDistribution(dist, uncertainty, opts = {}) {
  const riskAversion = Number(opts.riskAversion ?? 0.5);
  const slPenalty = Number(opts.slPenalty ?? 0.3);
  const maePenalty = Number(opts.maePenalty ?? 0.15);

  if (dist.expectedR == null) return null;

  return (
    dist.expectedR -
    riskAversion * (uncertainty ?? 0) -
    slPenalty * (dist.pSlFirst ?? 0) -
    maePenalty * Math.abs(dist.expectedMaeR ?? 0)
  );
}

function buildExplanation(contributions, dist) {
  if (!contributions.length) return "insufficient_calibration";
  const top = [...contributions]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => `${c.feature}@${c.bucket}: E[R]=${c.expectedR?.toFixed(2)} σ=${c.outcomeStd?.toFixed(2)}`)
    .join("; ");
  return `${top} → P(+1R)=${dist.pHit1R?.toFixed(2)} P(SL)=${dist.pSlFirst?.toFixed(2)}`;
}

export function estimateAllDistributional(candidates, model, opts = {}) {
  return candidates.map((c) => ({
    ...c,
    candidateKey: c.candidateKey ?? `${c.entryTs}|${c.side}`,
    actualR: num(c[model.outcome ?? "fwd_closeR_20"]),
    actualHit1R: num(c.hit1R_flag),
    actualHit2R: num(c.hit2R_flag),
    actualSlFirst: num(c.firstHit_sl),
    actualMfeR: num(c.fwd_mfeR_20),
    actualMaeR: num(c.fwd_maeR_20),
    scorePick: num(c.weightedQuality ?? c.scoreV2_total),
    ...estimateDistributionalOutcome(c, model, opts),
  }));
}
