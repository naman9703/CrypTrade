/**
 * LIQ hypothesis experiment registry — internal research notebook as data.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LAYER } from "./liqPromotionPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "liq-experiments.json");

export const DEFAULT_EXPERIMENTS = [
  {
    id: "EXP-001",
    layer: LAYER.RESEARCH,
    hypothesis: "Continuation room (cont_score) improves forward expectancy — more room before opposing liquidity → higher avg R.",
    feature: "cont_score",
    outcome: "fwd_closeR_20",
    test: "bucket_monotonicity",
    minMonotonicity: 0.3,
    minSpread: 0.15,
    status: "pending",
  },
  {
    id: "EXP-002",
    layer: LAYER.RESEARCH,
    hypothesis: "Sweep velocity alone is weak; sweep_velocityAtr × level_importance interaction lifts expectancy.",
    feature: "sweep_velocityAtr",
    interaction: "level_importance",
    outcome: "fwd_closeR_20",
    test: "interaction_lift",
    minLift: 0.15,
    status: "pending",
  },
  {
    id: "EXP-003",
    layer: LAYER.RESEARCH,
    hypothesis: "Weekly/daily external liquidity (level_importance) predicts hit2R rate.",
    feature: "level_importance",
    outcome: "hit2R_flag",
    test: "bucket_monotonicity",
    minMonotonicity: 0.25,
    status: "pending",
  },
  {
    id: "EXP-004",
    layer: LAYER.RESEARCH,
    hypothesis: "Market ADX × continuation score interaction improves forward R (nonlinear combo).",
    feature: "marketState_adx",
    interaction: "cont_score",
    outcome: "fwd_closeR_20",
    test: "interaction_lift",
    minLift: 0.2,
    status: "pending",
  },
  {
    id: "EXP-005",
    layer: LAYER.RESEARCH,
    hypothesis: "scoreV2_total negative correlation is selection bias — decompose components vs forward R on all candidates.",
    feature: "scoreV2_total",
    outcome: "fwd_closeR_20",
    test: "selection_bias_check",
    status: "pending",
  },
  {
    id: "EXP-006",
    layer: LAYER.RESEARCH,
    hypothesis: "Session narrative × level type interaction improves forward R across coins and regimes.",
    feature: "sessionNarrative",
    interaction: "level_type",
    outcome: "fwd_closeR_20",
    test: "categorical_interaction_slices",
    minLift: 0.2,
    minSliceRatio: 0.5,
    status: "pending",
  },
];

export function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ experiments: DEFAULT_EXPERIMENTS }, null, 2));
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  }
  const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const ids = new Set((data.experiments ?? []).map((e) => e.id));
  for (const exp of DEFAULT_EXPERIMENTS) {
    if (!ids.has(exp.id)) data.experiments.push(exp);
  }
  return data;
}

export function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

export function updateExperiment(id, patch) {
  const reg = loadRegistry();
  const idx = reg.experiments.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  reg.experiments[idx] = { ...reg.experiments[idx], ...patch, updatedAt: new Date().toISOString() };
  saveRegistry(reg);
  return reg.experiments[idx];
}

export function registryToMarkdown(experiments) {
  const lines = [
    "# LIQ Experiment Registry",
    "",
    "| ID | Layer | Hypothesis | Result | Accepted |",
    "|----|-------|------------|--------|----------|",
  ];
  for (const e of experiments) {
    const icon = e.accepted === true ? "✅" : e.accepted === "partial" ? "🟡" : e.accepted === false ? "❌" : "⏳";
    lines.push(
      `| ${e.id} | ${e.layer ?? "research"} | ${e.hypothesis.slice(0, 70)}… | ${e.result ?? "pending"} | ${icon} |`,
    );
  }
  return lines.join("\n");
}
