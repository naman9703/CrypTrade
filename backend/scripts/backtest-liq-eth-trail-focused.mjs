#!/usr/bin/env node
/**
 * Focused ETH trail search — PDH/PDL vs session, entry score, displacement.
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
const VARIANTS = [];
for (const pdhOnly of [true, false]) {
  for (const minES of [45, 48, 50, 52, 55]) {
    for (const disp of [1.2, 1.5, 2.0]) {
      for (const hold of [0, 1]) {
        VARIANTS.push({
          name: `pdh${pdhOnly ? 1 : 0}_es${minES}_d${disp}_h${hold}`,
          patch: {
            intradayLiqPdhPdlOnly: pdhOnly,
            intradayLiqMinEntryScore: minES,
            intradayLiqSweepDisplacementMinAtrMult: disp,
            intradayLiqReclaimHoldBars: hold,
            intradayLiqSessionExtreme: !pdhOnly,
          },
        });
      }
    }
  }
}

async function run(patch) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_ETH_15M, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const trailMicro = await buildTrailMicroContext({
    symbol: SYMBOL,
    fromMs: FROM,
    toMs: TO,
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
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const months = Math.max(1, (TO - FROM) / (30 * 86_400_000));
  return {
    n: sim.trades.length,
    tpm: sim.trades.length / months,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    dd: Number(m.maxDrawdownPct ?? 0),
  };
}

console.log("\nETH trail focused search\n");
const rows = [];
for (let i = 0; i < VARIANTS.length; i++) {
  const v = VARIANTS[i];
  process.stdout.write(`\r  ${i + 1}/${VARIANTS.length} ${v.name}`.padEnd(45));
  rows.push({ name: v.name, ...(await run(v.patch)) });
}
console.log("\n");

rows.sort((a, b) => b.ret - a.ret);
console.log("Top 20 by return:");
console.log(`${"name".padEnd(28)} ${"n".padStart(4)} ${"tpm".padStart(5)} ${"ret%".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(5)} ${"DD%".padStart(6)}`);
for (const r of rows.slice(0, 20)) {
  console.log(
    `${r.name.padEnd(28)} ${String(r.n).padStart(4)} ${r.tpm.toFixed(2).padStart(5)} ${r.ret.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(5)} ${r.wr.toFixed(0).padStart(5)} ${r.dd.toFixed(1).padStart(6)}`,
  );
}

const freq = [...rows].filter((r) => r.ret > -5).sort((a, b) => b.n - a.n);
console.log("\nBest freq with ret > -5%:");
for (const r of freq.slice(0, 10)) {
  console.log(`  ${r.name} n=${r.n} tpm=${r.tpm.toFixed(2)} ret=${r.ret.toFixed(2)}%`);
}

await closePool();
