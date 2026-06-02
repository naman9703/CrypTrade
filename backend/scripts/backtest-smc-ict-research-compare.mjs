#!/usr/bin/env node
/**
 * Diagnose PnL differences: isolated window sim vs continuous full-range sim.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const inFrom = Date.parse("2026-01-01");
const inTo = Date.parse("2026-05-27");
const STARTING = 10_000;
const RISK_USD = STARTING * 0.025;

const { INTRADAY_PRO_ICT_RESEARCH_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

function agg(trades, fromMs, toMs) {
  const byEntry = new Map();
  for (const t of trades.filter((x) => x.entryTs >= fromMs && x.entryTs <= toMs)) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const n = pnls.length;
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const rs = pnls.map((p) => p / RISK_USD);
  const wr = n ? wins / n : 0;
  const aw = rs.filter((r, i) => pnls[i] > 0);
  const al = rs.filter((r, i) => pnls[i] <= 0).map(Math.abs);
  const avgWinR = aw.length ? aw.reduce((a, b) => a + b, 0) / aw.length : 0;
  const avgLossR = al.length ? al.reduce((a, b) => a + b, 0) / al.length : 0;
  return {
    entries: n,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    totalPnlUsd: Math.round(total * 100) / 100,
    returnPctCorrect: Math.round((total / STARTING) * 10000) / 100,
    returnPctOldBuggy: Math.round(total / 100) / 100,
    expectancyR: n ? Math.round((wr * avgWinR - (1 - wr) * avgLossR) * 100) / 100 : null,
    avgWinR: aw.length ? Math.round(avgWinR * 100) / 100 : null,
    avgLossR: al.length ? Math.round(avgLossR * 100) / 100 : null,
    pnlDistribution: pnls.map((p) => Math.round(p * 100) / 100).sort((a, b) => b - a),
    entryTimes: [...byEntry.keys()].map((ts) => new Date(ts).toISOString()),
  };
}

async function sim(candles, label) {
  clearIntradayAdapterCache();
  const cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_ICT_RESEARCH_15M, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: { ...merged, symbol, timeframe: tf, manualStrategy: "SR_INTRADAY", marketMode: "FUTURES", riskPerTrade: 2.5, futuresLeverage: 12 },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: STARTING,
    timeframe: tf,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  return { label, finalEquity: Math.round(out.finalEquity * 100) / 100, ...agg(out.trades, inFrom, inTo) };
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const cIsolated = await readCandles(symbol, tf, inFrom - 5 * 864e5, inTo);
const cContinuous = await readCandles(symbol, tf, Date.parse("2025-06-01") - 10 * 864e5, inTo + 864e5);
await closePool();

const isolated = await sim(cIsolated, "isolated_in_sample_only");
const continuous = await sim(cContinuous, "continuous_from_jun2025");

const sameEntries =
  isolated.entries === continuous.entries &&
  isolated.entryTimes.every((t, i) => t === continuous.entryTimes[i]);

console.log(
  JSON.stringify(
    {
      explanation:
        "Risk sizing is PCT_EQUITY. Continuous sim loses ~24% in OOS before Jan 2026, so in-sample trades use smaller qty → lower $ PnL and lower R vs fixed $250 denominator.",
      sameTradeCountAndTimestamps: sameEntries,
      isolated: { candles: cIsolated.length, ...isolated },
      continuousFilteredToInSample: { candles: cContinuous.length, ...continuous },
      pnlRatioTopWin:
        isolated.pnlDistribution[0] && continuous.pnlDistribution[0]
          ? Math.round((continuous.pnlDistribution[0] / isolated.pnlDistribution[0]) * 100) / 100
          : null,
    },
    null,
    2,
  ),
);
