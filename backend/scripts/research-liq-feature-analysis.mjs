#!/usr/bin/env node
/**
 * Institutional LIQ feature research — bucket-first analysis with stability, drift, interactions.
 *
 * Usage: cd backend && node scripts/research-liq-feature-analysis.mjs
 * Input:  scripts/.liq-feature-trades.csv
 * Output: scripts/.liq-feature-analysis.json
 *         scripts/.liq-research-dashboard.json
 *         scripts/.liq-research-dashboard.md
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  analyzeFeature,
  buildDashboard,
  dashboardToMarkdown,
  CORE_RESEARCH_FEATURES,
  INTERACTION_PAIRS,
  CATEGORICAL_INTERACTIONS,
  interactionGrid,
  categoricalInteraction,
  num,
  mean,
} from "./lib/liqResearchStats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_CSV = path.join(__dirname, ".liq-candidate-trades.csv");
const TRADE_CSV = path.join(__dirname, ".liq-feature-trades.csv");
const CSV_PATH = fs.existsSync(CANDIDATE_CSV) ? CANDIDATE_CSV : TRADE_CSV;
const OUT_JSON = path.join(__dirname, ".liq-feature-analysis.json");
const DASH_JSON = path.join(__dirname, ".liq-research-dashboard.json");
const DASH_MD = path.join(__dirname, ".liq-research-dashboard.md");

function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? "";
    rows.push(row);
  }
  return rows;
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

function availableFeatures(rows) {
  return CORE_RESEARCH_FEATURES.filter((f) => {
    const n = rows.filter((r) => num(r[f]) != null).length;
    return n >= 30;
  });
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`Missing ${CSV_PATH} — run: node scripts/research-liq-candidate-export.mjs`);
  process.exit(1);
}

const allRows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
const isCandidate = CSV_PATH === CANDIDATE_CSV;
const defaultOutcome = isCandidate ? "fwd_closeR_20" : "rMultiple";
const rows = allRows.filter((r) => !r.preset || r.preset === "V1" || isCandidate);

const analyzeRows = rows.length >= 50 ? rows : allRows;

const features = availableFeatures(analyzeRows);
const featureReports = features.map((f) =>
  analyzeFeature(analyzeRows, f, { controlFeature: "scoreV2_total", buckets: 10, outcome: defaultOutcome }),
);

const interactions = [];
for (const [a, b] of INTERACTION_PAIRS) {
  if (!features.includes(a) || !features.includes(b)) continue;
  const grid = interactionGrid(analyzeRows, a, b, defaultOutcome, 4);
  if (grid?.bestCell) {
    interactions.push({
      type: "numeric",
      features: [a, b],
      bestCell: grid.bestCell,
      lift: grid.lift,
      cells: grid.cells?.length ?? 0,
    });
  }
}
for (const [a, b] of CATEGORICAL_INTERACTIONS) {
  const cat = categoricalInteraction(analyzeRows, a, b, defaultOutcome);
  if (cat?.best) {
    interactions.push({
      type: "categorical",
      features: [a, b],
      best: cat.best,
      lift: cat.lift,
      cells: cat.cells?.length ?? 0,
    });
  }
}
interactions.sort((x, y) => (y.lift ?? 0) - (x.lift ?? 0));

const dashboard = buildDashboard(featureReports, interactions);
const coins = [...new Set(analyzeRows.map((r) => r.symbol))];

const report = {
  generatedAt: new Date().toISOString(),
  source: CSV_PATH,
  methodology: {
    primary: "bucket expectancy + monotonicity",
    supplementary: ["spearman", "mutual information", "permutation importance", "stump gain"],
    stability: ["per-coin spearman", "per-regime spearman", "yearly drift"],
    interactions: "numeric grids + categorical cross-tabs",
    evidenceChecklist: [
      "predictiveStrength",
      "monotonicity",
      "coinStability",
      "regimeStability",
      "driftStable",
      "incrementalValue",
      "interactionLift",
    ],
    note: "Do not manually tune score weights. Features passing USE checklist feed auto-calibration (Phase 8).",
  },
  sample: {
    totalRows: allRows.length,
    analyzedRows: analyzeRows.length,
    dataSource: isCandidate ? "candidates" : "executed_trades",
    defaultOutcome,
    v1Rows: rows.length,
    coins,
    pickedCandidates: isCandidate ? analyzeRows.filter((r) => num(r.selectedByDayPicker) === 1).length : null,
    winPct: analyzeRows.length
      ? (analyzeRows.filter((r) => num(r.win) === 1).length / analyzeRows.length) * 100
      : 0,
    avgOutcome: mean(analyzeRows.map((r) => num(r[defaultOutcome])).filter((v) => v != null)),
  },
  dashboard,
  topInteractions: interactions.slice(0, 15),
  features: Object.fromEntries(featureReports.map((r) => [r.feature, r])),
  promoteCandidates: dashboard.filter((d) => d.recommendation === "USE").slice(0, 10),
  deprioritize: dashboard.filter((d) => d.recommendation === "IGNORE").slice(0, 10),
  reviewNegativeScore: featureReports.find((r) => r.feature === "scoreV2_total"),
};

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(DASH_JSON, JSON.stringify({ sample: report.sample, dashboard, topInteractions: report.topInteractions }, null, 2));
fs.writeFileSync(
  DASH_MD,
  dashboardToMarkdown(dashboard, {
    generatedAt: report.generatedAt,
    totalRows: analyzeRows.length,
    coins: coins.join(", "),
    window: analyzeRows[0]?.window ?? "?",
  }),
);

console.log(`\n=== LIQ Research Platform (${analyzeRows.length} trades, ${features.length} features) ===\n`);
console.log("Evidence-ranked features (bucket-first):");
for (const r of dashboard.slice(0, 12)) {
  console.log(
    `  ${String(r.rank).padStart(2)}. ${r.feature.padEnd(28)} ${r.recommendation.padEnd(8)} mono=${fmt(r.monotonicity)} spread=${fmt(r.bucketSpread)} coin=${fmtPct(r.coinStable)}`,
  );
}
if (interactions[0]) {
  console.log(`\nTop interaction: ${interactions[0].features.join(" × ")} lift=${fmt(interactions[0].lift)}R`);
}
console.log(`\nUSE candidates: ${report.promoteCandidates.map((r) => r.feature).join(", ") || "none yet"}`);
console.log(`\nDashboard → ${DASH_MD}`);
console.log(`Full JSON → ${OUT_JSON}`);

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(2);
}
function fmtPct(v) {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}
