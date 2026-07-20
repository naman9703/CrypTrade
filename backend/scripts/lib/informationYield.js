/**
 * Information Yield — subset of Decision Yield for observable data sources (Problem 2: ranking).
 * @see decisionYield.js for the full decision-theory framework.
 */
import { YIELD_VERDICT } from "./decisionYield.js";

export { YIELD_VERDICT };

export const INFORMATION_YIELD_REGISTRY = [
  {
    source: "OHLCV (L0)",
    cost: "low",
    acquisitionCost: "free",
    incrementalDecisionQuality: YIELD_VERDICT.BASELINE,
    discriminationSpearman: null,
    familiesTested: ["A", "C", "D"],
    note: "Baseline — no production-grade candidate-ranking edge found",
  },
  {
    source: "Derived price features (L1)",
    cost: "low",
    acquisitionCost: "free",
    incrementalDecisionQuality: YIELD_VERDICT.NONE,
    discriminationSpearman: "~0",
    familiesTested: ["A", "C", "D"],
    note: "Phase 2a falsification — re-expressing L0 does not add information",
  },
  {
    source: "Binance funding (L2)",
    cost: "low",
    acquisitionCost: "free",
    incrementalDecisionQuality: YIELD_VERDICT.NONE,
    discriminationSpearman: "0.00–0.08",
    familiesTested: ["A", "C", "D"],
    validationPhase: "2b",
    archivedProposition: "8h funding improves 15m candidate ranking",
    note: "Full 2022–2026 coverage — rigorous negative result",
  },
  {
    source: "Binance OI (L2 native)",
    cost: "low",
    acquisitionCost: "free",
    incrementalDecisionQuality: YIELD_VERDICT.INSUFFICIENT_DATA,
    discriminationSpearman: null,
    familiesTested: ["A", "C", "D"],
    validationPhase: "2b",
    note: "~30d API window — conclusions deferred on native Binance OI",
  },
  {
    source: "Bybit OI/L-S (L2 proxy)",
    cost: "medium",
    acquisitionCost: "free",
    incrementalDecisionQuality: YIELD_VERDICT.NONE,
    discriminationSpearman: "0.00–0.05",
    familiesTested: ["A", "C", "D"],
    validationPhase: "2b",
    note: "100% proxy coverage — no candidate-ranking improvement; asset-dependent proxy fidelity",
  },
  {
    source: "Order book (L3)",
    cost: "very_high",
    acquisitionCost: "paid",
    incrementalDecisionQuality: YIELD_VERDICT.UNKNOWN,
    discriminationSpearman: null,
    familiesTested: [],
    note: "Not justified by L2 negatives alone — evaluate only with explicit hypothesis",
  },
  {
    source: "Liquidations",
    cost: "high",
    acquisitionCost: "partial",
    incrementalDecisionQuality: YIELD_VERDICT.UNKNOWN,
    discriminationSpearman: null,
    familiesTested: [],
    note: "Untested — different use case than candidate ranking",
  },
];

/** Scoped falsification — not a blanket rejection of all observable information. */
export const PHASE_2B_FALSIFIED_PROPOSITION =
  "For Families A (Liquidity Continuation), C (Trend Acceleration), and D (Volatility Expansion), " +
  "adding Binance funding and Bybit-proxy open interest did not materially improve candidate " +
  "discrimination under the current holdout validation framework.";

export const PHASE_2B_NOT_FALSIFIED = [
  "Liquidation imbalance",
  "Options-implied volatility",
  "Cross-exchange basis",
  "Cross-asset / stablecoin / ETF flows",
  "Macro regime",
  "News/sentiment",
  "Other strategy families or optimization targets (sizing, abstention, portfolio)",
];

export function informationYieldToMarkdown() {
  const lines = [
    "# Information Yield",
    "",
    "Cost vs incremental decision quality for candidate ranking (Families A/C/D).",
    "",
    "| Source | Cost | Incremental decision quality | Spearman (best) | Status |",
    "|--------|------|------------------------------|-----------------|--------|",
  ];
  for (const row of INFORMATION_YIELD_REGISTRY) {
    const spearman = row.discriminationSpearman ?? "—";
    const status = row.incrementalDecisionQuality;
    lines.push(`| ${row.source} | ${row.cost} | ${status} | ${spearman} | ${row.note?.slice(0, 50) ?? "—"}… |`);
  }
  lines.push(
    "",
    "## Falsified (scoped)",
    "",
    PHASE_2B_FALSIFIED_PROPOSITION,
    "",
    "## Not falsified (remains open)",
    "",
    ...PHASE_2B_NOT_FALSIFIED.map((s) => `- ${s}`),
  );
  return lines.join("\n");
}
