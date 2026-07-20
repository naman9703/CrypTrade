#!/usr/bin/env node
/**
 * Phase 2b — additional observable information discrimination test.
 *
 * Split scientific questions:
 *   Funding — does full historical funding improve discrimination over L0–L1? (rigorous)
 *   OI      — does recent OI justify continuous collection? (exploratory, partial coverage)
 *
 * Usage: cd backend && npm run research:phase2b
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { bucketExpectancy, spearman, num } from "./lib/liqResearchStats.js";
import {
  ADDITIONAL_OBSERVABLE_GROUPS,
  accountDatasetCoverage,
  accountFeatureColumnCoverage,
  featureCoverageToMarkdown,
  phase2bInterpretation,
  positioningMatrixToMarkdown,
  isValidFeatureValue,
} from "./lib/featureCoverage.js";
import { PHASE_2B_FALSIFIED_PROPOSITION, informationYieldToMarkdown } from "./lib/informationYield.js";
import { decisionYieldToMarkdown } from "./lib/decisionYield.js";
import { decisionQualityToMarkdown } from "./lib/decisionQuality.js";
import { proxyFidelityToMarkdown } from "./lib/proxyFidelity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DATASETS = [
  { name: "Family A (LIQ)", path: path.join(__dirname, ".liq-candidate-trades.csv") },
  { name: "Family C (Trend)", path: path.join(__dirname, ".fals-family-c-candidates.csv") },
  { name: "Family D (Vol)", path: path.join(__dirname, ".fals-family-d-candidates.csv") },
];

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
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = vals[i] ?? ""));
    return row;
  });
}

function analyzeFeature(rows, feature, group, outcome = "fwd_closeR_20") {
  const research = rows.filter((r) => num(r.entryYear) !== 2026);
  const holdout = rows.filter((r) => num(r.entryYear) === 2026);
  const withFeat = research.filter((r) => isValidFeatureValue(r, feature));
  const bucket = bucketExpectancy(withFeat, feature, outcome, 8);
  const holdBucket = bucketExpectancy(
    holdout.filter((r) => isValidFeatureValue(r, feature)),
    feature,
    outcome,
    6,
  );
  const xs = withFeat.map((r) => num(r[feature])).filter((v) => v != null);
  const ys = withFeat.map((r) => num(r[outcome])).filter((v) => v != null);
  const rho = xs.length >= 20 ? spearman(xs, ys) : null;
  const colCov = accountFeatureColumnCoverage(rows, feature, {
    minCoverageForPromotionPct: group.minCoverageForPromotionPct,
  });
  const coveragePct = colCov.coveragePct;
  const meetsPromo = colCov.meetsPromotionThreshold;

  return {
    feature,
    group: group.id,
    evaluationMode: group.evaluationMode,
    n: withFeat.length,
    coveragePct,
    researchValidCount: colCov.researchValidCount,
    holdoutValidCount: colCov.holdoutValidCount,
    researchMono: bucket?.monotonicity,
    researchSpread: bucket?.spread,
    holdoutMono: holdBucket?.monotonicity,
    spearmanR: rho,
    meetsPromotionThreshold: meetsPromo,
    interpretable:
      group.evaluationMode === "rigorous"
        ? meetsPromo
        : withFeat.length >= 20,
  };
}

function bestSpearman(results) {
  const valid = results.filter((r) => r.spearmanR != null && r.interpretable);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (Math.abs(b.spearmanR) > Math.abs(a.spearmanR ?? 0) ? b : a));
}

const report = {
  generatedAt: new Date().toISOString(),
  phase: "2b_additional_observable_information",
  positioningMatrix: [
    { data: "Funding", historical: "full", live: true },
    { data: "Open Interest", historical: "partial", live: true },
    { data: "Order Book", historical: false, live: true },
  ],
  questions: {
    funding: "Does historical funding improve discrimination over L0–L1?",
    open_interest: "Does recent OI justify continuous collection? (exploratory)",
  },
  datasets: [],
};

for (const ds of DATASETS) {
  if (!fs.existsSync(ds.path)) {
    report.datasets.push({ name: ds.name, error: "missing_csv", path: ds.path });
    continue;
  }
  const rows = parseCsv(fs.readFileSync(ds.path, "utf8"));
  const coverage = accountDatasetCoverage(rows);
  const hasAny = rows.some(
    (r) => r.binance_has_funding === "1" || r.binance_has_oi === "1" || r.bybit_has_oi === "1",
  );

  const allResults = [];
  for (const [groupKey, group] of Object.entries(ADDITIONAL_OBSERVABLE_GROUPS)) {
    for (const f of group.features) {
      if (rows.some((r) => isValidFeatureValue(r, f.col))) {
        allResults.push(analyzeFeature(rows, f.col, group));
      }
    }
  }

  const fundingResults = allResults.filter((r) => r.group === "binance_funding");
  const binanceOiResults = allResults.filter((r) => r.group === "binance_oi");
  const bybitResults = allResults.filter((r) => r.group === "bybit_positioning");
  const bestFunding = bestSpearman(fundingResults);
  const bestBybit = bestSpearman(bybitResults);

  report.datasets.push({
    name: ds.name,
    candidates: rows.length,
    observableAttached: hasAny,
    coverage,
    binanceFunding: { results: fundingResults, best: bestFunding },
    binanceOi: { results: binanceOiResults },
    bybitProxy: { results: bybitResults, best: bestBybit },
    interpretation: {
      binanceFunding: coverage.groups.find((g) => g.group === "binance_funding"),
      binanceOi: coverage.groups.find((g) => g.group === "binance_oi"),
      bybitProxy: coverage.groups.find((g) => g.group === "bybit_positioning"),
    },
  });
}

const OUT_JSON = path.join(__dirname, ".research-phase2b-l2.json");
const OUT_MD = path.join(__dirname, ".research-phase2b-l2.md");

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

const md = [
  "# Phase 2b — Additional Observable Information",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "## Research Questions (split)",
  "",
  `1. **Funding (rigorous):** ${report.questions.funding}`,
  `2. **Open Interest (exploratory):** ${report.questions.open_interest}`,
  "",
  "## Positioning Data Availability",
  "",
  positioningMatrixToMarkdown(),
  "",
];

for (const ds of report.datasets) {
  md.push(`## ${ds.name}`, "");
  if (ds.error) {
    md.push(`Missing: ${ds.path}`, "", "Re-run exports with L2 enabled after `npm run research:l2:sync`.", "");
    continue;
  }
  md.push(`Candidates: ${ds.candidates}`, "");
  md.push(featureCoverageToMarkdown(ds.coverage), "");

  if (!ds.observableAttached) {
    md.push("No additional observable information attached — re-export candidates.", "");
    continue;
  }

  md.push("### Binance Funding (native, rigorous)", "");
  md.push(
    "| Feature | N | Coverage % | Research mono | Holdout mono | Spearman | Promo OK |",
    "|---------|---|------------|---------------|--------------|----------|----------|",
  );
  for (const f of ds.binanceFunding.results) {
    md.push(
      `| ${f.feature} | ${f.n} | ${f.coveragePct.toFixed(0)} | ${fmt(f.researchMono)} | ${fmt(f.holdoutMono)} | ${fmt(f.spearmanR)} | ${f.meetsPromotionThreshold ? "yes" : "no"} |`,
    );
  }
  md.push("");

  md.push("### Bybit OI/L-S (cross-venue proxy)", "");
  md.push(
    "| Feature | N | Coverage % | Research mono | Holdout mono | Spearman | Promo OK |",
    "|---------|---|------------|---------------|--------------|----------|----------|",
  );
  for (const f of ds.bybitProxy.results) {
    md.push(
      `| ${f.feature} | ${f.n} | ${f.coveragePct.toFixed(0)} | ${fmt(f.researchMono)} | ${fmt(f.holdoutMono)} | ${fmt(f.spearmanR)} | ${f.meetsPromotionThreshold ? "yes" : "no"} |`,
    );
  }
  md.push("");

  md.push(
    phase2bInterpretation(ds.coverage, {
      fundingSignal: ds.binanceFunding.best?.spearmanR != null ? fmt(ds.binanceFunding.best.spearmanR) : null,
      bybitSignal: ds.bybitProxy.best?.spearmanR != null ? fmt(ds.bybitProxy.best.spearmanR) : null,
    }),
    "",
  );
}

md.push(
  "## Scoped Conclusion",
  "",
  PHASE_2B_FALSIFIED_PROPOSITION,
  "",
  "> This does **not** falsify all observable information — only candidate-ranking for Families A/C/D under current validation.",
  "",
  proxyFidelityToMarkdown(),
  "",
  "### Information Yield (Problem 2 — ranking)",
  "",
  informationYieldToMarkdown(),
  "",
  "## Phase 3 — Decision Yield",
  "",
  decisionYieldToMarkdown(),
  "",
  decisionQualityToMarkdown(),
  "",
);

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(3);
}

fs.writeFileSync(OUT_MD, md.join("\n"));
console.log(md.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
