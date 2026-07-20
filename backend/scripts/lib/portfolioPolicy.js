/**
 * Portfolio Policy — one object, many levers.
 * Optimize the portfolio, not isolated policies. Levers are coupled controls, not sequential goals.
 */

/** Ultimate baseline — every future policy must beat this on holdout. */
export const NULL_POLICY = {
  id: "null",
  name: "Null Policy",
  description: "No portfolio optimization — every strategy trades independently",
  allocation: "independent",
  overlap: "ignored",
  abstention: "none",
  sizing: "per-strategy default",
  exposure: "unmanaged",
  riskBudget: "none",
};

/**
 * Portfolio Policy — the single object institutions optimize.
 * Levers are controls acting on one system; changing one lever affects the others.
 */
export const PORTFOLIO_POLICY_LEVERS = {
  allocation: {
    id: "allocation",
    label: "Allocation",
    backlogId: "PORT-001",
    question: "How is capital distributed across strategies?",
    incrementalBaseline: "Equal-weight",
    exampleExperiment: "Equal-weight vs risk-parity (one week, holdout, conclude)",
  },
  overlap: {
    id: "overlap",
    label: "Overlap",
    backlogId: "PORT-002",
    question: "How are correlated exposures across strategies netted?",
    incrementalBaseline: "Independent signals (naive summation)",
    exampleExperiment: "Overlap ON vs OFF (one week, holdout, conclude)",
  },
  abstention: {
    id: "abstention",
    label: "Abstention",
    backlogId: "ABST-001",
    question: "When is capital deployed at all?",
    incrementalBaseline: "Always trade",
    exampleExperiment: "Abstention gate vs always-trade (one week, holdout, conclude)",
  },
  sizing: {
    id: "sizing",
    label: "Sizing",
    backlogId: "SIZE-001",
    question: "How much capital per position?",
    incrementalBaseline: "Fixed-fraction risk",
    exampleExperiment: "Fixed-fraction vs adaptive sizing (one week, holdout, conclude)",
  },
  exposure: {
    id: "exposure",
    label: "Exposure",
    backlogId: null,
    question: "What is aggregate net exposure by asset and direction?",
    incrementalBaseline: "Unmanaged (sum of strategy exposures)",
    exampleExperiment: "Exposure cap vs uncapped (incremental)",
  },
  riskBudget: {
    id: "riskBudget",
    label: "Risk Budget",
    backlogId: null,
    question: "How much total capital is at risk at any time?",
    incrementalBaseline: "No portfolio-level risk cap",
    exampleExperiment: "Portfolio risk cap vs none (incremental)",
  },
};

/** Suggested experiment order — controls to probe, not a waterfall roadmap. */
export const PORTFOLIO_LEVER_PROBE_ORDER = ["allocation", "overlap", "abstention", "sizing"];

export const PHASE_3_OBJECTIVE =
  "What portfolio policy maximizes risk-adjusted return? (Not: is Kelly sizing better?)";

export function portfolioPolicyToMarkdown() {
  const lines = [
    "# Portfolio Policy",
    "",
    "Optimize the **portfolio**, not isolated policies. All levers act on one coupled system.",
    "",
    `**Objective:** ${PHASE_3_OBJECTIVE}`,
    "",
    "## Null Policy (ultimate baseline)",
    "",
    NULL_POLICY.description + ". Every proposed policy must beat Null Policy on holdout.",
    "",
    "## Levers",
    "",
    "| Lever | Question | Incremental baseline | Backlog |",
    "|-------|----------|----------------------|---------|",
  ];
  for (const lever of Object.values(PORTFOLIO_POLICY_LEVERS)) {
    lines.push(
      `| ${lever.label} | ${lever.question} | ${lever.incrementalBaseline} | ${lever.backlogId ?? "—"} |`,
    );
  }
  lines.push(
    "",
    "> Allocation, overlap, abstention, and sizing are **controls**, not goals. Changing overlap changes effective allocation.",
  );
  return lines.join("\n");
}
