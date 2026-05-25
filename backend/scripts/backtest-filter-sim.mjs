#!/usr/bin/env node
/** Simulate candidate filters on the 29 trades — block losses only? */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runId = (await pool.query(`SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`)).rows[1].id;
const run = (await pool.query(`SELECT start_date, end_date, symbol, timeframe FROM backtest_runs WHERE id=$1`, [runId])).rows[0];
const trades = (await pool.query(`SELECT trade_number, direction, net_pnl, entry_time FROM backtest_trades WHERE backtest_run_id=$1`, [runId])).rows;
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const candles = await readCandles(run.symbol, run.timeframe, new Date(run.start_date).getTime(), new Date(run.end_date).getTime());
const { ema, rsi: computeRsi } = await import("../src/strategy/indicators.js");
const hourly = [];
for (let i = 0; i + 3 < candles.length; i += 4) hourly.push({ close: candles[i + 3].close });
const hEma21 = ema(hourly.map((c) => c.close), 21);
const hEma50 = ema(hourly.map((c) => c.close), 50);
const rsiSeries = computeRsi(candles.map((c) => c.close), 14);

function ctx(entryTime) {
  const t = new Date(entryTime).getTime();
  let i = candles.findIndex((c) => c.ts >= t) - 1;
  const bar = candles[i];
  const prev = candles[i - 1];
  const hi = Math.floor(i / 4);
  const htfE21 = hEma21[hi];
  const htfE50 = hEma50[hi];
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const isLong = trades.find((x) => x.entry_time === entryTime)?.direction === "BUY";
  return {
    i,
    isLong,
    rsiNow,
    rsiPrev,
    sep: Math.abs(htfE21 - htfE50) / htfE50,
    htfUp: htfE21 > htfE50,
    htfDown: htfE21 < htfE50,
    barOk: isLong ? bar.close >= bar.open : bar.close <= bar.open,
    closeUp: bar.close > prev.close,
    closeDown: bar.close < prev.close,
    recovering: rsiNow > rsiPrev,
    rejecting: rsiNow < rsiPrev,
  };
}

function getCtx(i, dir) {
  const bar = candles[i];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  const hi = Math.floor(i / 4);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const isLong = dir === "BUY";
  return {
    isLong,
    rsiNow,
    rsiPrev,
    rsiPrev2: rsiSeries[i - 2],
    sep: Math.abs(hEma21[hi] - hEma50[hi]) / hEma50[hi],
    barOk: isLong ? bar.close >= bar.open : bar.close <= bar.open,
    closeUp: bar.close > prev.close,
    closeDown: bar.close < prev.close,
    recovering: rsiNow > rsiPrev,
    rejecting: rsiNow < rsiPrev,
    prevRed: prev.close < prev.open,
    prevGreen: prev.close >= prev.open,
    threeBarDown: bar.close < prev.close && prev.close < prev2.close,
    threeBarUp: bar.close > prev.close && prev.close > prev2.close,
  };
}

const filters = {
  sep004: (c) => c.sep >= 0.0004,
  sep0012_short: (c) => !(c.isLong === false && c.sep < 0.0012),
  weakLong031: (c) => !(c.isLong && c.sep < 0.0005 && c.rsiNow > 31),
  closeVsPrev: (c) => (c.isLong ? c.closeUp : c.closeDown),
  strictNoEarly: (c) => (c.isLong ? c.recovering && c.barOk : c.rejecting && c.barOk),
  longRsi30: (c) => !(c.isLong && c.rsiNow > 30),
  shortRsi70: (c) => !(c.isLong === false && c.rsiNow < 70),
  prevRsiExtreme: (c) =>
    c.isLong ? c.rsiPrev <= 33 || c.rsiNow <= 28 : c.rsiPrev >= 63 || c.rsiNow >= 72,
  no3barAgainst: (c) => !(c.isLong && c.threeBarDown) && !(!c.isLong && c.threeBarUp),
  comboA: (c) =>
    c.sep >= 0.0004 &&
    (c.isLong ? c.recovering && c.barOk && c.closeUp : c.rejecting && c.barOk && c.closeDown) &&
    !(c.isLong && c.sep < 0.0005 && c.rsiNow > 31) &&
    !(c.isLong === false && c.sep < 0.0012 && c.rsiNow < 69),
  comboB: (c) =>
    c.sep >= 0.0004 &&
    (c.isLong ? c.recovering && c.barOk && c.closeUp && c.rsiNow <= 32 : c.rejecting && c.barOk && c.closeDown && c.rsiNow >= 68) &&
    !(c.isLong && c.threeBarDown) &&
    !(!c.isLong && c.threeBarUp),
};

for (const [name, fn] of Object.entries(filters)) {
  let blockW = 0,
    blockL = 0;
  for (const t of trades) {
    const tms = new Date(t.entry_time).getTime();
    const i = candles.findIndex((c) => c.ts >= tms) - 1;
    const c = getCtx(i, t.direction);
    const pass = fn(c);
    if (!pass) {
      if (Number(t.net_pnl) > 0) blockW++;
      else blockL++;
    }
  }
  console.log(`${name.padEnd(14)} block wins ${blockW}/21 losses ${blockL}/8`);
}

console.log("\ncomboA blocked trades:");
const fn = filters.comboA;
for (const t of trades) {
  const tms = new Date(t.entry_time).getTime();
  const i = candles.findIndex((c) => c.ts >= tms) - 1;
  const c = getCtx(i, t.direction);
  if (!fn(c)) {
    const w = Number(t.net_pnl) > 0 ? "WIN" : "LOSS";
    console.log(`  #${t.trade_number} ${w} ${t.direction} rsi=${c.rsiNow.toFixed(1)} sep=${(c.sep * 100).toFixed(3)}%`);
  }
}

await closePool();
