/**
 * FALS-001 interpretation — four plausible explanations, not a single forced verdict.
 */
export const FALS_001_QUESTION =
  "Is current observable information sufficient to justify continued L0–L1 research?";

export const FALS_OUTCOMES = {
  /** Primary outcome when all price-derived families fail promotion — does not assume Case B. */
  NO_PRICE_DERIVED_PROMOTION: "no_price_derived_family_promotion",
  L01_SUFFICIENT_FOR_SOME: "l01_sufficient_for_some_families",
  CASE_A_INSUFFICIENT_INFO: "case_a_insufficient_information",
  CASE_B_WEAK_FORMULATION: "case_b_weak_formulation",
  CASE_C_TIMEFRAME_UNIVERSE: "case_c_timeframe_or_universe",
  CASE_D_LITTLE_EDGE: "case_d_little_exploitable_edge",
  CASE_MIXED: "case_mixed",
  INCONCLUSIVE: "inconclusive",
};

export const FALS_001_SUMMARY_NO_PROMOTION =
  "No L0–L2 (price-derived) hypothesis family achieved promotion under the current validation framework. " +
  "The next evidence-based research step is to evaluate whether additional observable information " +
  "(Open Interest and Funding) improves decision quality before considering higher-cost market microstructure data.";

const PLAUSIBLE_EXPLANATIONS = [
  "Weak formulation — implementations may be poor (not ruled out)",
  "Insufficient observable information — all families used price-derived features; OI/funding (L2) untested",
  "Validation conservatism — strict promotion gates increase false negatives; no promotion ≠ no signal",
  "Market/timeframe dependence — phenomenon may exist on different horizon or universe",
];

/**
 * Interpret FALS-001 results across families tested at L0–L1.
 */
export function interpretFalsificationResults(results = {}) {
  const {
    familyAResult = "failed",
    familyCResult = null,
    familyDResult = null,
    familiesTested = 0,
    familiesPassed = 0,
    anyHoldoutSlicePositive = false,
    testedTimeframe = "15m",
    testedUniverse = "crypto_futures",
    runParity = null,
    priceDerivedFamiliesFailed = 3,
  } = results;

  const falsComplete = familiesTested >= 3 && familyCResult != null && familyDResult != null;
  const allPriceDerivedFailed = familiesPassed === 0 && priceDerivedFamiliesFailed >= 3;
  const onePassed = familiesPassed >= 1;

  if (!falsComplete && familiesTested < 2) {
    return {
      question: FALS_001_QUESTION,
      outcome: FALS_OUTCOMES.INCONCLUSIVE,
      summary: "FALS-001 incomplete — run Families C and D through validation pipeline",
      interpretations: ["Await falsification families C and D"],
      nextSteps: [{ action: "Complete FALS-002 and FALS-003", priority: 1 }],
      sufficientForContinuedL01Research: null,
      phase: "2a_in_progress",
    };
  }

  if (onePassed) {
    return {
      question: FALS_001_QUESTION,
      outcome: FALS_OUTCOMES.L01_SUFFICIENT_FOR_SOME,
      summary: "L0–L1 information IS sufficient for at least one unrelated family — continue L0–L1 research on successful formulation",
      interpretations: [
        "At least one price-derived family passed — Family A limitation may be formulation-specific",
      ],
      nextSteps: [
        { action: "Pursue successful family; reformulate failed families before richer data", priority: 1 },
      ],
      sufficientForContinuedL01Research: true,
      phase: "2a_complete",
    };
  }

  if (allPriceDerivedFailed) {
    const interpretations = [
      "Evidence is insufficient to distinguish between the plausible explanations below — do not assume a single cause",
      ...PLAUSIBLE_EXPLANATIONS.map((e) => `- ${e}`),
    ];

    if (anyHoldoutSlicePositive) {
      interpretations.push(
        "Some holdout slices showed weak signal — consistent with validation conservatism or weak formulation, not uniquely insufficient information",
      );
    }

    if (runParity && !runParity.parityWithFamilyA) {
      interpretations.push(
        `Run parity with Family A baseline not confirmed (${JSON.stringify(runParity.checks)}) — treat C/D as provisional until full parity rerun`,
      );
    }

    interpretations.push(
      `Case C always possible: phenomenon may exist on different timeframe than ${testedTimeframe} or outside ${testedUniverse}`,
    );

    const nextSteps = [
      {
        action: "Integrate free L2: OI + funding — genuinely new information, not another OHLCV transform",
        priority: 1,
      },
      {
        action: "Retest price-derived families with L2 features before any L3 microstructure investment",
        priority: 2,
      },
      {
        action: "Only consider L3 historical order book if OI/funding measurably improve discrimination",
        priority: 3,
      },
    ];

    return {
      question: FALS_001_QUESTION,
      outcome: FALS_OUTCOMES.NO_PRICE_DERIVED_PROMOTION,
      summary: FALS_001_SUMMARY_NO_PROMOTION,
      interpretations,
      nextSteps,
      sufficientForContinuedL01Research: false,
      sufficientForContinuedPriceDerivedResearch: false,
      phase: "2a_complete",
      endOfPhase2a: true,
      nextPhase: "2b_l2_oi_funding",
      cases: {
        weakFormulation: "plausible — not uniquely identified",
        insufficientInformation: "plausible — L2 OI/funding untested",
        validationConservatism: "plausible — no promotion ≠ no signal",
        marketTimeframeDependence: "plausible — alternate horizon/universe",
        littleExploitableEdge: "possible — legitimate scientific outcome",
      },
      families: { A: familyAResult, C: familyCResult, D: familyDResult },
      runParity,
    };
  }

  return {
    question: FALS_001_QUESTION,
    outcome: FALS_OUTCOMES.INCONCLUSIVE,
    summary: "FALS-001 incomplete",
    interpretations: [],
    nextSteps: [],
  };
}

export function falsificationToMarkdown(result) {
  const lines = [
    "# FALS-001 Interpretation",
    "",
    `**Question:** ${result.question}`,
    "",
    `**Outcome:** ${result.outcome}`,
    "",
    result.summary,
    "",
    "## Interpretations",
    "",
    ...result.interpretations.map((i) => (i.startsWith("-") ? i : `- ${i}`)),
  ];
  if (result.cases) {
    lines.push("", "## Plausible explanations (not mutually exclusive)", "", "| Explanation | Status |", "|-------------|--------|");
    for (const [k, v] of Object.entries(result.cases)) {
      lines.push(`| ${k} | ${v} |`);
    }
  }
  if (result.runParity) {
    lines.push(
      "",
      "## Run parity (Family A baseline)",
      "",
      `Parity confirmed: **${result.runParity.parityWithFamilyA ? "yes" : "no — provisional"}**`,
      "",
      `Checks: ${JSON.stringify(result.runParity.checks)}`,
    );
  }
  if (result.nextSteps?.length) {
    lines.push("", "## Next steps", "");
    for (const s of result.nextSteps) {
      lines.push(`${s.priority}. ${s.action}`);
    }
  }
  if (result.phase) {
    lines.push("", `**Phase:** ${result.phase}${result.nextPhase ? ` → next: ${result.nextPhase}` : ""}`);
  }
  return lines.join("\n");
}
