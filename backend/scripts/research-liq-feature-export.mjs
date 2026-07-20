#!/usr/bin/env node
/**
 * Export LIQ trades with full feature vectors for institutional research.
 * Targets 5k+ labeled trades via multi-coin + multi-year harvest.
 *
 * Usage:
 *   cd backend && node scripts/research-liq-feature-export.mjs
 *   cd backend && node scripts/research-liq-feature-export.mjs --coins BTCUSDT,ETHUSDT --from 2022-01-01 --to 2026-06-01
 *
 * Output: scripts/.liq-feature-trades.csv + .jsonl + .liq-feature-export-summary.json
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
const START = 1000;
const FROM = argValue("--from", "2022-01-01");
const TO = argValue("--to", "2026-06-01");
const COINS = argValue("--coins", "BTCUSDT,BNBUSDT,ETHUSDT,SOLUSDT,XRPUSDT").split(",").map((s) => s.trim());
const PRESET_MODE = argValue("--preset", "V1"); // V1 | RESEARCH | BOTH

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_15M_RESEARCH,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
const { tradeToFeatureRow, rowsToCsv } = await import(
  "../src/strategy/techniques/liq/flattenFeatures.js"
);

const PRESETS =
  PRESET_MODE === "BOTH"
    ? [
        ["V1", INTRADAY_PRO_LIQ_15M],
        ["RESEARCH", INTRADAY_PRO_LIQ_15M_RESEARCH],
      ]
    : PRESET_MODE === "RESEARCH"
      ? [["RESEARCH", INTRADAY_PRO_LIQ_15M_RESEARCH]]
      : [["V1", INTRADAY_PRO_LIQ_15M]];

async function runPreset(symbol, preset, presetName, fromMs, toMs) {
  clearIntradayAdapterCache();
  const candles = await readCandles(symbol, TF, fromMs, toMs, { market: "futures" });
  if (!candles?.length) return { rows: [], candleCount: 0 };
  const base = materializeIntradayEngineCfgSync(
    { ...preset, symbol, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  const cfg = mergeAdaptiveCfg(base, candles);
  const trailMicro = await buildTrailMicroContext({
    symbol,
    fromMs,
    toMs,
    cfg,
    trailEnabled: cfg.trailingStopLossAuto === true,
  });
  const out = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  return {
    rows: out.trades.map((t) => tradeToFeatureRow(t, { symbol, window: `${FROM}_${TO}`, preset: presetName })),
    candleCount: candles.length,
  };
}

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const allRows = [];
const summary = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  coins: COINS,
  presetMode: PRESET_MODE,
  runs: [],
};

for (const symbol of COINS) {
  for (const [name, preset] of PRESETS) {
    process.stdout.write(`Export ${symbol} ${name} ${FROM}→${TO}...\n`);
    const { rows, candleCount } = await runPreset(symbol, preset, name, fromMs, toMs);
    const withFeat = rows.filter((r) => r.scoreV2_total != null || r.feat != null);
    summary.runs.push({ symbol, preset: name, trades: rows.length, withFeatures: withFeat.length, candleCount });
    allRows.push(...rows);
  }
}

const csvPath = path.join(__dirname, ".liq-feature-trades.csv");
const jsonlPath = path.join(__dirname, ".liq-feature-trades.jsonl");
fs.writeFileSync(csvPath, rowsToCsv(allRows));
fs.writeFileSync(jsonlPath, allRows.map((r) => JSON.stringify(r)).join("\n"));
fs.writeFileSync(
  path.join(__dirname, ".liq-feature-export-summary.json"),
  JSON.stringify({ ...summary, totalRows: allRows.length }, null, 2),
);

console.log(`\nExported ${allRows.length} trades → ${csvPath}`);
console.log(`By coin: ${COINS.map((c) => `${c}=${allRows.filter((r) => r.symbol === c).length}`).join(", ")}`);
console.log(`\nNext: node scripts/research-liq-feature-analysis.mjs`);
console.log(`  or: node scripts/research-liq-platform.mjs`);

await closePool();
