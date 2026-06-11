#!/usr/bin/env node
/**
 * Per-trade TP1/TP2 hindsight analysis for TOKYO_SESSION (dynamic SL + legs).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const HOLD = 32;
const FEE = 0.0008;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { tokyoSessionPadFromMs, optsFromTokyoSessionCfg } = await import(
  "../src/strategy/tokyoSessionIntraday.js"
);
const { TOKYO_SESSION_BNB_15M } = await import("../src/strategy/presets/tokyoSessionOptimized.js");
const {
  buildPreAsiaRangeByDay,
  buildTokyoBrackets,
  resolveDynamicTpLegs,
} = await import("../src/strategy/techniques/tokyoSession.js");
const { atr: computeAtr } = await import("../src/strategy/indicators.js");

const fromMs = Date.UTC(2026, 0, 1);
const toMs = Date.UTC(2026, 5, 30);
const symbol = "BNBUSDT";
const tf = "15m";
const opts = optsFromTokyoSessionCfg(TOKYO_SESSION_BNB_15M);

const candles = await readCandles(symbol, tf, tokyoSessionPadFromMs(fromMs, tf), toMs, { market: "futures" });
const preAsia = buildPreAsiaRangeByDay(candles);
const atrSeries = computeAtr(candles, 14);
const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));

const trades = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, entry_price, sl_price, tp_price,
            net_pnl, exit_reason, mae_pct, mfe_pct, signal_context
     FROM backtest_trades t
     JOIN backtest_runs r ON r.id = t.backtest_run_id
     WHERE r.status='done' AND r.config_snapshot->'bot'->>'manualStrategy'='TOKYO_SESSION'
     ORDER BY t.entry_time`,
  )
).rows;

function walk(entryIdx, entry, side, sl, tp1, tp2) {
  let mae = 0;
  let mfe = 0;
  let hit1 = false;
  let hit2 = false;
  let hitSl = false;
  let pnl = 0;
  const isLong = side === "BUY";

  for (let j = entryIdx + 1; j < Math.min(candles.length, entryIdx + 1 + HOLD); j++) {
    const b = candles[j];
    if (isLong) {
      mae = Math.min(mae, (b.low - entry) / entry);
      mfe = Math.max(mfe, (b.high - entry) / entry);
      if (!hitSl && b.low <= sl) {
        hitSl = true;
        pnl = (sl - entry) / entry - FEE;
        break;
      }
      if (!hit1 && tp1 > 0 && b.high >= tp1) hit1 = true;
      if (!hit2 && tp2 > 0 && b.high >= tp2) {
        hit2 = true;
        pnl = 0.5 * ((tp1 - entry) / entry) + 0.5 * ((tp2 - entry) / entry) - FEE;
        break;
      }
    } else {
      mae = Math.min(mae, (entry - b.high) / entry);
      mfe = Math.max(mfe, (entry - b.low) / entry);
      if (!hitSl && b.high >= sl) {
        hitSl = true;
        pnl = (entry - sl) / entry - FEE;
        break;
      }
      if (!hit1 && tp1 > 0 && b.low <= tp1) hit1 = true;
      if (!hit2 && tp2 > 0 && b.low <= tp2) {
        hit2 = true;
        pnl = 0.5 * ((entry - tp1) / entry) + 0.5 * ((entry - tp2) / entry) - FEE;
        break;
      }
    }
  }
  if (!hitSl && !hit2) {
    const last = candles[Math.min(candles.length - 1, entryIdx + HOLD)];
    const closePnl = isLong ? (last.close - entry) / entry : (entry - last.close) / entry;
    pnl =
      (hit1 ? 0.5 * (isLong ? (tp1 - entry) / entry : (entry - tp1) / entry) : 0) +
      (hit1 ? 0.5 * closePnl : closePnl) -
      FEE;
  }
  return { mae: mae * 100, mfe: mfe * 100, hit1, hit2, hitSl, pnl: pnl * 100 };
}

const rows = [];
let sumActual = 0;
let sumProposed = 0;

for (const t of trades) {
  const entryMs = new Date(t.entry_time).getTime();
  const idx = tsToIdx.get(entryMs);
  if (idx == null) continue;
  const c1 = candles[idx - 1];
  const c2 = candles[idx];
  if (!c1 || !c2) continue;
  const dayKey = Math.floor(entryMs / 86_400_000) * 86_400_000;
  const pre = preAsia.get(dayKey);
  const entry = Number(t.entry_price);
  const side = t.direction;
  const atrVal = atrSeries[idx]?.atr ?? 0;
  const brackets = buildTokyoBrackets(entry, c1, c2, side, opts, atrVal, pre);
  if (!brackets) continue;
  const sl = brackets.slPrice;
  const tp1 = brackets.tp1Price;
  const tp2 = brackets.tp2Price;
  const risk = Math.abs(entry - sl);
  const sim = walk(idx, entry, side, sl, tp1, tp2);
  sumActual += Number(t.net_pnl);
  sumProposed += sim.pnl;

  rows.push({
    n: t.trade_number,
    side,
    setup: brackets.tokyoMeta?.setup,
    exit: t.exit_reason,
    actualPnl: Number(t.net_pnl),
    simPnl: sim.pnl,
    mfe: sim.mfe,
    mae: sim.mae,
    hit1: sim.hit1,
    hit2: sim.hit2,
    tp1Rr: brackets.tokyoMeta?.tp1Rr?.toFixed(2),
    tp2Rr: brackets.tokyoMeta?.tp2Rr?.toFixed(2),
    slPct: ((risk / entry) * 100).toFixed(2),
    tp1Pct: ((Math.abs(tp1 - entry) / entry) * 100).toFixed(2),
    tp2Pct: ((Math.abs(tp2 - entry) / entry) * 100).toFixed(2),
  });
}

console.log(`\n=== DYNAMIC SL + TP1/TP2 SIM (${rows.length} trades) ===`);
console.log(`Actual net $: ${sumActual.toFixed(2)} · Proposed sim sum %: ${sumProposed.toFixed(1)}%`);

const hit1 = rows.filter((r) => r.hit1).length;
const hit2 = rows.filter((r) => r.hit2).length;
const simWins = rows.filter((r) => r.simPnl > 0).length;
console.log(
  `TP1 reachable: ${hit1}/${rows.length} · TP2 reachable: ${hit2}/${rows.length} · sim WR: ${((simWins / rows.length) * 100).toFixed(0)}%`,
);

console.log("\n--- Sample trades ---");
for (const r of rows.slice(0, 15)) {
  console.log(
    `#${r.n} ${r.side} ${r.setup ?? "?"} SL=${r.slPct}% TP1=${r.tp1Pct}%(${r.tp1Rr}R) TP2=${r.tp2Pct}%(${r.tp2Rr}R) ` +
      `MFE=${r.mfe.toFixed(2)}% hit1=${r.hit1} hit2=${r.hit2} sim=${r.simPnl.toFixed(2)}% actual=$${r.actualPnl.toFixed(2)}`,
  );
}

await closePool();
