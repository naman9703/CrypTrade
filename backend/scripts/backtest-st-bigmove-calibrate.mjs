#!/usr/bin/env node
/**
 * Calibrate big-move gate thresholds from ST-only backtest trades (intel OFF).
 * Finds strength/move/ADX cuts that maximize WR while keeping enough trades.
 *
 *   node scripts/backtest-st-bigmove-calibrate.mjs --symbol BNBUSDT
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbol = String(arg("symbol", "BNBUSDT")).toUpperCase();
const tf = String(arg("tf", "15m"));
const fromMs = new Date(arg("from", "2026-01-01")).getTime();
const toMs = new Date(arg("to", "2026-05-20")).getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { computeSupertrendSeries } = await import("../src/strategy/supertrend.js");
const { evaluateSupertrendBigMoveGate, BIG_MOVE_DEFAULTS } = await import("../src/strategy/supertrendBigMoveGate.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const cfg = {
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  intelligenceGateEnabled: false,
  supertrendBigMoveGateEnabled: false,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.03,
  trailingStopLossAuto: false,
  supertrendFlipExitEnabled: true,
  riskPerTrade: 8,
  futuresLeverage: 15,
  riskPerTradeUnit: "PCT",
};
const adapters = await buildBacktestAdapters({ strategyKey: "SUPERTREND", cfg, symbol, tf, candles, fromMs });
const stSeries = computeSupertrendSeries(candles, { period: 10, multiplier: 3, wilder: true });
const sim = await runSimulation({
  strategyKey: "SUPERTREND",
  candles,
  cfg,
  gateMode: "off",
  gateFn: null,
  startingUsdt: 100,
  timeframe: tf,
  adapters,
  symbol,
});

const slPct = 0.012;
const loose = { ...BIG_MOVE_DEFAULTS, minScore: 0.3, minAdx: 0, minMoveToSlRatio: 0.5, minStrength: 0, minVolumeVsAvg: 0 };

function idxForTs(ts) {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].ts >= ts) return Math.max(0, i - 1);
  }
  return candles.length - 1;
}

const rows = [];
for (const t of sim.trades) {
  const idx = t.entryIdx ?? idxForTs(t.entryTs);
  if (idx == null || idx < 0) continue;
  const side = t.side === "SHORT" ? "SELL" : "BUY";
  const bm = evaluateSupertrendBigMoveGate({
    candles,
    idx,
    barSignal: { action: side },
    stSeries,
    lastFlipIdx: idx,
    slDistancePct: slPct,
    opts: loose,
  });
  rows.push({
    win: Number(t.netPnl ?? 0) > 0,
    strength: bm.strength ?? 0,
    moveToSl: bm.moveToSlRatio ?? 0,
    mfe: t.mfePct ?? t.mfe ?? 0,
    exit: t.exitReason,
  });
}

const wins = rows.filter((r) => r.win);
const losses = rows.filter((r) => !r.win);
console.log(`\n${symbol} ST-only baseline: ${rows.length} trades, ${wins.length}W ${losses.length}L, WR ${((wins.length / rows.length) * 100).toFixed(1)}%`);

function sweepThreshold(getter, cuts) {
  console.log(`\nThreshold sweep (${getter.name}):`);
  for (const cut of cuts) {
    const kept = rows.filter((r) => getter(r) >= cut);
    if (kept.length < 5) continue;
    const w = kept.filter((r) => r.win).length;
    const wr = (w / kept.length) * 100;
    console.log(`  ≥${cut}: ${kept.length} trades WR ${wr.toFixed(1)}% (keeps ${((w / wins.length) * 100).toFixed(0)}% of wins)`);
  }
}

sweepThreshold((r) => r.strength, [40, 45, 50, 55, 60, 65, 70, 75]);
sweepThreshold((r) => r.moveToSl, [0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0]);

// Combined grid for WR >= 80%
let best = null;
for (const st of [45, 50, 55, 60, 65, 70]) {
  for (const ms of [0.6, 0.8, 1.0, 1.2, 1.5]) {
    const kept = rows.filter((r) => r.strength >= st && r.moveToSl >= ms);
    if (kept.length < 8) continue;
    const wr = (kept.filter((r) => r.win).length / kept.length) * 100;
    if (wr >= 80 && (!best || kept.length > best.n)) best = { st, ms, n: kept.length, wr };
  }
}
console.log(
  best
    ? `\nBest WR≥80% combo: strength≥${best.st} move/SL≥${best.ms} → ${best.n} trades WR ${best.wr.toFixed(1)}%`
    : "\nNo strength+move combo reached 80% WR with ≥8 trades on this window",
);

await closePool?.();
