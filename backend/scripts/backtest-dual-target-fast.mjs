#!/usr/bin/env node
/** Fast dual-target hunt: WR>=80% AND return>=1000%. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MIN_WR = 80;
const MIN_RET = 1000;
const MIN_N = 5;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const { SUPERTREND_INTEL_80WR_PRESET } = await import("../src/strategy/presets/supertrendIntel80Wr.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

async function runOne({ symbol, tf, from, to, strat, cfg, gateFn }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) return null;
  const full = {
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: strat,
    supertrendFuturesAuto: strat === "SUPERTREND",
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({ strategyKey: strat, cfg: full, symbol, tf, candles, fromMs });
  const sim = await runSimulation({
    strategyKey: strat,
    candles,
    cfg: full,
    gateMode: gateFn ? "approx" : "off",
    gateFn,
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  return {
    wr: (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    n: m.totalTrades ?? 0,
    pf: m.profitFactor,
    dd: m.maxDrawdownPct,
    final: sim.finalEquity,
  };
}

const hits = [];
const near = [];

const combos = [];

// ST + Intel (validated family)
for (const symbol of ["BNBUSDT", "BTCUSDT"]) {
  for (const [from, to] of [
    ["2026-01-01", "2026-05-20"],
    ["2025-06-01", "2026-05-20"],
  ]) {
    for (const [tp, sl] of [
      [0.007, 0.015],
      [0.007, 0.02],
      [0.01, 0.02],
      [0.01, 0.03],
      [0.015, 0.03],
      [0.02, 0.04],
    ]) {
      for (const [risk, lev] of [
        [5, 10],
        [10, 20],
        [15, 30],
        [20, 40],
        [25, 50],
      ]) {
        combos.push({
          symbol,
          tf: "15m",
          from,
          to,
          strat: "SUPERTREND",
          cfg: {
            ...SUPERTREND_INTEL_80WR_PRESET,
            supertrendFuturesFixedTpPct: tp,
            supertrendFuturesFixedSlPct: sl,
            riskPerTrade: risk,
            futuresLeverage: lev,
          },
          intel: true,
        });
      }
    }
  }
}

// TREND_HTF_ST + intel, bracket exits
for (const symbol of ["BNBUSDT", "BTCUSDT"]) {
  for (const [from, to] of [["2026-01-01", "2026-05-20"]]) {
    for (const [tp, sl] of [
      [0.01, 0.02],
      [0.015, 0.025],
      [0.02, 0.03],
      [0.03, 0.05],
    ]) {
      for (const [risk, lev] of [
        [8, 20],
        [10, 30],
        [15, 40],
        [20, 50],
      ]) {
        combos.push({
          symbol,
          tf: "15m",
          from,
          to,
          strat: "TREND_HTF_ST",
          cfg: {
            ...TREND_HTF_ST_BNB_MAX_PRESET,
            intelligenceGateEnabled: true,
            intelligenceGateStrict: false,
            supertrendFuturesFixedTpPct: tp,
            supertrendFuturesFixedSlPct: sl,
            supertrendFuturesExitOnFlip: false,
            trailingStopLossAuto: false,
            riskPerTrade: risk,
            futuresLeverage: lev,
            trendHtfStRegimeGate: false,
          },
          intel: true,
        });
      }
    }
  }
}

// HTF_RSI tight brackets, no intel
for (const symbol of ["BNBUSDT"]) {
  for (const [tp, sl] of [
    [0.008, 0.02],
    [0.01, 0.025],
    [0.015, 0.03],
  ]) {
    for (const [risk, lev] of [
      [10, 25],
      [15, 35],
      [20, 50],
    ]) {
      combos.push({
        symbol,
        tf: "15m",
        from: "2025-06-01",
        to: "2026-05-20",
        strat: "HTF_RSI",
        cfg: {
          supertrendFuturesFixedTpPct: tp,
          supertrendFuturesFixedSlPct: sl,
          trailingStopLossAuto: false,
          supertrendFuturesExitOnFlip: false,
          riskPerTrade: risk,
          futuresLeverage: lev,
        },
        intel: false,
      });
    }
  }
}

const gateCache = new Map();
async function gateFor(symbol, tf, from, to) {
  const k = `${symbol}|${from}|${to}`;
  if (!gateCache.has(k)) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    const candles = await readCandles(symbol, tf, fromMs, toMs);
    gateCache.set(
      k,
      await buildIntelligenceReplay({ symbol, fromMs, toMs, candles, timeframe: tf, strictMode: false }),
    );
  }
  return gateCache.get(k);
}

console.log(`Testing ${combos.length} combos for WR≥${MIN_WR}% & ret≥${MIN_RET}%...\n`);

let i = 0;
for (const c of combos) {
  i++;
  try {
    const gateFn = c.intel ? await gateFor(c.symbol, c.tf, c.from, c.to) : null;
    const r = await runOne({ ...c, gateFn });
    if (!r || r.n < MIN_N) continue;
    const row = { ...c, ...r };
    if (r.wr >= MIN_WR && r.ret >= MIN_RET) {
      hits.push(row);
      console.log(
        `★ ${c.symbol} ${c.from} ${c.strat} WR${r.wr.toFixed(1)}% ret${r.ret.toFixed(0)}% n=${r.n} TP${(c.cfg.supertrendFuturesFixedTpPct * 100).toFixed(1)}% risk${c.cfg.riskPerTrade}% ${c.cfg.futuresLeverage}x`,
      );
    } else if (r.wr >= 75 && r.ret >= 100) near.push(row);
  } catch {
    /* skip */
  }
  if (i % 25 === 0) process.stdout.write(`\r  ${i}/${combos.length}`);
}

near.sort((a, b) => b.ret - a.ret);
hits.sort((a, b) => b.ret - a.ret);

console.log(`\n\n=== Hits: ${hits.length} ===`);
for (const h of hits.slice(0, 10)) {
  console.log(JSON.stringify({ symbol: h.symbol, strat: h.strat, wr: h.wr, ret: h.ret, n: h.n, cfg: h.cfg }));
}

console.log(`\n=== Best near-miss (WR≥75%, ret≥100%) top 10 ===`);
for (const h of near.slice(0, 10)) {
  console.log(
    `${h.symbol} ${h.strat} WR${h.wr.toFixed(1)}% ret${h.ret.toFixed(1)}% n=${h.n} TP${(h.cfg.supertrendFuturesFixedTpPct * 100).toFixed(1)}% risk${h.cfg.riskPerTrade}% ${h.cfg.futuresLeverage}x`,
  );
}

await closePool?.();
