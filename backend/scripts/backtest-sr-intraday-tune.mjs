#!/usr/bin/env node
/** Fast SR_INTRADAY tune — precomputes signals once, sweeps SL/TP/risk. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const SL_TP = [
  { sl: 0.004, tp: 0.01 },
  { sl: 0.005, tp: 0.012 },
  { sl: 0.005, tp: 0.015 },
  { sl: 0.006, tp: 0.015 },
  { sl: 0.006, tp: 0.018 },
  { sl: 0.007, tp: 0.021 },
  { sl: 0.008, tp: 0.024 },
  { sl: 0.006, tp: 0.012, trail: true },
];
const RISKS = [3, 4, 5, 6];
const LEVS = [15, 20, 25];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildSrIntradaySignalSeries } = await import("../src/strategy/srIntraday.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const series = buildSrIntradaySignalSeries(candles);
const rawN = series.filter(Boolean).length;
console.error(`${symbol} raw signals: ${rawN} (${(rawN / days).toFixed(2)}/day)\n`);

let best = null;
let tested = 0;

for (const sltp of SL_TP) {
  for (const risk of RISKS) {
    for (const lev of LEVS) {
      tested++;
      const cfg = {
        marketMode: "FUTURES",
        futuresLeverage: lev,
        backtestPositionSizing: "RISK_AT_SL",
        riskPerTrade: risk,
        riskPerTradeUnit: "PCT",
        supertrendFuturesAuto: false,
        strategyMode: "MANUAL",
        manualStrategy: "SR_INTRADAY",
        supertrendFuturesFixedSlPct: sltp.sl,
        supertrendFuturesFixedTpPct: sltp.tp ?? 0,
        trailingStopLossAuto: Boolean(sltp.trail),
        slippagePct: 0.0005,
        srIntradayCooldownBars: 6,
        srIntradayMaxTradesPerDay: 4,
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
      const m = computeAllMetrics({
        trades: sim.trades,
        equityCurve: sim.equityCurve,
        tf,
        startingEquity: 100,
      });
      const ret = m.totalReturnPct ?? 0;
      const wr = (m.winRate ?? 0) * 100;
      const n = m.totalTrades ?? 0;
      const dd = Math.abs(m.maxDrawdownPct ?? 0);
      const tpd = n / days;
      if (n < 5) continue;
      const sc = ret * 1.3 + wr * 0.9 - Math.max(0, dd - 30) * 1.2 + (wr >= 55 ? 50 : 0);
      const row = { sl: sltp.sl, tp: sltp.tp, trail: sltp.trail, risk, lev, ret, wr, n, dd, tpd, pf: m.profitFactor ?? 0, sc };
      if (!best || sc > best.sc) best = row;
    }
  }
}

console.log(JSON.stringify({ symbol, best, tested, rawSignals: rawN }));
if (best) {
  console.error(
    `BEST: ret=${best.ret.toFixed(1)}% WR=${best.wr.toFixed(1)}% n=${best.n} tpd=${best.tpd.toFixed(2)} sl=${best.sl} tp=${best.tp} risk=${best.risk} lev=${best.lev}`
  );
}
await closePool?.();
