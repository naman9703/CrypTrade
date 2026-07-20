/**
 * Three-layer feature lifecycle + promotion policy (research → experimental → production).
 */
import { DEPLOYMENT_OBJECTIVES, evaluateAssetGroupStability } from "./assetBehaviorGroups.js";
import { PHASE_STANDARDS } from "./informationHierarchy.js";

export const LAYER = {
  RESEARCH: "research",
  EXPERIMENTAL: "experimental",
  PRODUCTION: "production",
};

/** Criteria every feature must pass before layer promotion. */
export const PROMOTION_POLICY = {
  researchToExperimental: {
    minCandidates: 200,
    minMonotonicity: 0.25,
    minBucketSpread: 0.12,
    maxPermutationP: 0.1,
    minCoinStabilityRatio: 0.5,
    minCoinsTested: 3,
    walkForwardSignConsistent: true,
    fdrAdjustedSignificant: true,
    holdoutNotUsedForSelection: true,
  },
  experimentalToProduction: {
    minCandidates: 400,
    minMonotonicity: 0.35,
    minBucketSpread: 0.15,
    maxPermutationP: 0.05,
    minCoinStabilityRatio: 0.6,
    minCoinsTested: 4,
    minRegimeStabilityRatio: 0.5,
    holdoutValidatePositive: true,
    incrementalOverPromoted: true,
    explainableContributions: true,
  },
};

/**
 * Evaluate whether evidence supports layer promotion.
 * @returns {{ layer: string, nextLayer: string|null, passed: boolean, checks: object, recommendation: string }}
 */
export const SPECIALIZATION_MODE = {
  UNIVERSAL: "universal",
  PER_COIN: "per_coin",
  PER_REGIME: "per_regime",
};

/** @typedef {"universal"|"per_coin"|"per_regime"} SpecializationMode */

/**
 * Evaluate promotion with universal or per-coin specialization.
 */
export function evaluatePromotion(evidence, targetLayer = LAYER.EXPERIMENTAL, mode = SPECIALIZATION_MODE.UNIVERSAL) {
  const policy =
    targetLayer === LAYER.PRODUCTION
      ? PROMOTION_POLICY.experimentalToProduction
      : PROMOTION_POLICY.researchToExperimental;

  const coinOk =
    mode === SPECIALIZATION_MODE.PER_COIN
      ? evaluatePerCoinByBehaviorGroups(evidence)
      : (evidence.coinStabilityRatio ?? 0) >= policy.minCoinStabilityRatio &&
        (evidence.coinsTested ?? 0) >= policy.minCoinsTested;

  const checks = {
    sampleSize: (evidence.n ?? 0) >= policy.minCandidates,
    monotonicity: Math.abs(evidence.monotonicity ?? 0) >= policy.minMonotonicity,
    bucketSpread: Math.abs(evidence.bucketSpread ?? 0) >= policy.minBucketSpread,
    permutation: (evidence.permutationP ?? 1) <= policy.maxPermutationP,
    coinStability: coinOk,
    regimeStability:
      targetLayer !== LAYER.PRODUCTION ||
      (evidence.regimeStabilityRatio ?? 0) >= policy.minRegimeStabilityRatio,
    walkForward: evidence.walkForwardConsistent !== false,
    fdr: evidence.fdrSignificant !== false,
    holdout:
      targetLayer === LAYER.PRODUCTION
        ? (evidence.holdoutSpread ?? 0) > 0 && (evidence.holdoutMono ?? 0) > 0
        : evidence.holdoutUnused !== false,
    incremental: targetLayer !== LAYER.PRODUCTION || evidence.incrementalValue !== false,
    explainable: targetLayer !== LAYER.PRODUCTION || evidence.explainable !== false,
    informationGain: (evidence.informationGain ?? 0) >= 0.01 || evidence.informationGain == null,
  };

  const passed = Object.values(checks).every(Boolean);
  const failed = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return {
    layer: evidence.currentLayer ?? LAYER.RESEARCH,
    nextLayer: passed ? targetLayer : null,
    passed,
    checks,
    failed,
    recommendation: passed
      ? `Promote to ${targetLayer}`
      : `Remain in ${evidence.currentLayer ?? LAYER.RESEARCH} — failed: ${failed.join(", ")}`,
  };
}

function evaluatePerCoinByBehaviorGroups(evidence) {
  if (!evidence.sliceBySymbol) return (evidence.perCoinPositive ?? 0) >= 1;
  const groups = evaluateAssetGroupStability(evidence.sliceBySymbol);
  const specializedPass = Object.values(groups).some((g) => g.passesSpecialized);
  const universalPass = Object.values(groups).every((g) => g.passesUniversal || g.tested === 0);
  if (evidence.deploymentObjective === DEPLOYMENT_OBJECTIVES.universal.id) return universalPass;
  return specializedPass;
}

export function policyToMarkdown() {
  const expl = PHASE_STANDARDS.exploration;
  const val = PHASE_STANDARDS.validation;
  return `# LIQ Feature Promotion Policy

## Layers

1. **Research** — hypothesis registered, candidate-level evidence collected
2. **Experimental** — passes FDR + walk-forward on research folds (holdout untouched)
3. **Production** — holdout confirmation + cross-asset/regime stability + incremental value

## Research → Experimental

- ≥200 candidates, monotonicity ≥0.25, bucket spread ≥0.12R
- Permutation p < 0.10, coin stability ≥50% across ≥3 coins
- Walk-forward sign consistent, Benjamini–Hochberg FDR significant
- Holdout year (2026) NOT used for selection

## Experimental → Production

- ≥400 candidates, monotonicity ≥0.35, spread ≥0.15R, p < 0.05
- Coin stability ≥60% across ≥4 coins, regime stability ≥50%
- Holdout validates positive expectancy
- Incremental over already-promoted features; contributions inspectable

## Philosophy

Estimate **outcome distributions** (P(+1R), P(+2R), E[MFE], E[MAE]) — not opaque win probability.

## Research phases

- **Exploration** — cheap, fast, speculative (${expl.minCandidates}+ candidates, no FDR/holdout gate)
- **Validation** — rigorous confirmation (${val.minCandidates}+ candidates, FDR + holdout required)

Hypotheses enter via exploration; only validation-phase evidence counts toward promotion.

## Specialization modes

- **universal** — must survive all major asset behavior groups (large-cap trend + high-beta alt)
- **specialized** — must survive assets sharing similar characteristics within at least one behavior group
- **per_regime** — future: regime-specialized deployment

## Information gain

Features with MI ≥ 0.01 that fail promotion may remain in the **research pool** — they reduce uncertainty even if not production-ready alone.
`;
}
