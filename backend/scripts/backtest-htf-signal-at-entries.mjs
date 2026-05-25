#!/usr/bin/env node
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
const candles = await readCandles(run.symbol, run.timeframe, new Date(run.start_date).getTime(), new Date(run.end_date).getTime());

const ind = await import("../src/strategy/indicators.js");
const { ema } = ind;
const computeRsi = ind.rsi;
const computeAtr = ind.atr;

function signalV1({ candles: c }) {
  const WARMUP = 80;
  if (c.length < WARMUP) return { action: "HOLD" };
  const hourly = [];
  for (let i = 0; i + 3 < c.length; i += 4) hourly.push({ close: c[i + 3].close });
  if (hourly.length < 22) return { action: "HOLD" };
  const hCloses = hourly.map((x) => x.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const hLast = hourly.length - 1;
  const htfE21 = hEma21[hLast];
  const htfE50 = hEma50[hLast];
  const htfUp = htfE21 > htfE50;
  const htfDown = htfE21 < htfE50;
  const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
  if (htfSep < 0.0005) return { action: "HOLD" };
  const closes = c.map((x) => x.close);
  const volumes = c.map((x) => Number(x.volume) || 0);
  const i = c.length - 1;
  const bar = c[i];
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(c, 14);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const atrVal = atrSeries[i];
  if (!Number.isFinite(rsiNow)) return { action: "HOLD" };
  if (atrVal > 0 && (bar.high - bar.low) / atrVal > 4) return { action: "HOLD" };
  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol > 0 && volumes[i] < 0.8 * avgVol) return { action: "HOLD" };
  if (htfUp && rsiNow <= 35) {
    const recovering = rsiNow > rsiPrev;
    const barOk = bar.close >= bar.open;
    if (recovering || (rsiNow <= 28 && barOk)) return { action: "BUY" };
  }
  if (htfDown && rsiNow >= 65) {
    const rejecting = rsiNow < rsiPrev;
    const barOk = bar.close <= bar.open;
    if (rejecting || (rsiNow >= 72 && barOk)) return { action: "SELL" };
  }
  return { action: "HOLD" };
}

const { signal: signalV2 } = await import("../src/strategy/htfRsi.js");

for (const t of trades) {
  const tms = new Date(t.entry_time).getTime();
  const i = candles.findIndex((c) => c.ts >= tms) - 1;
  const slice = candles.slice(0, i + 1);
  const s1 = signalV1({ candles: slice });
  const s2 = signalV2({ candles: slice });
  const win = Number(t.net_pnl) > 0;
  const diff = s1.action !== s2.action;
  if (diff || (!win && s2.action === "HOLD")) {
    console.log(
      `#${t.trade_number} ${win ? "WIN" : "LOSS"} ${t.direction} v1=${s1.action}(${s1.reason}) v2=${s2.action}(${s2.reason})`,
    );
  }
}
console.log("Done — only diffs / losses blocked by v2 printed");
await closePool();
