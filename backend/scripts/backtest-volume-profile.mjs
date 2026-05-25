#!/usr/bin/env node
/**
 * Backtest standalone VOLUME_PROFILE strategy.
 * Usage: npm run backtest:volume-profile -- [SYMBOL] [TF] [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.argv[4] || "2026-01-01").getTime();
const toMs = new Date(process.argv[5] || "2026-05-18").getTime();
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectVolumeProfilePicks } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_15M } = await import("../src/strategy/presets/volumeProfileOptimized.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
if (candles.length < 700) {
  console.error(`Not enough candles: ${candles.length} (need ~700+ for VP lookback)`);
  process.exit(1);
}

const cfg = { ...VOLUME_PROFILE_15M, symbol, timeframe: tf, marketMode: "FUTURES", strategyMode: "MANUAL", manualStrategy: "VOLUME_PROFILE" };
const picks = selectVolumeProfilePicks(candles, cfg);
const adapters = await buildBacktestAdapters({
  strategyKey: "VOLUME_PROFILE",
  cfg,
  symbol,
  tf,
  candles,
  fromMs,
});
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: tf,
  adapters,
  symbol,
});
const m = computeAllMetrics({
  trades: sim.trades,
  equityCurve: sim.equityCurve,
  tf,
  startingEquity: 100,
});
const tpm = ((m.totalTrades ?? 0) / days) * 30;

console.log(`\nVOLUME_PROFILE ${symbol} ${tf}`);
console.log(`${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)} (${days.toFixed(0)}d, ${candles.length} bars)\n`);
console.log({
  picks: picks.pickedCount,
  candidates: picks.candidateCount,
  trades: m.totalTrades,
  tradesPerMonth: +tpm.toFixed(1),
  winRatePct: +((m.winRate ?? 0) * 100).toFixed(1),
  returnPct: +(m.totalReturnPct ?? 0).toFixed(2),
  profitFactor: +(m.profitFactor ?? 0).toFixed(2),
  maxDrawdownPct: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
});

if (sim.trades.length) {
  console.log("\nTrades:");
  for (const t of sim.trades) {
    const d = new Date(t.entryTs).toISOString().slice(0, 10);
    console.log(`  ${d}  ${t.side ?? "?"}  pnl=${Number(t.netPnl).toFixed(2)}  ${t.exitReason}  setup=${t.vpSetup ?? "—"}`);
  }
}

await closePool?.();
