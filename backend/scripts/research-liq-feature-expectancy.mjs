#!/usr/bin/env node
/**
 * LIQ v1 vs v2 feature expectancy — IS/OOS compare with persisted feature vectors.
 * For empirical feature research (correlation, buckets), prefer:
 *   node scripts/research-liq-feature-export.mjs
 *   node scripts/research-liq-feature-analysis.mjs
 *
 * Usage: cd backend && node scripts/research-liq-feature-expectancy.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TF = "15m";
const START = 1000;
const WINDOWS = [
  { label: "IS", from: "2024-01-01", to: "2025-06-30" },
  { label: "OOS", from: "2025-07-01", to: "2026-06-01" },
];
const COINS = ["BNBUSDT", "BTCUSDT"];

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, INTRADAY_PRO_LIQ_15M_V2, materializeIntradayEngineCfgSync } =
  await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

function summarizeTrades(trades) {
  const wins = trades.filter((t) => Number(t.netPnl) > 0);
  const grossWin = wins.reduce((s, t) => s + Number(t.netPnl), 0);
  const grossLoss = trades
    .filter((t) => Number(t.netPnl) <= 0)
    .reduce((s, t) => s + Math.abs(Number(t.netPnl)), 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const withFeatures = trades.filter((t) => t.liqContext?.features);
  const avgScore =
    withFeatures.length > 0
      ? withFeatures.reduce((s, t) => s + Number(t.liqContext.features.scoreV2?.total ?? 0), 0) /
        withFeatures.length
      : 0;
  const avgR =
    trades.length > 0
      ? trades.reduce((s, t) => s + Number(t.rMultiple ?? t.r ?? 0), 0) / trades.length
      : 0;
  return {
    n: trades.length,
    winPct: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPct: trades.reduce((s, t) => s + Number(t.netPnl), 0) / START * 100,
    pf: Number(pf.toFixed(2)),
    avgR: Number(avgR.toFixed(3)),
    avgScoreV2: Number(avgScore.toFixed(1)),
    featureCoveragePct: trades.length ? (withFeatures.length / trades.length) * 100 : 0,
  };
}

function evaluateOosGates(v1, v2) {
  const gates = {
    v2OosPfGt1: v2.summary.pf > 1.0,
    v2OosReturnGt0: v2.summary.netPct > 0,
    tradeCountNotHalved:
      v1.summary.n === 0 ? v2.summary.n > 0 : v2.summary.n >= v1.summary.n * 0.5,
    v2ImprovesAvgROrDd:
      v2.summary.avgR >= v1.summary.avgR || v2.maxDdPct <= v1.maxDdPct,
  };
  gates.pass = Object.values(gates).every(Boolean);
  return gates;
}

async function runPreset(symbol, preset, fromMs, toMs) {
  clearIntradayAdapterCache();
  const candles = await readCandles(symbol, TF, fromMs, toMs, { market: "futures" });
  if (!candles?.length) return null;
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
  const metrics = computeAllMetrics({
    trades: out.trades,
    equityCurve: out.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  return { trades: out.trades, metrics, summary: summarizeTrades(out.trades) };
}

const report = { generatedAt: new Date().toISOString(), windows: {}, promotion: {} };

for (const win of WINDOWS) {
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  report.windows[win.label] = {};
  for (const symbol of COINS) {
    report.windows[win.label][symbol] = {};
    for (const [name, preset] of [
      ["V1", INTRADAY_PRO_LIQ_15M],
      ["V2", INTRADAY_PRO_LIQ_15M_V2],
    ]) {
      process.stdout.write(`Running ${win.label} ${symbol} ${name}...\n`);
      const r = await runPreset(symbol, preset, fromMs, toMs);
      if (!r) {
        report.windows[win.label][symbol][name] = { error: "no candles" };
        continue;
      }
      report.windows[win.label][symbol][name] = {
        summary: r.summary,
        maxDdPct: Number(r.metrics.maxDrawdownPct ?? 0),
        cagrPct: Number(r.metrics.cagrPct ?? 0),
      };
    }
    const v1 = report.windows[win.label][symbol].V1;
    const v2 = report.windows[win.label][symbol].V2;
    if (v1?.summary && v2?.summary && win.label === "OOS") {
      report.promotion[symbol] = evaluateOosGates(v1, v2);
    }
  }
}

report.promotion.overallPass = Object.values(report.promotion).every(
  (g) => g && typeof g === "object" && g.pass === true,
);

const outPath = path.join(__dirname, ".liq-feature-expectancy.log");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(
  report.promotion.overallPass
    ? "\nOOS gates: PASS — V2 preset eligible for promotion review"
    : "\nOOS gates: FAIL — keep V1 as default; review gates before promoting V2",
);

await closePool();
