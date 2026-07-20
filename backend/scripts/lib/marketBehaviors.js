/**
 * Market behaviors — hypotheses about how price moves, not strategy implementations.
 * Strategies are implementations that exploit validated behaviors.
 */

export const MARKET_BEHAVIORS = {
  LIQUIDITY_REMOVAL: {
    id: "liquidity_removal",
    name: "Liquidity removal",
    description: "Price sweeps external/internal liquidity pools then reacts",
    status: "research_frozen",
    implementations: ["INTRADAY_PRO_LIQ", "LIQ_MAP"],
    experiments: ["EXP-001", "EXP-002", "EXP-003", "EXP-004", "EXP-006"],
  },
  POST_SWEEP_CONTINUATION: {
    id: "post_sweep_continuation",
    name: "Post-sweep continuation",
    description: "After reclaim, price continues toward opposing liquidity",
    status: "weak_signal",
    parent: "liquidity_removal",
    experiments: ["EXP-001", "EXP-004"],
  },
  POST_SWEEP_REVERSAL: {
    id: "post_sweep_reversal",
    name: "Post-sweep reversal",
    description: "Sweep is exhaustion — fade continuation expectation",
    status: "planned",
    parent: "liquidity_removal",
    experiments: [],
  },
  TREND_ACCELERATION: {
    id: "trend_acceleration",
    name: "Trend acceleration",
    description: "Pullback in established trend resumes directional move",
    status: "planned",
    implementations: ["TREND_PULLBACK", "SUPERTREND_ELITE"],
    experiments: [],
  },
  VOLATILITY_COMPRESSION: {
    id: "volatility_compression",
    name: "Volatility compression",
    description: "Compressed range precedes expansion — trade regime transition",
    status: "planned",
    experiments: [],
  },
  BREAKOUT_FAILURE: {
    id: "breakout_failure",
    name: "Breakout failure",
    description: "Failed breakout returns into range — mean reversion behavior",
    status: "planned",
    experiments: [],
  },
  MEAN_REVERSION: {
    id: "mean_reversion",
    name: "Mean reversion",
    description: "Extension from fair value reverts",
    status: "planned",
    experiments: [],
  },
};

export const PLATFORM_NAME = "Market Decision Research Platform";

export const PRIMARY_OBJECTIVE =
  "Better decision quality on unseen data — not Family A success, not backtest CAGR.";

export const PROGRESS_METRICS = [
  "Did the platform correctly reject a weak hypothesis?",
  "Did a reproducible effect survive holdout testing?",
  "Did research reduce uncertainty about market behavior?",
  "Did decision quality improve on unseen data?",
];

export const PHASE2_PIPELINE = [
  "hypothesis",
  "candidate_generation",
  "evidence_collection",
  "statistical_validation",
  "distributional_outcome_estimation",
  "decision_policy",
  "portfolio_simulation",
  "capital_allocation",
  "execution",
];

export function behaviorVerdict(behavior, experimentResults) {
  const exps = experimentResults.filter((r) => (behavior.experiments ?? []).includes(r.id));
  const accepted = exps.filter((r) => r.accepted === true).length;
  const partial = exps.filter((r) => r.accepted === "partial").length;
  let verdict = "insufficient_evidence";
  if (accepted > 0) verdict = "validated";
  else if (partial > 0 && exps.length >= 2) verdict = "weak_signal";
  else if (exps.length >= 3 && accepted === 0) verdict = "behavior_reject";
  return { behaviorId: behavior.id, name: behavior.name, experiments: exps.length, accepted, partial, verdict };
}
