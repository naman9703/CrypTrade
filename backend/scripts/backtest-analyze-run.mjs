#!/usr/bin/env node
/**
 * Deep analysis of a backtest run: losses, trade density, missed opportunities.
 * Usage: node scripts/backtest-analyze-run.mjs [--nth=2] [--run-id=uuid]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const nth = (() => {
  const a = process.argv.find((x) => x.startsWith("--nth="));
  return a ? Math.max(1, parseInt(a.split("=")[1], 10)) : 2;
})();
const runIdArg = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: console.warn, error: console.error });
const pool = getPool();
if (!pool) {
  console.error("No DB");
  process.exit(2);
}

let runId = runIdArg;
if (!runId) {
  const r = await pool.query(
    `SELECT id FROM backtest_runs WHERE status = 'done' ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT $1`,
    [nth],
  );
  runId = r.rows[nth - 1]?.id;
}
if (!runId) {
  console.error("Run not found");
  process.exit(1);
}

const run = (
  await pool.query(
    `SELECT id, symbol, timeframe, start_date, end_date, initial_capital, final_capital,
            total_trades, metrics, config_snapshot, engine_type, created_at
       FROM backtest_runs WHERE id = $1`,
    [runId],
  )
).rows[0];

const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const trades = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price,
            net_pnl, gross_pnl, fees_usdt, exit_reason, sl_price, tp_price,
            mae_pct, mfe_pct, bars_held, signal_context
       FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  )
).rows;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { computeIndicators } = await import("../src/strategy/indicators.js");

const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);
const adapters = await buildBacktestAdapters({
  strategyKey: "HTF_RSI",
  cfg,
  symbol: run.symbol,
  tf: run.timeframe,
  candles,
  fromMs,
});

// Count raw signals
let buySignals = 0;
let sellSignals = 0;
const signalBars = [];
for (let i = 120; i < candles.length - 1; i++) {
  const sig = await adapters.HTF_RSI(candles[i], i, { candles, cfg, timeframe: run.timeframe });
  if (sig?.action === "BUY") {
    buySignals++;
    signalBars.push({ i, ts: candles[i].ts, action: "BUY", reason: sig.reason });
  } else if (sig?.action === "SELL") {
    sellSignals++;
    signalBars.push({ i, ts: candles[i].ts, action: "SELL", reason: sig.reason });
  }
}

const days = (toMs - fromMs) / 86400000;
const metrics = run.metrics || {};

console.log("=".repeat(72));
console.log("BACKTEST RUN ANALYSIS");
console.log("=".repeat(72));
console.log(`Run ID:     ${runId}`);
console.log(`Symbol/TF:  ${run.symbol} ${run.timeframe}`);
console.log(`Period:     ${run.start_date} → ${run.end_date} (${days.toFixed(0)} days)`);
console.log(`Capital:    $${run.initial_capital} → $${Number(run.final_capital).toFixed(2)}`);
console.log(`Return:     ${metrics.totalReturnPct != null ? Number(metrics.totalReturnPct).toFixed(2) + "%" : "—"}`);
console.log(`Trades:     ${trades.length} (${(trades.length / (days / 30)).toFixed(1)}/month)`);
console.log(`Strategy:   ${cfg.manualStrategy ?? run.engine_type}`);
console.log(`SL/TP:      ${(Number(cfg.supertrendFuturesFixedSlPct ?? 0) * 100).toFixed(2)}% / ${(Number(cfg.supertrendFuturesFixedTpPct ?? 0) * 100).toFixed(2)}%`);
console.log(`Risk:       ${cfg.riskPerTrade}% ${cfg.riskPerTradeUnit ?? ""} · Lev ${cfg.futuresLeverage ?? cfg.leverage ?? "?"}`);
console.log(`Trail:      ${cfg.trailingStopLossAuto ? "ON" : "OFF"} · FeeBE ${cfg.futuresTrailingStFeeBreakeven !== false} · Adv ${cfg.futuresTrailingStAdvanced !== false}`);
console.log(`ST mult:    ${cfg.supertrendMultiplier ?? 3} · Trail buf ${cfg.trailBufferMode ?? "PERCENT"} ${cfg.trailBufferAtrMult ?? cfg.trailBufferRate}`);
console.log(`Raw signals: BUY ${buySignals} SELL ${sellSignals} total ${buySignals + sellSignals} (${signalBars.length} bars)`);
console.log(`Candles:    ${candles.length}`);

// Exit breakdown
const exits = {};
for (const t of trades) exits[t.exit_reason] = (exits[t.exit_reason] || 0) + 1;
console.log("\nExit reasons:", exits);

// Loss analysis
const losses = trades.filter((t) => Number(t.net_pnl) < 0);
const wins = trades.filter((t) => Number(t.net_pnl) > 0);
console.log(`\nWins: ${wins.length} · Losses: ${losses.length} · WR ${((wins.length / trades.length) * 100).toFixed(1)}%`);

console.log("\n--- LOSS TRADES (SL focus) ---\n");
for (const t of losses) {
  const ctx = t.signal_context || {};
  const entry = Number(t.entry_price);
  const exit = Number(t.exit_price);
  const sl = Number(t.sl_price);
  const mae = Number(t.mae_pct);
  const mfe = Number(t.mfe_pct);
  const dir = t.direction;
  const movePct = dir === "BUY" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
  const hadProfitFirst = mfe > 0.3; // went >0.3% in favor before loss
  console.log(
    `#${t.trade_number} ${dir} ${t.exit_reason} | entry ${entry.toFixed(1)} exit ${exit.toFixed(1)} | PnL ${Number(t.net_pnl).toFixed(2)} | MAE ${mae?.toFixed(2)}% MFE ${mfe?.toFixed(2)}% | bars ${t.bars_held} | ${hadProfitFirst ? "HAD profit first" : "never green"}`,
  );
}

// SL trades specifically
const slTrades = trades.filter((t) => t.exit_reason === "sl");
console.log(`\n--- SL exits: ${slTrades.length} ---`);
let hadMfeBeforeSl = 0;
for (const t of slTrades) {
  if (Number(t.mfe_pct) > 0.2) hadMfeBeforeSl++;
}
console.log(`SL trades that reached >0.2% MFE before stopping: ${hadMfeBeforeSl}/${slTrades.length}`);

// Missed signals vs taken
const takenEntryTimes = new Set(trades.map((t) => new Date(t.entry_time).getTime()));
let missedSignals = 0;
for (const s of signalBars) {
  const entryTs = candles[s.i + 1]?.ts;
  if (entryTs && !takenEntryTimes.has(entryTs)) missedSignals++;
}
console.log(`\nSignals while flat (potential extra entries): ~${missedSignals} not taken (overlapping position / same-bar rules)`);

// Monthly trade density
const byMonth = {};
for (const t of trades) {
  const m = new Date(t.entry_time).toISOString().slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log("\nTrades per month:", byMonth);

// Gap between trades
console.log("\nLongest gaps between entries (days):");
const entryTimes = trades.map((t) => new Date(t.entry_time).getTime()).sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < entryTimes.length; i++) {
  gaps.push({ days: (entryTimes[i] - entryTimes[i - 1]) / 86400000, after: i });
}
gaps.sort((a, b) => b.days - a.days);
for (const g of gaps.slice(0, 8)) {
  console.log(`  ${g.days.toFixed(1)}d after trade #${g.after}`);
}

await closePool();
