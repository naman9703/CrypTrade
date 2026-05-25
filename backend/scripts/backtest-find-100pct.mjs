#!/usr/bin/env node
/** Targeted realistic sweep — small grid, multiple symbols. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbols = (process.argv.find((a) => a.startsWith("--symbols="))?.split("=")[1] || "BNBUSDT,BTCUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase());
const tf = process.argv.find((a, i) => process.argv[i - 1] === "--tf") || "15m";
const fromMs = new Date(process.argv.find((a, i) => process.argv[i - 1] === "--from") || "2026-01-01").getTime();
const toMs = Date.now();
const cap = Number(process.argv.find((a, i) => process.argv[i - 1] === "--capital") || "10000");
const minRet = Number(process.argv.find((a, i) => process.argv[i - 1] === "--minRet") || "100");

const COST = { slippagePct: 0.0005, takerOpenFeeRate: 0.0004, takerCloseFeeRate: 0.0004 };

const CONFIGS = [
  { strat: "TREND_PULLBACK", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: false },
  { strat: "TREND_PULLBACK", lev: 20, risk: 2, sl: 0.012, tp: 0.024, trail: false, mq: false },
  { strat: "TREND_PULLBACK", lev: 15, risk: 1.5, sl: 0.01, tp: 0, trail: true, mq: false },
  { strat: "HTF_RSI", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: false },
  { strat: "HTF_RSI", lev: 20, risk: 2, sl: 0.012, tp: 0.024, trail: false, mq: false },
  { strat: "HTF_RSI", lev: 15, risk: 1, sl: 0.01, tp: 0, trail: true, mq: false },
  { strat: "RSI_MEAN", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: false },
  { strat: "RSI_MEAN", lev: 20, risk: 2, sl: 0.012, tp: 0.024, trail: false, mq: false },
  { strat: "CONFLUENCE", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: false },
  { strat: "CONFLUENCE", lev: 20, risk: 2, sl: 0.012, tp: 0, trail: true, mq: false },
  { strat: "SUPERTREND", lev: 15, risk: 1.5, sl: 0.01, tp: 0, trail: true, mq: true },
  { strat: "SUPERTREND", lev: 20, risk: 2, sl: 0.012, tp: 0, trail: true, mq: false },
  { strat: "SMART_REVERSAL", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: false },
  { strat: "AUTO", lev: 15, risk: 1.5, sl: 0.01, tp: 0.02, trail: false, mq: true },
  { strat: "AUTO", lev: 20, risk: 2, sl: 0.012, tp: 0, trail: true, mq: true },
];

function bot(c) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: c.lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: c.risk,
    riskPerTradeUnit: "PCT_EQUITY",
    strategyMode: c.strat === "AUTO" ? "AUTO" : "MANUAL",
    manualStrategy: c.strat === "AUTO" ? undefined : c.strat,
    supertrendWilderAtr: true,
    supertrendFuturesAuto: false,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendFuturesFixedSlPct: c.sl,
    supertrendFuturesFixedTpPct: c.tp,
    trailingStopLossAuto: c.trail,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    supertrendMoveQualityGate: c.mq,
    supertrendMoveQualityMinScore: 0.55,
    supertrendMoveQualityMinAdx: 22,
    signalStrengthGatesTrades: false,
    marketDecision: { enabled: false },
    ...COST,
  };
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
  const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");

  const all = [];
  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ${tf} ===`);
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    const candles = await readCandles(symbol, tf, fromMs, toMs);
    const funding = await readFundingRates(symbol, fromMs, candles.at(-1).ts).catch(() => []);
    console.log(`${candles.length} bars, ${CONFIGS.length} configs`);
    const adapters = {};

    for (const c of CONFIGS) {
      const cfg = bot(c);
      const key = c.strat === "AUTO" ? "AUTO" : c.strat;
      if (!adapters[key]) adapters[key] = await buildBacktestAdapters({ strategyKey: key, cfg, symbol, tf, candles, fromMs });
      const sim = await runSimulation({
        strategyKey: key,
        candles,
        cfg,
        costModelOverride: COST,
        gateMode: "off",
        fundingRates: funding,
        startingUsdt: cap,
        timeframe: tf,
        adapters: adapters[key],
        symbol,
      });
      const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: cap });
      const ret = Number(m.totalReturnPct ?? 0);
      const wr = (m.winRate ?? 0) * 100;
      all.push({ symbol, ret, wr, pf: m.profitFactor, dd: m.maxDrawdownPct, n: m.totalTrades, ...c, cfg });
      const mark = ret >= minRet ? "★" : " ";
      console.log(`${mark} ${ret.toFixed(1)}% WR ${wr.toFixed(1)}% PF ${Number(m.profitFactor).toFixed(2)} n=${m.totalTrades} | ${c.strat} lev${c.lev} risk${c.risk}%`);
    }
  }

  all.sort((a, b) => b.ret - a.ret);
  console.log(`\n=== Best overall (target ${minRet}%+) ===`);
  for (const r of all.slice(0, 8)) {
    console.log(
      `${r.symbol} ${r.ret.toFixed(1)}% WR ${r.wr.toFixed(1)}% PF ${Number(r.pf).toFixed(2)} DD ${Number(r.dd).toFixed(1)}% | ${r.strat} lev${r.lev} risk${r.risk} sl${r.sl} ${r.trail ? "trail" : "tp" + r.tp}`,
    );
  }
  const best = all[0];
  if (best && best.ret >= minRet) {
    console.log("\nWinning bot config:");
    console.log(JSON.stringify(bot(best), null, 2));
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
