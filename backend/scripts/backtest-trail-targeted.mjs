/**
 * Targeted: ST multiplier, delayed activation (~TP), minGap sweep (advanced-only).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const FROM = new Date("2026-01-01").getTime();
const TO = new Date("2026-05-15").getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const candles = await readCandles("BTCUSDT", "15m", FROM, TO);

function base(o = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 50,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: 0.008,
    supertrendFuturesFixedTpPct: 0.025,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: false,
    futuresTrailingStAdvanced: true,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    riskPerTrade: 5,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0001,
    strategyMode: "MANUAL",
    manualStrategy: "HTF_RSI",
    trailOpenFeeRate: 0.0005,
    trailCloseFeeRate: 0.0005,
    trailBufferMode: "PERCENT",
    ...o,
  };
}

async function run(label, cfg) {
  const adapters = await buildBacktestAdapters({
    strategyKey: "HTF_RSI",
    cfg,
    symbol: "BTCUSDT",
    tf: "15m",
    candles,
    fromMs: FROM,
  });
  const sim = await runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: "15m",
    adapters,
    symbol: "BTCUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 1000 });
  const ex = {};
  for (const t of sim.trades) ex[t.exitReason || "?"] = (ex[t.exitReason || "?"] || 0) + 1;
  const ret = m.totalReturnPct ?? 0;
  console.log(
    `${label.padEnd(52)} ret=${ret.toFixed(1).padStart(6)}% SL=${ex.sl ?? 0} trail=${ex.trail ?? 0} tp=${ex.tp ?? 0} DD=${(m.maxDrawdownPct ?? 0).toFixed(1)}%`,
  );
  return { label, ret, ex };
}

const results = [];
console.log(`Candles: ${candles.length}\n`);
results.push(await run("no_trail", base({ trailingStopLossAuto: false })));
results.push(await run("adv buf=0.0015 mult=3", base({ trailBufferRate: 0.0015, supertrendMultiplier: 3 })));

for (const mult of [2, 3, 4, 5, 6]) {
  for (const buf of [0.0015, 0.002, 0.025, 0.03]) {
    results.push(
      await run(`ST mult=${mult} buf=${buf}`, base({ supertrendMultiplier: mult, trailBufferRate: buf })),
    );
  }
}

for (const tp of [0.025, 0.04, 0.05, 0.08]) {
  results.push(
    await run(`TP=${(tp * 100).toFixed(0)}% buf=0.0015`, base({ supertrendFuturesFixedTpPct: tp, trailBufferRate: 0.0015 })),
  );
  results.push(
    await run(`TP=${(tp * 100).toFixed(0)}% buf=0.025 trail`, base({
      supertrendFuturesFixedTpPct: tp,
      trailBufferRate: 0.025,
      supertrendMultiplier: 4,
    })),
  );
}

for (const mult of [0.6, 0.8, 1.0, 1.5]) {
  results.push(
    await run(`ATR mult=${mult} ST=4`, base({
      trailBufferMode: "ATR",
      trailBufferAtrMult: mult,
      supertrendMultiplier: 4,
      trailBufferRate: 0.002,
    })),
  );
}

results.sort((a, b) => b.ret - a.ret);
console.log("\nTOP 8:");
for (const r of results.slice(0, 8)) console.log(`  ${r.label} → ${r.ret.toFixed(2)}%`);

await closePool();
