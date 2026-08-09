#!/usr/bin/env node
import { initPool, getPool, closePool } from "../src/db/pool.js";
import { readCandles } from "../src/backtest/data/klineIngest.js";
import { readFundingRates } from "../src/backtest/data/fundingIngest.js";
import { runSimulation } from "../src/backtest/engine/runner.js";
import { computeAllMetrics } from "../src/backtest/engine/metrics.js";

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const r = await pool.query(`SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id = $1`, [
  "db6a6e92-61e9-4177-8fe9-f0346393fc94",
]);
const bot = r.rows[0].config_snapshot.bot || r.rows[0].config_snapshot;
const fromMs = +new Date("2025-01-01");
const toMs = +new Date("2026-08-02");
const candles = await readCandles("BNBUSDT", "15m", fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates("BNBUSDT", fromMs, toMs);
} catch {}
const start = Number(r.rows[0].initial_capital) || 10000;
const base = {
  ...bot,
  symbol: "BNBUSDT",
  timeframe: "15m",
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  slAtrMultiplier: 3,
  supertrendXgbGateEnabled: false,
};
// emaStretchPct=0 → BUY skip if dist<0, SELL if dist>0; RSI 0/100 disabled
const withRule = {
  ...base,
  supertrendStretchSkipEnabled: true,
  supertrendStretchEma20Pct: 0,
  supertrendStretchRsiHigh: 100,
  supertrendStretchRsiLow: 0,
};

async function run(cfg, label) {
  console.error(`[sim] ${label}`);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: start,
    timeframe: "15m",
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: start,
  });
  return {
    label,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    replay: sim.stretchSkipReplay,
  };
}

const a = await run(base, "atr3");
const b = await run(withRule, "atr3_wrong_side_ema_skip");
console.log(JSON.stringify({ a, b }, null, 2));
await closePool?.();
