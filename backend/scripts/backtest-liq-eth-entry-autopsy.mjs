#!/usr/bin/env node
/**
 * ETH LIQ entry autopsy — classify winners vs losers (trail exit, full year).
 * Usage: cd backend && node scripts/backtest-liq-eth-entry-autopsy.mjs
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

const TRAIL_CFG = {
  riskPerTrade: 3.5,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  trailingStopLossAuto: true,
  trailOnlyAfterTp2Fill: false,
  intradayLiqMinRr: 2,
  intradayLiqMinQuality: 10,
  intradayLiqMaxTpRr: 3.35,
  intradayLiqMinReclaimClosePct: 0,
  intradayLiqVetoCounterTrend: false,
  backtestTrailMicroTf: "5m",
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
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

clearIntradayAdapterCache();
let cfg = materializeIntradayEngineCfgSync(
  { ...INTRADAY_PRO_LIQ_ETH_15M, ...TRAIL_CFG, symbol: SYMBOL, timeframe: TF },
  materializeIntradayPanelOnCfg,
);
const candles = await readCandles(SYMBOL, TF, FROM_MS, TO_MS, { market: "futures" });
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
  startingUsdt: 100,
  timeframe: TF,
  symbol: SYMBOL,
  adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  trailMicro,
});

function liq(t) {
  return t.liqContext ?? t.signalContext?.liq ?? {};
}

const rows = sim.trades.map((t) => {
  const l = liq(t);
  const pnl = Number(t.netPnl ?? 0);
  return {
    pnl,
    win: pnl > 0,
    dir: t.direction,
    exit: t.exitReason,
    level: l.levelType ?? "?",
    qual: l.liqQuality ?? l.quality,
    ext: l.extension,
    htf: l.htfAlign ?? l.htf,
  };
});

const wins = rows.filter((r) => r.win);
const losses = rows.filter((r) => !r.win);
const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);

function bucket(arr, key) {
  const m = new Map();
  for (const r of arr) {
    const k = String(r[key] ?? "?");
    const b = m.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    b.n++;
    b.pnl += r.pnl;
    if (r.win) b.wins++;
    m.set(k, b);
  }
  return [...m.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
}

console.log("\nETH LIQ entry autopsy (trail exit, Jun25–May26)");
console.log(`trades=${rows.length} net=$${sum(rows, "pnl").toFixed(2)} WR=${((wins.length / Math.max(1, rows.length)) * 100).toFixed(1)}%`);
console.log("\nBy levelType:");
for (const [k, v] of bucket(rows, "level")) {
  console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(3)} WR=${((v.wins / v.n) * 100).toFixed(0).padStart(3)}% net=$${v.pnl.toFixed(2)}`);
}
console.log("\nBy direction:");
for (const [k, v] of bucket(rows, "dir")) {
  console.log(`  ${k.padEnd(6)} n=${String(v.n).padStart(3)} WR=${((v.wins / v.n) * 100).toFixed(0).padStart(3)}% net=$${v.pnl.toFixed(2)}`);
}
console.log("\nBy exit:");
for (const [k, v] of bucket(rows, "exit")) {
  console.log(`  ${k.padEnd(12)} n=${String(v.n).padStart(3)} net=$${v.pnl.toFixed(2)}`);
}

const wq = wins.map((r) => Number(r.qual)).filter(Number.isFinite);
const lq = losses.map((r) => Number(r.qual)).filter(Number.isFinite);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`\nAvg quality: wins=${avg(wq).toFixed(1)} losses=${avg(lq).toFixed(1)}`);
console.log(`Avg extension: wins=${avg(wins.map((r) => r.ext).filter(Number.isFinite)).toFixed(4)} losses=${avg(losses.map((r) => r.ext).filter(Number.isFinite)).toFixed(4)}`);

await closePool();
