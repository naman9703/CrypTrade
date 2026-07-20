#!/usr/bin/env node
/**
 * Family-level verdict — does this hypothesis family deserve production consideration?
 *
 * Usage: cd backend && node scripts/research-liq-family-verdict.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  HYPOTHESIS_FAMILIES,
  evaluateFamilyVerdict,
  familiesToMarkdown,
} from "./lib/hypothesisFamilies.js";
import { informationGain, perCoinPositiveCount, sliceValidation } from "./lib/liqResearchStats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXP_RESULTS = path.join(__dirname, ".liq-experiments-results.json");
const CANDIDATES = path.join(__dirname, ".liq-candidate-trades.csv");
const OUT_JSON = path.join(__dirname, ".liq-family-verdict.json");
const OUT_MD = path.join(__dirname, ".liq-family-verdict.md");

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

const expData = fs.existsSync(EXP_RESULTS)
  ? JSON.parse(fs.readFileSync(EXP_RESULTS, "utf8"))
  : { results: [] };
const candidates = fs.existsSync(CANDIDATES) ? parseCsv(fs.readFileSync(CANDIDATES, "utf8")) : [];

const researchPool = ["cont_score", "sweep_velocityAtr", "level_importance", "marketState_adx", "scoreV2_total"]
  .map((f) => ({
    feature: f,
    ...informationGain(candidates, f, "fwd_closeR_20"),
    coinPositive: perCoinPositiveCount(sliceValidation(candidates, f, "fwd_closeR_20", "symbol")),
  }))
  .filter((r) => r.researchPoolWorthy);

const verdicts = Object.values(HYPOTHESIS_FAMILIES).map((family) =>
  evaluateFamilyVerdict(family, expData.results ?? [], []),
);

const report = {
  generatedAt: new Date().toISOString(),
  familyVerdicts: verdicts,
  researchPoolFeatures: researchPool,
  platformNote:
    "Family A frozen. Platform ready for families B–E. Zero promotions is successful disproof, not failure.",
};

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, familiesToMarkdown(verdicts));

console.log(familiesToMarkdown(verdicts));
console.log("\n## Research Pool (information gain ≥ 0.01, not promoted)\n");
for (const r of researchPool) {
  console.log(`  ${r.feature}: MI=${(r.mutualInfo ?? 0).toFixed(4)} coins+=${r.coinPositive}`);
}
console.log(`\nWrote ${OUT_JSON}`);
