/**
 * Research debt — maintenance backlog for the research process itself.
 */
export const DEFAULT_RESEARCH_DEBT = [
  { id: "RD-001", item: "FALS-001 complete — Families A/C/D tested at L0–L1", severity: "low", category: "replication", resolved: true },
  { id: "RD-002", item: "Funding integration complete — full historical pipeline", severity: "high", category: "data_integration", resolved: true },
  { id: "RD-002b", item: "OI integration partial — streaming yes, historical ~30d API only", severity: "medium", category: "data_integration" },
  { id: "RD-003", item: "Holdout rank correlation near zero — discrimination debt", severity: "medium", category: "robustness" },
  { id: "RD-004", item: "Phase 2b L2 discrimination test not yet run on full candidate exports", severity: "medium", category: "replication" },
  { id: "RD-005", item: "Cross-market validation limited to 5 crypto futures symbols", severity: "low", category: "cross_market" },
  { id: "RD-006", item: "Quarterly RROI not yet tracked", severity: "low", category: "governance" },
];

export function researchDebtToMarkdown(debt = DEFAULT_RESEARCH_DEBT) {
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...debt].sort((a, b) => order[a.severity] - order[b.severity]);
  return [
    "# Research Debt",
    "",
    "Maintenance backlog for the research process — analogous to technical debt.",
    "",
    "| ID | Item | Severity | Category |",
    "|----|------|----------|----------|",
    ...sorted.map((d) => `| ${d.id} | ${d.resolved ? "✅ " : ""}${d.item} | ${d.severity} | ${d.category} |`),
  ].join("\n");
}
