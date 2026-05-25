#!/usr/bin/env node
/**
 * Deep dive on loss trades for 2nd-last backtest run.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runs = await pool.query(
  `SELECT id, symbol, timeframe, start_date, end_date, config_snapshot
     FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`,
);
const run = runs.rows[1];
const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const slPct = Number(cfg.supertrendFuturesFixedSlPct ?? 0.008);
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { strategies } = await import("../src/strategy/strategies.js");
const ind = await import("../src/strategy/indicators.js");
const { ema, rsi: computeRsi, atr: computeAtr } = ind;

const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);
const closes = candles.map((c) => c.close);
const rsiSeries = computeRsi(closes, 14);
const atrSeries = computeAtr(candles, 14);

function toHourly(c) {
  const out = [];
  for (let i = 0; i + 3 < c.length; i += 4) out.push({ close: c[i + 3].close });
  return out;
}
const hourly = toHourly(candles);
const hCloses = hourly.map((c) => c.close);
const hEma21 = ema(hCloses, 21);
const hEma50 = ema(hCloses, 50);

function htfAtBar(i) {
  const hi = Math.floor(i / 4);
  if (hi < 22 || !hEma50[hi]) return null;
  const e21 = hEma21[hi];
  const e50 = hEma50[hi];
  const sep = (Math.abs(e21 - e50) / e50) * 100;
  return {
    up: e21 > e50,
    down: e21 < e50,
    sep,
    chop: sep < 0.3,
    weak: sep < 0.15,
  };
}

function findBarIdx(ts) {
  const t = new Date(ts).getTime();
  let i = candles.findIndex((c) => c.ts === t);
  if (i < 0) i = candles.findIndex((c) => c.ts >= t);
  return i;
}

const losses = (
  await pool.query(
    `SELECT * FROM backtest_trades WHERE backtest_run_id=$1 AND net_pnl < 0 ORDER BY trade_number`,
    [run.id],
  )
).rows;

console.log(`Run ${run.id.slice(0, 8)} · SL=${(slPct * 100).toFixed(2)}% · ${losses.length} losses\n`);

for (const t of losses) {
  const entryTs = new Date(t.entry_time).getTime();
  const exitTs = new Date(t.exit_time).getTime();
  const signalIdx = findBarIdx(t.entry_time) - 1; // signal on bar before fill at next open
  const fillIdx = findBarIdx(t.entry_time);
  const exitIdx = findBarIdx(t.exit_time);

  const sigBar = signalIdx >= 0 ? candles[signalIdx] : null;
  const fillBar = fillIdx >= 0 ? candles[fillIdx] : null;
  const slice = candles.slice(0, signalIdx + 1);
  const sig = signalIdx >= 80 ? strategies.HTF_RSI.signal({ candles: slice, timeframe: run.timeframe }) : null;

  const rsiSig = signalIdx >= 0 ? rsiSeries[signalIdx] : null;
  const rsiPrev = signalIdx > 0 ? rsiSeries[signalIdx - 1] : null;
  const htf = signalIdx >= 0 ? htfAtBar(signalIdx) : null;

  const entry = Number(t.entry_price);
  const sl = Number(t.sl_price);
  const exit = Number(t.exit_price);
  const isLong = t.direction === "BUY";
  const slDist = isLong ? ((entry - sl) / entry) * 100 : ((sl - entry) / entry) * 100;

  // Bars after fill until exit
  const path = [];
  for (let j = fillIdx; j <= Math.min(exitIdx + 1, candles.length - 1); j++) {
    const b = candles[j];
    const move = isLong ? ((b.low - entry) / entry) * 100 : ((b.high - entry) / entry) * 100;
    const fav = isLong ? ((b.high - entry) / entry) * 100 : ((entry - b.low) / entry) * 100;
    path.push({
      j,
      ts: new Date(b.ts).toISOString().slice(0, 16),
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      advPct: move.toFixed(2),
      favPct: fav.toFixed(2),
    });
  }

  const sigBarBearish = sigBar && sigBar.close < sigBar.open;
  const sigBarBullish = sigBar && sigBar.close >= sigBar.open;
  const wrongCandle =
    (isLong && sigBarBearish) || (!isLong && sigBarBullish);
  const rsiRecovering = rsiSig != null && rsiPrev != null && (isLong ? rsiSig > rsiPrev : rsiSig < rsiPrev);
  const earlyEntry =
    isLong ? rsiSig > 30 && rsiSig <= 35 : rsiSig < 70 && rsiSig >= 65;

  // Would filters block?
  const blockSep03 = htf && htf.sep < 0.3;
  const blockSep015 = htf && htf.sep < 0.15;
  const blockNoRecover = !rsiRecovering;
  const blockRsiLoose = isLong ? rsiSig > 32 : rsiSig < 68;
  const blockWrongBar = wrongCandle;

  let rootCause = [];
  if (htf?.weak) rootCause.push("HTF_trend_too_weak");
  else if (htf?.chop) rootCause.push("HTF_choppy");
  if (!rsiRecovering) rootCause.push("RSI_not_turning");
  if (earlyEntry && !rsiRecovering) rootCause.push("early_RSI_entry_rule");
  if (wrongCandle) rootCause.push("wrong_bar_color");
  if (path.length <= 2 && Number(path[0]?.advPct) <= -0.7) rootCause.push("instant_gap_against");
  if (path.length > 5 && Number(t.mfe_pct) < 0.1) rootCause.push("slow_grind_to_SL");

  console.log("═".repeat(70));
  console.log(`TRADE #${t.trade_number} ${t.direction} · ${t.exit_reason} · PnL $${Number(t.net_pnl).toFixed(2)}`);
  console.log(`Entry ${new Date(entryTs).toISOString().slice(0, 16)} @ ${entry.toFixed(1)} → Exit ${new Date(exitTs).toISOString().slice(0, 16)} @ ${exit.toFixed(1)}`);
  console.log(`Signal: ${sig?.reason ?? "?"} · RSI ${rsiSig?.toFixed(1)} (${rsiRecovering ? "turning" : "flat/wrong way"}) · HTF ${htf?.up ? "UP" : "DOWN"} sep ${htf?.sep.toFixed(3)}%`);
  console.log(`SL distance ${slDist.toFixed(2)}% · Bars held ${t.bars_held} · MAE ${Number(t.mae_pct).toFixed(2)}% MFE ${Number(t.mfe_pct).toFixed(2)}%`);
  console.log(`ROOT CAUSE: ${rootCause.join(" + ") || "trend_continuation_against_position"}`);
  console.log("\nPrice path (fill bar → exit):");
  for (const p of path.slice(0, 6)) {
    console.log(`  ${p.ts} O${p.o.toFixed(0)} H${p.h.toFixed(0)} L${p.l.toFixed(0)} C${p.c.toFixed(0)} | fav ${p.favPct}% adv ${p.advPct}%`);
  }
  console.log("\nWould filter BLOCK trade?");
  console.log(`  HTF sep < 0.3%: ${blockSep03 ? "YES ✓" : "no"}`);
  console.log(`  HTF sep < 0.15%: ${blockSep015 ? "YES ✓" : "no"}`);
  console.log(`  Require RSI turning: ${blockNoRecover ? "YES (failed)" : "ok"}`);
  console.log(`  Stricter RSI (≤30/≥70): ${blockRsiLoose ? "no" : "YES ✓"}`);
  console.log(`  Require bar color confirm: ${blockWrongBar ? "YES (failed)" : "ok"}`);
  console.log("");
}

// Summary table
console.log("\n" + "═".repeat(70));
console.log("FILTER SUMMARY — how many losses each rule would remove\n");
const rules = [
  { name: "HTF sep ≥ 0.3%", test: (t, ctx) => ctx.htfSep >= 0.3 },
  { name: "HTF sep ≥ 0.5%", test: (t, ctx) => ctx.htfSep >= 0.5 },
  { name: "RSI ≤30 long / ≥70 short", test: (t, ctx) => (t.dir === "BUY" ? ctx.rsi <= 30 : ctx.rsi >= 70) },
  { name: "RSI must be turning", test: (t, ctx) => ctx.turning },
  { name: "Bar color confirm", test: (t, ctx) => ctx.barOk },
];
// recompute contexts
const contexts = [];
for (const t of losses) {
  const signalIdx = findBarIdx(t.entry_time) - 1;
  const htf = htfAtBar(signalIdx);
  const rsiSig = rsiSeries[signalIdx];
  const rsiPrev = rsiSeries[signalIdx - 1];
  const bar = candles[signalIdx];
  const isLong = t.direction === "BUY";
  contexts.push({
    trade: t.trade_number,
    htfSep: htf?.sep ?? 0,
    rsi: rsiSig,
    turning: isLong ? rsiSig > rsiPrev : rsiSig < rsiPrev,
    barOk: isLong ? bar.close >= bar.open : bar.close <= bar.open,
    dir: t.direction,
  });
}
for (const r of rules) {
  const kept = contexts.filter((c) => {
    const t = { dir: c.dir };
    return r.test(t, c);
  });
  const blocked = 8 - kept.length;
  console.log(`  ${r.name.padEnd(28)} blocks ${blocked}/8 losses`);
}

await closePool();
