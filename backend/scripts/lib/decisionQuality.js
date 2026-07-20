/**
 * Decision Quality — process standard for each decision type.
 * Yield measures outcomes; quality measures whether the decision process was sound.
 */
import { GOVERNANCE_LITMUS } from "./decisionYield.js";
import { portfolioPolicyToMarkdown } from "./portfolioPolicy.js";
import {
  PHASE_3_DUAL_REPORTING_RULE,
  PHASE_3_VALUE_STANDARD,
  PLATFORM_PRINCIPLE,
  phase3StandardsToMarkdown,
} from "./phase3Standards.js";

export const DECISION_QUALITY_DIMENSIONS = [
  {
    decision: "Trade / No trade",
    problem: "ABSTENTION",
    qualityQuestion: "Was the trade/no-trade decision supported by evidence?",
    validationRequired: true,
  },
  {
    decision: "Which candidate",
    problem: "RANKING",
    qualityQuestion: "Was candidate selection supported by holdout discrimination evidence?",
    validationRequired: true,
  },
  {
    decision: "Position size",
    problem: "SIZING",
    qualityQuestion: "Was the position sized appropriately for uncertainty?",
    validationRequired: true,
    note: "Do not assume dynamic sizing helps — test on holdout",
  },
  {
    decision: "Capital allocation",
    problem: "ALLOCATION",
    qualityQuestion: "Was capital allocated optimally given available information?",
    validationRequired: true,
    note: "Do not assume allocation dominates — test on holdout",
  },
];

/** Same validation discipline as Phase 2 — hypotheses must earn conclusions. */
export const PHASE_3_SCIENTIFIC_STANDARD = PLATFORM_PRINCIPLE + " " + PHASE_3_DUAL_REPORTING_RULE;

export function decisionQualityToMarkdown() {
  const lines = [
    "# Decision Quality",
    "",
    "Yield is an **outcome** (did research improve decisions?). Quality is a **process** (was each decision sound?).",
    "",
    `> **Litmus:** ${GOVERNANCE_LITMUS}`,
    "",
    "| Decision | Quality question |",
    "|----------|------------------|",
  ];
  for (const row of DECISION_QUALITY_DIMENSIONS) {
    lines.push(`| ${row.decision} | ${row.qualityQuestion} |`);
  }
  lines.push(
    "",
    "## Scientific standard (Phase 3)",
    "",
    PHASE_3_SCIENTIFIC_STANDARD,
    "",
    PHASE_3_VALUE_STANDARD,
    "",
    portfolioPolicyToMarkdown(),
    "",
    phase3StandardsToMarkdown(),
  );
  return lines.join("\n");
}
