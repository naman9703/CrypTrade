/**
 * Unexplained Outcome Analysis (UOA) — can remaining variance be explained by available information?
 *
 * Three conclusions: missing information | irreducible randomness | no exploitable relationship
 */
import { mean, num } from "./liqResearchStats.js";
import { UOA_OUTCOMES, UOA_QUESTION } from "./informationHierarchy.js";

const DISCRIMINATING_FEATURES = [
  "cont_score",
  "sweep_velocityAtr",
  "level_importance",
  "marketState_adx",
  "scoreV2_total",
  "weightedQuality",
];

export function analyzeUnexplainedOutcomes(multiDayGroups, outcome = "fwd_closeR_20", pickBy = "expectedUtility") {
  const failures = [];
  const failureModes = {
    score_misrank: 0,
    similar_expected_r: 0,
    oracle_higher_variance: 0,
    regime_mismatch: 0,
    feature_indistinguishable: 0,
  };

  for (const list of multiDayGroups) {
    if (list.length < 2) continue;

    const oracle = [...list].sort((a, b) => num(b[outcome] ?? b.actualR) - num(a[outcome] ?? a.actualR))[0];
    const picked = [...list].sort((a, b) => num(b[pickBy]) - num(a[pickBy]))[0];
    const scorePick = [...list].sort(
      (a, b) => num(b.weightedQuality ?? b.scoreV2_total) - num(a.weightedQuality ?? a.scoreV2_total),
    )[0];

    const correct = oracle.candidateKey === picked.candidateKey;
    if (correct) continue;

    const oracleR = num(oracle[outcome] ?? oracle.actualR);
    const pickedR = num(picked[outcome] ?? picked.actualR);

    const record = {
      symbol: oracle.symbol,
      dayId: oracle.dayId,
      opportunityCost: oracleR != null && pickedR != null ? oracleR - pickedR : null,
      oracleExpectedR: num(oracle.expectedR),
      pickedExpectedR: num(picked.expectedR),
      oracleUncertainty: num(oracle.uncertainty),
      pickedUncertainty: num(picked.uncertainty),
      regime: oracle.marketState_regime,
      featureGaps: {},
    };

    for (const feat of DISCRIMINATING_FEATURES) {
      const ov = num(oracle[feat]);
      const pv = num(picked[feat]);
      if (ov != null && pv != null) record.featureGaps[feat] = ov - pv;
    }

    failures.push(record);

    if (scorePick.candidateKey === picked.candidateKey) failureModes.score_misrank++;
    if (Math.abs(num(oracle.expectedR) - num(picked.expectedR)) < 0.1) failureModes.similar_expected_r++;
    if (num(oracle.uncertainty) > num(picked.uncertainty) * 1.2) failureModes.oracle_higher_variance++;
    if (oracle.marketState_regime && oracle.marketState_regime !== picked.marketState_regime)
      failureModes.regime_mismatch++;

    const gaps = Object.values(record.featureGaps).map(Math.abs);
    if (gaps.length && mean(gaps) < 0.05) failureModes.feature_indistinguishable++;
  }

  const total = multiDayGroups.filter((l) => l.length > 1).length;
  const conclusion = inferUoaConclusion(failureModes, total, failures);

  return {
    experimentFamily: "UOA",
    researchQuestion: UOA_QUESTION,
    multiCandidateDays: total,
    failures: failures.length,
    failureRate: total ? failures.length / total : 0,
    avgOpportunityCost: mean(failures.map((f) => f.opportunityCost)),
    failureModes,
    conclusion,
    hypotheses: buildUoaHypotheses(failureModes, conclusion),
    // backward compat
    experimentFamilyLegacy: "OFA",
  };
}

function inferUoaConclusion(modes, total, failures) {
  const similarRate = total > 0 ? modes.similar_expected_r / total : 0;
  if (similarRate > 0.4) return UOA_OUTCOMES.MISSING_INFORMATION;
  if (modes.feature_indistinguishable > total * 0.5) return UOA_OUTCOMES.NO_EXPLOITABLE_RELATIONSHIP;
  if (failures.length < total * 0.3) return UOA_OUTCOMES.INCONCLUSIVE;
  if (modes.oracle_higher_variance > modes.similar_expected_r) return UOA_OUTCOMES.IRREDUCIBLE_RANDOMNESS;
  return UOA_OUTCOMES.INCONCLUSIVE;
}

function buildUoaHypotheses(modes, conclusion) {
  const h = [];
  if (conclusion === UOA_OUTCOMES.MISSING_INFORMATION) {
    h.push("UOA-001: Unexplained variance at L0–L1 — L2/L3 information may be required (not more L1 features)");
  }
  if (modes.similar_expected_r > 0) {
    h.push("UOA-002: Identical L1 representation, divergent outcomes — test whether L2 improves discrimination");
  }
  if (modes.oracle_higher_variance > 0) {
    h.push("UOA-003: Oracle picks higher-variance — portfolio context may favor tails; not necessarily bad variance");
  }
  const topRegime = modes.regime_mismatch;
  if (topRegime > 0) {
    h.push("UOA-004: Regime mismatch on failure days — regime-conditional information may help");
  }
  return h;
}

/** @deprecated use analyzeUnexplainedOutcomes */
export const analyzeOracleFailures = analyzeUnexplainedOutcomes;
