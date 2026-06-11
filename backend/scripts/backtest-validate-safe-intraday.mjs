#!/usr/bin/env node
/**
 * Validate SAFE_INTRADAY vs SUPERTREND_ELITE on shared window.
 *
 *   FROM=2025-01-01 SYMBOLS=BTCUSDT,BNBUSDT,ETHUSDT node scripts/backtest-validate-safe-intraday.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,BNBUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);

import { SAFE_INTRADAY_ACTIVATION_PATCH } from "../src/strategy/safeIntraday.js";

const baseCfg = {
  marketMode: "FUTURES",
  ...SAFE_INTRADAY_ACTIVATION_PATCH,
  slippagePct: 0.0005,
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

async function runOne(symbol, strategyKey) {
  const candles = await readCandles(symbol, TF, fromMs, toMs);
  if (!candles?.length) return null;
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs, toMs);
  } catch {
    funding = [];
  }
  const cfg = { ...baseCfg, symbol };
  const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf: TF, candles, fromMs });
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const days = (toMs - fromMs) / (86400000);
  const dailyPct = days > 0 ? m.totalReturnPct / days : 0;
  return { symbol, strategyKey, ...m, dailyPct, days };
}

console.log(`\n=== SAFE_INTRADAY validation ${SYMBOLS.join(",")} ${TF} ${FROM}->${TO} ===\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const key of ["SAFE_INTRADAY", "SUPERTREND_ELITE"]) {
    process.stdout.write(`  ${sym} ${key}...`);
    const r = await runOne(sym, key);
    if (r) rows.push(r);
    console.log(r ? ` ${r.totalReturnPct.toFixed(1)}% ${r.totalTrades} trades` : " skip");
  }
}

console.log(`\n${"symbol".padEnd(10)}${"strategy".padEnd(18)}${"net%".padStart(8)}${"daily%".padStart(8)}${"trades".padStart(8)}${"maxDD%".padStart(8)}${"PF".padStart(7)}${"Calmar".padStart(8)}`);
for (const r of rows) {
  console.log(
    `${r.symbol.padEnd(10)}${r.strategyKey.padEnd(18)}${r.totalReturnPct.toFixed(1).padStart(8)}${r.dailyPct.toFixed(3).padStart(8)}${String(r.totalTrades).padStart(8)}${r.maxDrawdownPct.toFixed(1).padStart(8)}${(r.profitFactor || 0).toFixed(2).padStart(7)}${(r.calmar ?? 0).toFixed(2).padStart(8)}`,
  );
}

const safe = rows.filter((r) => r.strategyKey === "SAFE_INTRADAY");
const meanDaily = safe.length ? safe.reduce((a, r) => a + r.dailyPct, 0) / safe.length : 0;
const meanNet = safe.length ? safe.reduce((a, r) => a + r.totalReturnPct, 0) / safe.length : 0;
console.log(`\nSAFE_INTRADAY mean: net ${meanNet.toFixed(1)}% | ~${meanDaily.toFixed(3)}%/calendar-day (not trading days)`);
console.log(`Target doc: ~1%/month (~0.033%/day) — 1%/day is NOT realistic.\n`);

await closePool?.();
