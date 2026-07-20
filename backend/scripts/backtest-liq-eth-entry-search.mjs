#!/usr/bin/env node
/**
 * ETH LIQ entry-mode search — trail exit fixed, compare entry routers (full year).
 * Usage: cd backend && node scripts/backtest-liq-eth-entry-search.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const FROM_MS = Date.parse("2025-06-01");
const TO_MS = Date.parse("2026-06-01");
const START = 100;

const TRAIL_BASE = {
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  backtestTrailMicroTf: "5m",
  riskPerTrade: 3.5,
  intradayLiqMinRr: 2,
  intradayLiqMinReclaimClosePct: 0.001,
  intradayLiqMinReclaimBodyRatio: 0.4,
  intradayLiqVetoCounterTrend: true,
};

const VARIANTS = [
  { name: "fade_baseline", patch: { intradayLiqEntryMode: "fade", intradayLiqMinQuality: 10 } },
  { name: "trend_pullback", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 15 } },
  {
    name: "trend_pdh_pdl",
    patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqPdhPdlOnly: true, intradayLiqMinQuality: 15 },
  },
  {
    name: "trend_adx_band",
    patch: {
      intradayLiqEntryMode: "trend_pullback",
      intradayLiqMinAdx: 18,
      intradayLiqMaxAdx: 48,
      intradayLiqMinQuality: 15,
    },
  },
  { name: "eth_preset", patch: {} },
];

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

const candles = await readCandles(SYMBOL, TF, FROM_MS, TO_MS, { market: "futures" });

async function runVariant(name, patch) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_ETH_15M, ...TRAIL_BASE, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const trailMicro = await buildTrailMicroContext({
    symbol: SYMBOL,
    fromMs: FROM_MS,
    toMs: TO_MS,
    cfg,
    trailEnabled: true,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const exits = {};
  let sl = 0;
  let trail = 0;
  for (const t of sim.trades) {
    const r = t.exitReason ?? "?";
    exits[r] = (exits[r] ?? 0) + 1;
    if (r === "sl") sl++;
    if (r === "trail") trail++;
  }
  return {
    name,
    n: sim.trades.length,
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    dd: +Number(m.maxDrawdownPct ?? 0).toFixed(1),
    pf: +Number(m.profitFactor ?? 0).toFixed(2),
    wr: +((Number(m.winRate ?? 0) * 100).toFixed(1)),
    sl,
    trail,
    exits,
  };
}

console.log("\nETH LIQ entry search (trail exit, Jun25–May26)\n");
console.log(`${"variant".padEnd(18)} ${"n".padStart(4)} ${"ret%".padStart(8)} ${"DD%".padStart(6)} ${"PF".padStart(5)} ${"WR%".padStart(6)} sl trail`);
const results = [];
for (const v of VARIANTS) {
  process.stdout.write(`\r  running ${v.name}…`);
  results.push(await runVariant(v.name, v.patch));
}
console.log("\n");
for (const r of results.sort((a, b) => b.ret - a.ret)) {
  console.log(
    `${r.name.padEnd(18)} ${String(r.n).padStart(4)} ${String(r.ret).padStart(8)} ${String(r.dd).padStart(6)} ${String(r.pf).padStart(5)} ${String(r.wr).padStart(6)} ${String(r.sl).padStart(3)} ${String(r.trail).padStart(5)}`,
  );
}

await closePool();
