#!/usr/bin/env node
/**
 * Multi-symbol INTRADAY_PRO research — 5m/15m, adaptive SL/TP, 5mo + 1yr windows.
 * Usage: npm run backtest:intraday-pro -- [SYMBOL] [TF]
 *        npm run backtest:intraday-pro -- --all
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const allMode = process.argv.includes("--all");
const symbol = allMode ? null : process.argv[2] || "BNBUSDT";
const tf = allMode ? "5m" : process.argv[3] || "5m";
const symbols = allMode
  ? ["BNBUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"]
  : [symbol];

const windows = [
  { label: "5mo", from: "2026-01-01", to: "2026-05-18" },
  { label: "1yr", from: "2025-05-18", to: "2026-05-18" },
];

const grids = [
  { minScore: 8, maxDay: 8, gap: 6, trail: false, intel: false },
  { minScore: 9, maxDay: 8, gap: 6, trail: false, intel: false },
  { minScore: 9, maxDay: 6, gap: 8, trail: false, intel: true },
  { minScore: 10, maxDay: 6, gap: 8, trail: true, intel: false },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectIntradayPicks, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { INTRADAY_PRO_BASE } = await import("../src/strategy/presets/srIntradayOptimized.js");

let best = null;
const rows = [];

for (const sym of symbols) {
  for (const w of windows) {
    const fromMs = new Date(w.from).getTime();
    const toMs = new Date(w.to).getTime();
    const days = (toMs - fromMs) / 86_400_000;
    await ensureKlines(sym, tf, { from: fromMs, to: toMs, market: "futures" });
    const candles = await readCandles(sym, tf, fromMs, toMs);
    if (candles.length < 500) {
      console.error(`skip ${sym} ${w.label}: only ${candles.length} bars`);
      continue;
    }

    for (const g of grids) {
      let cfg = mergeAdaptiveCfg(
        {
          ...INTRADAY_PRO_BASE,
          srIntradayMinScore: g.minScore,
          srIntradayMaxTradesPerDay: g.maxDay,
          srIntradayMinBarGap: g.gap,
          trailingStopLossAuto: g.trail,
          supertrendFuturesExitOnFlip: g.trail,
          supertrendFuturesFixedTpPct: g.trail ? 0 : undefined,
          supertrendPeriod: 10,
          supertrendMultiplier: 2.5,
          supertrendWilderAtr: true,
          backtestBreakevenAtMfePct: g.trail ? 0.004 : 0,
          intelligenceGateEnabled: g.intel,
          intelligenceGateHighWinRate: g.intel,
        },
        candles,
      );

      const pick = selectIntradayPicks(candles, {
        maxTradesPerDay: g.maxDay,
        minScore: g.minScore,
        minBarGap: g.gap,
      });

      const adapters = await buildBacktestAdapters({
        strategyKey: "SR_INTRADAY",
        cfg,
        symbol: sym,
        tf,
        candles,
        fromMs,
      });

      const sim = await runSimulation({
        strategyKey: "SR_INTRADAY",
        candles,
        cfg,
        gateMode: g.intel ? "approx" : "off",
        fundingRates: [],
        startingUsdt: 100,
        timeframe: tf,
        adapters,
        symbol: sym,
      });

      const m = computeAllMetrics({
        trades: sim.trades,
        equityCurve: sim.equityCurve,
        tf,
        startingEquity: 100,
      });

      const tpm = days > 0 ? ((m.totalTrades ?? 0) / days) * 30 : 0;
      const row = {
        sym,
        window: w.label,
        tf,
        ...g,
        sl: cfg.supertrendFuturesFixedSlPct,
        tp: cfg.supertrendFuturesFixedTpPct,
        cands: pick.candidateCount,
        picks: pick.pickedCount,
        n: m.totalTrades,
        tradesPerMonth: +tpm.toFixed(1),
        wr: +((m.winRate ?? 0) * 100).toFixed(1),
        ret: +(m.totalReturnPct ?? 0).toFixed(1),
        pf: +(m.profitFactor ?? 0).toFixed(2),
        dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
      };
      rows.push(row);
      console.log(row);

      const sc =
        (row.tradesPerMonth >= 20 && row.tradesPerMonth <= 35 ? 400 : row.tradesPerMonth >= 12 ? 150 : 0) +
        (row.wr >= 75 ? 500 : row.wr >= 65 ? 250 : row.wr >= 55 ? 100 : 0) +
        row.ret * 2 +
        (row.pf > 1.3 ? 200 : row.pf > 1 ? 80 : 0);
      if (!best || sc > best.sc) best = { ...row, sc };
    }
  }
}

rows.sort((a, b) => b.ret - a.ret);
console.error("\n── TOP 10 by return ──");
for (const r of rows.slice(0, 10)) {
  console.error(
    `${r.sym} ${r.window} ms=${r.minScore} n=${r.n} tpm=${r.tradesPerMonth} WR=${r.wr}% ret=${r.ret}% PF=${r.pf}`,
  );
}
console.error("\nBEST SCORE", best);
await closePool?.();
