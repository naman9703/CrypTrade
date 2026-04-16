#!/usr/bin/env node
/**
 * Bucket-analysis for Move Quality features vs trade outcomes (from mq-trade-outcomes.jsonl).
 *
 * Usage:
 *   node scripts/analyze-mq-trades.mjs
 *   node scripts/analyze-mq-trades.mjs --file data/modes/paper/mq-trade-outcomes.jsonl
 *   node scripts/analyze-mq-trades.mjs --percentile 60 --metric adx
 *
 * Set MQ_TRADE_OUTCOMES_LOG=0 in the backend to disable logging new rows.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const a = process.argv.slice(2);
  let file = path.resolve(process.cwd(), "data/modes/paper/mq-trade-outcomes.jsonl");
  let percentile = null;
  let pMetric = "mqScore";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--file" && a[i + 1]) {
      file = path.resolve(process.cwd(), a[i + 1]);
      i++;
    } else if (a[i] === "--percentile" && a[i + 1]) {
      percentile = Number(a[i + 1]);
      i++;
    } else if (a[i] === "--metric" && a[i + 1]) {
      pMetric = a[i + 1];
      i++;
    }
  }
  return { file, percentile, pMetric };
}

function loadRows(p) {
  if (!fs.existsSync(p)) {
    console.error(`File not found: ${p}`);
    console.error("Trade a few Supertrend rounds first, or pass --file path/to/mq-trade-outcomes.jsonl");
    process.exit(0);
  }
  const txt = fs.readFileSync(p, "utf8");
  const rows = [];
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      /* skip */
    }
  }
  return rows.filter((r) => r && typeof r === "object");
}

function analyzeMetric(rows, key, buckets, isWin) {
  const out = [];
  for (const [min, max] of buckets) {
    const group = rows.filter((t) => {
      const v = Number(t[key]);
      return Number.isFinite(v) && v >= min && v < max;
    });
    if (!group.length) {
      out.push({ range: `${min}–${max}`, n: 0, winRate: null, avgPnlPct: null });
      continue;
    }
    const wins = group.filter((t) => isWin(t)).length;
    const winRate = wins / group.length;
    const avgPnlPct = group.reduce((a, b) => a + Number(b.pnlPct ?? 0), 0) / group.length;
    out.push({
      range: `${min}–${max}`,
      n: group.length,
      winRate: Math.round(winRate * 1000) / 1000,
      avgPnlPct: Math.round(avgPnlPct * 10000) / 10000,
    });
  }
  return out;
}

function isWin(t) {
  return String(t.outcome || "").toUpperCase() === "WIN" || Number(t.pnl) > 0;
}

function percentileThreshold(rows, key, p) {
  const vals = rows.map((r) => Number(r[key])).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const pos = (p / 100) * Math.max(0, vals.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(vals.length - 1, Math.ceil(pos));
  const w = pos - lo;
  if (hi <= lo) return vals[lo];
  return vals[lo] * (1 - w) + vals[hi] * w;
}

const { file, percentile, pMetric } = parseArgs();
const rows = loadRows(file);
if (!rows.length) {
  console.log("No rows in file.");
  process.exit(0);
}

console.log(`Loaded ${rows.length} rows from ${file}\n`);

const adxBuckets = [
  [0, 20],
  [20, 22],
  [22, 25],
  [25, 30],
  [30, 1000],
];
const mqBuckets = [
  [0, 0.4],
  [0.4, 0.6],
  [0.6, 0.7],
  [0.7, 1.01],
];
const moveBuckets = [
  [0, 1.2],
  [1.2, 1.5],
  [1.5, 2],
  [2, 1000],
];
const expBuckets = [
  [0, 1],
  [1, 1.05],
  [1.05, 1.1],
  [1.1, 100],
];
const bodyBuckets = [
  [0, 0.5],
  [0.5, 0.6],
  [0.6, 100],
];

console.log("ADX buckets (win rate · avg pnl% · n)");
console.table(analyzeMetric(rows, "adx", adxBuckets, isWin));

console.log("\nMQ score buckets");
console.table(analyzeMetric(rows, "mqScore", mqBuckets, isWin));

console.log("\nMove vs SL (moveVsSL) buckets");
console.table(analyzeMetric(rows, "moveVsSL", moveBuckets, isWin));

console.log("\nATR expansion (atrExpand) buckets");
console.table(analyzeMetric(rows, "atrExpand", expBuckets, isWin));

console.log("\nBody ratio buckets");
console.table(analyzeMetric(rows, "bodyRatio", bodyBuckets, isWin));

if (percentile != null && Number.isFinite(percentile) && percentile > 0 && percentile < 100) {
  const th = percentileThreshold(rows, pMetric, percentile);
  console.log(`\n~${percentile}th percentile of ${pMetric}: ${th == null ? "—" : th}`);
}

console.log("\nTip: tune gates toward buckets with higher winRate × enough n; avoid overfitting on tiny n.");
