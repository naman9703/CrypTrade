#!/usr/bin/env node
/** Compare flip-only adapter vs emit-every-signal trade count (simulated). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runs = await pool.query(
  `SELECT id, start_date, end_date, symbol, timeframe, config_snapshot
     FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`,
);
const run = runs.rows[1];
const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { strategies } = await import("../src/strategy/strategies.js");
const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);

let lastDir = 0;
let flipSignals = 0;
let allSignals = 0;
for (let i = 80; i < candles.length - 1; i++) {
  const slice = candles.slice(0, i + 1);
  const sig = strategies.HTF_RSI.signal({ candles: slice, timeframe: run.timeframe });
  if (!sig || sig.action === "HOLD") continue;
  allSignals++;
  if (sig.action === "BUY" && lastDir !== 1) {
    flipSignals++;
    lastDir = 1;
  } else if (sig.action === "SELL" && lastDir !== -1) {
    flipSignals++;
    lastDir = -1;
  }
}

// Simulate flat re-entry: count signals whenever flat (avg hold 3 bars proxy)
let pos = null;
let entries = 0;
let entriesEmitAll = 0;
const avgHold = 4;
for (let i = 80; i < candles.length - 1; i++) {
  const slice = candles.slice(0, i + 1);
  const sig = strategies.HTF_RSI.signal({ candles: slice, timeframe: run.timeframe });
  if (pos) {
    pos.bars--;
    if (pos.bars <= 0) pos = null;
  }
  if (!sig || sig.action === "HOLD") continue;
  if (!pos) {
    entriesEmitAll++;
    pos = { bars: avgHold };
  }
  if (sig.action === "BUY" && lastDir !== 1) {
    if (!pos) entries++;
    lastDir = 1;
  } else if (sig.action === "SELL" && lastDir !== -1) {
    if (!pos) entries++;
    lastDir = -1;
  }
}

console.log("HTF_RSI signal counts on run", run.id.slice(0, 8));
console.log("  Strategy BUY/SELL bars (any):", allSignals);
console.log("  Flip-only (current adapter):", flipSignals);
console.log("  Actual backtest trades: 29");
console.log("  Est. entries if re-enter when flat:", entriesEmitAll, "(~4 bar hold proxy)");

await closePool();
