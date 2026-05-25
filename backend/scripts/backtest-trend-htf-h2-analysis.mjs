#!/usr/bin/env node
/**
 * Classify TREND_HTF_ST trades: Jun–Dec 2025 (bad) vs Jan–May 2026 (good).
 * Finds discriminating entry features for structural chop losses.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");
const { evaluateTrendHtfStEntryQuality, classifyTradeOutcome } = await import(
  "../src/strategy/trendHtfStEntryQuality.js"
);

async function simWindow(from, to) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, toMs);
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...TREND_HTF_ST_BNB_MAX_PRESET,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
  });
  return runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
}

function enrichTrade(t, candles) {
  const entryIdx = candles.findIndex((c) => c.ts >= t.entryTs);
  const signalIdx = Math.max(0, entryIdx - 1);
  const q = evaluateTrendHtfStEntryQuality(candles, signalIdx, t.direction);
  const outcome = classifyTradeOutcome(t);
  return { ...t, quality: q, outcome };
}

function summarize(label, trades) {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const flagged = trades.filter((t) => t.quality?.wouldBlock);
  const flaggedLoss = flagged.filter((t) => t.netPnl <= 0);
  const flaggedWin = flagged.filter((t) => t.netPnl > 0);

  console.log(`\n══ ${label} (${trades.length} trades, ${losses.length} losses) ══`);
  console.log(
    `  chop filter would block: ${flagged.length} (${flaggedLoss.length} losses, ${flaggedWin.length} wins)`,
  );

  const flagCounts = {};
  for (const t of trades) {
    for (const f of t.quality?.flags ?? []) {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
  }
  console.log("  flag frequency (all trades):");
  for (const [f, n] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) {
    const lossN = trades.filter((x) => x.quality?.flags?.includes(f) && x.netPnl <= 0).length;
    console.log(`    ${f.padEnd(22)} ${n} (${lossN} losses)`);
  }

  const outcomeCounts = {};
  for (const t of losses) {
    outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] || 0) + 1;
  }
  console.log("  loss outcome patterns:");
  for (const [k, n] of Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(18)} ${n}`);
  }

  const avg = (arr, fn) => (arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0);
  console.log(
    `  avg entry score  wins=${avg(wins, (t) => t.quality.score).toFixed(1)} losses=${avg(losses, (t) => t.quality.score).toFixed(1)}`,
  );
  console.log(
    `  avg htf sep%     wins=${avg(wins, (t) => t.quality.htfSepPct * 100).toFixed(3)} losses=${avg(losses, (t) => t.quality.htfSepPct * 100).toFixed(3)}`,
  );
  console.log(
    `  avg adx          wins=${avg(wins, (t) => t.quality.adx15m).toFixed(1)} losses=${avg(losses, (t) => t.quality.adx15m).toFixed(1)}`,
  );
  console.log(
    `  avg st flips/16b wins=${avg(wins, (t) => t.quality.stFlipCount16).toFixed(1)} losses=${avg(losses, (t) => t.quality.stFlipCount16).toFixed(1)}`,
  );
}

const h2From = "2025-06-01";
const h2To = "2025-12-31";
const janFrom = "2026-01-01";
const janTo = "2026-05-19";

const h2Candles = await readCandles("BNBUSDT", "15m", new Date(h2From).getTime(), new Date(h2To).getTime());
const janCandles = await readCandles("BNBUSDT", "15m", new Date(janFrom).getTime(), new Date(janTo).getTime());

const h2Sim = await simWindow(h2From, h2To);
const janSim = await simWindow(janFrom, janTo);

const h2Trades = h2Sim.trades.map((t) => enrichTrade(t, h2Candles));
const janTrades = janSim.trades.map((t) => enrichTrade(t, janCandles));

summarize("H2 2025 (Jun–Dec)", h2Trades);
summarize("Jan–May 2026", janTrades);

// Combined filter impact
const fullSim = await simWindow("2025-06-01", "2026-05-19");
const fullCandles = await readCandles(
  "BNBUSDT",
  "15m",
  new Date("2025-06-01").getTime(),
  new Date("2026-05-19").getTime(),
);
const fullTrades = fullSim.trades.map((t) => enrichTrade(t, fullCandles));
const blocked = fullTrades.filter((t) => t.quality?.wouldBlock);
console.log("\n══ Full year — chop filter simulation ══");
console.log(
  `  would block ${blocked.length}/${fullTrades.length}: ${blocked.filter((t) => t.netPnl <= 0).length} losses, ${blocked.filter((t) => t.netPnl > 0).length} wins`,
);
console.log(
  `  kept PnL est: ${fullTrades.filter((t) => !t.quality?.wouldBlock).reduce((s, t) => s + t.netPnl, 0).toFixed(2)} vs full ${fullTrades.reduce((s, t) => s + t.netPnl, 0).toFixed(2)}`,
);

await closePool?.();
