/**
 * Phase 3 roadmap — research objective shifted from entry signals to durable portfolio returns.
 *
 * Do NOT build portfolio optimization (3C+) until independent strategy streams (3A)
 * and portfolio simulator (3B) exist.
 */

export const PHASE_3_RESEARCH_OBJECTIVE =
  "How do I build a portfolio that produces durable returns?";

export const PHASE_3_ARCHIVED_OBJECTIVE =
  "How do I improve Liquidity Sweep / candidate ranking?";

/** Milestone — not a perfect strategy, a credible portfolio. */
export const PHASE_3_MILESTONE =
  "Three independent strategies with modest positive expectancy, combined into a portfolio that outperforms any single strategy on holdout.";

export const PHASE_3_SUBPHASES = [
  {
    id: "3A",
    name: "Baseline strategy families",
    priority: 1,
    backlogIds: ["STRAT-POOL"],
    status: "active",
    blockedBy: null,
    deliverable: "3–5 fixed-rule strategies with basic OOS pass (modest edge OK)",
    doNot: "Heavy optimization, indicator stacking, L2 filter variants",
    candidates: [
      "Trend following (multi-timeframe) — SUPERTREND_ELITE already validates",
      "Mean reversion",
      "Breakout / vol expansion (new formulation)",
      "Pullback continuation",
      "Range trading",
    ],
  },
  {
    id: "3B",
    name: "Portfolio simulator",
    priority: 2,
    backlogIds: ["PORT-SIM"],
    status: "blocked",
    blockedBy: "3A",
    deliverable: "Simulator: active strategies/symbols, exposure, correlation, utilization, equity curve; equal-weight baseline",
  },
  {
    id: "3C",
    name: "PORT-001 — allocation",
    priority: 3,
    backlogIds: ["PORT-001"],
    status: "blocked",
    blockedBy: "3B",
    hypothesis: "Dynamic allocation vs equal-weight (holdout)",
    baselines: ["Equal-weight", "Static allocation"],
  },
  {
    id: "3D",
    name: "PORT-002 — overlap",
    priority: 4,
    backlogIds: ["PORT-002"],
    status: "blocked",
    blockedBy: "3C",
    hypothesis: "Overlap-aware exposure vs naive independent signals (holdout)",
  },
  {
    id: "3E",
    name: "ABST-001 — abstention",
    priority: 5,
    backlogIds: ["ABST-001"],
    status: "blocked",
    blockedBy: "3D",
    hypothesis: "Evidence-based skip vs always-trade (holdout)",
  },
  {
    id: "3F",
    name: "SIZE-001 — sizing",
    priority: 6,
    backlogIds: ["SIZE-001"],
    status: "blocked",
    blockedBy: "3E",
    hypothesis: "Adaptive sizing vs fixed-fraction (holdout); last — overfit-prone",
  },
];

/** Families A/C/D — archived as standalone production candidates after Phase 2. */
export const ARCHIVED_FALSIFICATION_FAMILIES = ["A", "C", "D"];

export const PHASE_3_DO_NOT = [
  "RSI/EMA filter stacking on rejected families",
  "OI/funding variants for candidate ranking",
  "More liquidity sweep refinements",
  "L3 order book until 3A–3F complete",
  "Portfolio optimization before 3B simulator exists",
];

export function phase3RoadmapToMarkdown() {
  const lines = [
    "# Phase 3 Roadmap",
    "",
    `**Objective:** ${PHASE_3_RESEARCH_OBJECTIVE}`,
    "",
    `**Milestone:** ${PHASE_3_MILESTONE}`,
    "",
    "| Phase | Name | Status | Deliverable |",
    "|-------|------|--------|-------------|",
  ];
  for (const p of PHASE_3_SUBPHASES) {
    lines.push(`| ${p.id} | ${p.name} | ${p.status} | ${p.deliverable ?? p.hypothesis} |`);
  }
  lines.push(
    "",
    "## Do not (Phase 2 showed low ROI)",
    "",
    ...PHASE_3_DO_NOT.map((s) => `- ${s}`),
    "",
    "## Parallel track",
    "",
    "Continue testing new strategy families (weeks not months). Archive failures. SUPERTREND_ELITE can deploy while 3A proceeds.",
  );
  return lines.join("\n");
}
