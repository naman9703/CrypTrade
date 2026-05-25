#!/usr/bin/env node
/** Hunt configs for higher WR while keeping H2 non-negative */
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
const { buildTrendHtfStQualityOpts } = await import("../src/strategy/trendHtfSt.js");
const { evaluateTrendHtfStRegime } = await import("../src/strategy/trendHtfStRegime.js");

const cache = new Map();
async function candles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) cache.set(k, await readCandles("BNBUSDT", "15m", new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

async function run(from, to, strategyKey, cfg, extraFilter) {
  const fromMs = new Date(from).getTime();
  const c = await candles(from, to);
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: strategyKey,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: 7,
    riskPerTradeUnit: "PCT_EQUITY",
    supertrendPeriod: 10,
    supertrendMultiplier: 2.5,
    trendHtfStRegimeGate: true,
    ...cfg,
  };
  let adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles: c,
    fromMs,
  });
  if (extraFilter && adapters[strategyKey]) {
    const base = adapters[strategyKey];
    adapters = {
      ...adapters,
      [strategyKey]: async (bar, idx, ctx) => {
        const sig = await base(bar, idx, ctx);
        if (!sig) return null;
        const r = evaluateTrendHtfStRegime(c, idx, sig.action, full);
        if (!r?.allowEntry) return null;
        if (extraFilter === "TREND_OK" && r.structuralRisk !== "TREND_OK") return null;
        if (extraFilter === "NO_CHOP" && r.macroMode === "CHOP_SEASON") return null;
        if (extraFilter === "NO_SHRINK" && r.flags?.includes("HTF_SEP_SHRINKING")) return null;
        if (extraFilter === "NO_CROSS" && r.flags?.includes("HTF_EMA_CROSS_RECENT")) return null;
        if (extraFilter === "ELITE" && (r.structuralRisk !== "TREND_OK" || r.macroMode === "CHOP_SEASON")) return null;
        return sig;
      },
    };
  }
  const sim = await runSimulation({
    strategyKey,
    candles: c,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  return { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0 };
}

const windows = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

const configs = [
  ["baseline regime", {}],
  ["tp2 sl0.8", { supertrendFuturesFixedSlPct: 0.008, supertrendFuturesFixedTpPct: 0.02, trendHtfStRegimeTpTrend: 0.02, trendHtfStRegimeTpChop: 0.025 }],
  ["tp1.5 sl0.6", { supertrendFuturesFixedSlPct: 0.006, supertrendFuturesFixedTpPct: 0.015, trendHtfStRegimeTpTrend: 0.015, trendHtfStRegimeTpChop: 0.02 }],
  ["tp1.2 sl0.5", { supertrendFuturesFixedSlPct: 0.005, supertrendFuturesFixedTpPct: 0.012, trendHtfStRegimeTpTrend: 0.012, trendHtfStRegimeTpChop: 0.015 }],
  ["filter TREND_OK", {}, "TREND_OK"],
  ["filter NO_CHOP", {}, "NO_CHOP"],
  ["filter NO_SHRINK", {}, "NO_SHRINK"],
  ["filter NO_CROSS", {}, "NO_CROSS"],
  ["filter ELITE", {}, "ELITE"],
  ["tp1.5+NO_SHRINK", { supertrendFuturesFixedSlPct: 0.006, supertrendFuturesFixedTpPct: 0.015 }, "NO_SHRINK"],
  ["tp1.5+TREND_OK", { supertrendFuturesFixedSlPct: 0.006, supertrendFuturesFixedTpPct: 0.015 }, "TREND_OK"],
  ["tp1.2+NO_CROSS", { supertrendFuturesFixedSlPct: 0.005, supertrendFuturesFixedTpPct: 0.012 }, "NO_CROSS"],
];

console.log("── WR hunt TREND_HTF_ST @ 7% risk ──\n");
const scored = [];
for (const row of configs) {
  const [name, cfg, filt] = row;
  const parts = [];
  for (const [w, f, t] of windows) {
    const r = await run(f, t, "TREND_HTF_ST", { ...buildTrendHtfStQualityOpts(cfg), ...cfg }, filt);
    parts.push({ w, ...r });
  }
  const h2 = parts.find((p) => p.w === "H2");
  const jan = parts.find((p) => p.w === "Jan");
  const yr = parts.find((p) => p.w === "1yr");
  const minWr = Math.min(h2.wr, jan.wr, yr.wr);
  const ok = h2.ret >= 0 && yr.ret >= 100;
  scored.push({ name, minWr, ok, h2, jan, yr });
  console.log(
    `${name.padEnd(22)} H2=${h2.ret.toFixed(0)}%/${h2.wr.toFixed(0)}%/${h2.n} Jan=${jan.ret.toFixed(0)}%/${jan.wr.toFixed(0)}% 1yr=${yr.ret.toFixed(0)}%/${yr.wr.toFixed(0)}%`,
  );
}

scored.sort((a, b) => b.minWr - a.minWr);
console.log("\n── Top min WR (H2≥0 & 1yr≥100% marked *) ──");
for (const s of scored.slice(0, 8)) {
  console.log(`  ${s.ok ? "*" : " "} ${s.name} minWR=${s.minWr.toFixed(0)}%`);
}

await closePool?.();
