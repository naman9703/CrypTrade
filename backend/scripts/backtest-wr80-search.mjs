#!/usr/bin/env node
/** Dense search for 80%+ WR configs (BNB/BTC, multiple strategies). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildTrendHtfStQualityOpts } = await import("../src/strategy/trendHtfSt.js");
const { evaluateTrendHtfStRegime } = await import("../src/strategy/trendHtfStRegime.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

const TARGET = 80;
const MIN_N = 6;

async function sim(symbol, tf, from, to, strategyKey, cfg, extraFilter) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  const full = {
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: strategyKey,
    supertrendFuturesAuto: false,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...cfg,
  };
  let adapters = await buildBacktestAdapters({ strategyKey, cfg: full, symbol, tf, candles, fromMs });
  if (extraFilter && strategyKey === "TREND_HTF_ST" && adapters[strategyKey]) {
    const base = adapters[strategyKey];
    adapters = {
      ...adapters,
      [strategyKey]: async (bar, idx, ctx) => {
        const sig = await base(bar, idx, ctx);
        if (!sig) return null;
        const r = evaluateTrendHtfStRegime(candles, idx, sig.action, full);
        if (!r?.allowEntry) return null;
        if (extraFilter === "TREND_OK" && r.structuralRisk !== "TREND_OK") return null;
        if (extraFilter === "NO_CHOP" && r.macroMode === "CHOP_SEASON") return null;
        if (extraFilter === "NO_CROSS" && r.flags?.includes("HTF_EMA_CROSS_RECENT")) return null;
        if (extraFilter === "NO_SHRINK" && r.flags?.includes("HTF_SEP_SHRINKING")) return null;
        if (extraFilter === "ELITE" && (r.structuralRisk !== "TREND_OK" || r.macroMode === "CHOP_SEASON")) return null;
        return sig;
      },
    };
  }
  const run = await runSimulation({
    strategyKey,
    candles,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: run.trades, equityCurve: run.equityCurve, tf, startingEquity: 100 });
  return { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0 };
}

const hits = [];
const grids = [];

for (const symbol of ["BNBUSDT", "BTCUSDT"]) {
  for (const tf of ["15m", "1h"]) {
    for (const [from, to, label] of [
      ["2026-01-01", "2026-05-20", "Jan26"],
      ["2025-06-01", "2025-12-31", "H2"],
      ["2025-06-01", "2026-05-20", "1yr"],
    ]) {
      for (const strat of ["TREND_HTF_ST", "HTF_RSI", "TREND_PULLBACK", "APEX_TREND"]) {
        for (const risk of [5, 7, 10]) {
          for (const lev of [15, 20, 30]) {
            for (const tp of [0.025, 0.03, 0.04, 0.05]) {
              for (const sl of [0.008, 0.01, 0.012]) {
                const cfg =
                  strat === "TREND_HTF_ST"
                    ? {
                        ...TREND_HTF_ST_BNB_MAX_PRESET,
                        ...buildTrendHtfStQualityOpts({}),
                        riskPerTrade: risk,
                        futuresLeverage: lev,
                        supertrendFuturesFixedSlPct: sl,
                        supertrendFuturesFixedTpPct: tp,
                        trendHtfStRegimeGate: false,
                      }
                    : {
                        riskPerTrade: risk,
                        futuresLeverage: lev,
                        supertrendFuturesFixedSlPct: sl,
                        supertrendFuturesFixedTpPct: tp,
                        trailingStopLossAuto: false,
                      };
                grids.push({ symbol, tf, from, to, label, strat, cfg, filt: null });
              }
            }
          }
        }
      }
      for (const filt of ["TREND_OK", "NO_CHOP", "NO_CROSS", "ELITE"]) {
        grids.push({
          symbol,
          tf,
          from,
          to,
          label,
          strat: "TREND_HTF_ST",
          cfg: {
            ...TREND_HTF_ST_BNB_MAX_PRESET,
            riskPerTrade: 10,
            futuresLeverage: 30,
            supertrendFuturesFixedTpPct: 0.04,
            trendHtfStRegimeGate: true,
            trendHtfStRegimeBlockCross: true,
          },
          filt,
        });
      }
    }
  }
}

console.log(`Testing ${grids.length} combos for WR>=${TARGET}%...\n`);
let i = 0;
for (const g of grids) {
  i++;
  if (i % 50 === 0) process.stdout.write(`\r  ${i}/${grids.length}`);
  try {
    const r = await sim(g.symbol, g.tf, g.from, g.to, g.strat, g.cfg, g.filt);
    if (r.n >= MIN_N && r.wr >= TARGET) {
      hits.push({ ...g, ...r });
      console.log(
        `\n★ ${g.symbol} ${g.tf} ${g.label} ${g.strat}${g.filt ? "+" + g.filt : ""} WR=${r.wr.toFixed(1)}% ret=${r.ret.toFixed(0)}% n=${r.n} risk=${g.cfg.riskPerTrade} lev=${g.cfg.futuresLeverage} tp=${g.cfg.supertrendFuturesFixedTpPct}`,
      );
    }
  } catch {
    /* skip */
  }
}
console.log(`\n\nTotal hits: ${hits.length}`);
hits.sort((a, b) => b.ret - a.ret);
for (const h of hits.slice(0, 25)) {
  console.log(
    `${h.symbol} ${h.tf} ${h.label} ${h.strat} WR=${h.wr.toFixed(1)}% ret=${h.ret.toFixed(0)}% n=${h.n}`,
  );
}
await closePool?.();
