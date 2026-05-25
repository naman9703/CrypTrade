#!/usr/bin/env node
/** Fast focused sweep on promising strategies (RSI_MEAN, TREND_PULLBACK, AUTO). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const days = Number(process.argv.find((a, i) => process.argv[i - 1] === "--days") || 30);
const symbol = "BTCUSDT";
const startingUsdt = 10_000;

const combos = [];
for (const tf of ["5m", "15m"]) {
  for (const sl of [0.006, 0.008, 0.01, 0.012]) {
    for (const tp of [0.008, 0.01, 0.012, 0.015, 0]) {
      for (const mq of [false, true]) {
        for (const ss of [false, true]) {
          for (const strat of ["RSI_MEAN", "TREND_PULLBACK", "CONFLUENCE", "AUTO"]) {
            combos.push({ tf, strat, sl, tp, mq, ss });
          }
        }
      }
    }
  }
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  const cache = new Map();

  for (const tf of ["5m", "15m"]) {
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    cache.set(tf, await readCandles(symbol, tf, fromMs, toMs));
    console.log(`${tf}: ${cache.get(tf).length} bars`);
  }

  const rows = [];
  let i = 0;
  for (const c of combos) {
    const candles = cache.get(c.tf);
    const cfg = {
      marketMode: "FUTURES",
      futuresLeverage: 5,
      supertrendPeriod: 10,
      supertrendMultiplier: 3,
      supertrendWilderAtr: true,
      supertrendFuturesAuto: false,
      supertrendFuturesFixedSlPct: c.sl,
      supertrendFuturesFixedTpPct: c.tp,
      trailingStopLossAuto: false,
      riskPerTrade: 1,
      riskPerTradeUnit: "PCT_EQUITY",
      slippagePct: 0.0001,
      tradeHistoryTakerOpenFeeRate: 0.0002,
      tradeHistoryTakerCloseFeeRate: 0.0004,
      supertrendMoveQualityGate: c.mq,
      supertrendMoveQualityMinScore: 0.55,
      supertrendMoveQualityMinAdx: 20,
      signalStrengthGatesTrades: c.ss,
      signalStrengthOpenMin: 70,
      strategyMode: c.strat === "AUTO" ? "AUTO" : "MANUAL",
      manualStrategy: c.strat === "AUTO" ? undefined : c.strat,
    };

    const adapters = await buildBacktestAdapters({
      strategyKey: c.strat,
      cfg,
      symbol,
      tf: c.tf,
      candles,
      fromMs,
    });

    const sim = await runSimulation({
      strategyKey: c.strat,
      candles,
      cfg,
      gateMode: "off",
      fundingRates: [],
      startingUsdt,
      timeframe: c.tf,
      adapters,
      symbol,
    });

    const m = computeAllMetrics({
      trades: sim.trades,
      equityCurve: sim.equityCurve,
      tf: c.tf,
      startingEquity: startingUsdt,
    });

    const n = m.totalTrades ?? 0;
    const ret = Number(m.totalReturnPct ?? 0);
    const wr = (m.winRate ?? 0) * 100;
    if (n >= 5) {
      rows.push({
        ...c,
        n,
        ret,
        wr,
        pf: m.profitFactor ?? 0,
        dd: m.maxDrawdownPct ?? 0,
        score: ret * 1.5 + wr * 0.3 + Math.min(m.profitFactor ?? 0, 3) * 5,
      });
    }
    i++;
    if (i % 20 === 0) process.stdout.write(`\r${i}/${combos.length}`);
  }
  console.log("\n");

  const positive = rows.filter((r) => r.ret > 0).sort((a, b) => b.score - a.score);
  const highWr = rows.filter((r) => r.wr >= 60 && r.ret > -2).sort((a, b) => b.ret - a.ret);

  console.log(`=== POSITIVE RETURN (${positive.length}) — top 15 ===`);
  for (const r of positive.slice(0, 15)) {
    console.log(
      `${r.strat.padEnd(16)} ${r.tf} n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(2)}% wr=${r.wr.toFixed(1)}% PF=${r.pf.toFixed(2)} SL=${(r.sl * 100).toFixed(1)}% TP=${r.tp ? (r.tp * 100).toFixed(1) + "%" : "—"} MQ=${r.mq}`
    );
  }

  console.log(`\n=== HIGH WR (≥60%, ret>-2%) — top 10 ===`);
  for (const r of highWr.slice(0, 10)) {
    console.log(
      `${r.strat.padEnd(16)} ${r.tf} n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(2)}% wr=${r.wr.toFixed(1)}% SL=${(r.sl * 100).toFixed(1)}% TP=${r.tp ? (r.tp * 100).toFixed(1) + "%" : "—"} MQ=${r.mq}`
    );
  }

  const best = positive[0] || rows.sort((a, b) => b.score - a.score)[0];
  if (best) {
    console.log("\n=== BEST CONFIG ===");
    console.log(JSON.stringify(best, null, 2));
  }

  await closePool().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
