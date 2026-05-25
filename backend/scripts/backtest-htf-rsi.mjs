/**
 * HTF_RSI quick-validation script.
 * Usage: node scripts/backtest-htf-rsi.mjs
 *
 * Tests HTF_RSI (recommended config: SL 0.8%, TP 2.5%, 15m) over:
 *   - Full 4.5 month window (Jan–May)
 *   - Q1 / Q2 split
 *   - Last 30 days (OOS)
 *   - vs RSI_MEAN baseline
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const SYMBOL = "BTCUSDT";

async function run(label, strat, tf, sl, tp, fromMs, toMs, cap = 10_000) {
  const candles = await readCandles(SYMBOL, tf, fromMs, toMs);
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: 5,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: sl,
    supertrendFuturesFixedTpPct: tp,
    trailingStopLossAuto: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0002,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    strategyMode: "MANUAL",
    manualStrategy: strat,
  };
  const adapters = await buildBacktestAdapters({ strategyKey: strat, cfg, symbol: SYMBOL, tf, candles, fromMs });
  const sim = await runSimulation({ strategyKey: strat, candles, cfg, gateMode: "off", fundingRates: [], startingUsdt: cap, timeframe: tf, adapters, symbol: SYMBOL });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: cap });
  const n = m.totalTrades ?? 0, ret = m.totalReturnPct ?? 0, wr = (m.winRate ?? 0) * 100;
  console.log(`${label.padEnd(45)} n=${String(n).padStart(3)} ret=${ret.toFixed(2).padStart(7)}% WR=${wr.toFixed(1)}% PF=${(m.profitFactor ?? 0).toFixed(2)} DD=${(m.maxDrawdownPct ?? 0).toFixed(1)}%`);
}

const f90 = new Date("2026-01-01").getTime(), t90 = new Date("2026-05-15").getTime();
const fQ1 = new Date("2026-01-01").getTime(), tQ1 = new Date("2026-03-31").getTime();
const fQ2 = new Date("2026-04-01").getTime(), tQ2 = new Date("2026-05-15").getTime();
const f30 = Date.now() - 30 * 864e5, tNow = Date.now();

console.log("═══ HTF_RSI Validation (SL 0.8% / TP 2.5% / 5× / 1% risk) ═══\n");
await run("Full Jan–May15 (4.5mo)", "HTF_RSI", "15m", 0.008, 0.025, f90, t90);
await run("Q1  Jan–Mar (in-sample)", "HTF_RSI", "15m", 0.008, 0.025, fQ1, tQ1);
await run("Q2  Apr–May15 (near OOS)", "HTF_RSI", "15m", 0.008, 0.025, fQ2, tQ2);
await run("30d Last 30 days (OOS)", "HTF_RSI", "15m", 0.008, 0.025, f30, tNow);
console.log("\n── Baseline: RSI_MEAN (SL 0.6% / TP 2.0%) ──");
await run("RSI_MEAN Full Jan–May15", "RSI_MEAN", "15m", 0.006, 0.02, f90, t90);
await run("RSI_MEAN Last 30 days", "RSI_MEAN", "15m", 0.006, 0.02, f30, tNow);

await closePool();
