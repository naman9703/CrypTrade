#!/usr/bin/env node
/**
 * FALS-001 candidate export — Families C (trend) and D (vol expansion).
 *
 * Usage: cd backend && node scripts/research-fals-candidate-export.mjs
 *        cd backend && node scripts/research-fals-candidate-export.mjs --family C
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TF = "15m";
const FROM = argValue("--from", "2022-01-01");
const TO = argValue("--to", "2026-06-01");
const FAMILY = String(argValue("--family", "both")).toUpperCase();
const QUICK = process.argv.includes("--quick");
const REST_ONLY = process.argv.includes("--rest-only") || QUICK;
const SKIP_OBS = process.argv.includes("--skip-l2") || process.argv.includes("--skip-observable") || REST_ONLY;
const SKIP_BYBIT = process.argv.includes("--skip-bybit");
const COINS = argValue("--coins", QUICK ? "BTCUSDT,ETHUSDT" : "BTCUSDT,BNBUSDT,ETHUSDT,SOLUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim());

const { initPool, closePool } = await import("../src/db/pool.js");
let poolOk = false;
if (!REST_ONLY) {
  await initPool({ info: () => {}, warn: () => {}, error: console.error });
  poolOk = true;
} else {
  console.warn("REST-only mode — skipping TimescaleDB");
}

const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
const { harvestTrendCandidates } = await import("../src/strategy/techniques/research/trendCandidateHarvest.js");
const { harvestVolExpansionCandidates } = await import("../src/strategy/techniques/research/volExpansionHarvest.js");
const { assessRunParity } = await import("./lib/familyLifecycle.js");
const { ensureObservableData, loadObservableSeries } = await import("../src/backtest/data/observableFeatures.js");
const { rowsToCsv } = await import("../src/strategy/techniques/liq/flattenFeatures.js");

async function loadCandles(symbol, fromMs, toMs) {
  if (poolOk) {
    const rows = await readCandles(symbol, TF, fromMs, toMs, { market: "futures" });
    if (rows?.length) return rows;
  }
  process.stdout.write(`  REST backfill ${symbol}...\n`);
  return fetchBinanceKlinesRange({
    symbol,
    interval: TF,
    startTime: fromMs,
    endTime: toMs,
    feedKind: "BINANCE_FUTURES",
  });
}

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const outputs = {
  C: { rows: [], path: path.join(__dirname, ".fals-family-c-candidates.csv") },
  D: { rows: [], path: path.join(__dirname, ".fals-family-d-candidates.csv") },
};
const summary = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  timeframe: TF,
  dataSource: REST_ONLY ? "rest" : "timescale",
  coins: COINS,
  quick: QUICK,
  observableEnabled: !SKIP_OBS,
  bybitEnabled: !SKIP_OBS && !SKIP_BYBIT,
  families: {},
};

for (const symbol of COINS) {
  process.stdout.write(`Harvest ${symbol} ${FROM}→${TO}...\n`);
  const candles = await loadCandles(symbol, fromMs, toMs);
  if (!candles?.length) {
    summary.families[symbol] = { error: "no candles" };
    continue;
  }
  const pre = precomputeIntraday(candles);
  let observableSeries = null;
  if (!SKIP_OBS && poolOk) {
    process.stdout.write(`  Observable sync ${symbol}...\n`);
    await ensureObservableData(symbol, fromMs, toMs, { skipBybit: SKIP_BYBIT });
    const loaded = await loadObservableSeries(symbol, fromMs, toMs, { skipBybit: SKIP_BYBIT });
    observableSeries = { binance: loaded.binance, bybit: loaded.bybit };
  }
  const harvestOpts = { symbol, observableSeries };

  if (FAMILY === "BOTH" || FAMILY === "C") {
    const cRows = harvestTrendCandidates(candles, pre, harvestOpts);
    outputs.C.rows.push(...cRows);
    summary.families[`${symbol}_C`] = {
      candidates: cRows.length,
      picked: cRows.filter((r) => r.selectedByDayPicker).length,
      binanceFundingPct: cRows.length
        ? (cRows.filter((r) => r.binance_has_funding === 1).length / cRows.length) * 100
        : 0,
      bybitOiPct: cRows.length ? (cRows.filter((r) => r.bybit_has_oi === 1).length / cRows.length) * 100 : 0,
    };
  }
  if (FAMILY === "BOTH" || FAMILY === "D") {
    const dRows = harvestVolExpansionCandidates(candles, pre, harvestOpts);
    outputs.D.rows.push(...dRows);
    summary.families[`${symbol}_D`] = {
      candidates: dRows.length,
      picked: dRows.filter((r) => r.selectedByDayPicker).length,
      binanceFundingPct: dRows.length
        ? (dRows.filter((r) => r.binance_has_funding === 1).length / dRows.length) * 100
        : 0,
      bybitOiPct: dRows.length ? (dRows.filter((r) => r.bybit_has_oi === 1).length / dRows.length) * 100 : 0,
    };
  }
}

for (const [fam, out] of Object.entries(outputs)) {
  if (FAMILY !== "BOTH" && FAMILY !== fam) continue;
  fs.writeFileSync(out.path, rowsToCsv(out.rows));
  fs.writeFileSync(
    path.join(__dirname, `.fals-family-${fam.toLowerCase()}-candidates.jsonl`),
    out.rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  console.log(`Family ${fam}: ${out.rows.length} candidates → ${out.path}`);
}

summary.runParity = assessRunParity({
  from: FROM,
  to: TO,
  coins: COINS,
  timeframe: TF,
  dataSource: REST_ONLY ? "rest" : "timescale",
});
summary.parityWithFamilyA = summary.runParity.parityWithFamilyA;
summary.totalCandidates =
  (FAMILY === "BOTH" || FAMILY === "C" ? outputs.C.rows.length : 0) +
  (FAMILY === "BOTH" || FAMILY === "D" ? outputs.D.rows.length : 0);

fs.writeFileSync(path.join(__dirname, ".fals-candidate-export-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("\nNext: node scripts/research-fals-experiments.mjs");

await closePool().catch(() => {});
