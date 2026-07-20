#!/usr/bin/env node
/**
 * Export every LIQ candidate (sweep→reclaim) with forward path labels.
 *
 * Usage: cd backend && node scripts/research-liq-candidate-export.mjs
 *        cd backend && node scripts/research-liq-candidate-export.mjs --coins BTCUSDT,BNBUSDT --from 2022-01-01
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
const COINS = argValue("--coins", "BTCUSDT,BNBUSDT,ETHUSDT,SOLUSDT,XRPUSDT").split(",").map((s) => s.trim());
const SKIP_OBS = process.argv.includes("--skip-l2") || process.argv.includes("--skip-observable");
const SKIP_BYBIT = process.argv.includes("--skip-bybit");

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureObservableData, loadObservableSeries } = await import("../src/backtest/data/observableFeatures.js");

const { INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { harvestLiqCandidates } = await import("../src/strategy/techniques/liq/candidateHarvest.js");
const { rowsToCsv } = await import("../src/strategy/techniques/liq/flattenFeatures.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const allRows = [];
const summary = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  observableEnabled: !SKIP_OBS,
  bybitEnabled: !SKIP_OBS && !SKIP_BYBIT,
  runs: [],
};

for (const symbol of COINS) {
  process.stdout.write(`Harvest ${symbol} ${FROM}→${TO}...\n`);
  let observableSeries = null;
  if (!SKIP_OBS) {
    process.stdout.write(`  Observable sync ${symbol} (binance${SKIP_BYBIT ? "" : "+bybit"})...\n`);
    await ensureObservableData(symbol, fromMs, toMs, { skipBybit: SKIP_BYBIT });
    const loaded = await loadObservableSeries(symbol, fromMs, toMs, { skipBybit: SKIP_BYBIT });
    observableSeries = { binance: loaded.binance, bybit: loaded.bybit };
  }
  const candles = await readCandles(symbol, TF, fromMs, toMs, { market: "futures" });
  if (!candles?.length) {
    summary.runs.push({ symbol, candidates: 0, error: "no candles" });
    continue;
  }
  const base = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_CANDIDATE_HARVEST, symbol, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  const cfg = mergeAdaptiveCfg(base, candles);
  const pre = precomputeIntraday(candles);
  const rows = harvestLiqCandidates(candles, pre, { ...cfg, symbol, observableSeries });
  const picked = rows.filter((r) => r.selectedByDayPicker === 1).length;
  const fundingN = rows.filter((r) => r.binance_has_funding === 1).length;
  const bybitOiN = rows.filter((r) => r.bybit_has_oi === 1).length;
  summary.runs.push({
    symbol,
    candidates: rows.length,
    selectedByDayPicker: picked,
    selectionRatePct: rows.length ? (picked / rows.length) * 100 : 0,
    candleCount: candles.length,
    binanceFundingPct: rows.length ? (fundingN / rows.length) * 100 : 0,
    bybitOiPct: rows.length ? (bybitOiN / rows.length) * 100 : 0,
  });
  allRows.push(...rows);
}

const csvPath = path.join(__dirname, ".liq-candidate-trades.csv");
const jsonlPath = path.join(__dirname, ".liq-candidate-trades.jsonl");
fs.writeFileSync(csvPath, rowsToCsv(allRows));
fs.writeFileSync(jsonlPath, allRows.map((r) => JSON.stringify(r)).join("\n"));
fs.writeFileSync(
  path.join(__dirname, ".liq-candidate-export-summary.json"),
  JSON.stringify({ ...summary, totalCandidates: allRows.length }, null, 2),
);

console.log(`\nHarvested ${allRows.length} candidates → ${csvPath}`);
console.log(`Selection bias: ${allRows.filter((r) => r.selectedByDayPicker).length} would be day-picked`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nNext: node scripts/research-liq-experiments.mjs`);

await closePool();
