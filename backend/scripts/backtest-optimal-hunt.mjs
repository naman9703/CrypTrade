#!/usr/bin/env node
/**
 * Hunt 80%+ WR + strong returns — TREND_HTF_ST + intel variants on BTC/BNB 15m.
 *   node scripts/backtest-optimal-hunt.mjs --symbol BTCUSDT
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const symbol = String(arg("symbol", "BTCUSDT")).toUpperCase();
const tf = "15m";
const targetWr = Number(arg("targetWr", "80"));
const minTrades = Number(arg("minTrades", "8"));

const WINDOWS = [
  ["full", "2025-06-01", "2026-05-20"],
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan", "2026-01-01", "2026-05-20"],
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

const candleCache = new Map();
const gateCache = new Map();

async function loadCandles(from, to) {
  const k = `${from}|${to}`;
  if (!candleCache.has(k)) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    candleCache.set(k, await readCandles(symbol, tf, fromMs, toMs));
  }
  return candleCache.get(k);
}

async function gateFnFor(from, to, candles, strict) {
  const k = `${from}|${strict}`;
  if (!gateCache.has(k)) {
    gateCache.set(
      k,
      await buildIntelligenceReplay({
        symbol,
        fromMs: new Date(from).getTime(),
        toMs: new Date(to).getTime(),
        candles,
        timeframe: tf,
        strictMode: strict,
      }),
    );
  }
  return gateCache.get(k);
}

async function runWindow(from, to, cfg, intel) {
  const fromMs = new Date(from).getTime();
  const candles = await loadCandles(from, to);
  if (!candles.length) return { wr: 0, ret: 0, n: 0 };
  const full = {
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    supertrendFuturesAuto: false,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...TREND_HTF_ST_BNB_MAX_PRESET,
    futuresLeverage: symbol === "BTCUSDT" ? 20 : 30,
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const gateMode = intel ? "approx" : "off";
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
    cfg: full,
    gateMode,
    gateFn: intel ? await gateFnFor(from, to, candles, full.intelligenceGateStrict === true) : null,
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  return { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0 };
}

const VARIANTS = [
  ["MAX (no gate)", { ...TREND_HTF_ST_BNB_MAX_PRESET, trendHtfStRegimeGate: false }, false],
  ["MAX + surgical", { trendHtfStSurgicalLossFilter: true, trendHtfStRegimeGate: false }, false],
  ["MAX + intel", { intelligenceGateEnabled: true, trendHtfStRegimeGate: false }, true],
  ["MAX + intel strict", { intelligenceGateEnabled: true, intelligenceGateStrict: true, trendHtfStRegimeGate: false }, true],
  ["cross block", { trendHtfStRegimeGate: true, trendHtfStRegimeBlockCross: true, trendHtfStRegimeBlockTriple: false }, false],
  ["cross + surgical", { trendHtfStRegimeGate: true, trendHtfStRegimeBlockCross: true, trendHtfStSurgicalLossFilter: true }, false],
  ["tp4 sl1.2 cross", { supertrendFuturesFixedSlPct: 0.012, supertrendFuturesFixedTpPct: 0.04, trendHtfStRegimeGate: true, trendHtfStRegimeBlockCross: true, trendHtfStMinHtfSep: 0.0006 }, false],
  ["tp5 sl1.5 cross", { supertrendFuturesFixedSlPct: 0.015, supertrendFuturesFixedTpPct: 0.05, trendHtfStRegimeGate: true, trendHtfStRegimeBlockCross: true, trendHtfStMinHtfSep: 0.0008 }, false],
  ["tp3 sl0.8 tight", { supertrendFuturesFixedSlPct: 0.008, supertrendFuturesFixedTpPct: 0.03, riskPerTrade: 7, futuresLeverage: 15 }, false],
  ["tp3 + whipsaw BE", { supertrendFuturesFixedSlPct: 0.012, supertrendFuturesFixedTpPct: 0.03, backtestBreakevenAtMfePct: 0.01 }, false],
  ["tp4 sep0.06", { supertrendFuturesFixedTpPct: 0.04, trendHtfStMinHtfSep: 0.0006, trendHtfStRegimeGate: true, trendHtfStRegimeBlockCross: true }, false],
  ["elite filter", { trendHtfStQualityFilter: true, trendHtfStMaxEntryRangeAtr: 1.5, supertrendFuturesFixedTpPct: 0.04 }, false],
];

console.log(`\n=== Optimal hunt ${symbol} ${tf} (target WR ${targetWr}%+) ===\n`);

const scored = [];
for (const [name, cfg, intel] of VARIANTS) {
  const parts = {};
  for (const [w, f, t] of WINDOWS) {
    parts[w] = await runWindow(f, t, cfg, intel);
  }
  const full = parts.full;
  const minWr = Math.min(parts.H2.wr, parts.Jan.wr, parts.full.wr);
  const hit80 = [parts.full, parts.H2, parts.Jan].some((p) => p.wr >= targetWr && p.n >= minTrades);
  const score =
    (hit80 ? 1000 : 0) +
    minWr * 2 +
    parts.full.ret * 0.5 +
    parts.Jan.ret * 0.3 +
    (parts.full.wr >= 50 ? 50 : 0);
  scored.push({ name, intel, parts, minWr, hit80, score });
  console.log(
    `${hit80 ? "★" : " "} ${name.padEnd(22)} full=${full.ret.toFixed(0)}%/${full.wr.toFixed(0)}%/${full.n}  H2=${parts.H2.ret.toFixed(0)}%/${parts.H2.wr.toFixed(0)}%  Jan=${parts.Jan.ret.toFixed(0)}%/${parts.Jan.wr.toFixed(0)}%`,
  );
}

scored.sort((a, b) => b.score - a.score);
console.log("\n── Top 5 ──");
for (const s of scored.slice(0, 5)) {
  console.log(`  ${s.hit80 ? "★80%+" : ""} ${s.name} minWR=${s.minWr.toFixed(0)}% full=${s.parts.full.wr.toFixed(0)}%/${s.parts.full.ret.toFixed(0)}%`);
}

const winners = scored.filter((s) => s.hit80);
if (winners.length) {
  console.log("\n── Configs hitting 80%+ WR on a window ──");
  for (const w of winners) {
    for (const [label, p] of Object.entries(w.parts)) {
      if (p.wr >= targetWr && p.n >= minTrades) {
        console.log(`  ${w.name} @ ${label}: WR ${p.wr.toFixed(1)}% ret ${p.ret.toFixed(0)}% n=${p.n}`);
      }
    }
  }
}

await closePool?.();
