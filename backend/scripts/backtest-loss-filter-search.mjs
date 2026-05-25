#!/usr/bin/env node
/** Search loss-only filters with correct HTF indexing (hLast, not floor(i/4)). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runId = (await pool.query(`SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`)).rows[1].id;
const run = (await pool.query(`SELECT symbol, timeframe, start_date, end_date FROM backtest_runs WHERE id=$1`, [runId])).rows[0];
const trades = (await pool.query(`SELECT trade_number, direction, net_pnl, entry_time FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`, [runId])).rows;
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const ind = await import("../src/strategy/indicators.js");
const { ema } = ind;
const computeRsi = ind.rsi;
const computeAtr = ind.atr;
const candles = await readCandles(run.symbol, run.timeframe, new Date(run.start_date).getTime(), new Date(run.end_date).getTime());
const rsiSeries = computeRsi(candles.map((c) => c.close), 14);
const atrSeries = computeAtr(candles, 14);

function htfCtx(slice) {
  const hourly = [];
  for (let j = 0; j + 3 < slice.length; j += 4) hourly.push({ close: slice[j + 3].close });
  if (hourly.length < 22) return null;
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const hLast = hourly.length - 1;
  const e21 = hEma21[hLast];
  const e50 = hEma50[hLast];
  return {
    up: e21 > e50,
    down: e21 < e50,
    sep: Math.abs(e21 - e50) / e50,
  };
}

function getCtx(entryTime, dir) {
  const tms = new Date(entryTime).getTime();
  const i = candles.findIndex((c) => c.ts >= tms) - 1;
  const slice = candles.slice(0, i + 1);
  const bar = candles[i];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  const htf = htfCtx(slice);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const isLong = dir === "BUY";
  const range = bar.high - bar.low || 1;
  const closePos = (bar.close - bar.low) / range;
  const atrVal = atrSeries[i];
  return {
    i,
    isLong,
    rsiNow,
    rsiPrev,
    sep: htf?.sep ?? 0,
    htfUp: htf?.up,
    htfDown: htf?.down,
    barOk: isLong ? bar.close >= bar.open : bar.close <= bar.open,
    closeUp: bar.close > prev.close,
    closeDown: bar.close < prev.close,
    recovering: rsiNow > rsiPrev,
    rejecting: rsiNow < rsiPrev,
    threeBarDown: bar.close < prev.close && prev.close < prev2.close,
    threeBarUp: bar.close > prev.close && prev.close > prev2.close,
    closePos,
    spikeBar: atrVal > 0 && range / atrVal > 4,
    rsiPrevDeep: isLong ? rsiPrev <= 32 : rsiPrev >= 68,
    weakShort: !isLong && htf?.sep < 0.0015 && rsiNow < 68,
    flatLong: isLong && htf?.sep < 0.00058 && rsiNow > 31,
    sep006: htf?.sep >= 0.0006,
  };
}

const filters = {
  flatLong: (c) => !c.flatLong,
  sep006_long: (c) => !(c.isLong && c.sep < 0.0006),
  weakShort15: (c) => !(c.weakShort),
  weakShort12_rsi69: (c) => !(c.isLong === false && c.sep < 0.0012 && c.rsiNow < 69),
  rsiPrevDeep: (c) => c.rsiPrevDeep,
  strongCloseLong: (c) => !(c.isLong && c.closePos < 0.55),
  strongCloseShort: (c) => !(!c.isLong && c.closePos > 0.45),
  comboLoss1: (c) =>
    !(c.flatLong) &&
    !(c.isLong === false && c.sep < 0.0012 && c.rsiNow < 68 && c.rsiPrev < 67) &&
    !(c.isLong && c.closePos < 0.5 && c.rsiNow > 30),
};

for (const [name, fn] of Object.entries(filters)) {
  let bw = 0,
    bl = 0;
  for (const t of trades) {
    const c = getCtx(t.entry_time, t.direction);
    if (!fn(c)) {
      if (Number(t.net_pnl) > 0) bw++;
      else bl++;
    }
  }
  console.log(`${name.padEnd(22)} block wins ${bw}/21 losses ${bl}/8`);
}

console.log("\nPer-trade ctx (losses):");
for (const t of trades.filter((x) => Number(x.net_pnl) < 0)) {
  const c = getCtx(t.entry_time, t.direction);
  console.log(
    `#${t.trade_number} ${t.direction} sep=${(c.sep * 100).toFixed(3)}% rsi=${c.rsiNow.toFixed(1)}/${c.rsiPrev.toFixed(1)} closePos=${c.closePos.toFixed(2)} flatLong=${c.flatLong} weakShort=${c.weakShort}`,
  );
}

await closePool();
