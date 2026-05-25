#!/usr/bin/env node
/** Quick strategy matrix — Jan–May 2026, BNB+BTC 15m */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const symbols = ["BNBUSDT", "BTCUSDT"];

const GRID = [
  { sl: 0.006, tp: 0.018 },
  { sl: 0.006, tp: 0.024 },
  { sl: 0.008, tp: 0.024 },
  { sl: 0.01, tp: 0.03 },
];

const STRATS = ["HTF_RSI", "APEX_TREND", "HTF_LEG_RIDER", "TREND_HTF_ST"];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const cache = new Map();
for (const sym of symbols) {
  const c = await readCandles(sym, "15m", fromMs, toMs);
  cache.set(sym, c);
  console.error(`${sym}: ${c.length} bars`);
}

const rows = [];
for (const sym of symbols) {
  const candles = cache.get(sym);
  for (const strat of STRATS) {
    for (const { sl, tp } of GRID) {
      for (const risk of [5, 7]) {
        const cfg = {
          marketMode: "FUTURES",
          futuresLeverage: 25,
          backtestPositionSizing: "RISK_AT_SL",
          riskPerTrade: risk,
          riskPerTradeUnit: "PCT_EQUITY",
          strategyMode: "MANUAL",
          manualStrategy: strat,
          supertrendFuturesFixedSlPct: sl,
          supertrendFuturesFixedTpPct: tp,
          trailingStopLossAuto: false,
          slippagePct: 0.0005,
          tradeHistoryTakerOpenFeeRate: 0.0004,
          tradeHistoryTakerCloseFeeRate: 0.0004,
          // TREND_HTF_ST entries use ST flip — must match tuned mult (see trendHtfStOptimized.js)
          ...(strat === "TREND_HTF_ST"
            ? { supertrendPeriod: 10, supertrendMultiplier: 2.5 }
            : {}),
        };
        const adapters = await buildBacktestAdapters({
          strategyKey: strat,
          cfg,
          symbol: sym,
          tf: "15m",
          candles,
          fromMs,
        });
        const sim = await runSimulation({
          strategyKey: strat,
          candles,
          cfg,
          gateMode: "off",
          fundingRates: [],
          startingUsdt: 100,
          timeframe: "15m",
          adapters,
          symbol: sym,
        });
        const m = computeAllMetrics({
          trades: sim.trades,
          equityCurve: sim.equityCurve,
          tf: "15m",
          startingEquity: 100,
        });
        const ret = m.totalReturnPct ?? 0;
        const wr = (m.winRate ?? 0) * 100;
        const n = m.totalTrades ?? 0;
        rows.push({ sym, strat, sl, tp, risk, ret, wr, n, score: ret * 1.2 + wr * 0.5 });
      }
    }
  }
}

rows.sort((a, b) => b.score - a.score);
console.log("\n── TOP 20 (Jan–May 2026) ──");
console.log(
  `${"sym".padEnd(8)} ${"strategy".padEnd(14)} ${"SL/TP".padStart(10)} ${"risk".padStart(4)} ${"n".padStart(4)} ${"ret%".padStart(8)} ${"WR%".padStart(6)}`,
);
console.log("-".repeat(60));
for (const r of rows.slice(0, 20)) {
  const sltp = `${(r.sl * 100).toFixed(1)}/${(r.tp * 100).toFixed(1)}`;
  console.log(
    `${r.sym.padEnd(8)} ${r.strat.padEnd(14)} ${sltp.padStart(10)} ${String(r.risk).padStart(4)} ${String(r.n).padStart(4)} ${r.ret.toFixed(1).padStart(8)} ${r.wr.toFixed(1).padStart(6)}`,
  );
}

const bestWr = [...rows].filter((r) => r.n >= 8).sort((a, b) => b.wr - a.wr || b.ret - a.ret)[0];
const bestRet = [...rows].filter((r) => r.n >= 8).sort((a, b) => b.ret - a.ret)[0];
console.log("\nBest WR (n≥8):", bestWr);
console.log("Best return (n≥8):", bestRet);

await closePool?.();
