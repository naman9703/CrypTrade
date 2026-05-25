#!/usr/bin/env node
/** Verify gross/net/fees for a single backtest trade. Usage: node ... --trade=29 [--run-id=uuid] */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const tradeNum = Number(process.argv.find((x) => x.startsWith("--trade="))?.split("=")[1] || 29);
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
  await pool.query(`SELECT * FROM backtest_runs WHERE id = $1`, [runId])
).rows[0];
const t = (
  await pool.query(`SELECT * FROM backtest_trades WHERE backtest_run_id = $1 AND trade_number = $2`, [
    runId,
    tradeNum,
  ])
).rows[0];

if (!t) {
  console.error("Trade not found");
  process.exit(1);
}

const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const { resolveCostModel, tradeBreakdown, applySlippage, fundingPaidBetween } = await import(
  "../src/backtest/engine/costModel.js"
);
const cm = resolveCostModel(cfg, run.cost_model ?? {});

const entry = Number(t.entry_price);
const exit = Number(t.exit_price);
const qty = Number(t.quantity);
const sl = Number(t.sl_price);
const slip = cm.slippagePct;

// Reverse-engineer raw SL before exit slippage (SHORT close = BUY slip)
const rawSlFromExit = exit / (1 + slip);

const breakdown = tradeBreakdown({
  side: t.direction,
  entryFill: entry,
  exitFill: exit,
  qty,
  leverage: cm.leverage,
  model: cm,
});

const fromMs = new Date(t.entry_time).getTime();
const toMs = new Date(t.exit_time).getTime();
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const fundingRates = await readFundingRates(t.symbol, fromMs, toMs).catch(() => []);
const fundingPaid = fundingPaidBetween(
  { side: t.direction, qty, entryFill: entry },
  fundingRates,
  fromMs,
  toMs,
);

const grossDb = Number(t.gross_pnl);
const feesDb = Number(t.fees_usdt);
const netDb = Number(t.net_pnl);
const fundDb = Number(t.funding_paid);
const slipDb = Number(t.slippage_cost);

const netCalc = breakdown.gross - breakdown.fees - fundingPaid;
const grossManual = (entry - exit) * qty; // SELL

const slipCalc =
  Math.abs(qty) * (Math.abs(entry * slip) + Math.abs(exit * slip));

const prev = (
  await pool.query(
    `SELECT trade_number, net_pnl, signal_context FROM backtest_trades WHERE backtest_run_id=$1 AND trade_number=$2`,
    [runId, tradeNum - 1],
  )
).rows[0];
const sc = t.signal_context ?? {};
const prevSc = prev?.signal_context ?? {};
const eqAtEntry = Number(sc.equityAtEntry);
const prevEq = Number(prevSc.equityAtEntry) + Number(prev?.net_pnl ?? 0);

console.log("═".repeat(72));
console.log(`Trade #${tradeNum} · Run ${run.id.slice(0, 8)} · ${t.symbol} ${t.direction} · ${t.exit_reason}`);
console.log("═".repeat(72));
console.log(`Entry  ${t.entry_time} @ ${entry}`);
console.log(`Exit   ${t.exit_time} @ ${exit} (${t.bars_held} bars)`);
console.log(`SL     ${sl} (raw≈${rawSlFromExit.toFixed(8)} vs exit slip check)`);
console.log(`Qty    ${qty} · Margin $${Number(sc.marginUsdt).toFixed(2)} · Lev ${cm.leverage}x`);
console.log(`Trail  ${sc.trailTierLabel} step ${sc.trailStep} · MAE ${t.mae_pct}% MFE ${t.mfe_pct}%`);
console.log("");
console.log("Cost model:", {
  takerOpen: cm.takerOpenFeeRate,
  takerClose: cm.takerCloseFeeRate,
  slippagePct: slip,
});

console.log("\n── Gross PnL ──");
console.log(`  Manual (entry-exit)×qty:     $${grossManual.toFixed(8)}`);
console.log(`  tradeBreakdown.gross:        $${breakdown.gross.toFixed(8)}`);
console.log(`  DB gross_pnl:                $${grossDb.toFixed(8)}`);
console.log(`  Match: ${Math.abs(grossManual - grossDb) < 0.01 ? "✓" : "✗"}`);

console.log("\n── Fees ──");
console.log(`  Entry fee (qty×entry×rate):  $${breakdown.entryFee.toFixed(8)}`);
console.log(`  Exit fee (qty×exit×rate):    $${breakdown.exitFee.toFixed(8)}`);
console.log(`  Sum:                         $${breakdown.fees.toFixed(8)}`);
console.log(`  DB fees_usdt:                $${feesDb.toFixed(8)}`);
console.log(`  Match: ${Math.abs(breakdown.fees - feesDb) < 0.01 ? "✓" : "✗"}`);

console.log("\n── Funding ──");
console.log(`  Recomputed fundingPaid:      $${fundingPaid.toFixed(8)} (${fundingRates.length} events)`);
console.log(`  DB funding_paid:             $${fundDb.toFixed(8)}`);
console.log(`  Match: ${Math.abs(fundingPaid - fundDb) < 0.01 ? "✓" : "✗"}`);
console.log(`  Note: negative = short received net funding (reduces cost)`);

console.log("\n── Net PnL ──");
console.log(`  gross - fees - funding:      $${netCalc.toFixed(8)}`);
console.log(`  DB net_pnl:                  $${netDb.toFixed(8)}`);
console.log(`  Match: ${Math.abs(netCalc - netDb) < 0.01 ? "✓" : "✗"}`);
console.log(`  Check: gross-fees+fundingRecv: $${(grossDb - feesDb + Math.abs(fundDb)).toFixed(2)} (if fund negative)`);

console.log("\n── Slippage (informational) ──");
console.log(`  Reported slippage_cost:      $${slipDb.toFixed(8)}`);
console.log(`  qty×(entry×slip+exit×slip):   $${slipCalc.toFixed(8)}`);
console.log(`  Match: ${Math.abs(slipCalc - slipDb) < 0.05 ? "✓" : "✗"}`);
console.log("  (Slippage already embedded in entry/exit prices used for gross)");

const roiOnMargin = (netDb / Number(sc.marginUsdt)) * 100;
console.log("\n── ROI ──");
console.log(`  DB roi_pct:                  ${t.roi_pct}%`);
console.log(`  net/margin×100:              ${roiOnMargin.toFixed(4)}%`);
console.log(`  DB roi looks like net/margin×100 with wrong scale if >>100`);

if (prev) {
  console.log("\n── Equity chain ──");
  console.log(`  #${tradeNum - 1} equity after: $${prevEq.toFixed(2)}`);
  console.log(`  #${tradeNum} equity@entry:    $${eqAtEntry.toFixed(2)} ${Math.abs(eqAtEntry - prevEq) < 0.02 ? "✓" : "✗"}`);
  console.log(`  #${tradeNum} equity after:    $${(eqAtEntry + netDb).toFixed(2)}`);
}

await closePool();
