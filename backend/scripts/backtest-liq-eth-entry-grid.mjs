#!/usr/bin/env node
/**
 * Focused ETH LIQ entry sweep — trend_pullback + trail, tune reclaim/quality/adx/htf.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const FROM = Date.parse("2025-06-01");
const TO = Date.parse("2026-06-01");
const H2_FROM = Date.parse("2025-07-01");
const H1_FROM = Date.parse("2026-01-01");
const START = 100;

const BASE = {
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  backtestTrailMicroTf: "5m",
  riskPerTrade: 3.5,
  intradayLiqMinRr: 2,
  intradayLiqVetoCounterTrend: true,
  intradayLiqEntryMode: "trend_pullback",
  intradayLiqPdhPdlOnly: false,
  intradayLiqSessionExtreme: false,
};

const GRID = [];
for (const minQ of [10, 12, 15, 18, 22]) {
  for (const reclaim of [0, 0.0005, 0.001, 0.0015, 0.002]) {
    for (const minAdx of [0, 14, 18, 22]) {
      for (const htfSep of [0, 0.0005, 0.0008, 0.0012]) {
        GRID.push({
          intradayLiqMinQuality: minQ,
          intradayLiqMinReclaimClosePct: reclaim,
          intradayLiqMinAdx: minAdx,
          intradayLiqMaxAdx: minAdx > 0 ? 50 : 0,
          intradayLiqMinHtfSep: htfSep,
        });
      }
    }
  }
}

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_ETH_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

const candles = await readCandles(SYMBOL, TF, FROM, TO, { market: "futures" });
const slice = (from, to) => candles.filter((c) => c.openTime >= from && c.openTime < to);

async function runOne(patch, barSlice, fromMs, toMs) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_ETH_15M, ...BASE, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, barSlice);
  const trailMicro = await buildTrailMicroContext({ symbol: SYMBOL, fromMs, toMs, cfg, trailEnabled: true });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: barSlice,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(barSlice, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  return { n: sim.trades.length, ret: Number(m.totalReturnPct ?? 0), dd: Number(m.maxDrawdownPct ?? 0) };
}

console.log(`\nFocused entry grid: ${GRID.length} combos\n`);
const rows = [];
for (let i = 0; i < GRID.length; i++) {
  if (i % 20 === 0) process.stdout.write(`\r  ${i}/${GRID.length}`);
  const patch = GRID[i];
  const full = await runOne(patch, candles, FROM, TO);
  if (full.n < 3) continue;
  const h2 = await runOne(patch, slice(H2_FROM, H1_FROM), H2_FROM, H1_FROM);
  const h1 = await runOne(patch, slice(H1_FROM, TO), H1_FROM, TO);
  rows.push({ patch, full, h2, h1, score: full.ret + h1.ret * 0.6 - full.dd * 0.1 });
}
console.log(`\n  ${rows.length} configs with >=3 trades\n`);

rows.sort((a, b) => b.score - a.score);
const fmt = (p) =>
  `Q${p.intradayLiqMinQuality} rc${p.intradayLiqMinReclaimClosePct} adx${p.intradayLiqMinAdx} htf${p.intradayLiqMinHtfSep}`;

console.log("Top 15:");
console.log(`${"cfg".padEnd(28)} full%   h2%   h1%  n  DD%`);
for (const r of rows.slice(0, 15)) {
  console.log(
    `${fmt(r.patch).padEnd(28)} ${r.full.ret.toFixed(2).padStart(5)} ${r.h2.ret.toFixed(2).padStart(5)} ${r.h1.ret.toFixed(2).padStart(5)} ${String(r.full.n).padStart(2)} ${r.full.dd.toFixed(1).padStart(4)}`,
  );
}

const bothPos = rows.filter((r) => r.full.ret > 0 && r.h1.ret > 0);
console.log(`\nDual-positive (full + H1'26): ${bothPos.length}`);
if (bothPos[0]) console.log(" best:", fmt(bothPos[0].patch), bothPos[0]);

await closePool();
