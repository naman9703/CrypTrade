#!/usr/bin/env node
/**
 * Production sweep: entries + exits + brackets for TREND_HTF_ST on H2 / Jan / 1yr.
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

const cache = new Map();
async function candles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) cache.set(k, await readCandles("BNBUSDT", "15m", new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

async function metrics(from, to, cfgExtra) {
  const fromMs = new Date(from).getTime();
  const c = await candles(from, to);
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
    ...cfgExtra,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg,
    symbol: "BNBUSDT",
    tf: "15m",
    candles: c,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles: c,
    cfg,
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

const combos = [];
const base = { trendHtfStRegimeGate: false };

for (const stMult of [2.5, 3, 3.5]) {
  for (const sl of [0.012, 0.015, 0.018]) {
    for (const tp of [0.03, 0.04, 0.05, 0]) {
      for (const minSep of [0.0005, 0.0008, 0.001]) {
        for (const regime of [false, "cross"]) {
          const cfg = {
            ...base,
            supertrendMultiplier: stMult,
            supertrendFuturesFixedSlPct: sl,
            supertrendFuturesFixedTpPct: tp,
            trendHtfStMinHtfSep: minSep,
          };
          if (regime === "cross") {
            cfg.trendHtfStRegimeGate = true;
            cfg.trendHtfStRegimeBlockCross = true;
            cfg.trendHtfStRegimeBlockTriple = false;
            cfg.trendHtfStRegimeBlockWhipsaw = false;
            cfg.trendHtfStRegimeMinHtfTrendAgeHours = 0;
          }
          combos.push({ label: `st${stMult} sl${(sl * 100).toFixed(1)} tp${tp ? (tp * 100).toFixed(0) : "off"} sep${minSep * 100}% ${regime || "noRg"}`, cfg });
        }
      }
    }
  }
}

// sep rising requirement via regime flags
combos.push({
  label: "base+sepRising+regime",
  cfg: {
    ...base,
    trendHtfStRegimeGate: true,
    trendHtfStRegimeBlockCross: true,
    trendHtfStRegimeBlockTriple: false,
    trendHtfStRegimeBlockWhipsaw: false,
    trendHtfStRegimeRequireSepRising: true,
    trendHtfStRegimeMinHtfTrendAgeHours: 0,
  },
});

console.log(`Sweeping ${combos.length} configs...\n`);

const ranked = [];
let i = 0;
for (const c of combos) {
  i++;
  if (i % 20 === 0) process.stderr.write(`  ${i}/${combos.length}\n`);
  const h2 = await metrics("2025-06-01", "2025-12-31", c.cfg);
  const jan = await metrics("2026-01-01", "2026-05-19", c.cfg);
  const yr = await metrics("2025-06-01", "2026-05-19", c.cfg);
  const pass = h2.ret >= 5 && jan.ret >= 380 && jan.wr >= 55 && yr.ret >= 200;
  const score = h2.ret * 0.45 + jan.ret * 0.35 + yr.ret * 0.2;
  ranked.push({ ...c, h2, jan, yr, pass, score });
}

ranked.sort((a, b) => b.score - a.score);
console.log("── Top 15 (by weighted score) ──\n");
for (const r of ranked.slice(0, 15)) {
  console.log(
    `${r.pass ? "✓" : " "} ${r.label.padEnd(42)} H2=${r.h2.ret.toFixed(0).padStart(4)}% Jan=${r.jan.ret.toFixed(0).padStart(4)}%/${r.jan.wr.toFixed(0)}% 1yr=${r.yr.ret.toFixed(0).padStart(4)}%`,
  );
}

const passed = ranked.filter((r) => r.pass);
console.log(`\n${passed.length} configs pass production targets (H2≥5%, Jan≥380%@55%WR, 1yr≥200%)`);
if (passed[0]) {
  console.log("\nBest pass:", passed[0].label);
  console.log(JSON.stringify(passed[0].cfg, null, 2));
}

await closePool?.();
