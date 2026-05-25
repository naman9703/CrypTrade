#!/usr/bin/env node
/** Signal funnel + SL entry context for a backtest window. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const nth = parseInt(process.argv.find((x) => x.startsWith("--nth="))?.split("=")[1] || "2", 10);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runs = await pool.query(
  `SELECT id, start_date, end_date, symbol, timeframe, config_snapshot
     FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT $1`,
  [nth],
);
const run = runs.rows[nth - 1];
const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const ind = await import("../src/strategy/indicators.js");
const { ema, rsi: computeRsi, atr: computeAtr } = ind;

const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);

function toHourly(c) {
  const out = [];
  for (let i = 0; i + 3 < c.length; i += 4) out.push({ close: c[i + 3].close });
  return out;
}

const holdReasons = {};
const nearMiss = { longRsi: 0, shortRsi: 0, htfSideways: 0 };
let buy = 0;
let sell = 0;

const hourly = toHourly(candles);
const hCloses = hourly.map((c) => c.close);
const hEma21 = ema(hCloses, 21);
const hEma50 = ema(hCloses, 50);
const closes = candles.map((c) => c.close);
const volumes = candles.map((c) => Number(c.volume) || 0);
const rsiSeries = computeRsi(closes, 14);
const atrSeries = computeAtr(candles, 14);

for (let i = 80; i < candles.length - 1; i++) {
  const bar = candles[i];
  const prev = candles[i - 1];
  const hi = Math.floor(i / 4);
  if (hi < 22) continue;
  const htfE21 = hEma21[hi];
  const htfE50 = hEma50[hi];
  if (!Number.isFinite(htfE21) || !Number.isFinite(htfE50)) continue;
  const htfUp = htfE21 > htfE50;
  const htfDown = htfE21 < htfE50;
  const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
  if (htfSep < 0.0005) {
    holdReasons.htf_sideways = (holdReasons.htf_sideways || 0) + 1;
    nearMiss.htfSideways++;
    continue;
  }
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const atrVal = atrSeries[i];
  if (!Number.isFinite(rsiNow)) continue;
  const range = bar.high - bar.low || 1;
  if (atrVal > 0 && range / atrVal > 4) {
    holdReasons.spike_bar = (holdReasons.spike_bar || 0) + 1;
    continue;
  }
  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol > 0 && volumes[i] < 0.8 * avgVol) {
    holdReasons.low_volume = (holdReasons.low_volume || 0) + 1;
    continue;
  }

  let fired = false;
  if (htfUp && rsiNow <= 35) {
    const recovering = rsiNow > rsiPrev;
    const barOk = bar.close >= bar.open;
    if (recovering || (rsiNow <= 28 && barOk)) {
      buy++;
      fired = true;
    } else nearMiss.longRsi++;
  } else if (htfUp && rsiNow <= 42) nearMiss.longRsi++;

  if (htfDown && rsiNow >= 65) {
    const rejecting = rsiNow < rsiPrev;
    const barOk = bar.close <= bar.open;
    if (rejecting || (rsiNow >= 72 && barOk)) {
      sell++;
      fired = true;
    } else nearMiss.shortRsi++;
  } else if (htfDown && rsiNow >= 58) nearMiss.shortRsi++;

  if (!fired) holdReasons.no_setup = (holdReasons.no_setup || 0) + 1;
}

const trades = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, exit_reason, net_pnl, mae_pct, mfe_pct, bars_held, entry_price, sl_price
       FROM backtest_trades WHERE backtest_run_id=$1 AND exit_reason='sl' ORDER BY trade_number`,
    [run.id],
  )
).rows;

console.log("Signal funnel (bars after warmup):");
console.log("  BUY signals:", buy);
console.log("  SELL signals:", sell);
console.log("  Total actionable:", buy + sell);
console.log("\nHold reason counts:", holdReasons);
console.log("\nNear-miss (relaxed would add):");
console.log("  HTF sideways bars:", nearMiss.htfSideways);
console.log("  Long: HTF up but RSI 35-42 or failed confirm:", nearMiss.longRsi);
console.log("  Short: HTF down but RSI 58-65 or failed confirm:", nearMiss.shortRsi);

// SL entry bar context
console.log("\n--- SL trade entry context ---");
for (const t of trades) {
  const et = new Date(t.entry_time).getTime();
  let idx = candles.findIndex((c) => Math.abs(c.ts - et) < 60000);
  if (idx < 1) idx = candles.findIndex((c) => c.ts >= et);
  const i = Math.max(80, idx - 1);
  const hi = Math.floor(i / 4);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const htfSep =
    hi >= 22 && hEma50[hi] > 0 ? (Math.abs(hEma21[hi] - hEma50[hi]) / hEma50[hi]) * 100 : 0;
  const bar = candles[i];
  const wrongWay =
    t.direction === "BUY"
      ? bar.close < bar.open
      : bar.close > bar.open;
  console.log(
    `#${t.trade_number} ${t.direction} | RSI ${rsiNow?.toFixed(1)} (${rsiNow > rsiPrev ? "up" : "dn"}) | HTF sep ${htfSep.toFixed(3)}% | ${wrongWay ? "WRONG bar color" : "bar ok"} | 1-bar SL=${t.bars_held <= 1}`,
  );
}

await closePool();
