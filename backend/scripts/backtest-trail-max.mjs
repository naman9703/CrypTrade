/**
 * Max-return trailing sweep: ATR/wide buffers, min gap from mark, TP variants.
 * Usage: node scripts/backtest-trail-max.mjs [--quick]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const quick = process.argv.includes("--quick");
const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = new Date("2026-01-01").getTime();
const TO = new Date("2026-05-15").getTime();
const CAP = 1000;
const SL = 0.008;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

console.log("Loading candles…");
const candles = await readCandles(SYMBOL, TF, FROM, TO);
console.log(`  ${candles.length} bars\n`);

function advBase(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 50,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: SL,
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
    tradeHistoryTakerOpenFeeRate: 0.0005,
    tradeHistoryTakerCloseFeeRate: 0.0005,
    strategyMode: "MANUAL",
    manualStrategy: "HTF_RSI",
    trailOpenFeeRate: 0.0005,
    trailCloseFeeRate: 0.0005,
    trailBufferMode: "PERCENT",
    trailPostT02SpacingFrac: 0.004,
    trailPostT02ActivationBufferRate: 0.004,
    ...overrides,
  };
}

async function runOne(label, cfg) {
  const adapters = await buildBacktestAdapters({
    strategyKey: "HTF_RSI",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: FROM,
  });
  const sim = await runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: CAP,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: CAP,
  });
  const exits = {};
  for (const t of sim.trades) {
    exits[t.exitReason || "?"] = (exits[t.exitReason || "?"] || 0) + 1;
  }
  const n = m.totalTrades ?? 0;
  const ret = m.totalReturnPct ?? 0;
  const wr = (m.winRate ?? 0) * 100;
  const dd = m.maxDrawdownPct ?? 0;
  const slN = exits.sl ?? 0;
  const trailN = exits.trail ?? 0;
  const tpN = exits.tp ?? 0;
  const avgWin =
    sim.trades.filter((t) => (t.netPnlUsdt ?? t.pnlUsdt ?? 0) > 0).length > 0
      ? sim.trades
          .filter((t) => (t.netPnlUsdt ?? t.pnlUsdt ?? 0) > 0)
          .reduce((s, t) => s + (t.netPnlUsdt ?? t.pnlUsdt ?? 0), 0) /
        sim.trades.filter((t) => (t.netPnlUsdt ?? t.pnlUsdt ?? 0) > 0).length
      : 0;
  return { label, ret, wr, dd, n, slN, trailN, tpN, exits, avgWin, score: ret - dd * 0.25 };
}

const results = [];

async function sweep(label, cfg) {
  process.stdout.write(`  ${label.slice(0, 58).padEnd(58)} `);
  const r = await runOne(label, cfg);
  results.push(r);
  console.log(
    `ret=${r.ret.toFixed(1)}% SL=${r.slN} trail=${r.trailN} tp=${r.tpN} DD=${r.dd.toFixed(1)}%`,
  );
}

console.log("=== Baselines ===\n");
await sweep("no_trail TP2.5%", advBase({ trailingStopLossAuto: false }));
await sweep("no_trail TP off", advBase({ trailingStopLossAuto: false, supertrendFuturesFixedTpPct: 0 }));
await sweep("adv prev default", advBase({
  trailBufferRate: 0.0015,
  trailPostT02SpacingFrac: 0.002,
  trailPostT02ActivationBufferRate: 0.0014,
  trailMinGapFromMarkFrac: 0,
}));

console.log("\n=== Wider PERCENT buffers + gap from mark ===\n");
const pctBufs = quick ? [0.002, 0.004, 0.006] : [0.002, 0.003, 0.004, 0.005, 0.006, 0.008];
const gaps = quick ? [0, 0.005, 0.01] : [0, 0.003, 0.005, 0.008, 0.01, 0.012];
const spacings = quick ? [0.003, 0.006] : [0.003, 0.004, 0.005, 0.006, 0.008];
for (const buf of pctBufs) {
  for (const gap of gaps) {
    for (const sp of spacings) {
      await sweep(`pct buf=${buf} gap=${gap} sp=${sp}`, advBase({
        trailBufferRate: buf,
        trailPostT02SpacingFrac: sp,
        trailPostT02ActivationBufferRate: buf,
        trailMinGapFromMarkFrac: gap,
      }));
    }
  }
}

console.log("\n=== ATR-based activation buffer ===\n");
const atrMults = quick ? [0.5, 1.0, 1.5] : [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0];
const atrGaps = quick ? [0.005, 0.01] : [0, 0.005, 0.008, 0.01];
for (const mult of atrMults) {
  for (const gap of atrGaps) {
    await sweep(`ATR mult=${mult} gap=${gap}`, advBase({
      trailBufferMode: "ATR",
      trailBufferAtrMult: mult,
      trailBufferRate: 0.002,
      trailPostT02SpacingFrac: 0.005,
      trailPostT02ActivationBufferRate: 0.005,
      trailMinGapFromMarkFrac: gap,
    }));
  }
}

console.log("\n=== TP variants (let trail run past fixed target) ===\n");
const tps = quick ? [0, 0.05] : [0, 0.04, 0.05, 0.08, 0.1];
const bestPct = { buf: 0.004, gap: 0.005, sp: 0.005 };
for (const tp of tps) {
  await sweep(`TP=${tp === 0 ? "off" : (tp * 100).toFixed(0) + "%"} wide trail`, advBase({
    supertrendFuturesFixedTpPct: tp,
    trailBufferRate: bestPct.buf,
    trailPostT02SpacingFrac: bestPct.sp,
    trailPostT02ActivationBufferRate: bestPct.buf,
    trailMinGapFromMarkFrac: bestPct.gap,
  }));
  await sweep(`TP=${tp === 0 ? "off" : (tp * 100).toFixed(0) + "%"} ATR1.0`, advBase({
    supertrendFuturesFixedTpPct: tp,
    trailBufferMode: "ATR",
    trailBufferAtrMult: 1.0,
    trailBufferRate: 0.002,
    trailPostT02SpacingFrac: 0.005,
    trailPostT02ActivationBufferRate: 0.005,
    trailMinGapFromMarkFrac: 0.008,
  }));
}

results.sort((a, b) => b.ret - a.ret);
console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║ TOP 15 by return                                            ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
for (const r of results.slice(0, 15)) {
  console.log(
    `${r.label.padEnd(44)} ret=${r.ret.toFixed(2).padStart(7)}% WR=${r.wr.toFixed(0).padStart(3)}% SL=${String(r.slN).padStart(2)} trail=${r.trailN} tp=${r.tpN} DD=${r.dd.toFixed(1)}%`,
  );
}

const bestTrail = results
  .filter((r) => !r.label.startsWith("no_trail"))
  .sort((a, b) => b.ret - a.ret)[0];
const noTrail = results.find((r) => r.label.startsWith("no_trail TP2.5"));
console.log("\n--- Verdict ---");
console.log(`Best overall:        ${results[0]?.label} → ${results[0]?.ret.toFixed(2)}%`);
console.log(`Best with trailing:  ${bestTrail?.label} → ${bestTrail?.ret.toFixed(2)}%`);
console.log(`No trail (TP 2.5%):  ${noTrail?.ret.toFixed(2)}%`);

await closePool();
