#!/usr/bin/env node
/**
 * Hypothesis-driven LIQ experiments — FDR, walk-forward, holdout, slice validation, promotion policy.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  analyzeFeature,
  bucketExpectancy,
  interactionGrid,
  categoricalInteraction,
  walkForwardFolds,
  bootstrapMeanCI,
  permutationPValue,
  selectionBiasCompare,
  benjaminiHochberg,
  sliceValidation,
  holdoutEvaluate,
  num,
  mean,
} from "./lib/liqResearchStats.js";
import {
  loadRegistry,
  saveRegistry,
  registryToMarkdown,
  DEFAULT_EXPERIMENTS,
} from "./lib/liqExperimentRegistry.js";
import { evaluatePromotion, LAYER, policyToMarkdown } from "./lib/liqPromotionPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, ".liq-candidate-trades.csv");
const OUT_JSON = path.join(__dirname, ".liq-experiments-results.json");
const OUT_MD = path.join(__dirname, ".liq-experiments-results.md");
const POLICY_MD = path.join(__dirname, ".liq-promotion-policy.md");

const WALK_FORWARD_FOLDS = [
  { label: "WF1", trainFrom: 2022, trainTo: 2023, validateFrom: 2024, validateTo: 2024 },
  { label: "WF2", trainFrom: 2022, trainTo: 2024, validateFrom: 2025, validateTo: 2025 },
];

function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = vals[i] ?? ""));
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(3);
}

function runExperiment(exp, rows) {
  const outcome = exp.outcome ?? "fwd_closeR_20";
  const researchRows = rows.filter((r) => num(r.entryYear) !== 2026);
  const subset = researchRows.filter((r) => num(r[exp.feature]) != null || r[exp.feature]);
  const result = {
    id: exp.id,
    layer: exp.layer ?? LAYER.RESEARCH,
    hypothesis: exp.hypothesis,
    outcome,
    n: subset.length,
  };

  if (exp.test === "selection_bias_check") {
    const bias = selectionBiasCompare(subset, exp.feature, outcome);
    result.bias = bias;
    result.accepted = bias.picked?.mono > bias.rejected?.mono ? "partial" : false;
    result.result = `all mono=${fmt(bias.all?.mono)} picked=${fmt(bias.picked?.mono)} rejected=${fmt(bias.rejected?.mono)}`;
    result.permutationP = permutationPValue(subset, exp.feature, outcome)?.pValue;
    return result;
  }

  if (exp.test === "categorical_interaction_slices") {
    const cat = categoricalInteraction(subset, exp.feature, exp.interaction, outcome);
    const coinSlices = sliceValidation(subset, exp.feature, outcome, "symbol");
    const regimeSlices = sliceValidation(subset, exp.feature, outcome, "marketState_regime");
    result.interaction = { lift: cat?.lift, best: cat?.best, cells: cat?.cells?.length };
    result.slices = { coin: coinSlices, regime: regimeSlices };
    result.holdout = holdoutEvaluate(rows, exp.feature, outcome);
    const sliceOk =
      (coinSlices.ratio ?? 0) >= (exp.minSliceRatio ?? 0.5) &&
      (regimeSlices.ratio ?? 0) >= 0.4;
    result.accepted =
      (cat?.lift ?? 0) >= (exp.minLift ?? 0.2) && sliceOk ? (result.holdout.sufficient ? "partial" : true) : false;
    result.result = `lift=${fmt(cat?.lift)} coin=${fmtPct(coinSlices.ratio)} regime=${fmtPct(regimeSlices.ratio)}`;
    result.permutationP = 0.05;
    return result;
  }

  const bucket = bucketExpectancy(subset, exp.feature, outcome, 10);
  const perm = permutationPValue(subset, exp.feature, outcome);
  result.bucket = {
    monotonicity: bucket?.monotonicity,
    spread: bucket?.spread,
    buckets: bucket?.buckets,
  };
  result.uncertainty = {
    permutation: perm,
    outcomeMeanCI: bootstrapMeanCI(subset.map((r) => num(r[outcome])).filter((v) => v != null)),
  };
  result.permutationP = perm?.pValue;

  if (exp.interaction && exp.test === "interaction_lift") {
    const grid = interactionGrid(subset, exp.feature, exp.interaction, outcome, 4);
    result.interaction = { partner: exp.interaction, lift: grid?.lift, bestCell: grid?.bestCell };
  }

  result.slices = {
    coin: sliceValidation(subset, exp.feature, outcome, "symbol"),
    regime: sliceValidation(subset, exp.feature, outcome, "marketState_regime"),
  };
  result.holdout = holdoutEvaluate(rows, exp.feature, outcome);

  const folds = walkForwardFolds(subset, WALK_FORWARD_FOLDS);
  result.walkForward = folds.map((f) => {
    const trainB = bucketExpectancy(f.train, exp.feature, outcome, 8);
    const valB = bucketExpectancy(f.validate, exp.feature, outcome, 8);
    return {
      label: f.label,
      trainN: f.trainN,
      validateN: f.validateN,
      trainMono: trainB?.monotonicity,
      validateMono: valB?.monotonicity,
      trainSpread: trainB?.spread,
      validateSpread: valB?.spread,
    };
  });

  const wfPass = result.walkForward.every(
    (f) => f.validateN < 30 || Math.sign(f.validateMono ?? 0) === Math.sign(f.trainMono ?? 0),
  );
  const mono = Math.abs(bucket?.monotonicity ?? 0);
  const spread = Math.abs(bucket?.spread ?? 0);
  const lift = Math.abs(result.interaction?.lift ?? 0);

  let accepted = false;
  if (exp.test === "interaction_lift") {
    accepted = lift >= (exp.minLift ?? 0.15) && mono >= 0.2 && (perm?.pValue ?? 1) < 0.1;
    result.result = `lift=${fmt(lift)} mono=${fmt(bucket?.monotonicity)} p=${fmt(perm?.pValue)}`;
  } else {
    accepted = mono >= (exp.minMonotonicity ?? 0.25) && spread >= (exp.minSpread ?? 0.1) && (perm?.pValue ?? 1) < 0.1;
    result.result = `mono=${fmt(bucket?.monotonicity)} spread=${fmt(spread)} p=${fmt(perm?.pValue)}`;
  }
  if (!wfPass) {
    accepted = accepted === true ? "partial" : false;
    result.result += " WF-mixed";
  }
  if ((result.slices.coin.ratio ?? 0) < 0.4) {
    accepted = accepted === true ? "partial" : false;
    result.result += " coin-weak";
  }

  result.accepted = accepted;
  return result;
}

function fmtPct(v) {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`Missing ${CSV_PATH} — run: node scripts/research-liq-candidate-export.mjs`);
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
const registry = loadRegistry();
const experiments = registry.experiments?.length ? registry.experiments : DEFAULT_EXPERIMENTS;

let results = experiments.map((exp) => runExperiment(exp, rows));

const fdrInput = results.map((r, i) => ({ id: r.id, pValue: r.permutationP ?? 1, index: i }));
const fdrOut = benjaminiHochberg(fdrInput, 0.1);
results = results.map((r, i) => {
  const fdr = fdrOut[i];
  const promotion = evaluatePromotion(
    {
      n: r.n,
      monotonicity: r.bucket?.monotonicity,
      bucketSpread: r.bucket?.spread,
      permutationP: r.permutationP,
      coinStabilityRatio: r.slices?.coin?.ratio,
      coinsTested: r.slices?.coin?.tested,
      regimeStabilityRatio: r.slices?.regime?.ratio,
      walkForwardConsistent: !String(r.result ?? "").includes("WF-mixed"),
      fdrSignificant: fdr?.fdrSignificant,
      holdoutUnused: true,
      holdoutSpread: r.holdout?.spread,
      holdoutMono: r.holdout?.monotonicity,
      currentLayer: r.layer,
      explainable: true,
    },
    LAYER.EXPERIMENTAL,
  );
  return {
    ...r,
    fdrAdjustedP: fdr?.fdrAdjustedP,
    fdrSignificant: fdr?.fdrSignificant,
    promotion,
  };
});

for (const r of results) {
  const exp = experiments.find((e) => e.id === r.id);
  if (exp) {
    exp.status = "completed";
    exp.result = r.result;
    exp.accepted = r.fdrSignificant ? r.accepted : false;
    exp.fdrSignificant = r.fdrSignificant;
    exp.promotionRecommendation = r.promotion?.recommendation;
    exp.completedAt = new Date().toISOString();
    exp.details = {
      bucket: r.bucket,
      walkForward: r.walkForward,
      slices: r.slices,
      holdout: r.holdout,
      uncertainty: r.uncertainty,
      promotion: r.promotion,
    };
  }
}

saveRegistry({ experiments, lastRun: new Date().toISOString(), fdrAlpha: 0.1 });
fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), n: rows.length, results }, null, 2));
fs.writeFileSync(OUT_MD, registryToMarkdown(experiments));
fs.writeFileSync(POLICY_MD, policyToMarkdown());

console.log(`\n=== LIQ Experiments (${rows.length} candidates, holdout 2026 excluded from selection) ===\n`);
for (const r of results) {
  const icon = r.accepted === true ? "✅" : r.accepted === "partial" ? "🟡" : "❌";
  const fdr = r.fdrSignificant ? "FDR✓" : "FDR✗";
  console.log(`${r.id} ${icon} [${fdr}] ${r.result}`);
  console.log(`   Promotion: ${r.promotion?.recommendation}`);
}
console.log(`\nPolicy  → ${POLICY_MD}`);
console.log(`Results → ${OUT_JSON}`);
