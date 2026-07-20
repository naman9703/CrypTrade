/**
 * Research backlog ranked by expected information gain — not expected return.
 */
export const INFORMATION_GAIN_TIERS = {
  HIGH: "high",
  VERY_HIGH: "very_high",
  MEDIUM: "medium",
  LOW: "low",
};

export const DEFAULT_RESEARCH_BACKLOG = [
  {
    id: "FALS-001",
    title: "Is L0–L1 observable information sufficient to justify continued research?",
    category: "falsification",
    informationLevels: ["L0", "L1"],
    informationLatency: "candle_close",
    informationGain: INFORMATION_GAIN_TIERS.VERY_HIGH,
    phase: "validation",
    rationale:
      "Neutral question — four outcomes (A: insufficient info, B: weak formulation, C: timeframe/universe, D: little edge). Does NOT auto-imply L3 purchase",
    status: "completed",
    blocksDataInvestment: false,
    blockedBy: null,
  },
  {
    id: "FALS-002",
    title: "Family C — trend acceleration harvester (SUPERTREND_ELITE candidates)",
    category: "falsification",
    informationLevels: ["L0", "L1"],
    informationLatency: "candle_close",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    phase: "validation",
    rationale: "First falsification family — expressible at L0–L1, unrelated to liquidity continuation",
    status: "completed",
    blockedBy: null,
  },
  {
    id: "FALS-003",
    title: "Family D — volatility expansion harvester",
    category: "falsification",
    informationLevels: ["L0", "L1"],
    informationLatency: "candle_close",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    phase: "validation",
    rationale: "Second falsification family — regime transition at L0–L1",
    status: "completed",
    blockedBy: null,
  },
  {
    id: "UOA-001",
    title: "Unexplained outcome analysis — can variance be explained by observable information?",
    category: "unexplained_outcome_analysis",
    informationLevels: ["L0", "L1"],
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Three outcomes: missing information, irreducible noise, no edge",
    status: "active",
    blockedBy: null,
  },
  {
    id: "DISC-001",
    title: "Holdout rank correlation (discrimination at L0–L1)",
    category: "probabilistic_modeling",
    decisionProblem: "RANKING",
    informationGain: INFORMATION_GAIN_TIERS.LOW,
    rationale: "Temporarily saturated for tested families and L0–L2 — reopens with new data or families",
    status: "completed",
    verdict: "temporarily_saturated",
    blockedBy: null,
  },
  {
    id: "STRAT-POOL",
    title: "Phase 3A — discover 3–5 independent baseline strategy families",
    category: "strategy_discovery",
    phase: "3A",
    informationGain: INFORMATION_GAIN_TIERS.VERY_HIGH,
    rationale:
      "Need independent return streams before portfolio policy — weeks per family, archive on fail",
    milestone: "Modest OOS-positive fixed rules; not heavy optimization",
    status: "active",
    blockedBy: null,
  },
  {
    id: "PORT-SIM",
    title: "Phase 3B — portfolio simulator (equal-weight baseline)",
    category: "portfolio",
    phase: "3B",
    informationGain: INFORMATION_GAIN_TIERS.VERY_HIGH,
    rationale: "Exposure, correlation, utilization, equity curve — foundation for PORT-001+",
    status: "blocked",
    blockedBy: "STRAT-POOL",
  },
  {
    id: "PORT-000",
    title: "Portfolio Policy — optimize the portfolio, not isolated policies",
    category: "portfolio",
    phase: 3,
    informationGain: INFORMATION_GAIN_TIERS.VERY_HIGH,
    rationale: "One coupled system: allocation, overlap, abstention, sizing, exposure, risk budget",
    baseline: "Null Policy — strategies trade independently",
    status: "blocked",
    blockedBy: "PORT-SIM",
  },
  {
    id: "PORT-001",
    title: "[3C / Lever: allocation] Dynamic vs equal-weight",
    category: "portfolio",
    portfolioLever: "allocation",
    parentId: "PORT-000",
    phase: "3C",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Equal-weight vs static/dynamic allocation on holdout — simple rules only",
    baseline: "Equal-weight",
    status: "blocked",
    blockedBy: "PORT-SIM",
  },
  {
    id: "PORT-002",
    title: "[3D / Lever: overlap] Correlated exposure netting",
    category: "portfolio",
    portfolioLever: "overlap",
    parentId: "PORT-000",
    phase: "3D",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Three strategies long BTC = one bet — overlap ON vs OFF on holdout",
    baseline: "Independent signals (naive summation)",
    status: "blocked",
    blockedBy: "PORT-001",
  },
  {
    id: "ABST-001",
    title: "[3E / Lever: abstention] When not to deploy capital",
    category: "portfolio",
    portfolioLever: "abstention",
    parentId: "PORT-000",
    phase: "3E",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Abstention gate vs always-trade on holdout — only after portfolio exists",
    baseline: "Always trade",
    status: "blocked",
    blockedBy: "PORT-002",
  },
  {
    id: "SIZE-001",
    title: "[3F / Lever: sizing] Capital per position",
    category: "portfolio",
    portfolioLever: "sizing",
    parentId: "PORT-000",
    phase: "3F",
    informationGain: INFORMATION_GAIN_TIERS.MEDIUM,
    rationale: "Fixed-fraction vs adaptive — last; after allocation/overlap/abstention understood",
    baseline: "Fixed-fraction risk",
    status: "blocked",
    blockedBy: "ABST-001",
  },
  {
    id: "DATA-001-FUNDING",
    title: "Integrate funding into additional observable information pipeline",
    category: "information_acquisition",
    informationLevels: ["L2"],
    informationLatency: "minutes",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Full Binance historical funding — ready for rigorous Phase 2b validation",
    status: "completed",
    blockedBy: null,
  },
  {
    id: "DATA-001-OI",
    title: "Integrate OI — Binance partial + Bybit cross-venue proxy",
    category: "information_acquisition",
    informationLevels: ["L2"],
    informationLatency: "minutes",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Binance OI ~30d native; Bybit full history as cross_venue_proxy with per-symbol fidelity",
    status: "completed",
    blockedBy: null,
  },
  {
    id: "PHASE2B-FUNDING",
    title: "Phase 2b — does historical funding improve discrimination over L0–L1?",
    category: "probabilistic_modeling",
    informationLevels: ["L2"],
    informationLatency: "minutes",
    informationGain: INFORMATION_GAIN_TIERS.HIGH,
    rationale: "Rigorous validation — full 2022–2026 funding coverage",
    status: "completed",
    verdict: "negative",
    archivedProposition: "8h funding improves 15m candidate ranking",
    blockedBy: null,
  },
  {
    id: "PHASE2B-OI",
    title: "Phase 2b — does Bybit-proxy OI improve candidate discrimination?",
    category: "probabilistic_modeling",
    informationLevels: ["L2"],
    informationLatency: "minutes",
    informationGain: INFORMATION_GAIN_TIERS.MEDIUM,
    rationale: "100% proxy coverage across Families A/C/D — exploratory discrimination test",
    status: "completed",
    verdict: "negative",
    blockedBy: null,
  },
  {
    id: "DATA-002",
    title: "L3 historical order book",
    category: "information_acquisition",
    informationLevels: ["L3"],
    informationLatency: "milliseconds",
    informationGain: INFORMATION_GAIN_TIERS.MEDIUM,
    rationale: "L2 candidate-ranking negatives — require explicit L3 hypothesis before purchase",
    status: "blocked",
    blockedBy: "explicit_hypothesis_required",
  },
  {
    id: "FEAT-001",
    title: "New L1 feature engineering (liquidity)",
    category: "feature_engineering",
    informationGain: INFORMATION_GAIN_TIERS.LOW,
    rationale: "Re-expresses L1 — does not add observable information",
    status: "frozen",
    blockedBy: null,
  },
];

const TIER_ORDER = { very_high: 0, high: 1, medium: 2, low: 3 };

export function rankBacklog(backlog = DEFAULT_RESEARCH_BACKLOG, opts = {}) {
  const includeFrozen = opts.includeFrozen ?? false;
  const includeBlocked = opts.includeBlocked ?? false;
  let items = [...backlog];
  if (!includeFrozen) items = items.filter((i) => i.status !== "frozen");
  if (!includeBlocked) items = items.filter((i) => i.status !== "blocked");

  return items.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.informationGain] - TIER_ORDER[b.informationGain];
    if (tierDiff !== 0) return tierDiff;
  const statusOrder = { active: 0, partial: 1, planned: 2, blocked: 3, frozen: 4, completed: 5 };
    return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
  });
}

export function backlogToMarkdown(backlog = DEFAULT_RESEARCH_BACKLOG) {
  const ranked = rankBacklog(backlog, { includeFrozen: true, includeBlocked: true });
  const lines = [
    "# Research Backlog",
    "",
    "**Active:** Phase 3A — discover 3–5 baseline strategies. PORT/SIM blocked until then.",
    "",
    "| Priority | ID | Item | Gain | Status |",
    "|----------|----|------|------|--------|",
  ];
  ranked.forEach((item, i) => {
    lines.push(
      `| ${i + 1} | ${item.id} | ${item.title.slice(0, 55)}… | ${item.informationGain} | ${item.status} |`,
    );
  });
  return lines.join("\n");
}
