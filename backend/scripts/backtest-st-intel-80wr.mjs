#!/usr/bin/env node
/**
 * Reproduce validated ST + Intelligence gate 80%+ WR preset on BNBUSDT 15m.
 *
 *   node scripts/backtest-st-intel-80wr.mjs
 *   node scripts/backtest-st-intel-80wr.mjs --symbol BNBUSDT --from 2026-01-01 --to 2026-05-20
 *   node scripts/backtest-st-intel-80wr.mjs --wide-sl
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbol = String(arg("symbol", "BNBUSDT")).toUpperCase();
const tf = String(arg("tf", "15m"));
const wideSl = process.argv.includes("--wide-sl");
const fromMs = new Date(arg("from", "2026-01-01")).getTime();
const toMs = new Date(arg("to", "2026-05-20")).getTime();
const capital = Number(arg("capital", "100"));

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const {
  SUPERTREND_INTEL_80WR_PRESET,
  SUPERTREND_INTEL_80WR_WIDE_SL_PRESET,
} = await import("../src/strategy/presets/supertrendIntel80Wr.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const cfg = wideSl ? SUPERTREND_INTEL_80WR_WIDE_SL_PRESET : SUPERTREND_INTEL_80WR_PRESET;

const gateFn = await buildIntelligenceReplay({
  symbol,
  fromMs,
  toMs,
  candles,
  timeframe: tf,
  strictMode: cfg.intelligenceGateStrict === true,
  highWinRateMode: cfg.intelligenceGateHighWinRate === true,
});

const adapters = await buildBacktestAdapters({
  strategyKey: "SUPERTREND",
  cfg,
  symbol,
  tf,
  candles,
  fromMs,
});

const sim = await runSimulation({
  strategyKey: "SUPERTREND",
  candles,
  cfg,
  gateMode: "approx",
  gateFn,
  startingUsdt: capital,
  timeframe: tf,
  adapters,
  symbol,
});

const m = computeAllMetrics({
  trades: sim.trades,
  equityCurve: sim.equityCurve,
  tf,
  startingEquity: capital,
});

const wr = (m.winRate ?? 0) * 100;
const exits = {};
for (const t of sim.trades) {
  exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
}

console.log(`\n=== ST + Intel 80WR preset ===`);
console.log(`${symbol} ${tf}  ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
console.log(`SL ${(cfg.supertrendFuturesFixedSlPct * 100).toFixed(1)}%  TP ${(cfg.supertrendFuturesFixedTpPct * 100).toFixed(2)}%`);
console.log(`Trades ${m.totalTrades}  WR ${wr.toFixed(1)}%  Return ${(m.totalReturnPct ?? 0).toFixed(1)}%  PF ${(m.profitFactor ?? 0).toFixed(2)}`);
console.log(`Gate replay:`, sim.gateReplay);
console.log(`Confirmation:`, sim.confirmationReplay);
console.log(`Exits:`, exits);
console.log(wr >= 80 && (m.totalReturnPct ?? 0) > 0 ? "\n✓ Target met (80%+ WR, positive return)" : "\n✗ Target not met on this window");

await closePool?.();
