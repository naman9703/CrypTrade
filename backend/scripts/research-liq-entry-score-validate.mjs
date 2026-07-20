#!/usr/bin/env node
/**
 * Validate context entry score vs baseline (multi-coin train/val/oos).
 * Usage: cd backend && node scripts/research-liq-entry-score-validate.mjs
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
  {
    name: "baseline",
    patch: {
      intradayLiqUseEntryScore: false,
      intradayLiqReclaimHoldBars: 0,
    },
  },
  ...[42, 45, 48, 50, 52].map((minEntryScore) => ({
    name: `score_${minEntryScore}`,
    patch: {
      intradayLiqUseEntryScore: true,
      intradayLiqMinEntryScore: minEntryScore,
      intradayLiqReclaimHoldBars: 1,
      intradayLiqMinQuality: 0,
    },
  })),
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
  return {
    n: sim.trades.length,
    tpm: sim.trades.length / months,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
  };
}

console.log("\nEntry context score validation\n");
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
    coinsPos: xs.filter((x) => x.ret > 0).length,
    runs: xs.length,
  };
}

for (const label of ["train", "val", "oos", "all"]) {
  console.log(`${label}:`);
  for (const v of VARIANTS) {
    const s = agg(v.name, label);
    console.log(
      `  ${v.name.padEnd(12)} retΣ=${String(s.ret.toFixed(2)).padStart(8)}% n=${String(s.n).padStart(4)} tpm=${s.avgTpm.toFixed(2)} coins+=${s.coinsPos}/${s.runs}`,
    );
  }
  console.log("");
}

const scored = VARIANTS.filter((v) => v.name !== "baseline").map((v) => {
  const oos = agg(v.name, "oos");
  const val = agg(v.name, "val");
  const all = agg(v.name, "all");
  return {
    name: v.name,
    min: v.patch.intradayLiqMinEntryScore,
    oosRet: oos.ret,
    valRet: val.ret,
    allRet: all.ret,
    oosN: oos.n,
    oosTpm: oos.avgTpm,
    oosCoinsPos: oos.coinsPos,
    score: oos.ret + val.ret * 0.35 + all.ret * 0.15 - Math.max(0, 40 - oos.n) * 0.05,
  };
});
scored.sort((a, b) => b.score - a.score);
console.log("Ranked score variants (favor OOS + trade count):");
for (const s of scored) {
  console.log(
    `  min=${s.min} oos=${s.oosRet.toFixed(2)}% val=${s.valRet.toFixed(2)}% all=${s.allRet.toFixed(2)}% n=${s.oosN} tpm=${s.oosTpm.toFixed(2)}`,
  );
}

await closePool();
