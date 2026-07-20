#!/usr/bin/env node
/**
 * Phase 2 — Distributional Outcome Estimation + Decision Policy
 *
 * Train on pre-holdout data only. ALL evaluation on frozen 2026 holdout.
 *
 * Usage: cd backend && node scripts/research-expected-outcome.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  trainDistributionalEstimator,
  estimateAllDistributional,
} from "./lib/distributionalOutcomeEstimator.js";
import { evaluateDistributionalCalibration } from "./lib/calibrationMetrics.js";
import { applyDecisionPolicy, compareDecisionPolicies, oraclePredictability } from "./lib/decisionPolicy.js";
import { analyzeOracleFailures } from "./lib/oracleFailureAnalysis.js";
import { discoverBehaviorClusters } from "./lib/behaviorDiscovery.js";
import { groupDecisionDays } from "./lib/liqDecisionAudit.js";
import { simulatePortfolio, portfolioDiversificationValue } from "./lib/portfolioSimulation.js";
import { MARKET_BEHAVIORS, PLATFORM_NAME, PHASE2_PIPELINE } from "./lib/marketBehaviors.js";
import { syncFromExperiments, negativeResultsToMarkdown } from "./lib/negativeResultsRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(__dirname, ".liq-candidate-trades.csv");
const EXP_JSON = path.join(__dirname, ".liq-experiments-results.json");
const OUT_JSON = path.join(__dirname, ".expected-outcome-report.json");
const OUT_MD = path.join(__dirname, ".expected-outcome-report.md");
const NEG_MD = path.join(__dirname, ".negative-results-registry.md");
const HOLDOUT_YEAR = 2026;

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

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = vals[i] ?? ""));
    return row;
  });
}

function yearFromRow(r) {
  const ts = Number(r.entryTs);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).getUTCFullYear();
}

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(3);
}

function reportToMarkdown(report) {
  const cal = report.calibration;
  const pol = report.holdoutPolicyComparison;
  const ofa = report.oracleFailureAnalysis;
  const lines = [
    `# ${PLATFORM_NAME} — Phase 2 Report`,
    "",
    `Pipeline: ${PHASE2_PIPELINE.join(" → ")}`,
    "",
    "> **Evaluation discipline:** estimator trained on pre-2026 only; all metrics below are frozen holdout (2026).",
    "",
    "## Distributional Estimator (holdout calibration)",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Train candidates | ${report.trainN} |`,
    `| Holdout candidates | ${report.holdoutN} |`,
    `| Calibrated features | ${report.calibratedFeatures} |`,
    `| E[R] rank correlation | ${fmt(cal.expectedR?.rankCorrelation)} |`,
    `| E[R] mean error | ${fmt(cal.expectedR?.meanError)} |`,
    `| Brier P(+1R) | ${fmt(cal.brier?.pHit1R?.score)} |`,
    `| Brier P(SL first) | ${fmt(cal.brier?.pSlFirst?.score)} |`,
    `| Reliability ECE P(+1R) | ${fmt(cal.reliability?.pHit1R?.expectedCalibrationError)} |`,
    "",
    "## Decision Policy (holdout only, multi-candidate days)",
    "",
    `| Policy | N picks | Avg ${report.outcome} |`,
    `|--------|---------|------------|`,
    ...Object.entries(pol).map(([k, v]) => `| ${k} | ${v.n ?? "—"} | ${fmt(v.avgOutcome)} |`),
    "",
    "## Oracle Predictability (holdout)",
    "",
    `Research question: *${report.oraclePredictability.researchQuestion}*`,
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Multi-candidate days | ${report.oraclePredictability.multiCandidateDays} |`,
    `| Distributional policy picked oracle | ${fmt(report.oraclePredictability.oraclePredictPct)}% |`,
    `| Legacy score picked oracle | ${fmt(report.legacyScoreOraclePct)}% |`,
    "",
    "## Oracle Failure Analysis (OFA)",
    "",
    `Failure rate: ${fmt(ofa.failureRate * 100)}% | Avg opportunity cost: ${fmt(ofa.avgOpportunityCost)}R`,
    "",
    "**Failure modes:**",
    ...Object.entries(ofa.failureModes).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "**Hypotheses to test:**",
    ...ofa.hypotheses.map((h) => `- ${h}`),
    "",
    "## Discovered Behavior Clusters (train data)",
    "",
    ...(report.behaviorDiscovery.clusters ?? []).map(
      (c) =>
        `- Cluster ${c.clusterId} (${c.n}): **${c.suggestedBehavior}** — avg R=${fmt(c.avgOutcome)}, P(+1R)=${fmt(c.pHit1R)}`,
    ),
    "",
    "## Portfolio Simulation (holdout)",
    "",
    `| Policy | Net return % | Avg R | Trades | Exposure skips |`,
    `|--------|--------------|-------|--------|----------------|`,
    ...Object.entries(report.portfolio ?? {}).map(
      ([k, v]) =>
        `| ${k} | ${fmt(v.netReturnPct)}% | ${fmt(v.avgR)} | ${v.trades} | ${v.skippedExposure ?? 0} |`,
    ),
    "",
    `Diversification insight: ${report.diversification?.insight ?? "—"}`,
    "",
    "## Interpretation",
    "",
    ...report.interpretation.map((i) => `- ${i}`),
  ];
  return lines.join("\n");
}

if (!fs.existsSync(CSV)) {
  console.error("Missing candidate CSV — run research-liq-candidate-export.mjs");
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
const outcome = "fwd_closeR_20";
const train = rows.filter((r) => (yearFromRow(r) ?? 9999) < HOLDOUT_YEAR);
const holdout = rows.filter((r) => yearFromRow(r) === HOLDOUT_YEAR);

if (!holdout.length) {
  console.error(`No holdout rows for year ${HOLDOUT_YEAR}`);
  process.exit(1);
}

const model = trainDistributionalEstimator(train, outcome);
const holdoutEstimates = estimateAllDistributional(holdout, model);
const calibration = evaluateDistributionalCalibration(holdoutEstimates);

const holdoutPolicyComparison = compareDecisionPolicies(holdoutEstimates, outcome, {
  policies: ["max_score", "max_expected_r", "max_distributional_utility"],
});

const holdoutDays = groupDecisionDays(holdout, outcome);
const holdoutMultiWithEst = holdoutDays
  .filter((d) => d.n > 1)
  .map((d) =>
    d.all.map((c) => {
      const est = holdoutEstimates.find((e) => e.candidateKey === c.candidateKey);
      return { ...c, ...est };
    }),
  );

const oraclePred = oraclePredictability(holdoutMultiWithEst, outcome);
const oracleFailureAnalysis = analyzeOracleFailures(holdoutMultiWithEst, outcome, "expectedUtility");

let legacyScoreOraclePct = 0;
{
  let correct = 0;
  let total = 0;
  for (const list of holdoutMultiWithEst) {
    if (list.length < 2) continue;
    total++;
    const oracle = [...list].sort((a, b) => Number(b[outcome]) - Number(a[outcome]))[0];
    const scorePick = [...list].sort(
      (a, b) => Number(b.weightedQuality ?? b.scoreV2_total) - Number(a.weightedQuality ?? a.scoreV2_total),
    )[0];
    if (oracle.candidateKey === scorePick.candidateKey) correct++;
  }
  legacyScoreOraclePct = total ? (correct / total) * 100 : 0;
}

const portfolio = {};
for (const policy of ["max_score", "max_distributional_utility"]) {
  const tagged = applyDecisionPolicy(holdoutEstimates, policy);
  const picked = tagged.filter((c) => c.selectedByPolicy === 1);
  portfolio[policy] = simulatePortfolio(picked, { feeBps: 4, slippageBps: 2 });
}

const diversification = portfolioDiversificationValue(holdoutEstimates.slice(0, 300), {
  feeBps: 4,
  slippageBps: 2,
});

const behaviorDiscovery = discoverBehaviorClusters(train, 6, outcome);

let negativeResults = [];
if (fs.existsSync(EXP_JSON)) {
  const exp = JSON.parse(fs.readFileSync(EXP_JSON, "utf8"));
  negativeResults = syncFromExperiments(exp.results ?? exp.experiments ?? []);
  fs.writeFileSync(NEG_MD, negativeResultsToMarkdown(negativeResults));
}

const interpretation = [];
interpretation.push("Bottleneck is probabilistic modeling — not strategy design or research methodology.");
if ((calibration.expectedR?.rankCorrelation ?? 0) > 0.1) {
  interpretation.push("Holdout E[R] rank correlation positive — distributional calibration has signal.");
} else {
  interpretation.push("Holdout E[R] rank correlation weak — improve calibration before production.");
}
const scoreAvg = holdoutPolicyComparison.max_score?.avgOutcome ?? -99;
const distAvg = holdoutPolicyComparison.max_distributional_utility?.avgOutcome ?? -99;
if (distAvg > scoreAvg) {
  interpretation.push(
    `Holdout: distributional policy (${fmt(distAvg)}R) beats legacy score (${fmt(scoreAvg)}R) — decision upgrade justified OOS.`,
  );
} else {
  interpretation.push(
    `Holdout: distributional policy (${fmt(distAvg)}R) does NOT beat score (${fmt(scoreAvg)}R) — do not deploy.`,
  );
}
interpretation.push(`Oracle predictability holdout: ${fmt(oraclePred.oraclePredictPct)}% (score: ${fmt(legacyScoreOraclePct)}%).`);
interpretation.push("Do not optimize oracle % directly — investigate OFA failure modes.");
if (behaviorDiscovery.sufficient) {
  interpretation.push(`${behaviorDiscovery.clusters.length} behavior clusters discovered from feature vectors — validate against manual taxonomy.`);
}

const report = {
  platform: PLATFORM_NAME,
  phase: 2,
  version: "distributional_v1",
  outcome,
  holdoutYear: HOLDOUT_YEAR,
  trainN: train.length,
  holdoutN: holdout.length,
  calibratedFeatures: Object.keys(model.calibrators).length,
  calibration,
  holdoutPolicyComparison,
  oraclePredictability: oraclePred,
  legacyScoreOraclePct,
  oracleFailureAnalysis,
  behaviorDiscovery,
  portfolio,
  diversification,
  negativeResultsCount: negativeResults.length,
  interpretation,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, reportToMarkdown(report));
console.log(reportToMarkdown(report));
console.log(`\nWrote ${OUT_JSON}`);
