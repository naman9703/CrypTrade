#!/usr/bin/env node
/**
 * Multi-coin TREND_PULLBACK scalp search — tune entries/exits for frequency + net edge.
 *
 *   cd backend && node scripts/backtest-trend-pullback-scalp-search.mjs
 *   TF=5m FROM=2026-01-01 TO=2026-05-01 SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT node scripts/...
 *   QUICK=1  — smaller grid (~24 configs)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,LINKUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TF = process.env.TF || "5m,1m";
const TFS = TF.split(",").map((s) => s.trim()).filter(Boolean);
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-05-01";
const OOS_FROM = process.env.OOS_FROM || "2026-05-01";
const OOS_TO = process.env.OOS_TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 1.5);
const LEVERAGE = Number(process.env.LEVERAGE || 10);
const QUICK = process.env.QUICK === "1";
const TOP_N = Number(process.env.TOP_N || 8);

const COST = {
  slippagePct: 0.0005,
  openFeeRate: 0.0004,
  closeFeeRate: 0.0004,
};

function baseCfg(sym, tf, patch = {}) {
  return {
    symbol: sym,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_PULLBACK",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    trailingStopLossAuto: false,
    supertrendFuturesFixedSlPct: 0.006,
    supertrendFuturesFixedTpPct: 0.012,
    ...patch,
  };
}

function labelCfg(c) {
  return [
    c.tf,
    `sl${(c.sl * 100).toFixed(1)}`,
    `qp${(c.quickProfit * 100).toFixed(2)}`,
    c.longOnly ? "L" : "LS",
    `rsi${c.rsiOversold}`,
    `cd${c.cooldown}`,
    `mh${c.maxHoldMin}`,
  ].join(" ");
}

async function runOne({ sym, tf, fromMs, toMs, patch }) {
  const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

  await ensureKlines(sym, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(sym, tf, fromMs, toMs);
  if (!candles?.length) return null;

  const cfg = baseCfg(sym, tf, patch);
  const adapters = await buildBacktestAdapters({ strategyKey: "TREND_PULLBACK", cfg, symbol: sym, tf, candles, fromMs });
  const sim = await runSimulation({
    strategyKey: "TREND_PULLBACK",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START_USDT,
    timeframe: tf,
    symbol: sym,
    adapters,
    costModelOverride: { ...COST, leverage: LEVERAGE, isFutures: true },
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: START_USDT });
  return {
    sym,
    trades: sim.trades.length,
    retPct: Number(m.totalReturnPct ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    pf: Number(m.profitFactor ?? 0),
    maxDd: Number(m.maxDrawdownPct ?? 0),
    sharpe: Number(m.sharpe ?? m.sharpeRatio ?? 0),
    expectancy: Number(m.expectancy ?? 0),
    avgHoldMin:
      sim.trades.length > 0
        ? sim.trades.reduce((s, t) => s + (t.exitTs - t.entryTs), 0) / sim.trades.length / 60000
        : 0,
  };
}

async function evalConfig(gridItem, fromMs, toMs) {
  const patch = {
    supertrendFuturesFixedSlPct: gridItem.sl,
    supertrendFuturesFixedTpPct: gridItem.tp,
    trendPullbackQuickProfitPct: gridItem.quickProfit,
    trendPullbackMinProfitPct: gridItem.minProfit,
    trendPullbackLongOnly: gridItem.longOnly,
    trendPullbackRsiOversold: gridItem.rsiOversold,
    trendPullbackRsiRecoverMin: gridItem.rsiRecover,
    trendPullbackCooldownBars: gridItem.cooldown,
    trendPullbackMaxHoldMin: gridItem.maxHoldMin,
    trendPullbackRsiExitLong: gridItem.rsiExitLong,
  };
  const perCoin = [];
  for (const sym of SYMBOLS) {
    const r = await runOne({ sym, tf: gridItem.tf, fromMs, toMs, patch });
    if (r) perCoin.push(r);
  }
  if (!perCoin.length) return null;
  const totalTrades = perCoin.reduce((s, r) => s + r.trades, 0);
  const avgRet = perCoin.reduce((s, r) => s + r.retPct, 0) / perCoin.length;
  const worstDd = Math.max(...perCoin.map((r) => r.maxDd));
  const avgPf = perCoin.reduce((s, r) => s + (Number.isFinite(r.pf) ? r.pf : 0), 0) / perCoin.length;
  const avgWr = perCoin.reduce((s, r) => s + r.wr, 0) / perCoin.length;
  const tradesPerCoinMo = totalTrades / perCoin.length / Math.max(1, (toMs - fromMs) / (30 * 86400000));
  const score = avgRet - worstDd * 0.35 + Math.min(avgPf, 3) * 2 + Math.log10(Math.max(1, totalTrades)) * 3;
  return { ...gridItem, totalTrades, avgRet, worstDd, avgPf, avgWr, tradesPerCoinMo, score, perCoin };
}

function buildGrid() {
  const grid = [];
  const tfs = QUICK && TFS.length === 1 ? TFS : QUICK ? ["5m"] : TFS;
  const sls = QUICK ? [0.005, 0.007] : [0.004, 0.006, 0.008];
  const quicks = QUICK ? [0.002, 0.003] : [0.0015, 0.0025, 0.0035];
  const longOnlyOpts = QUICK ? [true] : [true, false];
  const rsiOversoldOpts = QUICK ? [24] : [22, 25, 28];
  const cooldowns = QUICK ? [6] : [4, 8, 12];
  const maxHolds = QUICK ? [120] : [90, 150];

  for (const tf of tfs) {
    for (const sl of sls) {
      for (const quickProfit of quicks) {
        for (const longOnly of longOnlyOpts) {
          for (const rsiOversold of rsiOversoldOpts) {
            for (const cooldown of cooldowns) {
              for (const maxHoldMin of maxHolds) {
                const item = {
                  tf,
                  sl,
                  tp: Math.max(sl * 1.5, quickProfit * 2.5),
                  quickProfit,
                  minProfit: Math.min(0.001, quickProfit * 0.5),
                  longOnly,
                  rsiOversold,
                  rsiRecover: tf === "1m" ? 38 : 36,
                  cooldown,
                  maxHoldMin,
                  rsiExitLong: 40,
                };
                item.label = labelCfg(item);
                grid.push(item);
              }
            }
          }
        }
      }
    }
  }
  return grid;
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

  const fromMs = Date.parse(FROM);
  const toMs = Date.parse(TO);
  const oosFromMs = Date.parse(OOS_FROM);
  const oosToMs = Date.parse(OOS_TO);
  const grid = buildGrid();

  console.log(`\n=== TREND_PULLBACK scalp search ===`);
  console.log(`Coins: ${SYMBOLS.join(", ")}`);
  console.log(`IS: ${FROM} → ${TO} · OOS: ${OOS_FROM} → ${OOS_TO}`);
  console.log(`Risk ${RISK_PCT}% · ${LEVERAGE}x · ${grid.length} configs${QUICK ? " (QUICK)" : ""}\n`);

  const results = [];
  let i = 0;
  for (const g of grid) {
    i++;
    process.stdout.write(`\r[${i}/${grid.length}] ${g.label}…`);
    const r = await evalConfig(g, fromMs, toMs);
    if (r) results.push(r);
  }
  console.log("\n");

  results.sort((a, b) => b.score - a.score);
  console.log("── Top IS configs ──");
  console.log(
    `${"label".padEnd(42)} ${"trades".padStart(6)} ${"t/mo".padStart(5)} ${"ret%".padStart(7)} ${"DD%".padStart(6)} ${"PF".padStart(5)} ${"WR%".padStart(5)} score`,
  );
  for (const r of results.slice(0, TOP_N)) {
    console.log(
      `${r.label.padEnd(42)} ${String(r.totalTrades).padStart(6)} ${r.tradesPerCoinMo.toFixed(1).padStart(5)} ${r.avgRet.toFixed(2).padStart(7)} ${r.worstDd.toFixed(1).padStart(6)} ${r.avgPf.toFixed(2).padStart(5)} ${r.avgWr.toFixed(0).padStart(5)} ${r.score.toFixed(1)}`,
    );
  }

  if (results.length) {
    const best = results[0];
    console.log(`\n── OOS validation: ${best.label} ──`);
    const oos = await evalConfig(best, oosFromMs, oosToMs);
    if (oos) {
      console.log(
        `OOS: trades=${oos.totalTrades} avgRet=${oos.avgRet.toFixed(2)}% worstDD=${oos.worstDd.toFixed(1)}% PF=${oos.avgPf.toFixed(2)} WR=${oos.avgWr.toFixed(0)}%`,
      );
      console.log("Per coin OOS:");
      for (const c of oos.perCoin) {
        console.log(
          `  ${c.sym.padEnd(10)} n=${String(c.trades).padStart(4)} ret=${c.retPct.toFixed(2).padStart(7)}% WR=${c.wr.toFixed(0).padStart(3)}% PF=${c.pf.toFixed(2)} hold=${c.avgHoldMin.toFixed(0)}m`,
        );
      }
    }

    console.log(`\n── Recommended cfg patch ──`);
    console.log(
      JSON.stringify(
        {
          manualStrategy: "TREND_PULLBACK",
          timeframe: best.tf,
          supertrendFuturesFixedSlPct: best.sl,
          supertrendFuturesFixedTpPct: best.tp,
          trendPullbackQuickProfitPct: best.quickProfit,
          trendPullbackMinProfitPct: best.minProfit,
          trendPullbackLongOnly: best.longOnly,
          trendPullbackRsiOversold: best.rsiOversold,
          trendPullbackRsiRecoverMin: best.rsiRecover,
          trendPullbackCooldownBars: best.cooldown,
          trendPullbackMaxHoldMin: best.maxHoldMin,
          trendPullbackRsiExitLong: best.rsiExitLong,
          backtestPositionSizing: "RISK_AT_SL",
          riskPerTrade: RISK_PCT,
          futuresLeverage: LEVERAGE,
          trailingStopLossAuto: false,
        },
        null,
        2,
      ),
    );
  }

  await closePool().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
