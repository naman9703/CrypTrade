#!/usr/bin/env node
/**
 * Why did the verified-correct setups still lose? Cross-checks each loss against:
 *  - HTF 1h trend (EMA21/50) alignment vs trade direction
 *  - distance entry→TP(opposing pool) in R units (is the target realistic?)
 *  - the 8 bars after entry (did the reclaim hold or fail immediately?)
 * Usage: node scripts/audit-sr-loss-causes.mjs [runIdPrefix]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");

function pickBotCfg(s) {
  return s?.bot && typeof s.bot === "object" ? s.bot : s ?? {};
}
function findBarIndex(candles, ts) {
  const t = new Date(ts).getTime();
  let best = -1,
    bd = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return bd <= 9e5 ? best : -1;
}
const fmt = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : "—");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
let runId = process.argv[2];
if (!runId) {
  runId = (
    await pool.query(
      `SELECT id::text FROM backtest_runs WHERE status='done' AND symbol='BNBUSDT' AND timeframe='15m' ORDER BY finished_at DESC LIMIT 1`,
    )
  ).rows[0]?.id;
}
const run = (
  await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [`${String(runId).slice(0, 8)}%`])
).rows[0];
runId = run.id;
const cfg = pickBotCfg(run.config_snapshot);
const candles = await readCandles(
  run.symbol,
  run.timeframe,
  new Date(run.start_date).getTime() - 7 * 86400000,
  new Date(run.end_date).getTime(),
);
const pre = precomputeIntraday(candles);

const { rows } = await pool.query(
  `SELECT trade_number, direction, entry_time, entry_price, exit_price, sl_price, tp_price,
          exit_reason, net_pnl, mfe_pct, mae_pct, signal_context
   FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`,
  [runId],
);
const entries = new Map();
for (const t of rows) {
  const k = `${new Date(t.entry_time).toISOString()}:${t.direction}`;
  if (!entries.has(k)) entries.set(k, { ...t, legs: [] });
  entries.get(k).legs.push(t);
}
for (const e of entries.values()) {
  e.net = e.legs.reduce((s, l) => s + Number(l.net_pnl), 0);
  e.exits = e.legs.map((l) => l.exit_reason).join("+");
  e.mfe = Math.max(...e.legs.map((l) => Number(l.mfe_pct ?? 0)));
}
const losses = [...entries.values()].filter((e) => e.net < -0.01).sort((a, b) => a.net - b.net);

console.log("=== LOSS CAUSE CROSS-CHECK ===", run.symbol, run.timeframe, "losses:", losses.length);
let counterTrend = 0;
let tpTooFar = 0;
let immediateFail = 0;

for (const e of losses) {
  const idx = findBarIndex(candles, e.entry_time);
  const side = e.direction;
  const liq = e.signal_context?.liq ?? {};
  const entry = Number(e.entry_price);
  const sl = Number(e.sl_price);
  const tp = Number(e.tp_price);
  const opposing = Number(liq.opposingLevel ?? tp);
  const riskAbs = Math.abs(entry - sl);
  const rToTp = riskAbs > 0 ? Math.abs(tp - entry) / riskAbs : null;
  const rToOpposing = riskAbs > 0 ? Math.abs(opposing - entry) / riskAbs : null;

  const htfUp = pre.htfUp[idx];
  const htfDown = pre.htfDown[idx];
  const htfDir = htfUp ? "UP" : htfDown ? "DOWN" : "FLAT";
  const aligned = (side === "BUY" && htfUp) || (side === "SELL" && htfDown);
  const counter = (side === "BUY" && htfDown) || (side === "SELL" && htfUp);
  if (counter) counterTrend++;
  if (rToTp != null && rToTp > 2.2) tpTooFar++;

  // 8 bars after entry: did it move favorably first or fail?
  const after = [];
  for (let j = idx + 1; j <= Math.min(candles.length - 1, idx + 8); j++) {
    const fav = side === "BUY" ? (candles[j].high - entry) / entry : (entry - candles[j].low) / entry;
    after.push(fav * 100);
  }
  const firstFav = after.length ? Math.max(...after.slice(0, 3)) : 0;
  if (firstFav < 0.15) immediateFail++;

  console.log(
    `\n#${e.trade_number} ${side} ${new Date(e.entry_time).toISOString().slice(5, 16)} net=${fmt(e.net)} exit=${e.exits}`,
  );
  console.log(
    `   HTF 1h trend=${htfDir} → ${aligned ? "ALIGNED" : counter ? "COUNTER-TREND ⚠" : "flat/neutral"} (sep=${fmt((pre.htfSep[idx] ?? 0) * 100, 3)}%)`,
  );
  console.log(
    `   R:R to TP=${fmt(rToTp)} · to opposing pool=${fmt(rToOpposing)} ${rToTp > 2.2 ? "⚠ target far" : ""}`,
  );
  console.log(`   first 3 bars max favorable=${fmt(firstFav)}% · MFE=${fmt(e.mfe)}%`);
}

console.log(
  `\n=== TALLY === counter-HTF-trend: ${counterTrend}/${losses.length} · TP>2.2R: ${tpTooFar}/${losses.length} · immediate-fail(<0.15% in 3 bars): ${immediateFail}/${losses.length}`,
);

// Same checks across WINS for contrast.
const wins = [...entries.values()].filter((e) => e.net > 0.01);
let winCounter = 0,
  winAligned = 0;
const winFirstFav = [];
const winRtoTp = [];
for (const e of wins) {
  const idx = findBarIndex(candles, e.entry_time);
  const side = e.direction;
  if ((side === "BUY" && pre.htfDown[idx]) || (side === "SELL" && pre.htfUp[idx])) winCounter++;
  if ((side === "BUY" && pre.htfUp[idx]) || (side === "SELL" && pre.htfDown[idx])) winAligned++;
  const entry = Number(e.entry_price);
  const sl = Number(e.sl_price);
  const tp = Number(e.tp_price);
  const riskAbs = Math.abs(entry - sl);
  if (riskAbs > 0) winRtoTp.push(Math.abs(tp - entry) / riskAbs);
  let fav = 0;
  for (let j = idx + 1; j <= Math.min(candles.length - 1, idx + 3); j++) {
    const f = side === "BUY" ? (candles[j].high - entry) / entry : (entry - candles[j].low) / entry;
    fav = Math.max(fav, f * 100);
  }
  winFirstFav.push(fav);
}
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
console.log(
  `WINS: aligned ${winAligned}/${wins.length} · counter-trend ${winCounter}/${wins.length}`,
);
console.log(
  `WINS: avg R:R-to-TP=${fmt(avg(winRtoTp))} · avg first-3-bar favorable=${fmt(avg(winFirstFav))}% · min favorable=${fmt(Math.min(...winFirstFav))}%`,
);
console.log(
  `LOSSES avg first-3-bar favorable=${fmt(avg(losses.map((e) => {
    const idx = findBarIndex(candles, e.entry_time);
    const side = e.direction;
    const entry = Number(e.entry_price);
    let fav = 0;
    for (let j = idx + 1; j <= Math.min(candles.length - 1, idx + 3); j++) {
      const f = side === "BUY" ? (candles[j].high - entry) / entry : (entry - candles[j].low) / entry;
      fav = Math.max(fav, f * 100);
    }
    return fav;
  })))}%`,
);

await closePool();
