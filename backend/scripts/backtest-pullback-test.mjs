#!/usr/bin/env node
/**
 * Quick isolated test for the TREND_PULLBACK strategy.
 *
 *   node backend/scripts/backtest-pullback-test.mjs --tf 5m --days 30
 *   node backend/scripts/backtest-pullback-test.mjs --tf 1m --days 7
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const symbol = String(arg("symbol", "BTCUSDT")).toUpperCase();
const tf = String(arg("tf", "5m"));
const days = Math.max(1, Number(arg("days", "30")));
const startingUsdt = 10_000;

const cfg = {
  marketMode: "FUTURES",
  futuresLeverage: 5,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.012,
  slAtrMultiplier: 0,
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT_EQUITY",
  slippagePct: 0.0001,
  tradeHistoryTakerOpenFeeRate: 0.0002,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  strategyMode: "MANUAL",
  manualStrategy: "TREND_PULLBACK",
};

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) {
    await initPool({ info: () => {}, warn: () => {}, error: console.error });
  }

  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;

  console.log(`\n=== TREND_PULLBACK Backtest ===`);
  console.log(`${symbol} · ${tf} · ${days}d · ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
  console.log(`SL: ${(cfg.supertrendFuturesFixedSlPct * 100).toFixed(2)}%  TP: ${(cfg.supertrendFuturesFixedTpPct * 100).toFixed(2)}%  Lev: ${cfg.futuresLeverage}x\n`);

  console.log("Fetching candles...");
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  console.log(`Loaded ${candles.length} bars\n`);

  if (!candles.length) {
    console.error("No candles — check DB.");
    process.exit(1);
  }

  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_PULLBACK",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });

  console.log("Running simulation...");
  const sim = await runSimulation({
    strategyKey: "TREND_PULLBACK",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt,
    timeframe: tf,
    adapters,
    symbol,
  });

  const metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });

  // ── Summary ──
  console.log("\n─── RESULTS ───────────────────────────────────────────");
  console.log(`  Trades       : ${sim.trades.length}`);
  console.log(`  Win rate     : ${((metrics.winRate ?? 0) * 100).toFixed(1)}%`);
  console.log(`  Total return : ${(metrics.totalReturnPct ?? 0).toFixed(2)}%`);
  console.log(`  Max DD       : ${(metrics.maxDrawdownPct ?? 0).toFixed(2)}%`);
  console.log(`  Profit factor: ${(metrics.profitFactor ?? 0).toFixed(2)}`);
  console.log(`  Sharpe       : ${(metrics.sharpeRatio ?? 0).toFixed(2)}`);
  console.log(`  Expectancy   : ${(metrics.expectancy ?? 0).toFixed(2)}`);
  console.log(`  Avg hold     : ${avgHoldTime(sim.trades)}`);
  console.log(`  Final equity : $${sim.finalEquity.toFixed(2)}`);

  // ── Exit reason breakdown ──
  const reasons = {};
  for (const t of sim.trades) {
    const r = t.exitReason || "unknown";
    reasons[r] = (reasons[r] || 0) + 1;
  }
  console.log(`\n  Exit reasons :`);
  for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${r.padEnd(14)} ${c}`);
  }

  // ── Direction breakdown ──
  const buys = sim.trades.filter((t) => t.direction === "BUY");
  const sells = sim.trades.filter((t) => t.direction === "SELL");
  const buyWins = buys.filter((t) => t.netPnl > 0).length;
  const sellWins = sells.filter((t) => t.netPnl > 0).length;
  console.log(`\n  LONG  : ${buys.length} trades, ${buys.length ? ((buyWins / buys.length) * 100).toFixed(1) : 0}% win rate`);
  console.log(`  SHORT : ${sells.length} trades, ${sells.length ? ((sellWins / sells.length) * 100).toFixed(1) : 0}% win rate`);

  // ── Sample trades (first 10) ──
  if (sim.trades.length) {
    console.log(`\n  First 10 trades:`);
    console.log(`  ${"#".padStart(3)} ${"dir".padEnd(5)} ${"entry".padStart(10)} ${"exit".padStart(10)} ${"pnl".padStart(8)} ${"exit_reason".padEnd(14)} ${"bars".padStart(5)}`);
    for (const t of sim.trades.slice(0, 10)) {
      const pnlStr = t.netPnl >= 0 ? `+${t.netPnl.toFixed(2)}` : t.netPnl.toFixed(2);
      console.log(`  ${String(t.tradeNumber).padStart(3)} ${t.direction.padEnd(5)} ${t.entryPrice.toFixed(1).padStart(10)} ${t.exitPrice.toFixed(1).padStart(10)} ${pnlStr.padStart(8)} ${(t.exitReason || "").padEnd(14)} ${String(t.barsHeld).padStart(5)}`);
    }
  }

  console.log("\n───────────────────────────────────────────────────────");

  await closePool().catch(() => {});
}

function avgHoldTime(trades) {
  if (!trades.length) return "N/A";
  const avgMs = trades.reduce((s, t) => s + (t.exitTs - t.entryTs), 0) / trades.length;
  if (avgMs < 60000) return `${(avgMs / 1000).toFixed(0)}s`;
  if (avgMs < 3600000) return `${(avgMs / 60000).toFixed(0)}m`;
  return `${(avgMs / 3600000).toFixed(1)}h`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
