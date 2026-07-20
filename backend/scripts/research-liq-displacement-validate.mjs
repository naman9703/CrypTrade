#!/usr/bin/env node
/**
 * Validate sweep→reclaim displacement requirement vs baseline (multi-coin, train/val/oos).
 * Usage: cd backend && node scripts/research-liq-displacement-validate.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TF = "15m";
const COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "LINKUSDT"];
const WINDOWS = {
  train: { from: Date.parse("2024-01-01"), to: Date.parse("2025-06-01") },
  val: { from: Date.parse("2025-06-01"), to: Date.parse("2025-12-01") },
  oos: { from: Date.parse("2025-12-01"), to: Date.parse("2026-06-01") },
};
const VARIANTS = [
  { name: "baseline", patch: {} },
  {
    name: "disp_1.5",
    patch: { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 1.5 },
  },
  {
    name: "disp_2.0",
    patch: { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 2.0 },
  },
  {
    name: "disp_1.5_hold1",
    patch: {
      intradayLiqRequireSweepDisplacement: true,
      intradayLiqSweepDisplacementMinAtrMult: 1.5,
      intradayLiqReclaimHoldBars: 1,
    },
  },
];

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

async function run(symbol, win, patch) {
  const candles = await readCandles(symbol, TF, win.from, win.to, { market: "futures" });
  if (candles.length < 500) return null;
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, ...patch, symbol, timeframe: TF, trailingStopLossAuto: false },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const months = Math.max(1, (win.to - win.from) / (30 * 86_400_000));
  const net = sim.trades.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);
  return {
    n: sim.trades.length,
    tpm: sim.trades.length / months,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    dd: Number(m.maxDrawdownPct ?? 0),
    expectancy: sim.trades.length ? net / sim.trades.length : 0,
  };
}

console.log("\nSweep displacement validation (INTRADAY_PRO_LIQ_15M)\n");
const rows = [];
for (const v of VARIANTS) {
  for (const symbol of COINS) {
    for (const [label, win] of Object.entries(WINDOWS)) {
      process.stdout.write(`\r  ${v.name} ${symbol} ${label}`);
      try {
        const r = await run(symbol, win, v.patch);
        if (r) rows.push({ variant: v.name, symbol, window: label, ...r });
      } catch {
        /* skip */
      }
    }
  }
}
console.log("\n");

function agg(variant, windowLabel) {
  const xs = rows.filter((r) => r.variant === variant && (windowLabel === "all" || r.window === windowLabel));
  return {
    n: xs.reduce((a, x) => a + x.n, 0),
    ret: xs.reduce((a, x) => a + x.ret, 0),
    avgTpm: xs.length ? xs.reduce((a, x) => a + x.tpm, 0) / xs.length : 0,
    avgPf: xs.length ? xs.reduce((a, x) => a + x.pf, 0) / xs.length : 0,
    coinsPos: xs.filter((x) => x.ret > 0).length,
    coinRuns: xs.length,
    avgExpectancy: xs.length ? xs.reduce((a, x) => a + x.expectancy, 0) / xs.length : 0,
  };
}

for (const label of ["train", "val", "oos", "all"]) {
  console.log(`${label.padEnd(6)} summary (Σret%, total trades, avg tpm, coins+):`);
  for (const v of VARIANTS) {
    const s = agg(v.name, label);
    console.log(
      `  ${v.name.padEnd(16)} retΣ=${s.ret.toFixed(2).padStart(8)}% n=${String(s.n).padStart(4)} tpm=${s.avgTpm.toFixed(2)} coins+=${s.coinsPos}/${s.coinRuns}`,
    );
  }
  console.log("");
}

console.log(`${"variant".padEnd(16)} ${"coin".padEnd(10)} ${"win".padEnd(6)} ${"n".padStart(4)} ${"tpm".padStart(5)} ${"ret%".padStart(8)} ${"PF".padStart(6)} ${"exp$".padStart(7)}`);
for (const r of rows.sort((a, b) => a.variant.localeCompare(b.variant) || a.symbol.localeCompare(b.symbol))) {
  console.log(
    `${r.variant.padEnd(16)} ${r.symbol.padEnd(10)} ${r.window.padEnd(6)} ${String(r.n).padStart(4)} ${r.tpm.toFixed(2).padStart(5)} ${r.ret.toFixed(2).padStart(8)} ${r.pf.toFixed(2).padStart(6)} ${r.expectancy.toFixed(3).padStart(7)}`,
  );
}

await closePool();
