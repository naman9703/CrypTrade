#!/usr/bin/env node
/** Verify liquidation on a backtest trade (default: last run, trade #4). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const tradeNum = Number(process.argv.find((x) => x.startsWith("--trade="))?.split("=")[1] || 4);
const runIdArg = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

let runId = runIdArg;
if (!runId) {
  runId = (
    await pool.query(
      `SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    )
  ).rows[0]?.id;
}

const run = (
  await pool.query(
    `SELECT id, symbol, timeframe, start_date, end_date, initial_capital, final_capital,
            total_trades, metrics, config_snapshot
       FROM backtest_runs WHERE id = $1`,
    [runId],
  )
).rows[0];

const t = (
  await pool.query(
    `SELECT * FROM backtest_trades WHERE backtest_run_id = $1 AND trade_number = $2`,
    [runId, tradeNum],
  )
).rows[0];

if (!t) {
  console.error("Trade not found");
  process.exit(1);
}

const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const lev = Number(cfg.futuresLeverage ?? 50);
const mmr = Number(cfg.trailMaintMarginRate ?? 0.005);
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { liquidationPrice } = await import("../src/backtest/engine/costModel.js");
const { tradeBreakdown } = await import("../src/backtest/engine/costModel.js");

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);

function findIdx(ts) {
  const tms = new Date(ts).getTime();
  let i = candles.findIndex((c) => c.ts === tms);
  if (i < 0) i = candles.findIndex((c) => c.ts >= tms);
  return i;
}

const entryIdx = findIdx(t.entry_time);
const exitIdx = findIdx(t.exit_time);
const isLong = t.direction === "BUY";
const entry = Number(t.entry_price);
const exitPx = Number(t.exit_price);
const sl = Number(t.sl_price);
const tp = Number(t.tp_price);

const liqPx = liquidationPrice({
  side: t.direction,
  entryFill: entry,
  leverage: lev,
  maintenanceMarginRate: mmr,
});

const candlePath = [];
for (let j = entryIdx; j <= Math.min(exitIdx + 2, candles.length - 1); j++) {
  const b = candles[j];
  const hitLiq = isLong ? b.low <= liqPx : b.high >= liqPx;
  const hitSl = isLong ? b.low <= sl : b.high >= sl;
  candlePath.push({
    j,
    ts: new Date(b.ts).toISOString().slice(0, 16),
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    hitLiq,
    hitSl,
    adv: isLong ? ((b.low - entry) / entry) * 100 : ((entry - b.high) / entry) * 100,
  });
}

const priorTrades = (
  await pool.query(
    `SELECT trade_number, net_pnl, signal_context
       FROM backtest_trades WHERE backtest_run_id = $1 AND trade_number < $2 ORDER BY trade_number`,
    [runId, tradeNum],
  )
).rows;
const sc = typeof t.signal_context === "string" ? JSON.parse(t.signal_context) : t.signal_context ?? {};

const breakdown = tradeBreakdown({
  side: t.direction,
  qty: Number(t.quantity),
  entryFill: entry,
  exitFill: exitPx,
  model: { takerOpenFeeRate: 0.0004, takerCloseFeeRate: 0.0004, useMakerEntries: false, useMakerExits: false },
  leverage: lev,
});

console.log("═".repeat(72));
console.log(`RUN ${run.id}`);
console.log(`Symbol ${run.symbol} ${run.timeframe} · ${run.start_date?.toISOString?.()?.slice(0, 10) ?? run.start_date} → ${run.end_date?.toISOString?.()?.slice(0, 10) ?? run.end_date}`);
console.log(`Capital $${run.initial_capital} → $${Number(run.final_capital).toFixed(2)} · ${run.total_trades} trades`);
console.log("═".repeat(72));
console.log(`\nTRADE #${t.trade_number} ${t.direction} · exit: ${t.exit_reason}`);
console.log(`Entry ${new Date(t.entry_time).toISOString()} @ ${entry}`);
console.log(`Exit  ${new Date(t.exit_time).toISOString()} @ ${exitPx}`);
console.log(`SL ${sl} · TP ${tp} · Liq (calc) ${liqPx.toFixed(2)}`);
console.log(`Leverage ${lev}x · MMR ${(mmr * 100).toFixed(2)}%`);
console.log(`Qty ${t.quantity} · Margin $${Number(sc.marginUsdt ?? 0).toFixed(2)} · Equity@entry $${Number(sc.equityAtEntry ?? 0).toFixed(2)}`);
console.log(`Net PnL $${Number(t.net_pnl).toFixed(2)} · Gross $${Number(t.gross_pnl).toFixed(2)} · Fees $${Number(t.fees_usdt).toFixed(2)}`);
const maePct = t.mae_pct != null ? Number(t.mae_pct) : Number(t.mae);
const mfePct = t.mfe_pct != null ? Number(t.mfe_pct) : Number(t.mfe);
console.log(`MAE ${maePct.toFixed(2)}% · MFE ${mfePct.toFixed(2)}% · Bars ${t.bars_held ?? "?"}`);
console.log(`Signal context: ${JSON.stringify(sc)}`);

const liqDistPct = isLong ? ((entry - liqPx) / entry) * 100 : ((liqPx - entry) / entry) * 100;
const slDistPct = isLong ? ((entry - sl) / entry) * 100 : ((sl - entry) / entry) * 100;
console.log(`\nDistances from entry: SL ${slDistPct.toFixed(2)}% · Liq ${liqDistPct.toFixed(2)}% (theoretical max loss ~100% of margin at ${lev}x)`);
console.log(`Exit vs liqPx: ${Math.abs(exitPx - liqPx) < 1 ? "matches liq price ✓" : `exit ${exitPx} vs liq ${liqPx.toFixed(2)}`}`);
console.log(`Exit vs SL: ${Math.abs(exitPx - sl) < 1 ? "matches SL" : `exit ${exitPx} vs sl ${sl}`}`);

console.log("\nPrior trades (compounding context):");
for (const p of priorTrades) {
  console.log(
    `  #${p.trade_number} PnL $${Number(p.net_pnl).toFixed(2)} · equity@entry $${Number((typeof p.signal_context === 'string' ? JSON.parse(p.signal_context) : p.signal_context)?.equityAtEntry ?? 0).toFixed(0)}`,
  );
}

console.log("\nCandle path (entry → exit):");
for (const p of candlePath) {
  const flags = [p.hitLiq ? "LIQ" : null, p.hitSl ? "SL" : null].filter(Boolean).join("+") || "";
  console.log(
    `  ${p.ts} O${p.o.toFixed(0)} H${p.h.toFixed(0)} L${p.l.toFixed(0)} C${p.c.toFixed(0)} | adv ${p.adv.toFixed(2)}% ${flags}`,
  );
}

const firstLiqBar = candlePath.find((p) => p.hitLiq);
if (firstLiqBar) {
  console.log(`\n✓ Liq touched on bar ${firstLiqBar.ts} (low/high breached ${liqPx.toFixed(2)}) before SL on same bar: ${firstLiqBar.hitSl}`);
} else {
  console.log("\n✗ No bar breached liqPx in path — possible mismatch");
}

console.log("\nRecomputed PnL check:");
console.log(`  Engine net $${Number(t.net_pnl).toFixed(2)} vs breakdown gross-fees $${(breakdown.gross - breakdown.fees).toFixed(2)}`);

const metrics = run.metrics ?? {};
console.log("\nRun metrics:", JSON.stringify({ totalReturnPct: metrics.totalReturnPct, winRate: metrics.winRate, maxDrawdownPct: metrics.maxDrawdownPct }, null, 2));

await closePool();
