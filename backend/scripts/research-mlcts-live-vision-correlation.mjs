#!/usr/bin/env node
/**
 * Match live book snapshots to nearest Vision DB snapshot; report correlation.
 *
 * Usage (backend/):
 *   node scripts/research-mlcts-live-vision-correlation.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const MAX_MATCH_MS = Number(process.env.MAX_MATCH_MS || 15_000);
const livePath = path.join(__dirname, `.live-book-snapshots-${SYMBOL}.jsonl`);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readBookImbalanceSeries } = await import("../src/backtest/data/mlctsVisionIngest.js");

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

function spearman(xs, ys) {
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array(arr.length);
    sorted.forEach((o, r) => {
      out[o.i] = r + 1;
    });
    return out;
  };
  return pearson(rank(xs), rank(ys));
}

if (!fs.existsSync(livePath)) {
  console.log(JSON.stringify({ error: "no_live_file", livePath }));
  process.exit(0);
}

const liveRows = fs
  .readFileSync(livePath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const minTs = Math.min(...liveRows.map((r) => r.ts));
const maxTs = Math.max(...liveRows.map((r) => r.ts));
const vision = await readBookImbalanceSeries(SYMBOL, minTs - MAX_MATCH_MS, maxTs + MAX_MATCH_MS);

const pairs = [];
for (const live of liveRows) {
  let best = null;
  let bestDt = Infinity;
  for (const v of vision) {
    const dt = Math.abs(v.ts - live.ts);
    if (dt < bestDt) {
      bestDt = dt;
      best = v;
    }
  }
  if (best && bestDt <= MAX_MATCH_MS) {
    pairs.push({
      liveImb: live.imbalanceRatio,
      visionImb: best.imbalanceRatio,
      delta: best.imbalanceRatio - live.imbalanceRatio,
    });
  }
}

const liveImbs = pairs.map((p) => p.liveImb);
const visionImbs = pairs.map((p) => p.visionImb);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const std = (a) => {
  if (!a.length) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  liveSamples: liveRows.length,
  matchedPairs: pairs.length,
  matchWindowMs: MAX_MATCH_MS,
  pearsonR: pearson(liveImbs, visionImbs),
  spearmanRho: spearman(liveImbs, visionImbs),
  live: { mean: mean(liveImbs), std: std(liveImbs) },
  vision: { mean: mean(visionImbs), std: std(visionImbs) },
  meanDeltaVisionMinusLive: mean(pairs.map((p) => p.delta)),
  decisionGuide: {
    dropProxyIf: "matchedPairs>=500 AND (|pearsonR|<0.3 OR low correlation with material bias)",
    keepIf: "matchedPairs>=500 AND pearsonR>=0.5 AND comparable dispersion",
  },
};

const outPath = path.join(__dirname, ".mlcts-live-vision-correlation.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));
await closePool?.().catch(() => {});
