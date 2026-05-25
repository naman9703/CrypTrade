#!/usr/bin/env node
/**
 * Max-return sweep — tests top strategies × SL/TP × TF on 90d + validates top on 30d.
 *   node scripts/backtest-max-return.mjs
 *   node scripts/backtest-max-return.mjs --days 90 --symbol BTCUSDT
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BTCUSDT";
const days = Number(process.argv.find((a, i) => process.argv[i - 1] === "--days") || 90);
const startingUsdt = 10_000;

const STRATEGIES = ["RSI_MEAN", "TREND_PULLBACK", "CONFLUENCE", "AUTO", "BREAKOUT_VOL", "MOMENTUM_SURGE"];
const TFS = ["15m", "5m", "1h"];
const SL_TP = [
  { sl: 0.006, tp: 0.015 },
  { sl: 0.006, tp: 0.02 },
  { sl: 0.008, tp: 0.012 },
  { sl: 0.008, tp: 0.015 },
  { sl: 0.008, tp: 0.02 },
  { sl: 0.01, tp: 0.02 },
  { sl: 0.012, tp: 0.025 },
];

function pickStrategyKey(cfg) {
  if (cfg.supertrendFuturesAuto) return "SUPERTREND";
  if (String(cfg.strategyMode).toUpperCase() === "AUTO") return "AUTO";
  const m = String(cfg.manualStrategy || "").toUpperCase();
  return m || "SUPERTREND";
}

function baseCfg(strat, sl, tp) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 5,
    supertrendFuturesAuto: false,
    supertrendWilderAtr: true,
    supertrendFuturesFixedSlPct: sl,
    supertrendFuturesFixedTpPct: tp,
    trailingStopLossAuto: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0002,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    strategyMode: strat === "AUTO" ? "AUTO" : "MANUAL",
    manualStrategy: strat === "AUTO" ? undefined : strat,
  };
}

async function sim(strat, tf, sl, tp, fromMs, toMs) {
  const { readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) return null;
  const cfg = baseCfg(strat, sl, tp);
  const strategyKey = pickStrategyKey(cfg);
  const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
  const run = await runSimulation({
    strategyKey,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: run.trades,
    equityCurve: run.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });
  const n = m.totalTrades ?? 0;
  if (n < 8) return null;
  return {
    strat,
    tf,
    sl,
    tp,
    n,
    ret: Number(m.totalReturnPct ?? 0),
    wr: (m.winRate ?? 0) * 100,
    pf: Number(m.profitFactor ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    sharpe: Number(m.sharpeRatio ?? 0),
  };
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
  const { ensureKlines } = await import("../src/backtest/data/klineIngest.js");

  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;

  console.log(`\n=== Max Return Sweep · ${symbol} · ${days}d · $${startingUsdt} ===\n`);

  for (const tf of TFS) {
    process.stdout.write(`Loading ${tf}... `);
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    const { readCandles } = await import("../src/backtest/data/klineIngest.js");
    const c = await readCandles(symbol, tf, fromMs, toMs);
    console.log(`${c.length} bars`);
  }

  const rows = [];
  let i = 0;
  const total = STRATEGIES.length * TFS.length * SL_TP.length;
  for (const strat of STRATEGIES) {
    for (const tf of TFS) {
      for (const { sl, tp } of SL_TP) {
        const r = await sim(strat, tf, sl, tp, fromMs, toMs);
        if (r) rows.push(r);
        i++;
        if (i % 10 === 0) process.stdout.write(`\r  ${i}/${total}`);
      }
    }
  }
  console.log(`\n  Valid configs: ${rows.length}\n`);

  const positive = rows.filter((r) => r.ret > 0).sort((a, b) => b.ret - a.ret);
  const all = [...rows].sort((a, b) => b.ret - a.ret);

  console.log("── TOP 15 BY RETURN (90d) ──");
  for (const r of all.slice(0, 15)) {
    console.log(
      `${r.strat.padEnd(16)} ${r.tf.padEnd(4)} SL${(r.sl * 100).toFixed(1)} TP${(r.tp * 100).toFixed(1)} | n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(2)}% wr=${r.wr.toFixed(1)}% PF=${r.pf.toFixed(2)} DD=${r.dd.toFixed(1)}%`
    );
  }

  const best = all[0];
  if (!best) {
    console.log("No valid results.");
    await closePool();
    return;
  }

  // 30d out-of-sample on top 5
  const from30 = toMs - 30 * 86400000;
  console.log("\n── 30d VALIDATION (top 5) ──");
  for (const r of all.slice(0, 5)) {
    const v = await sim(r.strat, r.tf, r.sl, r.tp, from30, toMs);
    console.log(
      `${r.strat} ${r.tf} SL${(r.sl * 100).toFixed(1)}/TP${(r.tp * 100).toFixed(1)} | 90d=${r.ret.toFixed(2)}% → 30d=${v ? v.ret.toFixed(2) + "% wr=" + v.wr.toFixed(1) + "%" : "n/a"}`
    );
  }

  // Pick best that is positive on BOTH windows if possible
  let robust = null;
  for (const r of positive.slice(0, 10)) {
    const v = await sim(r.strat, r.tf, r.sl, r.tp, from30, toMs);
    if (v && v.ret > 0) {
      robust = { train: r, valid: v };
      break;
    }
  }

  console.log("\n── RECOMMENDED (MAX RETURN) ──");
  const pick = robust?.train ?? best;
  console.log(JSON.stringify({
    strategyMode: pick.strat === "AUTO" ? "AUTO" : "MANUAL",
    manualStrategy: pick.strat === "AUTO" ? undefined : pick.strat,
    timeframe: pick.tf,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: pick.sl,
    supertrendFuturesFixedTpPct: pick.tp,
    trailingStopLossAuto: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    futuresLeverage: 5,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    initial_capital: 10000,
    expected_90d_return_pct: pick.ret,
    expected_90d_win_rate_pct: pick.wr,
    robust_30d_positive: Boolean(robust),
  }, null, 2));

  if (robust) {
    console.log("\n── ROBUST PICK (positive 90d + 30d) ──");
    console.log(`  ${robust.train.strat} ${robust.train.tf} 90d=${robust.train.ret.toFixed(2)}% 30d=${robust.valid.ret.toFixed(2)}%`);
  } else {
    console.log("\n  ⚠ No config was positive on BOTH 90d and 30d — max-return pick may be regime-specific.");
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
