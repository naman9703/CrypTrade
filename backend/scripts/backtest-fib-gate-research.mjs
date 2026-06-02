#!/usr/bin/env node
/**
 * Tune strict fib gate — BNB 15m.
 * Usage: npm run backtest:fib-gate -- [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BNBUSDT";
const tf = "15m";
const fromArg = process.argv[2] || "2026-01-01";
const toArg = process.argv[3] || "2026-05-25";
const fromMs = Date.parse(fromArg);
const toMs = Date.parse(toArg);

const { INTRADAY_PRO_FIB_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

function fibCfg(extra = {}) {
  return {
    ...INTRADAY_PRO_FIB_15M,
    symbol,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    ...extra,
  };
}

const SCENARIOS = [
  { label: "FIB_15M_preset", cfg: fibCfg() },
  {
    label: "scalp_tighter",
    cfg: fibCfg({
      intradayFibScalpTpPct: 0.0035,
      intradayFibScalpSlPct: 0.0022,
      intradayFibMinWickRatio: 0.48,
    }),
  },
  {
    label: "partial_leg",
    cfg: fibCfg({
      intradayFibTpMode: "partial_leg",
      intradayFibPartialLegFrac: 0.28,
      intradayFibMaxTpPct: 0.008,
    }),
  },
];

let candles = null;

async function runOne(label, cfg) {
  if (!candles) candles = await readCandles(symbol, tf, fromMs, toMs);
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  return {
    label,
    n: m.totalTrades,
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
  };
}

await initPool({ info: () => {}, warn: console.warn, error: console.error });
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });

console.log(`\nFib gate · ${symbol} ${tf} · ${fromArg} → ${toArg}\n`);
const rows = [];
for (const s of SCENARIOS) {
  const r = await runOne(s.label, s.cfg);
  rows.push(r);
  console.log(`${r.label.padEnd(18)} n=${String(r.n).padStart(3)}  WR=${String(r.wr).padStart(5)}%  ret=${String(r.ret).padStart(7)}%  PF=${r.pf}`);
}
const best = rows.filter((r) => r.n >= 2).sort((a, b) => b.wr - a.wr || b.ret - a.ret)[0];
console.log(best ? `\nBest (n≥2): ${best.label} — ${best.wr}% WR, ${best.n} trades` : "\nToo few trades — loosen filters or widen window.");
await closePool();
