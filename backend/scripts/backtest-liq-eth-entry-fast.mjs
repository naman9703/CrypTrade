#!/usr/bin/env node
/**
 * Fast ETH LIQ entry variants — trail fixed, ~25 hand-picked entry patches.
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
const H2 = [Date.parse("2025-07-01"), Date.parse("2026-01-01")];
const H1 = [Date.parse("2026-01-01"), TO];
const START = 100;

const TRAIL = {
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  backtestTrailMicroTf: "5m",
  riskPerTrade: 3.5,
  intradayLiqMinRr: 2,
  intradayLiqVetoCounterTrend: true,
};

const VARIANTS = [
  { name: "trend_loose", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 10, intradayLiqMinReclaimClosePct: 0, intradayLiqSessionExtreme: false } },
  { name: "trend_preset", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 15, intradayLiqMinReclaimClosePct: 0.001, intradayLiqMinAdx: 18, intradayLiqMaxAdx: 48, intradayLiqSessionExtreme: false } },
  { name: "trend_tight", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 20, intradayLiqMinReclaimClosePct: 0.0015, intradayLiqMinAdx: 20, intradayLiqMaxAdx: 45, intradayLiqMinHtfSep: 0.001 } },
  { name: "trend_pdl_only", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 12, intradayLiqPdhPdlOnly: true, intradayLiqSessionExtreme: false } },
  { name: "trend_sess_on", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 12, intradayLiqSessionExtreme: true } },
  { name: "trend_big_sweep", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 12, intradayLiqMinSweepExtensionPct: 0.006 } },
  { name: "trend_no_adx", patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqMinQuality: 12, intradayLiqMinAdx: 0, intradayLiqMaxAdx: 0, intradayLiqMinReclaimClosePct: 0 } },
  { name: "fade_loose", patch: { intradayLiqEntryMode: "fade", intradayLiqMinQuality: 10, intradayLiqVetoCounterTrend: false } },
  { name: "fade_veto", patch: { intradayLiqEntryMode: "fade", intradayLiqMinQuality: 12, intradayLiqVetoCounterTrend: true } },
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

const candles = await readCandles(SYMBOL, TF, FROM, TO, { market: "futures" });
const slice = (r) => candles.filter((c) => c.openTime >= r[0] && c.openTime < r[1]);

async function run(name, patch, bars, fromMs, toMs) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_ETH_15M, ...TRAIL, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, bars);
  const trailMicro = await buildTrailMicroContext({ symbol: SYMBOL, fromMs, toMs, cfg, trailEnabled: true });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: bars,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(bars, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  let trail = 0;
  for (const t of sim.trades) if (t.exitReason === "trail") trail++;
  return { name, n: sim.trades.length, ret: +Number(m.totalReturnPct ?? 0).toFixed(2), trail };
}

console.log("\nETH LIQ fast entry variants (trail exit)\n");
console.log(`${"variant".padEnd(16)} full_n full% h2% h1% trail`);
for (const v of VARIANTS) {
  process.stdout.write(`\r  ${v.name}`);
  const full = await run(v.name, v.patch, candles, FROM, TO);
  const h2 = await run(v.name, v.patch, slice(H2), H2[0], H2[1]);
  const h1 = await run(v.name, v.patch, slice(H1), H1[0], H1[1]);
  console.log(`\r${v.name.padEnd(16)} ${String(full.n).padStart(6)} ${String(full.ret).padStart(6)} ${String(h2.ret).padStart(5)} ${String(h1.ret).padStart(5)} ${String(full.trail).padStart(5)}`);
}

await closePool();
