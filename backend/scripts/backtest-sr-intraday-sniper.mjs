#!/usr/bin/env node
/** Tune SR_INTRADAY — target 2–3 tpd, high WR, positive return. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const grids = [
  { minScore: 6, sl: 0.004, tp: 0.012, trail: false, risk: 3, lev: 15, intel: false, gap: 3 },
  { minScore: 7, sl: 0.004, tp: 0.012, trail: false, risk: 3, lev: 15, intel: false, gap: 4 },
  { minScore: 7, sl: 0.0045, tp: 0.015, trail: false, risk: 3, lev: 15, intel: false, gap: 4 },
  { minScore: 7, sl: 0.005, tp: 0, trail: true, be: 0.004, risk: 3, lev: 15, intel: false, gap: 4 },
  { minScore: 8, sl: 0.004, tp: 0.012, trail: false, risk: 2.5, lev: 12, intel: false, gap: 4 },
  { minScore: 7, sl: 0.004, tp: 0.01, trail: false, risk: 2.5, lev: 15, intel: true, gap: 4 },
  { minScore: 8, sl: 0.004, tp: 0.012, trail: false, risk: 2.5, lev: 15, intel: true, gap: 4 },
  { minScore: 6, sl: 0.0035, tp: 0.008, trail: false, risk: 2, lev: 12, intel: true, gap: 3 },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectDailyTopPicks } = await import("../src/strategy/srIntraday.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
console.error(`bars=${candles.length} days=${days.toFixed(0)}`);

let best = null;
for (const g of grids) {
  const pick = selectDailyTopPicks(candles, {
    maxTradesPerDay: 3,
    minScore: g.minScore,
    minBarGap: g.gap ?? (tf === "15m" ? 4 : 8),
  });
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: g.lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: g.risk,
    riskPerTradeUnit: "PCT",
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    supertrendPeriod: 10,
    supertrendMultiplier: 2.5,
    supertrendWilderAtr: true,
    trailingStopLossAuto: Boolean(g.trail),
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: Boolean(g.trail),
    supertrendFuturesFixedSlPct: g.sl,
    supertrendFuturesFixedTpPct: g.trail ? 0 : g.tp,
    backtestBreakevenAtMfePct: g.be ?? 0,
    supertrendHtf4hEnabled: true,
    supertrendHtf4hPeriod: 10,
    supertrendHtf4hMultiplier: 3,
    intelligenceGateEnabled: g.intel,
    intelligenceGateHighWinRate: g.intel,
    slippagePct: 0.0005,
    srIntradayMaxTradesPerDay: 3,
    srIntradayMinScore: g.minScore,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: g.intel ? "approx" : "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  const row = {
    ...g,
    picks: pick.pickedCount,
    cands: pick.candidateCount,
    n: m.totalTrades,
    tpd: +((m.totalTrades ?? 0) / days).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
  };
  console.log(row);
  const sc =
    (row.tpd >= 1.8 && row.tpd <= 3.5 ? 500 : row.tpd >= 1 ? 200 : 0) +
    (row.wr >= 75 ? 400 : row.wr >= 65 ? 200 : 0) +
    row.wr * 2 +
    row.ret * 3 +
    (row.pf > 1.2 ? 300 : row.pf > 1 ? 100 : 0);
  if (!best || sc > best.sc) best = { ...row, sc };
}
console.error("\nBEST", best);
await closePool?.();
