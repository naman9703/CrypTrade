#!/usr/bin/env node
/** Scale ST+Intel — find WR>=80% and max return (target 1000%+). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const symbol = String(arg("symbol", "BNBUSDT")).toUpperCase();
const fromMs = new Date(arg("from", "2025-06-01")).getTime();
const toMs = new Date(arg("to", "2026-05-20")).getTime();
const minWr = Number(arg("minWr", "80"));
const targetRet = Number(arg("targetRet", "1000"));

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const { SUPERTREND_INTEL_80WR_PRESET } = await import("../src/strategy/presets/supertrendIntel80Wr.js");

const tf = "15m";
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const gateFn = await buildIntelligenceReplay({
  symbol,
  fromMs,
  toMs,
  candles,
  timeframe: tf,
  strictMode: false,
});

const baseCfg = { symbol, timeframe: tf, marketMode: "FUTURES", ...SUPERTREND_INTEL_80WR_PRESET };
const adapters = await buildBacktestAdapters({
  strategyKey: "SUPERTREND",
  cfg: baseCfg,
  symbol,
  tf,
  candles,
  fromMs,
});

const TPS = [0.005, 0.007, 0.01, 0.012, 0.015, 0.02];
const SLS = [0.015, 0.02, 0.025, 0.03];
const RISK_LEV = [
  [5, 10],
  [8, 15],
  [10, 20],
  [12, 25],
  [15, 30],
  [18, 35],
  [20, 40],
  [25, 50],
  [30, 50],
  [40, 50],
  [50, 50],
];

const rows = [];
let done = 0;
const total = TPS.length * SLS.length * RISK_LEV.length;

for (const tp of TPS) {
  for (const sl of SLS) {
    if (tp >= sl) continue;
    for (const [risk, lev] of RISK_LEV) {
      done++;
      const cfg = {
        ...baseCfg,
        supertrendFuturesFixedTpPct: tp,
        supertrendFuturesFixedSlPct: sl,
        riskPerTrade: risk,
        futuresLeverage: lev,
      };
      const sim = await runSimulation({
        strategyKey: "SUPERTREND",
        candles,
        cfg,
        gateMode: "approx",
        gateFn,
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
      const wr = (m.winRate ?? 0) * 100;
      const ret = m.totalReturnPct ?? 0;
      const n = m.totalTrades ?? 0;
      if (n >= 5 && wr >= minWr) {
        rows.push({ tp, sl, risk, lev, wr, ret, n, pf: m.profitFactor });
        if (ret >= targetRet) {
          console.log(
            `★ WR${wr.toFixed(1)}% ret${ret.toFixed(0)}% n=${n} TP${(tp * 100).toFixed(2)}% SL${(sl * 100).toFixed(1)}% risk${risk}% ${lev}x`,
          );
        }
      }
      if (done % 20 === 0) process.stdout.write(`\r  ${done}/${total}`);
    }
  }
}
console.log(`\n\n${symbol} ${new Date(fromMs).toISOString().slice(0, 10)}→${new Date(toMs).toISOString().slice(0, 10)}`);
console.log(`${rows.length} configs WR≥${minWr}% (≥5 trades)\n`);

rows.sort((a, b) => b.ret - a.ret);
for (const r of rows.slice(0, 25)) {
  console.log(
    `${r.ret >= targetRet ? "★" : " "} WR${r.wr.toFixed(1)}% ret${r.ret.toFixed(1)}% n=${r.n} TP${(r.tp * 100).toFixed(2)}% SL${(r.sl * 100).toFixed(1)}% risk${r.risk}% ${r.lev}x pf${(r.pf ?? 0).toFixed(2)}`,
  );
}

const dual = rows.filter((r) => r.wr >= minWr && r.ret >= targetRet);
if (dual[0]) {
  console.log("\n=== DUAL TARGET MET ===");
  console.log(JSON.stringify(dual[0], null, 2));
} else if (rows[0]) {
  console.log(`\nBest WR≥${minWr}%: ret ${rows[0].ret.toFixed(1)}% (target ${targetRet}% not reached)`);
}

await closePool?.();
