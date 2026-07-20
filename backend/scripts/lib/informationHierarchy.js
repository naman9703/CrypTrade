/**
 * Observable Information Hierarchy — richness, latency, and practical availability.
 */
export const PLATFORM_DESCRIPTION =
  "A quantitative decision research platform that measures whether research directions improve trading decisions under rigorous validation. Observable information is one input; allocation, sizing, and abstention are first-class problems.";

export const MISSION_STATEMENT =
  "Empirically determine which decisions improve long-term performance under uncertainty — including what information to use, when to trade, how much to risk, and how to allocate capital.";

export const PROJECT_PHASES = {
  PHASE_0_ENGINEERING: { id: 0, name: "Engineering", question: "Can we build a reliable backtester?", status: "solved" },
  PHASE_1_STRATEGY: {
    id: 1,
    name: "Strategy Evaluation",
    question: "Can we build better strategies?",
    status: "solved_no_edge_at_L0_L1",
  },
  PHASE_2_SCIENTIFIC: {
    id: 2,
    name: "Information Evaluation",
    question: "Can better observable information improve candidate selection?",
    status: "complete",
    subphases: {
      "2a": { name: "Price-derived falsification (Families A/C/D)", status: "complete" },
      "2b": {
        name: "Funding + Bybit OI proxy (full coverage)",
        status: "complete",
        verdict: "negative_for_candidate_ranking",
      },
    },
  },
  PHASE_3_DECISION: {
    id: 3,
    name: "Portfolio Construction",
    question: "How do I build a portfolio that produces durable returns?",
    status: "active",
    subphase: "3A",
    object: "Portfolio Policy",
    levers: ["allocation", "overlap", "abstention", "sizing", "exposure", "riskBudget"],
    nullBaseline: "Null Policy — strategies trade independently",
    milestone: "3 independent modest edges → portfolio beats any single strategy on holdout",
    note: "3A strategy families → 3B simulator → 3C–3F levers. Do not optimize portfolio before streams exist.",
  },
};

export const INFORMATION_LATENCY = {
  CANDLE_CLOSE: "candle_close",
  MILLISECONDS: "milliseconds",
  MINUTES: "minutes",
  MINUTES_TO_HOURS: "minutes_to_hours",
  HOURS_TO_DAYS: "hours_to_days",
};

/** Data availability for acquisition economics. */
export const DATA_AVAILABILITY = {
  OHLCV: { live: true, historical: true, free: true, integrationPhase: 1 },
  MARK_PRICE: { live: true, historical: true, free: true, integrationPhase: 1 },
  FUNDING: { live: true, historical: true, free: true, integrationPhase: 1 },
  OPEN_INTEREST: {
    live: true,
    historical: "partial_native_full_proxy",
    free: true,
    integrationPhase: 1,
    note: "Binance openInterestHist ~30d; Bybit cross-venue proxy 2022+ with per-symbol fidelity",
  },
  TRADES: { live: true, historical: true, free: true, integrationPhase: 2 },
  ORDER_BOOK: { live: true, historical: false, free: false, integrationPhase: 3 },
  LIQUIDATIONS: { live: "limited", historical: false, free: false, integrationPhase: 3 },
  OPTIONS_IV: { live: "partial", historical: "limited", free: "partial", integrationPhase: 3 },
  MACRO_FRED: { live: true, historical: true, free: true, integrationPhase: 2 },
};

export const OBSERVABLE_INFORMATION_LEVELS = {
  L0: {
    id: "L0",
    name: "Raw market data",
    available: true,
    inPipeline: true,
    latency: INFORMATION_LATENCY.CANDLE_CLOSE,
    latencyLabel: "Candle close",
    examples: ["OHLCV", "mark_price", "volume"],
  },
  L1: {
    id: "L1",
    name: "Derived features",
    available: true,
    inPipeline: true,
    latency: INFORMATION_LATENCY.CANDLE_CLOSE,
    latencyLabel: "Candle close",
    examples: ["ATR", "trend", "liquidity levels", "volatility regime"],
    parent: "L0",
  },
  L2: {
    id: "L2",
    name: "Positioning (grouping label)",
    available: true,
    inPipeline: true,
    latency: INFORMATION_LATENCY.MINUTES,
    latencyLabel: "Minutes",
    examples: ["funding rate", "open interest", "long/short ratio"],
    note: "Use POSITIONING_DATA_MATRIX — funding and OI have different historical depth",
    children: ["funding", "open_interest"],
  },
  L3: {
    id: "L3",
    name: "Microstructure / historical order book",
    available: false,
    inPipeline: false,
    latency: INFORMATION_LATENCY.MILLISECONDS,
    latencyLabel: "Milliseconds",
    examples: ["order book imbalance", "queue dynamics", "trade flow"],
    blockingDependency: "Continuous L2 collection or commercial historical data",
    latencyNote: "May be impossible to reconstruct from 15m candles",
  },
  L4: {
    id: "L4",
    name: "Options surface",
    available: "partial",
    inPipeline: false,
    latency: INFORMATION_LATENCY.MINUTES_TO_HOURS,
    latencyLabel: "Minutes–hours",
    examples: ["implied volatility", "skew"],
    blockingDependency: "options chain data",
  },
  L5: {
    id: "L5",
    name: "Macro / cross-asset",
    available: "partial",
    inPipeline: false,
    latency: INFORMATION_LATENCY.HOURS_TO_DAYS,
    latencyLabel: "Hours–days",
    examples: ["FRED macro", "cross-asset flows"],
    blockingDependency: "macro feeds; crypto positioning more limited",
  },
};

export const INFORMATION_LEVELS = OBSERVABLE_INFORMATION_LEVELS;

export const INTEGRATION_ROADMAP = {
  phase1: { items: ["OHLCV", "mark_price", "funding", "open_interest_binance", "open_interest_bybit_proxy"], status: "complete" },
  phase2: { items: ["trade_flow", "multi_exchange_sync", "market_breadth", "macro_fred"], status: "planned" },
  phase3: { items: ["historical_l2", "liquidations", "options_surface"], status: "only_if_phase1_2_justify" },
};

/** Historical × Live availability for positioning-related data. */
export const POSITIONING_DATA_MATRIX = [
  { data: "Funding", historical: "full", live: true },
  { data: "Open Interest (Binance native)", historical: "partial", live: true },
  { data: "Open Interest (Bybit proxy)", historical: "full", live: true },
  { data: "Order Book", historical: false, live: true },
];

function formatHistLive(v) {
  if (v === "full" || v === true) return "✅";
  if (v === "partial") return "⚠️ Partial";
  return "❌";
}

export const RESEARCH_PHASE = { EXPLORATION: "exploration", VALIDATION: "validation" };

export const PHASE_STANDARDS = {
  exploration: {
    minCandidates: 50,
    holdoutRequired: false,
    fdrRequired: false,
    optimizesFor: "expected_information_gain",
    description: "Cheap speculative experiments",
  },
  validation: {
    minCandidates: 200,
    holdoutRequired: true,
    fdrRequired: true,
    optimizesFor: "expected_decision_quality",
    description: "Rigorous confirmation on holdout",
  },
};

export const UOA_OUTCOMES = {
  MISSING_INFORMATION: "missing_information",
  IRREDUCIBLE_RANDOMNESS: "irreducible_randomness",
  NO_EXPLOITABLE_RELATIONSHIP: "no_exploitable_relationship",
  INCONCLUSIVE: "inconclusive",
};

export const UOA_QUESTION =
  "Can the remaining variance be explained by observable information available to us?";

export function levelsAvailable() {
  return Object.values(OBSERVABLE_INFORMATION_LEVELS).filter((l) => l.available === true);
}

export function maxAvailableLevel() {
  const avail = levelsAvailable();
  return avail[avail.length - 1]?.id ?? "L0";
}

export function canTestAtLevels(requiredLevels) {
  const required = Array.isArray(requiredLevels) ? requiredLevels : [requiredLevels];
  return required.every((id) => {
    const l = OBSERVABLE_INFORMATION_LEVELS[id];
    return l?.available === true || l?.available === "partial";
  });
}

export function untestableLevels(requiredLevels) {
  const required = Array.isArray(requiredLevels) ? requiredLevels : [requiredLevels];
  return required.filter((id) => OBSERVABLE_INFORMATION_LEVELS[id]?.available === false);
}

export function formatLevelRange(levels) {
  if (!levels?.length) return "—";
  if (levels.length === 1) return levels[0];
  return `${levels[0]}–${levels[levels.length - 1]}`;
}

export function classifyHypothesisRequirements({ levels = ["L0", "L1"], latency = null } = {}) {
  const levelObjs = levels.map((id) => OBSERVABLE_INFORMATION_LEVELS[id]).filter(Boolean);
  const maxLatency = latency ?? levelObjs[levelObjs.length - 1]?.latency;
  return {
    levels,
    latency: maxLatency,
    latencyLabel: levelObjs.find((l) => l.latency === maxLatency)?.latencyLabel ?? "—",
    testable: canTestAtLevels(levels),
    untestable: untestableLevels(levels),
  };
}

export function observableInformationHierarchyToMarkdown() {
  const lines = [
    "# Observable Information Hierarchy",
    "",
    PLATFORM_DESCRIPTION,
    "",
    `**Mission:** ${MISSION_STATEMENT}`,
    "",
    "| Level | Status | Latency | Examples |",
    "|-------|--------|---------|----------|",
  ];
  for (const l of Object.values(OBSERVABLE_INFORMATION_LEVELS)) {
    const status = l.available === true ? (l.inPipeline ? "✅ in pipeline" : "✅ available") : l.available === "partial" ? "🟡 partial" : "❌ requires ingestion";
    lines.push(`| ${l.id} ${l.name} | ${status} | ${l.latencyLabel} | ${l.examples.join(", ")} |`);
  }
  lines.push(
    "",
    "## Data Availability",
    "",
    "| Data | Live | Historical | Free | Phase |",
    "|------|------|------------|------|-------|",
    ...Object.entries(DATA_AVAILABILITY).map(
      ([k, v]) => `| ${k} | ${v.live} | ${v.historical} | ${v.free} | ${v.integrationPhase} |`,
    ),
    "",
    "## Positioning Data (Historical × Live)",
    "",
    "| Data | Historical | Live |",
    "|------|------------|------|",
    ...POSITIONING_DATA_MATRIX.map((r) => `| ${r.data} | ${formatHistLive(r.historical)} | ${formatHistLive(r.live)} |`),
    "",
    "> Funding: historically validated (2022+). OI: streaming + partial — do not treat as full-history signal.",
    "",
    "## Integration Roadmap",
    "",
    `- **Phase 1:** ${INTEGRATION_ROADMAP.phase1.items.join(", ")} (${INTEGRATION_ROADMAP.phase1.status})`,
    `- **Phase 2:** ${INTEGRATION_ROADMAP.phase2.items.join(", ")}`,
    `- **Phase 3:** ${INTEGRATION_ROADMAP.phase3.items.join(", ")} (only if justified)`,
  );
  return lines.join("\n");
}

export const informationHierarchyToMarkdown = observableInformationHierarchyToMarkdown;
