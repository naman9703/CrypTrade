/**
 * Phase 3 experiment standards — portfolio-level optimization, baselines, incremental falsification.
 */
import { NULL_POLICY } from "./portfolioPolicy.js";

/** Platform principle — elevated from baseline rule. Prevents local optimization. */
export const PLATFORM_PRINCIPLE =
  "Every proposed policy must demonstrate incremental value over a simpler baseline within the context of the complete portfolio.";

/** @deprecated use PLATFORM_PRINCIPLE */
export const PHASE_3_BASELINE_RULE = PLATFORM_PRINCIPLE;

export const PHASE_3_POLICY_BASELINES = [
  {
    lever: "null",
    name: "Null Policy",
    baseline: NULL_POLICY.description,
    rightQuestion: "Does this policy beat independent strategy trading on holdout portfolio metrics?",
    isUltimateBaseline: true,
  },
  {
    lever: "allocation",
    backlogId: "PORT-001",
    name: "Equal-weight",
    baseline: "Equal-weight allocation across strategies",
    wrongQuestion: "Did dynamic allocation make money?",
    rightQuestion: "Did dynamic allocation outperform equal-weight on holdout?",
  },
  {
    lever: "overlap",
    backlogId: "PORT-002",
    name: "Independent signals",
    baseline: "Treat each strategy signal as independent exposure",
    wrongQuestion: "Did we detect overlap?",
    rightQuestion: "Does overlap-aware exposure improve portfolio metrics vs naive summation on holdout?",
  },
  {
    lever: "abstention",
    backlogId: "ABST-001",
    name: "Always trade",
    baseline: "Always trade (no abstention gate)",
    wrongQuestion: "Did abstention reduce drawdown?",
    rightQuestion: "Did abstention improve portfolio expectancy vs always trading on holdout?",
  },
  {
    lever: "sizing",
    backlogId: "SIZE-001",
    name: "Fixed-fraction",
    baseline: "Fixed-fraction risk per trade (same strategies)",
    wrongQuestion: "Did adaptive sizing increase CAGR?",
    rightQuestion: "Did adaptive sizing outperform fixed-fraction on holdout?",
  },
];

export const PHASE_3_STATISTICAL_METRICS = [
  "return",
  "profit_factor",
  "calmar",
  "max_drawdown",
  "sharpe",
  "expectancy",
];

export const PHASE_3_OPERATIONAL_METRICS = [
  "trades_skipped",
  "avg_capital_utilization",
  "avg_exposure",
  "turnover",
  "portfolio_concentration",
];

export const PHASE_3_DUAL_REPORTING_RULE =
  "Every experiment reports statistical AND operational improvement vs baseline. Lower return with lower drawdown may still be valuable.";

/** Small, falsifiable hypotheses — avoid multi-month optimization cycles before conclusions. */
export const PHASE_3_INCREMENTAL_EXPERIMENTS = [
  { week: 1, hypothesis: "Equal-weight vs risk-parity allocation", lever: "allocation" },
  { week: 2, hypothesis: "Overlap netting ON vs OFF", lever: "overlap" },
  { week: 3, hypothesis: "Abstention gate vs always-trade", lever: "abstention" },
  { week: 4, hypothesis: "Fixed-fraction vs adaptive sizing", lever: "sizing" },
];

export const PHASE_3_VALUE_STANDARD =
  "Phase 3 is valuable when it demonstrably improves trading decisions and portfolio outcomes vs a simpler alternative — not merely when experiments are disciplined.";

export function phase3StandardsToMarkdown() {
  const lines = [
    "# Phase 3 Experiment Standards",
    "",
    "## Platform principle",
    "",
    PLATFORM_PRINCIPLE,
    "",
    "## Baselines",
    "",
    "| Lever | Baseline | Right question |",
    "|-------|----------|----------------|",
  ];
  for (const row of PHASE_3_POLICY_BASELINES) {
    lines.push(`| ${row.lever} | ${row.baseline} | ${row.rightQuestion} |`);
  }
  lines.push(
    "",
    "## Dual reporting",
    "",
    PHASE_3_DUAL_REPORTING_RULE,
    "",
    "**Statistical:** " + PHASE_3_STATISTICAL_METRICS.join(", "),
    "",
    "**Operational:** " + PHASE_3_OPERATIONAL_METRICS.join(", "),
    "",
    "## Incremental experiments",
    "",
    "One hypothesis per cycle. Conclude. Next. Do not run a five-month optimization before any result.",
    "",
    "| Cycle | Hypothesis |",
    "|-------|------------|",
  );
  for (const ex of PHASE_3_INCREMENTAL_EXPERIMENTS) {
    lines.push(`| Week ${ex.week} | ${ex.hypothesis} |`);
  }
  lines.push("", "## Value standard", "", PHASE_3_VALUE_STANDARD);
  return lines.join("\n");
}
