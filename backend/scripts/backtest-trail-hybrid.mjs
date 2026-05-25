/** Hybrid: deferred activation (buf ~ TP) + higher TP for extensions. */
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
    trailMinGapFromMarkFrac: 0,
    supertrendMultiplier: 3,
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
    `${label.padEnd(48)} ret=${ret.toFixed(1).padStart(6)}% SL=${ex.sl ?? 0} trail=${ex.trail ?? 0} tp=${ex.tp ?? 0} DD=${(m.maxDrawdownPct ?? 0).toFixed(1)}%`,
  );
  return { label, ret, ex };
}

const grid = [
  ["no_trail TP2.5%", base({ trailingStopLossAuto: false })],
  ["trail buf=TP(2.5%)", base({ trailBufferRate: 0.025 })],
  ["TP4% buf2.5%", base({ supertrendFuturesFixedTpPct: 0.04, trailBufferRate: 0.025 })],
  ["TP5% buf2.5%", base({ supertrendFuturesFixedTpPct: 0.05, trailBufferRate: 0.025 })],
  ["TP5% buf2%", base({ supertrendFuturesFixedTpPct: 0.05, trailBufferRate: 0.02 })],
  ["TP6% buf2.5%", base({ supertrendFuturesFixedTpPct: 0.06, trailBufferRate: 0.025 })],
  ["TP8% buf2.5%", base({ supertrendFuturesFixedTpPct: 0.08, trailBufferRate: 0.025 })],
  ["TP5% buf2.5% ST4", base({ supertrendFuturesFixedTpPct: 0.05, trailBufferRate: 0.025, supertrendMultiplier: 4 })],
  ["TP5% buf2.5% ST5", base({ supertrendFuturesFixedTpPct: 0.05, trailBufferRate: 0.025, supertrendMultiplier: 5 })],
  ["TP4% buf1.5%", base({ supertrendFuturesFixedTpPct: 0.04, trailBufferRate: 0.015 })],
  ["adv tight buf0.15%", base({ trailBufferRate: 0.0015 })],
];

const results = [];
for (const [label, cfg] of grid) results.push(await run(label, cfg));
results.sort((a, b) => b.ret - a.ret);
console.log("\nRanked:");
for (const r of results) console.log(`  ${r.label} → ${r.ret.toFixed(2)}%`);
await closePool();
