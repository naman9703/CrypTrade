#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runIdArg = process.argv.find((a) => a.startsWith("--run-id="))?.split("=")[1];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: console.warn, error: console.error });
const pool = getPool();
if (!pool) {
  console.error("No DB pool");
  process.exit(2);
}

let runId = runIdArg;
if (!runId) {
  const r = await pool.query(
    `SELECT id FROM backtest_runs WHERE status = 'done' ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
  );
  runId = r.rows[0]?.id;
}

const run = (
  await pool.query(
    `SELECT id, initial_capital, final_capital, config_snapshot, metrics FROM backtest_runs WHERE id = $1`,
    [runId],
  )
).rows[0];
if (!run) {
  console.error("Run not found");
  process.exit(1);
}

const cfg = run.config_snapshot || {};
const riskPct = Number(cfg.riskPerTrade ?? 5);
const riskUnit = String(cfg.riskPerTradeUnit ?? "PCT_EQUITY");
const lev = Number(cfg.futuresLeverage ?? 1);

const trades = (
  await pool.query(
    `SELECT trade_number, net_pnl, signal_context, entry_price, exit_price, direction
       FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  )
).rows;

let equity = Number(run.initial_capital);
console.log(`Run: ${runId}`);
console.log(`Initial: $${equity} → Final: $${run.final_capital}`);
const levCfg = Number(cfg.futuresLeverage ?? cfg.leverage ?? lev);
console.log(`Risk: ${riskPct}${riskUnit === "USDT" ? " USDT" : "% equity"} · Leverage: ${levCfg}x · market: ${cfg.marketMode ?? "?"}\n`);

// Trade 1 sizing check
if (trades.length) {
  const t0 = trades[0];
  const ep = Number(t0.entry_price);
  const sl = Number(t0.sl_price);
  const qty = Number(t0.quantity);
  const dollarRisk = equity * (riskPct / 100);
  const perUnit = Math.abs(ep - sl);
  const qtyFromRisk = perUnit > 0 ? dollarRisk / perUnit : 0;
  const notional = qty * ep;
  const marginStored = Number((t0.signal_context || {}).marginUsdt);
  console.log("Trade 1 sizing:");
  console.log(`  dollarRisk (5% of $${equity}) = $${dollarRisk.toFixed(2)}`);
  console.log(`  qty from risk formula   = ${qtyFromRisk.toFixed(6)} (actual qty ${qty})`);
  console.log(`  notional                = $${notional.toFixed(2)}`);
  console.log(`  margin stored           = $${marginStored.toFixed(2)} (= notional/${levCfg} → implied lev ${(notional / marginStored).toFixed(1)}x)\n`);
}

console.log(
  "trade | equity@entry | margin | notional | net_pnl | equity_after | entry eq OK",
);
let issues = 0;
for (const t of trades) {
  const ctx = t.signal_context && typeof t.signal_context === "object" ? t.signal_context : {};
  const eqEntry = Number(ctx.equityAtEntry);
  const margin = Number(ctx.marginUsdt);
  const entryPx = Number(t.entry_price);
  const notional = margin * lev;
  const pnl = Number(t.net_pnl);
  const eqAfter = equity + pnl;
  const ok = Math.abs(eqEntry - equity) < Math.max(0.05, equity * 1e-6);
  if (!ok) issues++;
  console.log(
    `${String(t.trade_number).padStart(5)} | ${eqEntry.toFixed(2).padStart(12)} | ${margin.toFixed(2).padStart(7)} | ${notional.toFixed(0).padStart(8)} | ${pnl.toFixed(2).padStart(8)} | ${eqAfter.toFixed(2).padStart(12)} | ${ok ? "✓" : "✗ Δ" + (eqEntry - equity).toFixed(2)}`,
  );
  equity = eqAfter;
}

const finalOk = Math.abs(equity - Number(run.final_capital)) < 0.02;
console.log(`\nChained equity: $${equity.toFixed(2)} vs DB final $${Number(run.final_capital).toFixed(2)} → ${finalOk ? "✓" : "✗"}`);
console.log(`Equity-at-entry mismatches: ${issues}/${trades.length}`);

// Example: trade 1 vs 2 margin scaling
if (trades.length >= 2) {
  const c1 = trades[0].signal_context || {};
  const c2 = trades[1].signal_context || {};
  const m1 = Number(c1.marginUsdt);
  const m2 = Number(c2.marginUsdt);
  const pnl1 = Number(trades[0].net_pnl);
  const eq1 = Number(c1.equityAtEntry);
  const naiveNextMargin = (eq1 + pnl1) * (riskPct / 100); // wrong if user thinks margin = full equity
  console.log(`\nAfter trade 1: equity ${(eq1 + pnl1).toFixed(2)}, margin trade2 ${m2.toFixed(2)}`);
  console.log(`If margin = 100% equity after win: would be ~$${(eq1 + pnl1).toFixed(2)} (actual margin ${m2.toFixed(2)})`);
  console.log(`Margin ratio trade2/trade1: ${(m2 / m1).toFixed(3)}x (equity ratio ${((eq1 + pnl1) / eq1).toFixed(3)}x)`);
}

await closePool();
