#!/usr/bin/env node
/**
 * Sweep TREND_HTF_ST regime-gate parameters — H2 2025, Jan 2026, full year.
 */
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

const WINDOWS = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan26", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

const candleCache = new Map();
async function candlesFor(from, to) {
  const k = `${from}|${to}`;
  if (!candleCache.has(k)) {
    candleCache.set(
      k,
      await readCandles("BNBUSDT", "15m", new Date(from).getTime(), new Date(to).getTime()),
    );
  }
  return candleCache.get(k);
}

async function runCfg(label, regimeOpts) {
  const rows = [];
  for (const [wname, from, to] of WINDOWS) {
    const candles = await candlesFor(from, to);
    const cfg = {
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
      trendHtfStRegimeGate: true,
      ...regimeOpts,
    };
    const adapters = await buildBacktestAdapters({
      strategyKey: "TREND_HTF_ST",
      cfg,
      symbol: "BNBUSDT",
      tf: "15m",
      candles,
      fromMs: new Date(from).getTime(),
    });
    const sim = await runSimulation({
      strategyKey: "TREND_HTF_ST",
      candles,
      cfg,
      gateMode: "off",
      fundingRates: [],
      startingUsdt: 100,
      timeframe: "15m",
      adapters,
      symbol: "BNBUSDT",
    });
    const m = computeAllMetrics({
      trades: sim.trades,
      equityCurve: sim.equityCurve,
      tf: "15m",
      startingEquity: 100,
    });
    const sl = sim.trades.filter((t) => t.exitReason === "sl").length;
    const n = m.totalTrades ?? 0;
    rows.push({
      w: wname,
      n,
      wr: (m.winRate ?? 0) * 100,
      ret: m.totalReturnPct ?? 0,
      slPct: n ? (sl / n) * 100 : 0,
    });
  }
  return { label, rows };
}

function scoreResult(rows) {
  const h2 = rows.find((r) => r.w === "H2");
  const jan = rows.find((r) => r.w === "Jan26");
  const yr = rows.find((r) => r.w === "1yr");
  // Production score: H2 must be >= 0, Jan WR >= 55%, 1yr ret >= 180%
  const h2Ok = h2.ret >= 0;
  const janOk = jan.wr >= 55 && jan.ret >= 350;
  const yrOk = yr.ret >= 180;
  const composite = h2.ret * 0.35 + jan.ret * 0.35 + yr.ret * 0.3;
  return { composite, h2Ok, janOk, yrOk, pass: h2Ok && janOk && yrOk };
}

console.log("── Regime gate sweep ──\n");

const variants = [
  { label: "baseline (no gate)", regimeOpts: { trendHtfStRegimeGate: false } },
  { label: "cross only", regimeOpts: { trendHtfStRegimeBlockCross: true, trendHtfStRegimeBlockTriple: false, trendHtfStRegimeBlockWhipsaw: false } },
  { label: "cross+triple", regimeOpts: { trendHtfStRegimeBlockCross: true, trendHtfStRegimeBlockTriple: true, trendHtfStRegimeBlockWhipsaw: false } },
  { label: "full default", regimeOpts: {} },
  { label: "cross+minSep0.08", regimeOpts: { trendHtfStRegimeMinHtfSep: 0.0008 } },
  { label: "cross+minSep0.10", regimeOpts: { trendHtfStRegimeMinHtfSep: 0.001 } },
  { label: "cross+minAdx20", regimeOpts: { trendHtfStRegimeMinAdx: 20, trendHtfStRegimeBlockTriple: false } },
  { label: "cross+htfAge4", regimeOpts: { trendHtfStRegimeMinHtfTrendAgeHours: 4 } },
  { label: "cross+htfAge8", regimeOpts: { trendHtfStRegimeMinHtfTrendAgeHours: 8 } },
  { label: "cross+htfAge12", regimeOpts: { trendHtfStRegimeMinHtfTrendAgeHours: 12 } },
  { label: "cross+sepRising", regimeOpts: { trendHtfStRegimeRequireSepRising: true } },
  { label: "cross+noShrink", regimeOpts: { trendHtfStRegimeBlockSepShrinking: true } },
  { label: "prod v1", regimeOpts: { trendHtfStRegimeMinHtfTrendAgeHours: 6, trendHtfStRegimeBlockSepShrinking: true } },
  { label: "prod v2", regimeOpts: { trendHtfStRegimeMinHtfTrendAgeHours: 4, trendHtfStRegimeBlockCross: true, trendHtfStRegimeBlockTriple: true, trendHtfStRegimeMinHtfSep: 0.0007 } },
];

const results = [];
for (const v of variants) {
  const r = await runCfg(v.label, v.regimeOpts);
  const s = scoreResult(r.rows);
  results.push({ ...r, score: s });
  const fmt = r.rows.map((x) => `${x.w} n=${x.n} WR=${x.wr.toFixed(0)}% ret=${x.ret.toFixed(0)}%`).join(" | ");
  console.log(`${s.pass ? "✓" : " "} ${r.label.padEnd(22)} ${fmt}  [${s.composite.toFixed(0)}]`);
}

results.sort((a, b) => b.score.composite - a.score.composite);
console.log("\n── Top 5 by composite ──");
for (const r of results.slice(0, 5)) {
  console.log(`  ${r.label} composite=${r.score.composite.toFixed(0)} pass=${r.score.pass}`);
}

await closePool?.();
