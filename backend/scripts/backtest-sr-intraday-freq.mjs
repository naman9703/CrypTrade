#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "5m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const grids = [
  { sl: 0.006, tp: 0.018, risk: 2, lev: 15, cd: 6 },
  { sl: 0.005, tp: 0.015, risk: 2, lev: 15, cd: 6 },
  { sl: 0.004, tp: 0.012, risk: 2, lev: 20, cd: 6 },
  { sl: 0.005, tp: 0.012, risk: 2, lev: 20, cd: 8 },
  { sl: 0.006, tp: 0.02, risk: 2, lev: 15, cd: 6 },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildSrIntradaySignalSeries } = await import("../src/strategy/srIntraday.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const raw = buildSrIntradaySignalSeries(candles).filter(Boolean).length;
console.error(`${symbol} ${tf} bars=${candles.length} rawSignals=${raw} (${(raw / days).toFixed(2)}/day)\n`);

let best = null;
for (const g of grids) {
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: g.lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: g.risk,
    riskPerTradeUnit: "PCT",
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    supertrendFuturesFixedSlPct: g.sl,
    supertrendFuturesFixedTpPct: g.tp,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    srIntradayCooldownBars: g.cd,
    srIntradayMaxTradesPerDay: 3,
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
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  const row = {
    ...g,
    n: m.totalTrades,
    tpd: +((m.totalTrades ?? 0) / days).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
  };
  console.log(row);
  const freqOk = row.tpd >= 1.8 && row.tpd <= 3.5;
  const profitOk = row.ret > 0 && row.pf > 1.05;
  const sc =
    (freqOk ? 300 : 0) +
    (profitOk ? 500 : 0) +
    row.ret +
    row.wr * 0.8 +
    (row.pf > 1 ? row.pf * 25 : -30);
  if (!best || sc > best.sc) best = { ...row, sc, freqOk, profitOk };
}
console.error("\nBEST", best);
await closePool?.();
