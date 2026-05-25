#!/usr/bin/env node
/** Fast HTF_RSI / SUPERTREND hunt with O(n) signal precompute. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.argv[2] || "BNBUSDT").toUpperCase();
const TF = process.argv[3] || "15m";
const FROM = new Date(process.argv[4] || "2026-01-01").getTime();
const TO = new Date(process.argv[5] || "2026-05-15").getTime();
const CAP = 10_000;

const COST = { slippagePct: 0.0005, takerOpenFeeRate: 0.0004, takerCloseFeeRate: 0.0004 };

const GRID = [];
for (const lev of [10, 15, 20, 25, 30]) {
  for (const risk of [1, 1.5, 2, 2.5, 3]) {
    for (const [sl, tp] of [
      [0.006, 0.015],
      [0.008, 0.02],
      [0.008, 0.025],
      [0.01, 0.02],
      [0.01, 0.03],
      [0.012, 0.024],
      [0.012, 0.036],
    ]) {
      GRID.push({ strat: "HTF_RSI", lev, risk, sl, tp, trail: false });
    }
  }
}
for (const lev of [15, 20, 25]) {
  for (const risk of [1.5, 2, 3]) {
    GRID.push({ strat: "HTF_RSI", lev, risk, sl: 0.01, tp: 0, trail: true });
    GRID.push({ strat: "HTF_RSI", lev, risk, sl: 0.012, tp: 0, trail: true });
  }
}

function cfg(c) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: c.lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: c.risk,
    riskPerTradeUnit: "PCT_EQUITY",
    strategyMode: "MANUAL",
    manualStrategy: c.strat,
    supertrendWilderAtr: true,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: c.sl,
    supertrendFuturesFixedTpPct: c.tp,
    trailingStopLossAuto: c.trail,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    marketDecision: { enabled: false },
    ...COST,
  };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");

console.log(`\n${SYMBOL} ${TF} · HTF_RSI grid (${GRID.length}) · $${CAP}\n`);
const candles = await readCandles(SYMBOL, TF, FROM, TO);
const funding = await readFundingRates(SYMBOL, FROM, TO).catch(() => []);
console.log(`${candles.length} bars\n`);

const bot0 = cfg({ strat: "HTF_RSI", lev: 10, risk: 1, sl: 0.01, tp: 0.02, trail: false });
const adapters = await buildBacktestAdapters({ strategyKey: "HTF_RSI", cfg: bot0, symbol: SYMBOL, tf: TF, candles, fromMs: FROM });

const rows = [];
for (const c of GRID) {
  const bot = cfg(c);
  const sim = await runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg: bot,
    costModelOverride: COST,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: CAP,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: CAP });
  const ret = Number(m.totalReturnPct ?? 0);
  const wr = (m.winRate ?? 0) * 100;
  rows.push({ ret, wr, pf: m.profitFactor, dd: m.maxDrawdownPct, n: m.totalTrades, ...c, bot });
  if (ret >= 100) {
    console.log(`★ ${ret.toFixed(1)}% WR ${wr.toFixed(1)}% | lev${c.lev} risk${c.risk}% sl${c.sl} tp${c.tp} trail${c.trail}`);
  }
}

rows.sort((a, b) => b.ret - a.ret || b.wr - a.wr);
console.log(`\nTop 12:\n`);
for (const r of rows.slice(0, 12)) {
  console.log(
    `${r.ret.toFixed(1)}% WR ${r.wr.toFixed(1)}% PF ${Number(r.pf).toFixed(2)} DD ${Number(r.dd).toFixed(1)}% n=${r.n} | lev${r.lev} risk${r.risk} sl${r.sl} ${r.trail ? "TRAIL" : "tp" + r.tp}`,
  );
}
const best = rows[0];
console.log(`\nBest: ${best.ret.toFixed(1)}% WR ${best.wr.toFixed(1)}%`);
if (best.ret >= 50) console.log(JSON.stringify(best.bot, null, 2));
await closePool();
