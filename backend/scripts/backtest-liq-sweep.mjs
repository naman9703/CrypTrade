#!/usr/bin/env node
/**
 * Isolate the LIQUIDITY SWEEP sub-strategy (SR_INTRADAY liquidity-only solo path)
 * and backtest it across coins + tunings with realistic costs.
 *
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT FROM=2026-01-01 TO=2026-06-01 node scripts/backtest-liq-sweep.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 10);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

/** Liquidity-sweep SOLO base: only liquidity + session gates, everything else off. */
function liqBaseCfg(symbol) {
  return {
    symbol,
    timeframe: TF,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    // Liquidity-sweep solo gate stack
    intradayGateLiquidity: true,
    intradayGateSession: true,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradaySmcIctMode: false,
    intradaySrAPlusMode: false,
    intradayLearnedRulesEnabled: false,
    supertrendHtf4hEnabled: false,
    intradayLiqStrictMode: true,
    // exits come from liquidity brackets (partial 1R + opposing pool)
    trailingStopLossAuto: false,
    supertrendFuturesExitOnFlip: false,
    // wide caps so tuning, not caps, drives results
    srIntradayMaxTradesPerDay: 6,
    intradayLiqMaxTradesPerSidePerDay: 3,
    srIntradayMinBarGap: 2,
    // liquidity bracket defaults
    intradayLiqPartialTp: true,
    intradayLiqTp1Enabled: true,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: true,
  };
}

/** Tunings to sweep. Each overrides the liquidity sub-strategy thresholds. */
const TUNINGS = [
  {
    label: "T1 loose (sweep.10% ext.3% wick0)",
    cfg: { srIntradaySweepPct: 0.001, intradayLiqMinSweepExtensionPct: 0.003, intradayLiqMinWickRatio: 0, intradayLiqMinRr: 0, intradayLiqMinScore: 5 },
  },
  {
    label: "T2 base (sweep.10% ext.5% wick.3 rr1.2)",
    cfg: { srIntradaySweepPct: 0.001, intradayLiqMinSweepExtensionPct: 0.005, intradayLiqMinWickRatio: 0.3, intradayLiqMinRr: 1.2, intradayLiqMinScore: 6 },
  },
  {
    label: "T3 strict (sweep.15% ext.8% wick.4 rr1.5)",
    cfg: { srIntradaySweepPct: 0.0015, intradayLiqMinSweepExtensionPct: 0.008, intradayLiqMinWickRatio: 0.4, intradayLiqMinRr: 1.5, intradayLiqMinScore: 7, intradayLiqMinReclaimBodyRatio: 0.35 },
  },
  {
    label: "T4 strict+1pick/day (ext.8% wick.45 rr1.5)",
    cfg: { srIntradaySweepPct: 0.0015, intradayLiqMinSweepExtensionPct: 0.008, intradayLiqMinWickRatio: 0.45, intradayLiqMinRr: 1.5, intradayLiqMinScore: 7, intradayLiqMinReclaimBodyRatio: 0.4, intradayLiqOnePickPerDay: true, intradayLiqFirstCycleOnly: true },
  },
  {
    label: "T5 strict+HTFalign (ext.8% wick.4 rr1.5 htf)",
    cfg: { srIntradaySweepPct: 0.0015, intradayLiqMinSweepExtensionPct: 0.008, intradayLiqMinWickRatio: 0.4, intradayLiqMinRr: 1.5, intradayLiqMinScore: 7, intradayLiqMinReclaimBodyRatio: 0.35, intradayLiqRequireHtfAlign: true, intradayLiqMinHtfSep: 0.0008, supertrendHtf4hEnabled: true },
  },
  {
    label: "T6 strict+cluster (ext.8% +session-extreme)",
    cfg: { srIntradaySweepPct: 0.0015, intradayLiqMinSweepExtensionPct: 0.008, intradayLiqMinWickRatio: 0.4, intradayLiqMinRr: 1.5, intradayLiqMinScore: 7, intradayLiqMinReclaimBodyRatio: 0.35, intradayLiqSessionExtreme: true, intradayLiqSessionExtremeMinTouches: 2 },
  },
];

async function loadData(symbol) {
  const candles = await readCandles(symbol, TF, fromMs, toMs);
  if (!candles?.length) return null;
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs, toMs);
  } catch {
    funding = [];
  }
  return { candles, funding };
}

async function runOne(symbol, data, tuning) {
  const cfg = { ...liqBaseCfg(symbol), ...tuning.cfg };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf: TF,
    candles: data.candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: data.candles,
    cfg,
    gateMode: "off",
    fundingRates: data.funding,
    startingUsdt: START,
    timeframe: TF,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  return {
    symbol,
    tuning: tuning.label,
    net: m.totalReturnPct,
    trades: m.totalTrades,
    wr: (m.winRate || 0) * 100,
    pf: m.profitFactor || 0,
    dd: m.maxDrawdownPct,
    calmar: m.calmar ?? 0,
    sharpe: m.sharpe || 0,
    expR: m.expectancyR ?? 0,
  };
}

console.log(`\n=== LIQUIDITY SWEEP sub-strategy backtest ===`);
console.log(`symbols=${SYMBOLS.join(",")} tf=${TF} ${FROM}->${TO} risk=${RISK_PCT}% lev=${LEVERAGE}x\n`);

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const rows = [];
const data = {};
for (const sym of SYMBOLS) {
  data[sym] = await loadData(sym);
  if (!data[sym]) {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
}

for (const sym of SYMBOLS) {
  if (!data[sym]) continue;
  for (const tuning of TUNINGS) {
    const r = await runOne(sym, data[sym], tuning);
    rows.push(r);
  }
  process.stdout.write(`  ${sym} done\n`);
}

console.log(`\n${"symbol".padEnd(9)}${"tuning".padEnd(40)}${"net%".padStart(8)}${"trades".padStart(8)}${"wr%".padStart(6)}${"PF".padStart(7)}${"maxDD%".padStart(8)}${"Calmar".padStart(8)}${"expR".padStart(7)}`);
for (const r of rows) {
  console.log(
    `${r.symbol.padEnd(9)}${r.tuning.padEnd(40)}${fmt(r.net).padStart(8)}${String(r.trades).padStart(8)}${fmt(r.wr, 0).padStart(6)}${fmt(r.pf, 2).padStart(7)}${fmt(r.dd).padStart(8)}${fmt(r.calmar, 2).padStart(8)}${fmt(r.expR, 2).padStart(7)}`,
  );
}

// Aggregate per tuning across symbols.
console.log(`\n=== BY TUNING (mean across symbols) ===`);
const byTune = {};
for (const r of rows) {
  byTune[r.tuning] = byTune[r.tuning] || { nets: [], trades: 0, pos: 0, n: 0 };
  byTune[r.tuning].nets.push(r.net);
  byTune[r.tuning].trades += r.trades;
  byTune[r.tuning].pos += r.net > 0 ? 1 : 0;
  byTune[r.tuning].n += 1;
}
console.log(`${"tuning".padEnd(40)}${"meanNet%".padStart(10)}${"minNet%".padStart(10)}${"pos/sym".padStart(9)}${"trades".padStart(8)}`);
const agg = Object.entries(byTune).map(([label, v]) => ({
  label,
  mean: v.nets.reduce((a, b) => a + b, 0) / v.nets.length,
  min: Math.min(...v.nets),
  pos: v.pos,
  n: v.n,
  trades: v.trades,
}));
agg.sort((a, b) => b.mean - a.mean);
for (const a of agg) {
  console.log(`${a.label.padEnd(40)}${fmt(a.mean).padStart(10)}${fmt(a.min).padStart(10)}${`${a.pos}/${a.n}`.padStart(9)}${String(a.trades).padStart(8)}`);
}

await closePool?.();
