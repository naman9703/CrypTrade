#!/usr/bin/env node
/** Optimize MANUAL SUPERTREND + intel gate + trailing for 80%+ WR. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TARGET_WR = 80;
const MIN_TRADES = 8;
const symbol = process.argv.includes("--btc") ? "BTCUSDT" : "BNBUSDT";
const from = process.argv.find((a, i) => process.argv[i - 1] === "--from") || "2026-01-01";
const to = process.argv.find((a, i) => process.argv[i - 1] === "--to") || "2026-05-20";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");

const fromMs = new Date(from).getTime();
const toMs = new Date(to).getTime();
await ensureKlines(symbol, "15m", { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, "15m", fromMs, toMs);

const gateCache = new Map();
function gateKey(g) {
  return `${g.strict}|${g.highWr}`;
}
async function getGate(g) {
  const k = gateKey(g);
  if (!gateCache.has(k)) {
    gateCache.set(
      k,
      await buildIntelligenceReplay({
        symbol,
        fromMs,
        toMs,
        candles,
        timeframe: "15m",
        strictMode: g.strict,
        highWinRateMode: g.highWr,
      }),
    );
  }
  return gateCache.get(k);
}

async function runCfg(cfg, g) {
  const full = {
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND",
    supertrendFuturesAuto: true,
    intelligenceGateEnabled: true,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    supertrendFuturesExitOnFlip: false,
    supertrendWilderAtr: true,
    supertrendFuturesFixedTpPct: 0,
    futuresLeverage: 15,
    riskPerTrade: 7,
    riskPerTradeUnit: "PCT",
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SUPERTREND",
    cfg: full,
    symbol,
    tf: "15m",
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SUPERTREND",
    candles,
    cfg: full,
    gateMode: "approx",
    gateFn: await getGate(g),
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  return { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0, gate: sim.gateReplay };
}

const grid = [];
for (const period of [7, 10, 14]) {
  for (const mult of [2.5, 3, 3.5]) {
    for (const sl of [0.01, 0.012, 0.015]) {
      for (const highWr of [true, false]) {
        for (const strict of [false, true]) {
          for (const mq of [false, true]) {
            grid.push({ period, mult, sl, highWr, strict, mq });
          }
        }
      }
    }
  }
}

console.log(`Sweep ${symbol} ${from}..${to} — ${grid.length} configs\n`);
const results = [];
let i = 0;
for (const g of grid) {
  const r = await runCfg(
    {
      supertrendPeriod: g.period,
      supertrendMultiplier: g.mult,
      supertrendFuturesFixedSlPct: g.sl,
      supertrendMoveQualityGate: g.mq,
      supertrendMoveQualityMinScore: 0.58,
      supertrendMoveQualityMinAdx: 24,
      intelligenceGateStrict: g.strict,
      intelligenceGateHighWinRate: g.highWr,
    },
    g,
  );
  if (r.n >= 6) results.push({ ...g, ...r });
  if (r.n >= MIN_TRADES && r.wr >= TARGET_WR) {
    console.log(`★ WR ${r.wr.toFixed(1)}% ret ${r.ret.toFixed(0)}% n=${r.n}`, g);
  }
  if (++i % 24 === 0) process.stdout.write(`\r  ${i}/${grid.length}`);
}
console.log(`\n\nHits >= ${TARGET_WR}%: ${results.filter((r) => r.wr >= TARGET_WR && r.n >= MIN_TRADES).length}`);
results.sort((a, b) => b.wr - a.wr || b.ret - a.ret);
console.log("Top 10 WR:");
results.slice(0, 10).forEach((r) =>
  console.log(`  WR ${r.wr.toFixed(1)}% ret ${r.ret.toFixed(0)}% n=${r.n} p=${r.period} m=${r.mult} sl=${r.sl} highWr=${r.highWr} mq=${r.mq}`),
);
await closePool?.();
