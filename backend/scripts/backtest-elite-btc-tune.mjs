#!/usr/bin/env node
/**
 * BTC vs BNB SUPERTREND_ELITE 1H diagnosis + BTC param sweep.
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-09";
const RISK = Number(process.env.RISK || 5);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  normalizeEliteStRunCfg,
} = await import("../src/strategy/supertrendElite.js");
const { SUPERTREND_ELITE_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const candleCache = {};

async function candles(sym) {
  if (!candleCache[sym]) {
    candleCache[sym] = await readCandles(sym, "1h", fromMs, toMs, { market: "futures" });
  }
  return candleCache[sym];
}

async function runSym(sym, over = {}) {
  const c = await candles(sym);
  const cfg = normalizeEliteStRunCfg({
    ...SUPERTREND_ELITE_1H_PRESET,
    symbol: sym,
    timeframe: "1h",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    ...over,
  });
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles: c,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: "1h",
    adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(c, buildEliteStOptsFromCfg(cfg)) },
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "1h", startingEquity: 1000 });
  const trades = sim.trades.filter((t) => t.exitReason !== "tp1_partial");
  const liq = trades.filter((t) => t.exitReason === "liq").length;
  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    n: trades.length,
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRatePct ?? 0),
    liq,
  };
}

const sweeps = [
  ["base (BNB-tuned)", {}],
  ["ST m3.5 / 4H m3.5", { supertrendMultiplier: 3.5, eliteStHtf4hMultiplier: 3.5 }],
  ["ST m4 / 4H m4", { supertrendMultiplier: 4, eliteStHtf4hMultiplier: 4 }],
  ["ST m4.5 / 4H m4.5", { supertrendMultiplier: 4.5, eliteStHtf4hMultiplier: 4.5 }],
  ["1H EMA sep 0.05%", { eliteStHtf1hMinSep: 0.0005 }],
  ["1H EMA sep 0.08%", { eliteStHtf1hMinSep: 0.0008 }],
  ["ADX≥20 rising", { eliteStMinAdx: 20, eliteStRequireAdxRising: true }],
  ["vol≥1.2×", { eliteStMinVolumeVsAvg: 1.2 }],
  ["m4 + sep 0.05%", { supertrendMultiplier: 4, eliteStHtf4hMultiplier: 4, eliteStHtf1hMinSep: 0.0005 }],
  ["m4 + ADX20", { supertrendMultiplier: 4, eliteStHtf4hMultiplier: 4, eliteStMinAdx: 20, eliteStRequireAdxRising: true }],
  ["m3.5 + sep 0.05%", { supertrendMultiplier: 3.5, eliteStHtf4hMultiplier: 3.5, eliteStHtf1hMinSep: 0.0005 }],
  ["m4 + sep0.05 + ADX20", { supertrendMultiplier: 4, eliteStHtf4hMultiplier: 4, eliteStHtf1hMinSep: 0.0005, eliteStMinAdx: 20, eliteStRequireAdxRising: true }],
  ["sizing stop 1.5%", { backtestSizingStopPct: 0.015 }],
  ["m4 + sizing 1.5%", { supertrendMultiplier: 4, eliteStHtf4hMultiplier: 4, backtestSizingStopPct: 0.015 }],
];

console.log(`\n=== SUPERTREND_ELITE 1H — ${FROM} → ${TO} @ ${RISK}% risk ===\n`);
console.log(`${"config".padEnd(28)}${"BNB ret".padStart(9)}${"BNB dd".padStart(8)}${"BTC ret".padStart(9)}${"BTC dd".padStart(8)}${"BTC liq".padStart(8)}${"BTC n".padStart(6)}`);
let best = null;
for (const [label, over] of sweeps) {
  const bnb = await runSym("BNBUSDT", over);
  const btc = await runSym("BTCUSDT", over);
  console.log(
    `${label.padEnd(28)}${bnb.ret.toFixed(1).padStart(9)}${bnb.dd.toFixed(1).padStart(8)}${btc.ret.toFixed(1).padStart(9)}${btc.dd.toFixed(1).padStart(8)}${String(btc.liq).padStart(8)}${String(btc.n).padStart(6)}`,
  );
  if (!best || btc.ret > best.btc.ret) best = { label, over, bnb, btc };
}
console.log(`\nBest BTC config: ${best.label} → ret ${best.btc.ret.toFixed(1)}% dd ${best.btc.dd.toFixed(1)}% (BNB ${best.bnb.ret.toFixed(1)}%)`);

await closePool?.();
