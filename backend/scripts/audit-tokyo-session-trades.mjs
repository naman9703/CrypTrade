#!/usr/bin/env node
/**
 * Per-trade autopsy — last TOKYO_SESSION run.
 * Usage: node scripts/audit-tokyo-session-trades.mjs [runIdPrefix]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PRE_ASIA_START = 20;
const SESSION_END = 4;
const FEE = 0.0008;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runQ = process.argv[2]
  ? await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [`${process.argv[2]}%`])
  : await pool.query(
      `SELECT * FROM backtest_runs WHERE status='done'
       AND config_snapshot->'bot'->>'manualStrategy'='TOKYO_SESSION'
       ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    );
const run = runQ.rows[0];
if (!run) {
  console.error("No run");
  process.exit(1);
}

const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { tokyoSessionPadFromMs } = await import("../src/strategy/tokyoSessionIntraday.js");
const candles = await readCandles(run.symbol, run.timeframe, tokyoSessionPadFromMs(fromMs, run.timeframe), toMs, {
  market: "futures",
});
const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));

const trades = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price,
            net_pnl, exit_reason, sl_price, tp_price, mae_pct, mfe_pct, bars_held, signal_context
     FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`,
    [run.id],
  )
).rows;

function preAsiaForDay(dayStartMs) {
  const prevStart = dayStartMs - 86_400_000;
  let lo = Infinity;
  let hi = -Infinity;
  let found = false;
  for (const c of candles) {
    const h = new Date(c.ts).getUTCHours();
    const d = Math.floor(c.ts / 86_400_000) * 86_400_000;
    if (d === prevStart && h >= PRE_ASIA_START) {
      found = true;
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    if (d === dayStartMs && h < 0) {
      found = true;
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
  }
  if (!found || !Number.isFinite(hi)) return null;
  return { hi, lo, mid: (hi + lo) / 2, width: hi - lo };
}

function walkPath(entryIdx, side, maxBars = 32) {
  const entry = candles[entryIdx].close;
  let mae = 0;
  let mfe = 0;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let j = entryIdx + 1; j < Math.min(candles.length, entryIdx + 1 + maxBars); j++) {
    const b = candles[j];
    maxHigh = Math.max(maxHigh, b.high);
    minLow = Math.min(minLow, b.low);
    if (side === "BUY") {
      mae = Math.min(mae, (b.low - entry) / entry);
      mfe = Math.max(mfe, (b.high - entry) / entry);
    } else {
      mae = Math.min(mae, (entry - b.high) / entry);
      mfe = Math.max(mfe, (entry - b.low) / entry);
    }
  }
  return { mae: mae * 100, mfe: mfe * 100, maxHigh, minLow, entry };
}

function classify(c1, c2, pre, side) {
  const sweptHi = c2.high > (pre?.hi ?? 0) * 1.0003 && c2.close < (pre?.hi ?? Infinity);
  const sweptLo = c2.low < (pre?.lo ?? Infinity) * 0.9997 && c2.close > (pre?.lo ?? 0);
  const bothBull = c2.close > c2.open && c1.close > c1.open;
  const bothBear = c2.close < c2.open && c1.close < c1.open;
  let setup = "MOMENTUM";
  if (sweptHi) setup = "SWEEP_HI_FADE";
  else if (sweptLo) setup = "SWEEP_LO_FADE";
  else if (bothBull || bothBear) setup = "BODY_ALIGN";
  const aligned = (side === "BUY" && (sweptLo || bothBull)) || (side === "SELL" && (sweptHi || bothBear));
  return { setup, sweptHi, sweptLo, bothBull, bothBear, aligned };
}

const rows = [];
const agg = {
  winners: { optSlPct: [], optTpPct: [], actualSlPct: [], mfe: [] },
  losers: { optSlPct: [], optTpPct: [], actualSlPct: [], mfe: [], mae: [] },
  bySetup: new Map(),
};

for (const t of trades) {
  const entryMs = new Date(t.entry_time).getTime();
  const entryIdx = tsToIdx.get(entryMs);
  if (entryIdx == null) continue;
  const c1 = candles[entryIdx - 1];
  const c2 = candles[entryIdx];
  const dayStart = Math.floor(entryMs / 86_400_000) * 86_400_000;
  const pre = preAsiaForDay(dayStart);
  const path = walkPath(entryIdx, t.direction);
  const entry = Number(t.entry_price);
  const actualSlPct = (Math.abs(entry - Number(t.sl_price)) / entry) * 100;
  const actualTpPct = (Math.abs(Number(t.tp_price) - entry) / entry) * 100;
  const optSlPct = Math.abs(path.mae) + 0.05;
  const optTpPct = Math.max(0.1, path.mfe - 0.05);
  const cls = classify(c1, c2, pre, t.direction);
  const win = Number(t.net_pnl) > 0;
  const bucket = win ? agg.winners : agg.losers;
  bucket.optSlPct.push(optSlPct);
  bucket.optTpPct.push(optTpPct);
  bucket.actualSlPct.push(actualSlPct);
  if (win) bucket.mfe.push(path.mfe);
  else {
    bucket.mfe.push(path.mfe);
    bucket.mae.push(Math.abs(path.mae));
  }
  const sk = cls.setup;
  if (!agg.bySetup.has(sk)) agg.bySetup.set(sk, { n: 0, wins: 0, pnl: 0 });
  const s = agg.bySetup.get(sk);
  s.n++;
  s.pnl += Number(t.net_pnl);
  if (win) s.wins++;

  rows.push({
    n: t.trade_number,
    day: new Date(entryMs).toISOString().slice(0, 10),
    dir: t.direction,
    setup: cls.setup,
    aligned: cls.aligned,
    exit: t.exit_reason,
    pnl: Number(t.net_pnl),
    actualSl: actualSlPct.toFixed(2),
    actualTp: actualTpPct.toFixed(2),
    mae: path.mae.toFixed(2),
    mfe: path.mfe.toFixed(2),
    optSl: optSlPct.toFixed(2),
    optTp: optTpPct.toFixed(2),
    preW: pre ? ((pre.width / entry) * 100).toFixed(2) : "—",
  });
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

console.log(`\n=== TOKYO SESSION TRADE AUTOPSY (${run.id.slice(0, 8)}) ===`);
console.log(`Trades: ${rows.length} · Return: ${run.metrics?.totalReturnPct?.toFixed(1)}%\n`);

console.log("--- Per trade ---");
for (const r of rows) {
  console.log(
    `#${String(r.n).padStart(2)} ${r.day} ${r.dir.padEnd(4)} ${r.setup.padEnd(14)} align=${r.aligned ? "Y" : "N"} ` +
      `exit=${r.exit.padEnd(5)} pnl=${r.pnl.toFixed(2).padStart(7)} SL=${r.actualSl}% TP=${r.actualTp}% ` +
      `MAE=${r.mae}% MFE=${r.mfe}% optSL=${r.optSl}% optTP=${r.optTp}% preW=${r.preW}%`,
  );
}

console.log("\n--- Hindsight aggregates ---");
console.log(
  `Winners (${agg.winners.actualSlPct.length}): avg actual SL=${avg(agg.winners.actualSlPct).toFixed(2)}% ` +
    `optSL=${avg(agg.winners.optSlPct).toFixed(2)}% optTP=${avg(agg.winners.optTpPct).toFixed(2)}% MFE=${avg(agg.winners.mfe).toFixed(2)}%`,
);
console.log(
  `Losers  (${agg.losers.actualSlPct.length}): avg actual SL=${avg(agg.losers.actualSlPct).toFixed(2)}% ` +
    `optSL=${avg(agg.losers.optSlPct).toFixed(2)}% MAE=${avg(agg.losers.mae).toFixed(2)}% MFE=${avg(agg.losers.mfe).toFixed(2)}%`,
);

console.log("\n--- By setup type ---");
for (const [k, v] of agg.bySetup) {
  console.log(`${k.padEnd(16)} n=${v.n} wr=${((v.wins / v.n) * 100).toFixed(0)}% pnl=$${v.pnl.toFixed(2)}`);
}

console.log("\n--- SL/TP design hints ---");
console.log(`Ideal SL floor (losers MAE p75): ${percentile(agg.losers.mae, 0.75).toFixed(2)}%`);
console.log(`Ideal TP target (winners MFE p50): ${percentile(agg.winners.mfe, 0.5).toFixed(2)}%`);
console.log(`Noise buffer above MAE: +0.05–0.10%`);

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)] ?? 0;
}

await closePool();
