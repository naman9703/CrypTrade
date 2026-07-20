#!/usr/bin/env node
/**
 * BNB LIQUIDITY_MAP two-bar confirm + partial runner — 5 random months OOS probe.
 *
 * Tunes quality/sweep knobs on 3 in-sample months (walk-forward style), validates
 * on 2 held-out months. Auto-calibrate runs per-bar from warmup only (no symbol table).
 *
 * Usage (from backend/):
 *   node scripts/backtest-liq-map-bnb-oos.mjs
 *   MONTHS=2025-03,2025-07,2025-11,2026-01,2026-04 node scripts/backtest-liq-map-bnb-oos.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "5m";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 1);
const TUNE_MONTHS = Math.max(1, Number(process.env.TUNE_MONTHS || 3));

const DEFAULT_MONTHS = ["2025-03", "2025-07", "2025-11", "2026-01", "2026-04"];
const MONTHS = String(process.env.MONTHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_MONTHS = MONTHS.length ? MONTHS : DEFAULT_MONTHS;

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const to = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { from, to, label: ym };
}

const TUNE_GRID = [
  { minQualityScore: 5.4, minWickRatio: 0.2, minRvol: 0.85, sweepAtrFrac: 0.12 },
  { minQualityScore: 5.8, minWickRatio: 0.22, minRvol: 0.9, sweepAtrFrac: 0.13 },
  { minQualityScore: 6.2, minWickRatio: 0.24, minRvol: 0.95, sweepAtrFrac: 0.14 },
  { minQualityScore: 6.6, minWickRatio: 0.26, minRvol: 1.0, sweepAtrFrac: 0.15 },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  LIQUIDITY_MAP_BNB_5M_TWO_BAR_RUNNER_PRESET,
  resolveLiquidityMapRunCfg,
} = await import("../src/strategy/liquidityMapStrategy.js");

function uniqEntries(trades, fromMs, toMs) {
  const seen = new Set();
  let n = 0;
  for (const t of trades) {
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const key = `${ts}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
  }
  return n;
}

async function runMonth(window, tuneOverrides = {}) {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const warmupMs = 21 * 86_400_000;
  const candles = await readCandles(SYMBOL, TF, fromMs - warmupMs, toMs, { market: "futures" });
  if (!candles.length) return { error: "no_candles", label: window.label };

  const baseCfg = {
    ...LIQUIDITY_MAP_BNB_5M_TWO_BAR_RUNNER_PRESET,
    ...tuneOverrides,
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "LIQUIDITY_MAP",
    marketMode: "FUTURES",
    backtestSignalStartMs: fromMs,
  };
  const cfg = resolveLiquidityMapRunCfg(baseCfg, candles);
  const adapters = await buildBacktestAdapters({
    strategyKey: "LIQUIDITY_MAP",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: Number(candles[0]?.ts) || fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "LIQUIDITY_MAP",
    candles,
    cfg,
    costModelOverride: { slippagePct: 0.0005 },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const inWin = sim.trades.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  const metrics = computeAllMetrics({
    trades: inWin,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const days = Math.max(1, (toMs - fromMs) / 86_400_000);
  const trades = uniqEntries(sim.trades, fromMs, toMs);
  return {
    label: window.label,
    trades,
    perDay: trades / days,
    ret: Number(metrics.totalReturnPct ?? 0),
    retMo: Number(metrics.totalReturnPct ?? 0), // 1 calendar month window
    pf: Number(metrics.profitFactor ?? 0),
    wr: Number(metrics.winRate ?? 0) * 100,
    dd: Number(metrics.maxDrawdownPct ?? 0),
    avgR: Number(metrics.expectancyR ?? 0),
    tune: tuneOverrides,
  };
}

const windows = TEST_MONTHS.map(monthWindow);
const tuneWindows = windows.slice(0, TUNE_MONTHS);
const oosWindows = windows.slice(TUNE_MONTHS);

console.log(`BNB two-bar runner | ${SYMBOL} ${TF} | months=${TEST_MONTHS.join(",")}`);
console.log(`Tune on ${tuneWindows.map((w) => w.label).join(",")} | OOS ${oosWindows.map((w) => w.label).join(",")}`);

let best = { score: -Infinity, tune: TUNE_GRID[1], agg: null };
for (const tune of TUNE_GRID) {
  const overrides = {
    liqMapMinQualityScore: tune.minQualityScore,
    liqMapMinWickRatio: tune.minWickRatio,
    liqMapMinRvol: tune.minRvol,
    liqMapSweepAtrFrac: tune.sweepAtrFrac,
    liqMapQualityAuto: false,
  };
  const rows = [];
  for (const w of tuneWindows) {
    rows.push(await runMonth(w, overrides));
  }
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) continue;
  const aggRet = ok.reduce((s, r) => s + r.ret, 0) / ok.length;
  const aggDd = ok.reduce((s, r) => s + r.dd, 0) / ok.length;
  const aggTrades = ok.reduce((s, r) => s + r.trades, 0) / ok.length;
  const aggPf = ok.reduce((s, r) => s + (Number.isFinite(r.pf) ? r.pf : 0), 0) / ok.length;
  // Favor return with DD penalty; require ~1 trade/day band
  const tradePenalty = Math.abs(aggTrades - 30) * 0.15;
  const score = aggRet - aggDd * 0.8 - tradePenalty + Math.min(aggPf, 3) * 2;
  console.log(
    JSON.stringify({
      phase: "tune",
      tune,
      avgRet: Number(aggRet.toFixed(2)),
      avgDd: Number(aggDd.toFixed(2)),
      avgTrades: Number(aggTrades.toFixed(1)),
      avgPf: Number(aggPf.toFixed(2)),
      score: Number(score.toFixed(2)),
    }),
  );
  if (score > best.score) {
    best = {
      score,
      tune,
      agg: { avgRet: aggRet, avgDd: aggDd, avgTrades: aggTrades, avgPf: aggPf },
    };
  }
}

const bestOverrides = {
  liqMapMinQualityScore: best.tune.minQualityScore,
  liqMapMinWickRatio: best.tune.minWickRatio,
  liqMapMinRvol: best.tune.minRvol,
  liqMapSweepAtrFrac: best.tune.sweepAtrFrac,
  liqMapQualityAuto: false,
};

console.log("\n--- BEST TUNE (in-sample) ---");
console.log(JSON.stringify({ tune: best.tune, agg: best.agg, score: best.score }));

const allResults = [];
for (const w of windows) {
  const phase = oosWindows.some((o) => o.label === w.label) ? "oos" : "is";
  const r = await runMonth(w, bestOverrides);
  allResults.push({ ...r, phase });
  console.log(JSON.stringify({ phase, ...r, tune: undefined }));
}

const isRows = allResults.filter((r) => r.phase === "is" && !r.error);
const oosRows = allResults.filter((r) => r.phase === "oos" && !r.error);
const sum = (rows, key) => (rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0);

console.log("\n--- SUMMARY ---");
console.log(
  JSON.stringify({
    symbol: SYMBOL,
    preset: "LIQUIDITY_MAP_BNB_5M_TWO_BAR_RUNNER",
    bestTune: best.tune,
    inSample: {
      months: isRows.map((r) => r.label),
      avgRetMo: Number(sum(isRows, "retMo").toFixed(2)),
      avgDd: Number(sum(isRows, "dd").toFixed(2)),
      avgTrades: Number(sum(isRows, "trades").toFixed(1)),
      avgPerDay: Number(sum(isRows, "perDay").toFixed(2)),
    },
    oos: {
      months: oosRows.map((r) => r.label),
      avgRetMo: Number(sum(oosRows, "retMo").toFixed(2)),
      avgDd: Number(sum(oosRows, "dd").toFixed(2)),
      avgTrades: Number(sum(oosRows, "trades").toFixed(1)),
      avgPerDay: Number(sum(oosRows, "perDay").toFixed(2)),
    },
    all5: {
      avgRetMo: Number(sum(allResults.filter((r) => !r.error), "retMo").toFixed(2)),
      avgDd: Number(sum(allResults.filter((r) => !r.error), "dd").toFixed(2)),
      avgTrades: Number(sum(allResults.filter((r) => !r.error), "trades").toFixed(1)),
    },
    target50pctMo: false,
    targetDd10: sum(oosRows, "dd") < 10,
  }),
);

await closePool?.();
