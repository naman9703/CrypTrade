#!/usr/bin/env node
/** Compare aggressive scalp presets for TREND_PULLBACK across coins. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,LINKUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TF = process.env.TF || "5m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-05-01";

const PRESETS = [
  {
    name: "default_long",
    patch: { trendPullbackLongOnly: true },
  },
  {
    name: "fast_scalp",
    patch: {
      trendPullbackLongOnly: true,
      trendPullbackQuickProfitPct: 0.0012,
      trendPullbackMinProfitPct: 0.0006,
      trendPullbackMaxHoldMin: 45,
      trendPullbackCooldownBars: 4,
      trendPullbackRsiOversold: 23,
      trendPullbackRsiRecoverMin: 37,
      trendPullbackRsiExitLong: 38,
      supertrendFuturesFixedSlPct: 0.005,
      supertrendFuturesFixedTpPct: 0.008,
    },
  },
  {
    name: "ultra_scalp",
    patch: {
      trendPullbackLongOnly: true,
      trendPullbackQuickProfitPct: 0.0008,
      trendPullbackMinProfitPct: 0.0004,
      trendPullbackMaxHoldMin: 30,
      trendPullbackCooldownBars: 3,
      trendPullbackRsiOversold: 22,
      trendPullbackRsiRecoverMin: 38,
      trendPullbackRsiExitLong: 36,
      supertrendFuturesFixedSlPct: 0.004,
      supertrendFuturesFixedTpPct: 0.006,
    },
  },
  {
    name: "both_sides",
    patch: {
      trendPullbackLongOnly: false,
      trendPullbackQuickProfitPct: 0.0015,
      trendPullbackMaxHoldMin: 60,
      supertrendFuturesFixedSlPct: 0.006,
      supertrendFuturesFixedTpPct: 0.01,
    },
  },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

async function run(sym, preset) {
  await ensureKlines(sym, TF, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) return null;
  const cfg = {
    symbol: sym,
    timeframe: TF,
    marketMode: "FUTURES",
    manualStrategy: "TREND_PULLBACK",
    futuresLeverage: 10,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1.5,
    riskPerTradeUnit: "PCT",
    trailingStopLossAuto: false,
    supertrendFuturesFixedSlPct: 0.006,
    supertrendFuturesFixedTpPct: 0.012,
    ...preset.patch,
  };
  const adapters = await buildBacktestAdapters({ strategyKey: "TREND_PULLBACK", cfg, symbol: sym, tf: TF, candles, fromMs });
  const sim = await runSimulation({
    strategyKey: "TREND_PULLBACK",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: TF,
    symbol: sym,
    adapters,
    costModelOverride: { slippagePct: 0.0005, openFeeRate: 0.0004, closeFeeRate: 0.0004, leverage: 10, isFutures: true },
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 1000 });
  const reasons = {};
  for (const t of sim.trades) reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1;
  const avgHold =
    sim.trades.length > 0
      ? sim.trades.reduce((s, t) => s + (t.exitTs - t.entryTs), 0) / sim.trades.length / 60000
      : 0;
  return {
    n: sim.trades.length,
    ret: Number(m.totalReturnPct ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    pf: Number(m.profitFactor ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    avgHold,
    reasons,
  };
}

console.log(`\nTREND_PULLBACK preset compare · ${TF} · ${FROM}→${TO} · ${SYMBOLS.length} coins\n`);

const summary = [];
for (const preset of PRESETS) {
  const rows = [];
  for (const sym of SYMBOLS) {
    const r = await run(sym, preset);
    if (r) rows.push({ sym, ...r });
  }
  const totalN = rows.reduce((s, r) => s + r.n, 0);
  const avgRet = rows.length ? rows.reduce((s, r) => s + r.ret, 0) / rows.length : 0;
  const avgWr = rows.length ? rows.reduce((s, r) => s + r.wr, 0) / rows.length : 0;
  const avgPf = rows.length ? rows.reduce((s, r) => s + r.pf, 0) / rows.length : 0;
  const maxDd = rows.length ? Math.max(...rows.map((r) => r.dd)) : 0;
  const avgHold = rows.length ? rows.reduce((s, r) => s + r.avgHold, 0) / rows.length : 0;
  const posCoins = rows.filter((r) => r.ret > 0).length;
  summary.push({ preset: preset.name, totalN, avgRet, avgWr, avgPf, maxDd, avgHold, posCoins, rows });
}

summary.sort((a, b) => b.avgRet - a.avgRet);
for (const s of summary) {
  console.log(
    `${s.preset.padEnd(14)} n=${String(s.totalN).padStart(4)} avgRet=${s.avgRet.toFixed(2).padStart(7)}% WR=${s.avgWr.toFixed(0).padStart(3)}% PF=${s.avgPf.toFixed(2)} DD=${s.maxDd.toFixed(1)}% hold=${s.avgHold.toFixed(0)}m +coins=${s.posCoins}/${SYMBOLS.length}`,
  );
}
const best = summary[0];
console.log(`\nBest: ${best.preset}`);
for (const r of best.rows) {
  const ex = Object.entries(r.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  console.log(`  ${r.sym.padEnd(10)} n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(2).padStart(7)}% WR=${r.wr.toFixed(0).padStart(3)}% hold=${r.avgHold.toFixed(0).padStart(4)}m  ${ex}`);
}

await closePool().catch(() => {});
