#!/usr/bin/env node
/**
 * ETH trail-only LIQ search — displacement + context score + frequency gates.
 * Usage: cd backend && node scripts/backtest-liq-eth-trail-search.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const WINDOWS = {
  full: { from: Date.parse("2025-06-01"), to: Date.parse("2026-06-01") },
  h1: { from: Date.parse("2025-06-01"), to: Date.parse("2025-12-01") },
  h2: { from: Date.parse("2025-12-01"), to: Date.parse("2026-06-01") },
};

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

const candlesByWin = {};
for (const [k, w] of Object.entries(WINDOWS)) {
  candlesByWin[k] = await readCandles(SYMBOL, TF, w.from, w.to, { market: "futures" });
}

const VARIANTS = [];
VARIANTS.push({ name: "preset_default", patch: {} });

for (const minES of [40, 42, 45, 48, 50]) {
  for (const disp of [1.0, 1.2, 1.5]) {
    for (const hold of [0, 1]) {
      for (const pdhOnly of [false, true]) {
        VARIANTS.push({
          name: `es${minES}_d${disp}_h${hold}_pdh${pdhOnly ? 1 : 0}`,
          patch: {
            intradayLiqMinEntryScore: minES,
            intradayLiqSweepDisplacementMinAtrMult: disp,
            intradayLiqReclaimHoldBars: hold,
            intradayLiqPdhPdlOnly: pdhOnly,
          },
        });
      }
    }
  }
}

async function runWin(patch, winKey) {
  const win = WINDOWS[winKey];
  const candles = candlesByWin[winKey];
  if (candles.length < 500) return null;
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_ETH_15M, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const trailMicro = await buildTrailMicroContext({
    symbol: SYMBOL,
    fromMs: win.from,
    toMs: win.to,
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
  const months = Math.max(1, (win.to - win.from) / (30 * 86_400_000));
  return {
    n: sim.trades.length,
    tpm: sim.trades.length / months,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    dd: Number(m.maxDrawdownPct ?? 0),
  };
}

async function runVariant(v) {
  const full = await runWin(v.patch, "full");
  const h1 = await runWin(v.patch, "h1");
  const h2 = await runWin(v.patch, "h2");
  return { name: v.name, full, h1, h2 };
}

console.log("\nETH trail-only LIQ search\n");
const results = [];
let i = 0;
for (const v of VARIANTS) {
  i++;
  process.stdout.write(`\r  ${i}/${VARIANTS.length} ${v.name}`.padEnd(50));
  try {
    results.push(await runVariant(v));
  } catch (e) {
    results.push({ name: v.name, error: String(e.message ?? e) });
  }
}
console.log("\n");

const ok = results.filter((r) => r.full && r.full.n > 0);
ok.sort((a, b) => {
  const scoreA = a.full.ret + a.h2.ret * 0.5 + Math.min(a.full.tpm, 1) * 5;
  const scoreB = b.full.ret + b.h2.ret * 0.5 + Math.min(b.full.tpm, 1) * 5;
  return scoreB - scoreA;
});

console.log("Top 15 (full year, favor ret + H2 + trade freq):");
console.log(
  `${"variant".padEnd(28)} ${"n".padStart(4)} ${"tpm".padStart(5)} ${"ret%".padStart(7)} ${"h1%".padStart(7)} ${"h2%".padStart(7)} ${"PF".padStart(5)} ${"WR%".padStart(5)}`,
);
for (const r of ok.slice(0, 15)) {
  console.log(
    `${r.name.padEnd(28)} ${String(r.full.n).padStart(4)} ${r.full.tpm.toFixed(2).padStart(5)} ${r.full.ret.toFixed(2).padStart(7)} ${(r.h1?.ret ?? 0).toFixed(2).padStart(7)} ${(r.h2?.ret ?? 0).toFixed(2).padStart(7)} ${r.full.pf.toFixed(2).padStart(5)} ${r.full.wr.toFixed(0).padStart(5)}`,
  );
}

const freq = [...ok].sort((a, b) => b.full.n - a.full.n);
console.log("\nTop 10 by trade count:");
for (const r of freq.slice(0, 10)) {
  console.log(`  ${r.name.padEnd(28)} n=${r.full.n} ret=${r.full.ret.toFixed(2)}% h2=${(r.h2?.ret ?? 0).toFixed(2)}%`);
}

await closePool();
