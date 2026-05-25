#!/usr/bin/env node
/**
 * Brute-force compound entry rules on TREND_HTF_ST trades (feature vectors + grid).
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
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { evaluateTrendHtfStRegime } = await import("../src/strategy/trendHtfStRegime.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

async function simNoRegime(from, to) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, toMs);
  const cfg = {
    ...TREND_HTF_ST_BNB_MAX_PRESET,
    trendHtfStRegimeGate: false,
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
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
  return { candles, trades: sim.trades };
}

function enrich(candles, trades) {
  return trades.map((t) => {
    const entryIdx = candles.findIndex((c) => c.ts >= t.entryTs);
    const sigIdx = Math.max(0, entryIdx - 1);
    const r = evaluateTrendHtfStRegime(candles, sigIdx, t.direction, { trendHtfStRegimeGate: false });
    return {
      ...t,
      win: t.netPnl > 0,
      sigIdx,
      htfSepPct: (r?.htfSepPct ?? 0) * 100,
      htfSepSlope: (r?.htfSepSlope ?? 0) * 100,
      adx15m: r?.adx15m ?? 0,
      hoursSinceCross: r?.hoursSinceCross ?? 99,
      stFlips: r?.stFlipCount16 ?? 0,
      regime: r?.regime15m ?? "?",
      cross: r?.htfCrossRecent ?? false,
      sepShrink: (r?.htfSepSlope ?? 0) < -0.015,
      sideways: r?.regime15m === "SIDEWAYS",
    };
  });
}

function applyRule(trades, fn) {
  let kept = 0;
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let blockedWins = 0;
  let blockedLosses = 0;
  for (const t of trades) {
    if (fn(t)) {
      kept++;
      pnl += t.netPnl;
      if (t.win) wins++;
      else losses++;
    } else {
      if (t.win) blockedWins++;
      else blockedLosses++;
    }
  }
  const n = kept;
  return {
    n,
    wr: n ? (wins / n) * 100 : 0,
    ret: pnl,
    blockedWins,
    blockedLosses,
  };
}

const windows = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

const data = {};
for (const [name, from, to] of windows) {
  const { candles, trades } = await simNoRegime(from, to);
  data[name] = enrich(candles, trades);
  const w = trades.filter((t) => t.netPnl > 0).length;
  console.log(`${name}: ${trades.length} trades, ${w} wins, ret=${trades.reduce((s, t) => s + t.netPnl, 0).toFixed(1)}`);
}

const rules = [
  ["cross", (t) => !t.cross],
  ["cross+shrink", (t) => !(t.cross && t.sepShrink)],
  ["cross+side", (t) => !(t.cross && t.sideways)],
  ["cross+side+shrink", (t) => !(t.cross && t.sideways && t.sepShrink)],
  ["age>=6h", (t) => t.hoursSinceCross >= 6],
  ["age>=4h", (t) => t.hoursSinceCross >= 4],
  ["age>=6 OR sep>0.08", (t) => t.hoursSinceCross >= 6 || t.htfSepPct >= 0.08],
  ["age>=4 OR sep>0.10", (t) => t.hoursSinceCross >= 4 || t.htfSepPct >= 0.1],
  ["NOT(side+shrink+adx<22)", (t) => !(t.sideways && t.sepShrink && t.adx15m < 22)],
  ["NOT(cross+adx<25)", (t) => !(t.cross && t.adx15m < 25)],
  ["NOT(cross+shrink+adx<28)", (t) => !(t.cross && t.sepShrink && t.adx15m < 28)],
  ["sep>=0.06 OR age>=6", (t) => t.htfSepPct >= 0.06 || t.hoursSinceCross >= 6],
  ["sep>=0.08 OR age>=4", (t) => t.htfSepPct >= 0.08 || t.hoursSinceCross >= 4],
  ["adx>=22 OR age>=6", (t) => t.adx15m >= 22 || t.hoursSinceCross >= 6],
  ["adx>=25 OR sep>=0.10", (t) => t.adx15m >= 25 || t.htfSepPct >= 0.1],
  ["stFlips<=1 AND NOT(cross+side)", (t) => t.stFlips <= 1 && !(t.cross && t.sideways)],
  ["prod: !(cross&(side|shrink))", (t) => !(t.cross && (t.sideways || t.sepShrink))],
  ["prod: age>=5 OR (sep>=0.09&adx>=24)", (t) => t.hoursSinceCross >= 5 || (t.htfSepPct >= 0.09 && t.adx15m >= 24)],
  ["prod: !(cross&adx<26&sep<0.12)", (t) => !(t.cross && t.adx15m < 26 && t.htfSepPct < 0.12)],
];

console.log("\n── Rule replay (filter bad entries post-hoc) ──\n");
console.log("Rule".padEnd(32), "H2 ret", "H2 bl/w", "Jan ret", "Jan bl/w", "1yr ret");

let best = null;
for (const [name, fn] of rules) {
  const h2 = applyRule(data.H2, fn);
  const jan = applyRule(data.Jan, fn);
  const yr = applyRule(data["1yr"], fn);
  const pass = h2.ret >= 0 && jan.ret >= 350 && yr.ret >= 150;
  const line = `${name.padEnd(32)} ${String(h2.ret.toFixed(0)).padStart(6)} ${String(h2.blockedLosses + "/" + h2.blockedWins).padStart(7)} ${String(jan.ret.toFixed(0)).padStart(7)} ${String(jan.blockedLosses + "/" + jan.blockedWins).padStart(8)} ${String(yr.ret.toFixed(0)).padStart(6)} ${pass ? "✓" : ""}`;
  console.log(line);
  const score = h2.ret * 0.4 + jan.ret * 0.35 + yr.ret * 0.25;
  if (!best || score > best.score) best = { name, fn, score, h2, jan, yr, pass };
}

console.log("\nBest:", best?.name, "score=", best?.score?.toFixed(0), "pass=", best?.pass);

await closePool?.();
