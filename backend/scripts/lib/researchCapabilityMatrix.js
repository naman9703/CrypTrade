/**
 * Research capability matrix — domain × information level × blocking dependency.
 */
import { INFORMATION_LEVELS } from "./informationHierarchy.js";

export const CAPABILITY = {
  FULL: "full",
  PARTIAL: "partial",
  PLANNED: "planned",
  NOT_POSSIBLE: "not_possible",
};

export const RESEARCH_CAPABILITY_MATRIX = [
  { domain: "Liquidity (L0–L1)", capability: CAPABILITY.FULL, informationLevel: "L0–L1", blockingDependency: "None", notes: "Family A tested; no edge at formulation" },
  { domain: "OI + Funding", capability: CAPABILITY.PLANNED, informationLevel: "L2", blockingDependency: "Phase 1 ingestion", notes: "Free — integrate before L3 microstructure" },
  { domain: "Trend / momentum", capability: CAPABILITY.FULL, informationLevel: "L0–L1", blockingDependency: "None", notes: "Family C tested; no edge at L0–L1 formulation" },
  { domain: "Volatility regime", capability: CAPABILITY.FULL, informationLevel: "L0–L1", blockingDependency: "None", notes: "Family D tested; no edge at L0–L1 formulation" },
  { domain: "Portfolio / allocation", capability: CAPABILITY.PARTIAL, informationLevel: "L0–L1", blockingDependency: "Multi-family", notes: "Simulator v2" },
  { domain: "Order book microstructure", capability: CAPABILITY.NOT_POSSIBLE, informationLevel: "L3", blockingDependency: INFORMATION_LEVELS.L3.blockingDependency, notes: "Historical L2 generally unavailable" },
  { domain: "Liquidations", capability: CAPABILITY.NOT_POSSIBLE, informationLevel: "L2–L3", blockingDependency: "Liquidation stream", notes: "Limited live, poor historical" },
  { domain: "Options surface", capability: CAPABILITY.PARTIAL, informationLevel: "L4", blockingDependency: INFORMATION_LEVELS.L4.blockingDependency, notes: "Partial availability" },
  { domain: "Macro (FRED)", capability: CAPABILITY.PARTIAL, informationLevel: "L5", blockingDependency: "Macro feed integration", notes: "Free historical" },
];

export function capabilityMatrixToMarkdown(matrix = RESEARCH_CAPABILITY_MATRIX) {
  const icon = (c) => ({ full: "✅", partial: "🟡", planned: "⏳", not_possible: "❌" })[c] ?? "—";
  return [
    "# Research Capability Matrix",
    "",
    "| Domain | Status | Info Level | Blocking | Notes |",
    "|--------|--------|------------|----------|-------|",
    ...matrix.map((r) => `| ${r.domain} | ${icon(r.capability)} | ${r.informationLevel} | ${r.blockingDependency} | ${r.notes} |`),
  ].join("\n");
}
