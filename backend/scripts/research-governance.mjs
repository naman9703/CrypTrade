#!/usr/bin/env node
/**
 * Research governance — efficiency, beliefs, information limit, capability matrix.
 * Lean by design: one script, one report. No new dashboards.
 *
 * Usage: cd backend && node scripts/research-governance.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildGovernanceReport,
  governanceToMarkdown,
  efficiencyToMarkdown,
  beliefLogToMarkdown,
  informationLimitToMarkdown,
  capabilityMatrixToMarkdown,
  observableInformationHierarchyToMarkdown,
  researchInvestmentMatrixToMarkdown,
  acquisitionPlannerToMarkdown,
  falsificationToMarkdown,
  decisionBoundaryToMarkdown,
  researchDebtToMarkdown,
  rroiToMarkdown,
} from "./lib/researchGovernance.js";
import { exitCriteriaToMarkdown } from "./lib/researchExitCriteria.js";
import { backlogToMarkdown } from "./lib/researchBacklog.js";
import { evaluateExitCriteria } from "./lib/researchExitCriteria.js";
import { HYPOTHESIS_FAMILIES } from "./lib/hypothesisFamilies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXP_JSON = path.join(__dirname, ".liq-experiments-results.json");
const PHASE2_JSON = path.join(__dirname, ".expected-outcome-report.json");
const FALS_JSON = path.join(__dirname, ".fals-experiments-results.json");
const DASHBOARD = path.join(__dirname, ".liq-research-dashboard.md");
const OUT_JSON = path.join(__dirname, ".research-governance.json");
const OUT_MD = path.join(__dirname, ".research-governance.md");

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const exp = loadJson(EXP_JSON);
const phase2 = loadJson(PHASE2_JSON);
const falsReport = loadJson(FALS_JSON);
const experiments = exp?.results ?? [];

let researchPool = [];
if (fs.existsSync(DASHBOARD)) {
  const text = fs.readFileSync(DASHBOARD, "utf8");
  researchPool = [...text.matchAll(/mutualInfo[:\s]+([0-9.]+)/gi)].map((m) => ({
    mutualInfo: Number(m[1]),
  }));
}

const report = buildGovernanceReport({
  experimentResults: experiments,
  phase2Report: phase2,
  ofaReport: phase2?.oracleFailureAnalysis,
  researchPool,
  falsReport,
});

const exitEvals = Object.values(HYPOTHESIS_FAMILIES).map((family) => {
  const familyExps = experiments.filter((r) => (family.experiments ?? []).includes(r.id));
  const holdoutFailures = familyExps.filter((e) => e.holdout?.monotonicity != null && e.holdout.monotonicity <= 0).length;
  const coinSlices = familyExps.flatMap((e) => Object.values(e.slices?.coin?.slices ?? {}));
  const assetStabilityRatio = coinSlices.length
    ? coinSlices.filter((s) => (s.monotonicity ?? 0) > 0).length / coinSlices.length
    : 0;
  return evaluateExitCriteria(family, {
    experimentsRun: familyExps.length,
    promotedFeatures: 0,
    holdoutFailures,
    assetStabilityRatio,
    maxInformationGain: 0.01,
    researchCycles: 1,
    manualStatus: family.status,
  });
});

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

const md = [
  observableInformationHierarchyToMarkdown(),
  "",
  "---",
  "",
  governanceToMarkdown(report),
  "",
  "---",
  "",
  acquisitionPlannerToMarkdown(report.acquisitionPlan),
  "",
  "---",
  "",
  falsificationToMarkdown(report.falsification),
  "",
  "---",
  "",
  decisionBoundaryToMarkdown(report.decisionBoundary),
  "",
  "---",
  "",
  researchInvestmentMatrixToMarkdown(),
  "",
  "---",
  "",
  rroiToMarkdown(report.rroi),
  "",
  "---",
  "",
  researchDebtToMarkdown(),
  "",
  "---",
  "",
  efficiencyToMarkdown(report.efficiency),
  "",
  "---",
  "",
  beliefLogToMarkdown(report.beliefLog),
  "",
  "---",
  "",
  informationLimitToMarkdown(report.informationLimit),
  "",
  "---",
  "",
  capabilityMatrixToMarkdown(),
  "",
  "---",
  "",
  exitCriteriaToMarkdown(exitEvals),
  "",
  "---",
  "",
  backlogToMarkdown(),
].join("\n");

fs.writeFileSync(OUT_MD, md);
console.log(md);
console.log(`\nWrote ${OUT_JSON}`);
