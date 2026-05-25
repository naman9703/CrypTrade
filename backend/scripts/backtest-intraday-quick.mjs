#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const sym = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "5m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectIntradayPicks, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");

await ensureKlines(sym, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(sym, tf, fromMs, toMs);

const grids = [
  { ms: 10, max: 5, gap: 8, intel: false },
  { ms: 11, max: 4, gap: 10, intel: false },
  { ms: 10, max: 5, gap: 8, intel: true },
  { ms: 11, max: 4, gap: 10, intel: true },
];

for (const g of grids) {
  const cfg = mergeAdaptiveCfg(
    {
      marketMode: "FUTURES",
      futuresLeverage: 12,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTrade: 2.5,
      riskPerTradeUnit: "PCT",
      strategyMode: "MANUAL",
      manualStrategy: "SR_INTRADAY",
      supertrendHtf4hEnabled: true,
      slippagePct: 0.0005,
      srIntradayMinScore: g.ms,
      srIntradayMaxTradesPerDay: g.max,
      srIntradayMinBarGap: g.gap,
      intradayMinTechniqueCount: 4,
      intelligenceGateEnabled: g.intel,
      intelligenceGateHighWinRate: g.intel,
    },
    candles,
  );
  const pick = selectIntradayPicks(candles, { minScore: g.ms, maxTradesPerDay: g.max, minBarGap: g.gap });
  const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol: sym, tf, candles, fromMs });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: g.intel ? "approx" : "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  const tpm = ((m.totalTrades ?? 0) / days) * 30;
  console.log({
    ...g,
    sl: cfg.supertrendFuturesFixedSlPct,
    tp: cfg.supertrendFuturesFixedTpPct,
    cands: pick.candidateCount,
    picks: pick.pickedCount,
    n: m.totalTrades,
    tpm: +tpm.toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    pf: +(m.profitFactor ?? 0).toFixed(2),
  });
}
await closePool?.();
