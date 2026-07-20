/**
 * Hypothesis families — widen research beyond single liquidity implementation.
 */
import { evaluateExitCriteria } from "./researchExitCriteria.js";
import {
  FAMILY_LIFECYCLE,
  classifyNegativeResult,
  lifecycleLabel,
} from "./familyLifecycle.js";

export { FAMILY_LIFECYCLE, lifecycleLabel };

export const HYPOTHESIS_FAMILIES = {
  A_LIQ_CONTINUATION: {
    id: "A",
    name: "Liquidity continuation",
    description: "Sweep → reclaim → continuation (current classical LIQ)",
    status: FAMILY_LIFECYCLE.ARCHIVED,
    experiments: ["EXP-001", "EXP-002", "EXP-003", "EXP-004", "EXP-006"],
    minPromotedFeatures: 1,
    productionObjective: "universal",
    informationLevels: ["L0", "L1", "L2"],
    negativeResult: {
      verdict: "archived_standalone_production",
      testedLevels: ["L0", "L1", "L2"],
      result: "No promotion at L0–L1; Phase 2b L2 (funding/OI) no discrimination improvement",
      nextTestLevels: [],
      nextTestAction: "Archived — use platform for new families, not LIQ refinements",
      scientificStatement:
        "Liquidity continuation cannot be distinguished at promotion gates with tested L0–L2 information.",
      confirmedAt: "2026-07-11",
    },
  },
  B_LIQ_REVERSAL: {
    id: "B",
    name: "Liquidity reversal",
    description: "Certain sweeps are exhaustion — fade continuation, test reversal forward paths",
    status: "planned",
    experiments: [],
    minPromotedFeatures: 1,
    productionObjective: "universal",
  },
  C_TREND_CONTINUATION: {
    id: "C",
    name: "Trend continuation",
    description: "Independent of liquidity — trend pullback, HTF alignment",
    status: FAMILY_LIFECYCLE.ARCHIVED,
    experiments: ["EXP-C01", "EXP-C02", "EXP-C03", "EXP-C04", "EXP-C05", "EXP-C06"],
    minPromotedFeatures: 1,
    productionObjective: "per_coin",
    informationLevels: ["L0", "L1", "L2"],
    negativeResult: {
      verdict: "archived_standalone_production",
      testedLevels: ["L0", "L1", "L2"],
      result: "No promotion at L0–L1; Phase 2b no L2 discrimination gain",
      nextTestLevels: [],
      nextTestAction: "Archived — candidate harvester remains for falsification only",
      scientificStatement:
        "Trend acceleration harvester did not achieve promotion with tested observable information.",
      confirmedAt: "2026-07-11",
    },
  },
  D_VOL_EXPANSION: {
    id: "D",
    name: "Volatility expansion",
    description: "Trade regime vol expansion/compression transitions",
    status: FAMILY_LIFECYCLE.ARCHIVED,
    experiments: ["EXP-D01", "EXP-D02", "EXP-D03", "EXP-D04", "EXP-D05", "EXP-D06"],
    minPromotedFeatures: 1,
    productionObjective: "universal",
    informationLevels: ["L0", "L1", "L2"],
    negativeResult: {
      verdict: "archived_standalone_production",
      testedLevels: ["L0", "L1", "L2"],
      result: "No promotion at L0–L1; Phase 2b no L2 discrimination gain",
      nextTestLevels: [],
      nextTestAction: "Archived — try different vol formulation as new family if at all",
      scientificStatement:
        "Volatility expansion harvester did not achieve promotion with tested observable information.",
      confirmedAt: "2026-07-11",
    },
  },
  E_MEAN_REVERSION: {
    id: "E",
    name: "Mean reversion",
    description: "Independent MR hypothesis family",
    status: "planned",
    experiments: [],
    minPromotedFeatures: 1,
    productionObjective: "universal",
  },
};

export const SPECIALIZATION_MODE = {
  UNIVERSAL: "universal",
  PER_COIN: "per_coin",
  PER_REGIME: "per_regime",
};

/**
 * Verdict: does this hypothesis family deserve production consideration?
 */
export function evaluateFamilyVerdict(family, experimentResults, promotedFeatures = [], opts = {}) {
  const { runParity = null } = opts;
  const familyExps = experimentResults.filter((r) =>
    (family.experiments ?? []).includes(r.id),
  );
  const accepted = familyExps.filter((r) => r.accepted === true);
  const partial = familyExps.filter((r) => r.accepted === "partial");

  const holdoutFailures = familyExps.filter(
    (e) => e.holdout?.monotonicity != null && e.holdout.monotonicity <= 0,
  ).length;
  const coinSlices = familyExps.flatMap((e) => Object.values(e.slices?.coin?.slices ?? {}));
  const assetStabilityRatio = coinSlices.length
    ? coinSlices.filter((s) => (s.monotonicity ?? 0) > 0).length / coinSlices.length
    : 0;

  const exit = evaluateExitCriteria(family, {
    experimentsRun: familyExps.length,
    promotedFeatures: promotedFeatures.length,
    holdoutFailures,
    assetStabilityRatio,
    maxInformationGain: 0.01,
    researchCycles: 1,
    manualStatus: family.status,
  });

  const lifecycleStatus = classifyNegativeResult({
    parityWithFamilyA: runParity?.parityWithFamilyA ?? false,
    promoted: promotedFeatures.length + accepted.length,
    experimentsRun: familyExps.length,
  });

  let verdict = "insufficient_evidence";
  let recommendation = "Continue research or freeze family";

  if (family.status === FAMILY_LIFECYCLE.ARCHIVED || exit.shouldArchive && family.status === FAMILY_LIFECYCLE.ARCHIVED) {
    verdict = FAMILY_LIFECYCLE.ARCHIVED;
    recommendation = exit.recommendation;
  } else if (promotedFeatures.length >= family.minPromotedFeatures) {
    verdict = FAMILY_LIFECYCLE.PRODUCTION_CANDIDATE;
    recommendation = "Family has promoted features — proceed to experimental layer";
  } else if (accepted.length > 0) {
    verdict = FAMILY_LIFECYCLE.PROMISING;
    recommendation = "Some hypotheses accepted — deepen validation before production";
  } else if (
    familyExps.length >= 3 &&
    accepted.length === 0 &&
    lifecycleStatus === FAMILY_LIFECYCLE.PROVISIONAL_NEGATIVE
  ) {
    verdict = FAMILY_LIFECYCLE.PROVISIONAL_NEGATIVE;
    recommendation =
      "Provisional negative — failed promotion; confirm on full parity run (same universe, window, data source as Family A) before confirmed negative";
  } else if (
    familyExps.length >= 3 &&
    accepted.length === 0 &&
    lifecycleStatus === FAMILY_LIFECYCLE.CONFIRMED_NEGATIVE
  ) {
    verdict = FAMILY_LIFECYCLE.CONFIRMED_NEGATIVE;
    recommendation =
      "Confirmed negative at tested information levels — not archived; retest with L2 OI/funding before closing family";
  } else if (partial.length > 0 && familyExps.length >= 3) {
    verdict = "weak_signal";
    recommendation = "Partial signals only — do not promote; validation conservatism possible";
  } else if (familyExps.length >= 3 && accepted.length === 0) {
    verdict = "family_reject";
    recommendation = "Zero hypotheses survive promotion — widen to other families or new information levels";
  }

  return {
    familyId: family.id,
    familyName: family.name,
    status: family.status,
    lifecycle: lifecycleStatus,
    lifecycleLabel: lifecycleLabel(lifecycleStatus),
    experimentsRun: familyExps.length,
    accepted: accepted.length,
    partial: partial.length,
    promotedFeatures: promotedFeatures.length,
    verdict,
    recommendation,
    exit,
    productionObjective: family.productionObjective,
    runParity,
  };
}

export function familiesToMarkdown(verdicts) {
  const lines = [
    "# Hypothesis Family Verdicts",
    "",
    "| Family | Lifecycle | Experiments | Accepted | Verdict | Recommendation |",
    "|--------|-----------|-------------|----------|---------|----------------|",
  ];
  for (const v of verdicts) {
    lines.push(
      `| ${v.familyName} | ${v.lifecycleLabel ?? v.status} | ${v.experimentsRun} | ${v.accepted} | **${v.verdict}** | ${v.recommendation} |`,
    );
  }
  lines.push(
    "",
    "## Note",
    "",
    "Confirmed negative ≠ archived. Families remain open for L2 OI/funding retest.",
    "No promotion under strict gates ≠ no signal (validation conservatism).",
  );
  return lines.join("\n");
}
