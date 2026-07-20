/**
 * Research efficiency — how much did we learn per unit of effort?
 */
import { classifyVerdict } from "./researchVerdicts.js";

const GAIN_SCORE = { very_high: 1.0, high: 0.75, medium: 0.5, low: 0.25, none: 0 };
const EFFORT_SCORE = { low: 1, medium: 2, high: 4 };

/** Default effort estimates — update when actuals known. */
export const DEFAULT_EFFORT = {
  "EXP-001": { devDays: 2, compute: "medium", informationGain: "high", decision: "reject" },
  "EXP-002": { devDays: 4, compute: "high", informationGain: "low", decision: "reject" },
  "EXP-003": { devDays: 2, compute: "medium", informationGain: "medium", decision: "reject" },
  "EXP-004": { devDays: 3, compute: "medium", informationGain: "low", decision: "reject" },
  "EXP-005": { devDays: 2, compute: "low", informationGain: "high", decision: "reject" },
  "EXP-006": { devDays: 3, compute: "medium", informationGain: "low", decision: "reject" },
  "OFA-001": { devDays: 3, compute: "medium", informationGain: "very_high", decision: "continue" },
  "OFA-006": { devDays: 2, compute: "medium", informationGain: "high", decision: "continue" },
};

export function efficiencyScore(effort) {
  const gain = GAIN_SCORE[effort.informationGain] ?? 0.5;
  const cost = EFFORT_SCORE[effort.compute] ?? 2;
  const time = Math.max(1, effort.devDays ?? 1);
  return Number((gain / (cost * Math.sqrt(time))).toFixed(4));
}

/**
 * Build efficiency table from experiments + effort registry.
 */
export function buildEfficiencyTable(experiments = [], effortRegistry = DEFAULT_EFFORT) {
  return experiments.map((exp) => {
    const effort = effortRegistry[exp.id] ?? {
      devDays: 2,
      compute: "medium",
      informationGain: exp.accepted ? "high" : "low",
      decision: exp.accepted ? "continue" : "reject",
    };
    const verdict = classifyVerdict(exp);
    return {
      id: exp.id,
      devDays: effort.devDays,
      compute: effort.compute,
      informationGain: effort.informationGain,
      decision: effort.decision,
      verdict,
      efficiency: efficiencyScore(effort),
      hypothesis: (exp.hypothesis ?? "").slice(0, 80),
    };
  }).sort((a, b) => b.efficiency - a.efficiency);
}

export function efficiencyToMarkdown(table) {
  const lines = [
    "# Research Efficiency",
    "",
    "Information learned per unit of effort — not whether the experiment 'worked'.",
    "",
    "| ID | Dev Days | Compute | Info Gain | Efficiency | Decision | Verdict |",
    "|----|----------|---------|-----------|------------|----------|---------|",
  ];
  for (const row of table) {
    lines.push(
      `| ${row.id} | ${row.devDays} | ${row.compute} | ${row.informationGain} | ${row.efficiency} | ${row.decision} | ${row.verdict} |`,
    );
  }
  const avg = table.length ? table.reduce((s, r) => s + r.efficiency, 0) / table.length : 0;
  lines.push("", `Average efficiency: **${avg.toFixed(3)}**`);
  return lines.join("\n");
}
