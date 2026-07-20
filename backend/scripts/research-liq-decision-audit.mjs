#!/usr/bin/env node
/**
 * Decision audit — evaluate day-picker independently from entry logic.
 *
 * Usage: cd backend && node scripts/research-liq-decision-audit.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runDecisionAudit, decisionAuditToMarkdown } from "./lib/liqDecisionAudit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(__dirname, ".liq-candidate-trades.csv");
const OUT_JSON = path.join(__dirname, ".liq-decision-audit.json");
const OUT_MD = path.join(__dirname, ".liq-decision-audit.md");

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

if (!fs.existsSync(CSV)) {
  console.error("Missing candidate CSV — run research-liq-candidate-export.mjs");
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
const report = runDecisionAudit(rows, "fwd_closeR_20");

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
fs.writeFileSync(OUT_MD, decisionAuditToMarkdown(report));

console.log(decisionAuditToMarkdown(report));
console.log(`\nWrote ${OUT_JSON}`);
