#!/usr/bin/env node
/**
 * Demo: walk-forward split (same logic as backtest worker).
 * Usage:
 *   node scripts/demo-walk-forward.mjs
 *   node scripts/demo-walk-forward.mjs --train=0.5
 *   node scripts/demo-walk-forward.mjs --mode=portfolio
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const trainPct = Number(process.argv.find((a) => a.startsWith("--train="))?.split("=")[1] ?? 0.7);
const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "portfolio";

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates, ensureFunding } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { portfolioReplay, tradesToREvents } = await import("../src/backtest/engine/portfolioReplay.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { normalizeEliteStRunCfg } = await import("../src/strategy/supertrendElite.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const fromMs = Date.parse("2024-01-01T00:00:00Z");
const toMs = Date.parse("2025-01-01T00:00:00Z");
const startingUsdt = 100;
const tf = "1h";

const cfg = normalizeEliteStRunCfg({
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  backtestPositionSizing: "RISK_AT_SL",
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesFixedSlPct: 0.002,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  futuresLeverage: 10,
});

let trades = [];
let equityCurve = [];
let candles = [];
let label = "";

if (mode === "portfolio") {
  const symbols = ["BTCUSDT", "BNBUSDT", "SOLUSDT"];
  label = `Portfolio ${symbols.join("+")} ${tf}`;
  const riskPct = 5;
  const allEvents = [];
  for (const sym of symbols) {
    await ensureKlines(sym, tf, { from: fromMs, to: toMs, market: "futures" }).catch(() => {});
    await ensureFunding(sym, { from: fromMs, to: toMs }).catch(() => {});
    const c = await readCandles(sym, tf, fromMs, toMs, { market: "futures" });
    if (!candles.length) candles = c;
    const fundingRates = await readFundingRates(sym, fromMs, toMs).catch(() => []);
    const adapters = await buildBacktestAdapters({
      strategyKey: "SUPERTREND_ELITE",
      cfg,
      symbol: sym,
      tf,
      candles: c,
      fromMs,
    }).catch(() => ({}));
    const sim = await runSimulation({
      strategyKey: "SUPERTREND_ELITE",
      candles: c,
      cfg,
      gateMode: "off",
      fundingRates,
      startingUsdt: 1000,
      timeframe: tf,
      symbol: sym,
      adapters,
    });
    allEvents.push(...tradesToREvents(sym, sim.trades, riskPct));
  }
  const replay = portfolioReplay({
    events: allEvents,
    startingUsdt,
    riskFrac: riskPct / 100,
    startTs: fromMs,
  });
  trades = replay.trades;
  equityCurve = replay.equityCurve;
} else {
  const symbol = "BNBUSDT";
  label = `${symbol} ${tf}`;
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" }).catch(() => {});
  await ensureFunding(symbol, { from: fromMs, to: toMs }).catch(() => {});
  candles = await readCandles(symbol, tf, fromMs, toMs, { market: "futures" });
  const fundingRates = await readFundingRates(symbol, fromMs, toMs).catch(() => []);
  const adapters = await buildBacktestAdapters({
    strategyKey: "SUPERTREND_ELITE",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  }).catch(() => ({}));
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates,
    startingUsdt,
    timeframe: tf,
    symbol,
    adapters,
  });
  trades = sim.trades;
  equityCurve = sim.equityCurve;
}

console.log("=== Walk-forward demo ===");
console.log(label);
console.log("Window: 2024-01-01 → 2025-01-01 (12 months)");
console.log(`Starting capital: $${startingUsdt}`);
console.log(`Train split: ${(trainPct * 100).toFixed(0)}% / Test: ${((1 - trainPct) * 100).toFixed(0)}%`);
console.log("Config: SUPERTREND_ELITE, SL on 0.2%, 5% risk\n");

const full = computeAllMetrics({ trades, equityCurve, tf, startingEquity: startingUsdt });

const splitIdx = Math.floor(candles.length * trainPct);
const splitTs = Number(candles[splitIdx]?.ts);
const splitDate = new Date(splitTs).toISOString().slice(0, 10);

const trainTrades = trades.filter((t) => Number(t.exitTs) <= splitTs);
const testTrades = trades.filter((t) => Number(t.exitTs) > splitTs);
const trainCurve = equityCurve.filter((p) => Number(p.ts) <= splitTs);
const testCurve = equityCurve.filter((p) => Number(p.ts) > splitTs);
const startingTest = trainCurve.length ? trainCurve[trainCurve.length - 1].equity : startingUsdt;

const train = computeAllMetrics({
  trades: trainTrades,
  equityCurve: trainCurve,
  tf,
  startingEquity: startingUsdt,
});
const test = computeAllMetrics({
  trades: testTrades,
  equityCurve: testCurve,
  tf,
  startingEquity: startingTest,
});

function fmt(m, lbl) {
  return {
    label: lbl,
    trades: m.totalTrades,
    winRate: `${(m.winRate * 100).toFixed(1)}%`,
    returnPct: `${m.totalReturnPct.toFixed(1)}%`,
    netPnl: `$${m.totalNetPnl.toFixed(2)}`,
    maxDD: `${m.maxDrawdownPct.toFixed(1)}%`,
    sharpe: m.sharpe?.toFixed(2) ?? "—",
    expectancy: m.expectancy != null ? `$${m.expectancy.toFixed(2)}/trade` : "—",
  };
}

console.log("Split date (by bar index):", splitDate);
console.log(`Trade assignment: ${trainTrades.length} train exits, ${testTrades.length} test exits (${trades.length} total)\n`);
console.table([fmt(full, "FULL (headline)"), fmt(train, `TRAIN ≤ ${splitDate}`), fmt(test, `TEST > ${splitDate}`)]);

const trainExp = train.expectancy ?? 0;
const testExp = test.expectancy ?? 0;
const wfDeg =
  trainExp > 0 ? ((trainExp - testExp) / trainExp) * 100 : trainExp < 0 && testExp > trainExp ? -100 : null;

console.log("\n--- Interpretation ---");
if (test.totalTrades === 0) {
  console.log("⚠ TEST has 0 trades — split is too early or strategy is too sparse.");
  console.log("  Try: shorter train % (0.5), longer window, or more coins.");
} else if (train.sharpe != null && test.sharpe != null) {
  const sameSign = Math.sign(train.sharpe) === Math.sign(test.sharpe);
  console.log(`Sharpe: ${train.sharpe.toFixed(2)} (train) → ${test.sharpe.toFixed(2)} (test) ${sameSign ? "✓ same sign" : "✗ sign flipped"}`);
  console.log(`Return: ${train.totalReturnPct.toFixed(1)}% (train) → ${test.totalReturnPct.toFixed(1)}% (test on its own equity slice)`);
  if (wfDeg != null) console.log(`Expectancy drop: ${wfDeg.toFixed(1)}% (gate: < 35% for deploy scripts)`);
}

console.log("\n--- In the UI ---");
console.log("New Backtest → Walk-forward ✓ → 0.7 → Run.");
console.log("Headline panel = FULL row. WF train→test column = Sharpe comparison.");

await closePool?.();
