/**
 * Decision Yield — which research direction improves actual trading decisions?
 * Broader than Information Yield (which measures indicator → candidate ranking only).
 */
export const YIELD_VERDICT = {
  BASELINE: "baseline",
  NONE: "none",
  LOW: "low",
  UNKNOWN: "unknown",
  INSUFFICIENT_DATA: "insufficient_data",
};

/** Four distinct optimization problems. Problem 2 is saturated for current scope only — not closed. */
export const PROBLEM_STATUS = {
  UNTESTED: "untested",
  TEMPORARILY_SATURATED: "temporarily_saturated",
};

export const DECISION_PROBLEMS = {
  ABSTENTION: {
    id: 1,
    name: "Should I trade?",
    type: "binary_classification",
    status: PROBLEM_STATUS.UNTESTED,
  },
  RANKING: {
    id: 2,
    name: "Which trade should I take?",
    type: "ranking",
    status: PROBLEM_STATUS.TEMPORARILY_SATURATED,
    note: "Saturated for tested Families A/C/D and L0–L2 sources — reopens with new data or families",
  },
  SIZING: {
    id: 3,
    name: "How much should I risk?",
    type: "sizing",
    status: PROBLEM_STATUS.UNTESTED,
    note: "Hypothesis — must be validated on holdout; do not assume superiority over ranking",
  },
  ALLOCATION: {
    id: 4,
    name: "How should capital be allocated across strategies?",
    type: "portfolio",
    status: PROBLEM_STATUS.UNTESTED,
    note: "Hypothesis — must be validated on holdout; do not assume superiority over ranking",
  },
};

/** Litmus test for governance — avoid research-about-research. */
export const GOVERNANCE_LITMUS = "Will this change an actual trading decision?";

export const DECISION_YIELD_REGISTRY = [
  {
    researchArea: "Funding (candidate ranking)",
    decisionProblem: "RANKING",
    decisionYield: YIELD_VERDICT.NONE,
    phase: "2b",
    changesTradingDecision: false,
  },
  {
    researchArea: "Open Interest (candidate ranking)",
    decisionProblem: "RANKING",
    decisionYield: YIELD_VERDICT.NONE,
    phase: "2b",
    changesTradingDecision: false,
  },
  {
    researchArea: "Candidate ranking (L0–L2 indicators)",
    decisionProblem: "RANKING",
    decisionYield: YIELD_VERDICT.LOW,
    phase: "2a/2b",
    changesTradingDecision: false,
    note: "Temporarily saturated for tested families and L0–L2 sources",
  },
  {
    researchArea: "Portfolio Policy (allocation lever)",
    decisionProblem: "ALLOCATION",
    decisionYield: YIELD_VERDICT.UNKNOWN,
    backlogId: "PORT-001",
    portfolioLever: "allocation",
    changesTradingDecision: true,
  },
  {
    researchArea: "Portfolio Policy (overlap lever)",
    decisionProblem: "ALLOCATION",
    decisionYield: YIELD_VERDICT.UNKNOWN,
    backlogId: "PORT-002",
    portfolioLever: "overlap",
    changesTradingDecision: true,
  },
  {
    researchArea: "Portfolio Policy (abstention lever)",
    decisionProblem: "ABSTENTION",
    decisionYield: YIELD_VERDICT.UNKNOWN,
    backlogId: "ABST-001",
    portfolioLever: "abstention",
    changesTradingDecision: true,
  },
  {
    researchArea: "Portfolio Policy (sizing lever)",
    decisionProblem: "SIZING",
    decisionYield: YIELD_VERDICT.UNKNOWN,
    backlogId: "SIZE-001",
    portfolioLever: "sizing",
    changesTradingDecision: true,
  },
  {
    researchArea: "L3 order book (candidate ranking)",
    decisionProblem: "RANKING",
    decisionYield: YIELD_VERDICT.UNKNOWN,
    backlogId: "DATA-002",
    changesTradingDecision: null,
    note: "Blocked — no evidence it beats better decision policies",
  },
];

import { PORTFOLIO_LEVER_PROBE_ORDER, portfolioPolicyToMarkdown } from "./portfolioPolicy.js";
import { PLATFORM_PRINCIPLE } from "./phase3Standards.js";

export const PHASE_3_FOCUS =
  "Research → Evidence → Portfolio Decisions → Execution → Performance";

export const PHASE_3_PRIORITY = ["PORT-000", ...PORTFOLIO_LEVER_PROBE_ORDER.map((l) => {
  const ids = { allocation: "PORT-001", overlap: "PORT-002", abstention: "ABST-001", sizing: "SIZE-001" };
  return ids[l];
})];

export function decisionYieldToMarkdown() {
  const lines = [
    "# Decision Yield",
    "",
    "Which research direction improves **trading decisions** — not just candidate ranking?",
    "",
    `> **Litmus:** ${GOVERNANCE_LITMUS}`,
    "",
    "## Decision problems",
    "",
    "| # | Problem | Type | Status |",
    "|---|---------|------|--------|",
  ];
  for (const p of Object.values(DECISION_PROBLEMS)) {
    lines.push(`| ${p.id} | ${p.name} | ${p.type} | ${p.status} |`);
  }
  lines.push(
    "",
    "## Research areas",
    "",
    "| Research area | Decision problem | Decision yield | Changes trading decision? |",
    "|---------------|------------------|----------------|-------------------------|",
  );
  for (const row of DECISION_YIELD_REGISTRY) {
    const changes =
      row.changesTradingDecision === true ? "yes" : row.changesTradingDecision === false ? "no (yet)" : "TBD";
    lines.push(`| ${row.researchArea} | ${row.decisionProblem} | ${row.decisionYield} | ${changes} |`);
  }
  lines.push(
    "",
    portfolioPolicyToMarkdown(),
    "",
    "## Next phase focus",
    "",
    PHASE_3_FOCUS,
    "",
    `> **Platform principle:** ${PLATFORM_PRINCIPLE}`,
    "",
    "**Suggested lever probes:** " + PORTFOLIO_LEVER_PROBE_ORDER.join(" → "),
    "",
    "> Problem 2 reopens with new information sources (L3, options, flows) or new strategy families.",
  );
  return lines.join("\n");
}
