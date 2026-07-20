/**
 * Pre-registered hypothesis experiments for FALS Families C and D.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LAYER } from "./liqPromotionPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FAMILY_C_EXPERIMENTS = [
  {
    id: "EXP-C01",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "Elite gate pass count improves forward R — more gates aligned → higher avg R.",
    feature: "gate_pass_count",
    outcome: "fwd_closeR_20",
    test: "bucket_monotonicity",
    minMonotonicity: 0.25,
    minSpread: 0.1,
    status: "pending",
  },
  {
    id: "EXP-C02",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "ATR expansion at ST flip × ADX interaction lifts forward expectancy.",
    feature: "gate_atr_expansion",
    interaction: "gate_adx",
    outcome: "fwd_closeR_20",
    test: "interaction_lift",
    minLift: 0.15,
    status: "pending",
  },
  {
    id: "EXP-C03",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "4H supertrend alignment predicts hit2R rate on trend flips.",
    feature: "gate_htf4h_pass",
    outcome: "hit2R_flag",
    test: "bucket_monotonicity",
    minMonotonicity: 0.2,
    status: "pending",
  },
  {
    id: "EXP-C04",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "Volume ratio at entry monotonically improves forward R.",
    feature: "gate_vol_ratio",
    outcome: "fwd_closeR_20",
    test: "bucket_monotonicity",
    minMonotonicity: 0.25,
    status: "pending",
  },
  {
    id: "EXP-C05",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "Composite score negative correlation is selection bias — test all flips.",
    feature: "elite_composite_score",
    outcome: "fwd_closeR_20",
    test: "selection_bias_check",
    status: "pending",
  },
  {
    id: "EXP-C06",
    familyId: "C",
    layer: LAYER.RESEARCH,
    hypothesis: "1H EMA align × gate pass count interaction improves forward R across coins.",
    feature: "gate_htf1h_pass",
    interaction: "gate_pass_count",
    outcome: "fwd_closeR_20",
    test: "categorical_interaction_slices",
    minLift: 0.15,
    minSliceRatio: 0.4,
    status: "pending",
  },
];

export const FAMILY_D_EXPERIMENTS = [
  {
    id: "EXP-D01",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "ATR expansion ratio at entry improves forward R on vol expansion events.",
    feature: "vol_atr_expansion",
    outcome: "fwd_closeR_20",
    test: "bucket_monotonicity",
    minMonotonicity: 0.25,
    minSpread: 0.1,
    status: "pending",
  },
  {
    id: "EXP-D02",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "Lower BB percentile (deeper squeeze) before expansion → higher hit2R.",
    feature: "vol_bb_pctile",
    outcome: "hit2R_flag",
    test: "bucket_monotonicity",
    minMonotonicity: 0.2,
    status: "pending",
  },
  {
    id: "EXP-D03",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "Relative volume at expansion entry monotonically improves forward R.",
    feature: "vol_rvol",
    outcome: "fwd_closeR_20",
    test: "bucket_monotonicity",
    minMonotonicity: 0.25,
    status: "pending",
  },
  {
    id: "EXP-D04",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "ADX at expansion entry × ATR expansion interaction lifts expectancy.",
    feature: "marketState_adx",
    interaction: "vol_atr_expansion",
    outcome: "fwd_closeR_20",
    test: "interaction_lift",
    minLift: 0.15,
    status: "pending",
  },
  {
    id: "EXP-D05",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "Vol expansion composite score selection bias check on all candidates.",
    feature: "vol_expansion_score",
    outcome: "fwd_closeR_20",
    test: "selection_bias_check",
    status: "pending",
  },
  {
    id: "EXP-D06",
    familyId: "D",
    layer: LAYER.RESEARCH,
    hypothesis: "Trigger type × expansion score interaction across coins and regimes.",
    feature: "vol_expansion_score",
    interaction: "trigger",
    outcome: "fwd_closeR_20",
    test: "categorical_interaction_slices",
    minLift: 0.15,
    minSliceRatio: 0.4,
    status: "pending",
  },
];

export function loadFamilyRegistry(familyId) {
  const pathByFamily = {
    C: path.join(__dirname, "fals-family-c-experiments.json"),
    D: path.join(__dirname, "fals-family-d-experiments.json"),
  };
  const defaults = familyId === "C" ? FAMILY_C_EXPERIMENTS : FAMILY_D_EXPERIMENTS;
  const regPath = pathByFamily[familyId];
  if (!fs.existsSync(regPath)) {
    fs.writeFileSync(regPath, JSON.stringify({ experiments: defaults }, null, 2));
    return JSON.parse(fs.readFileSync(regPath, "utf8"));
  }
  const data = JSON.parse(fs.readFileSync(regPath, "utf8"));
  const ids = new Set((data.experiments ?? []).map((e) => e.id));
  for (const exp of defaults) {
    if (!ids.has(exp.id)) data.experiments.push(exp);
  }
  return data;
}

export function saveFamilyRegistry(familyId, data) {
  const pathByFamily = {
    C: path.join(__dirname, "fals-family-c-experiments.json"),
    D: path.join(__dirname, "fals-family-d-experiments.json"),
  };
  fs.writeFileSync(pathByFamily[familyId], JSON.stringify(data, null, 2));
}

export function registryToMarkdown(experiments, title) {
  const lines = [
    `# ${title}`,
    "",
    "| ID | Hypothesis | Result | Accepted |",
    "|----|------------|--------|----------|",
  ];
  for (const e of experiments) {
    const icon = e.accepted === true ? "✅" : e.accepted === "partial" ? "🟡" : e.accepted === false ? "❌" : "⏳";
    lines.push(`| ${e.id} | ${e.hypothesis.slice(0, 65)}… | ${e.result ?? "pending"} | ${icon} |`);
  }
  return lines.join("\n");
}
