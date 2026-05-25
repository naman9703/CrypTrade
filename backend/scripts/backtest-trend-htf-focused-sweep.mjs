#!/usr/bin/env node
/** Focused sweep around H2-winning zone: tp4-5, sep0.06-0.1, cross filter */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

const cache = new Map();
async function run(from, to, cfg) {
  const k = `${from}|${to}|${JSON.stringify(cfg)}`;
  if (cache.has(k)) return cache.get(k);
  const fromMs = new Date(from).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, new Date(to).getTime());
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...TREND_HTF_ST_BNB_MAX_PRESET,
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  const r = { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0 };
  cache.set(k, r);
  return r;
}

const crossRegime = {
  trendHtfStRegimeGate: true,
  trendHtfStRegimeBlockCross: true,
  trendHtfStRegimeBlockTriple: false,
  trendHtfStRegimeBlockWhipsaw: false,
  trendHtfStRegimeMinHtfTrendAgeHours: 0,
};

const results = [];
for (const tp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
  for (const sep of [0.0005, 0.0006, 0.0007, 0.0008]) {
    for (const useCross of [false, true]) {
      const cfg = {
        supertrendFuturesFixedTpPct: tp,
        trendHtfStMinHtfSep: sep,
        ...(useCross ? crossRegime : { trendHtfStRegimeGate: false }),
      };
      const h2 = await run("2025-06-01", "2025-12-31", cfg);
      const jan = await run("2026-01-01", "2026-05-19", cfg);
      const yr = await run("2025-06-01", "2026-05-19", cfg);
      const pass = h2.ret >= 0 && jan.wr >= 52 && jan.ret >= 300 && yr.ret >= 220;
      results.push({
        label: `tp${(tp * 100).toFixed(1)} sep${(sep * 100).toFixed(2)}% ${useCross ? "cross" : "—"}`,
        h2,
        jan,
        yr,
        pass,
        score: h2.ret * 0.4 + jan.ret * 0.35 + yr.ret * 0.25,
      });
    }
  }
}

results.sort((a, b) => b.score - a.score);
console.log("── Focused sweep (top 20) ──\n");
for (const r of results.slice(0, 20)) {
  console.log(
    `${r.pass ? "✓" : " "} ${r.label.padEnd(28)} H2=${String(r.h2.ret.toFixed(0)).padStart(4)}%/${r.h2.wr.toFixed(0)}% Jan=${String(r.jan.ret.toFixed(0)).padStart(4)}%/${r.jan.wr.toFixed(0)}% 1yr=${r.yr.ret.toFixed(0)}%`,
  );
}
const pass = results.filter((r) => r.pass);
console.log(`\n${pass.length} pass (H2≥0, Jan≥300%@52%WR, 1yr≥220%)`);
if (pass[0]) console.log("Best pass cfg:", JSON.stringify(pass[0], null, 2));

await closePool?.();
