#!/usr/bin/env node
/**
 * SCALP_MR validation — quality gates: WR, PF, return, max DD.
 *
 * Usage: npm run backtest:scalp-mr
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
const MONTHS = ["2025-07", "2025-09", "2025-11", "2026-01", "2026-04"];
const IS = new Set(["2025-07", "2025-09", "2025-11"]);
const OOS = new Set(["2026-01", "2026-04"]);

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return { from, to: `${nextY}-${String(nextM).padStart(2, "0")}-01`, label: ym };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildScalpMrBacktestAdapter, resolveScalpMrCfg, scalpMrPadFromMs } = await import(
  "../src/strategy/scalpMr.js"
);
const {
  SCALP_MR_BNB_5M,
  SCALP_MR_BNB_5M_LONG,
  SCALP_MR_BNB_15M,
} = await import("../src/strategy/presets/scalpMrOptimized.js");

const COST = { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };
const windows = MONTHS.map(monthWindow);
const cache = new Map();

async function load(tf, window) {
  const key = `${tf}|${window.label}`;
  if (cache.has(key)) return cache.get(key);
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const candles = await readCandles(SYMBOL, tf, scalpMrPadFromMs(fromMs, tf), toMs, { market: "futures" });
  const v = { candles, fromMs, toMs };
  cache.set(key, v);
  return v;
}

async function runMonth(tf, window, base, startEq = START) {
  const { candles, fromMs, toMs } = await load(tf, window);
  const cfg = resolveScalpMrCfg({
    ...base,
    symbol: SYMBOL,
    timeframe: tf,
    marketMode: "FUTURES",
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    backtestSignalStartMs: fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SCALP_MR",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: startEq,
    timeframe: tf,
    symbol: SYMBOL,
    adapters: { SCALP_MR: buildScalpMrBacktestAdapter(candles, cfg, tf) },
    costModelOverride: COST,
  });
  const m = computeAllMetrics(sim, { fromMs, toMs });
  const finalEq = Number(m.finalEquity ?? startEq);
  return {
    retPct: startEq > 0 ? ((finalEq - startEq) / startEq) * 100 : 0,
    finalEq,
    trades: m.totalTrades ?? 0,
    wr: (m.winRate ?? 0) * 100,
    dd: m.maxDrawdownPct ?? 0,
    pf: m.profitFactor ?? 0,
  };
}

async function evalPreset(id, label, base, tf) {
  console.log(`\n── ${SYMBOL} · ${label} (${tf}) ──`);
  let chained = START;
  let maxDd = 0;
  let totalTrades = 0;
  let wrWeighted = 0;
  let pfSum = 0;
  let pfN = 0;
  let isSum = 0;
  let oosSum = 0;
  const oosRets = [];

  for (const w of windows) {
    const indep = await runMonth(tf, w, base, START);
    const chain = await runMonth(tf, w, base, chained);
    chained = chain.finalEq;
    maxDd = Math.max(maxDd, chain.dd, indep.dd);
    totalTrades += indep.trades;
    if (indep.trades > 0) {
      wrWeighted += indep.wr * indep.trades;
      pfSum += indep.pf;
      pfN += 1;
    }
    if (IS.has(w.label)) isSum += indep.retPct;
    if (OOS.has(w.label)) {
      oosSum += indep.retPct;
      oosRets.push(indep.retPct);
    }
    console.log(
      `  ${w.label}: ${indep.retPct >= 0 ? "+" : ""}${indep.retPct.toFixed(2)}% | tr ${indep.trades} | WR ${indep.wr.toFixed(0)}% | PF ${Number(indep.pf).toFixed(2)} | DD ${indep.dd.toFixed(1)}%`,
    );
  }

  const chainedPct = ((chained - START) / START) * 100;
  const avgWr = totalTrades > 0 ? wrWeighted / totalTrades : 0;
  const avgPf = pfN > 0 ? pfSum / pfN : 0;
  const oosPos = oosRets.every((r) => r > 0);
  const pass =
    chainedPct >= 8 &&
    maxDd <= 12 &&
    avgWr >= 42 &&
    avgPf >= 1.15 &&
    totalTrades >= 6 &&
    oosSum > 0;

  console.log(
    `  CHAINED: ${chainedPct >= 0 ? "+" : ""}${chainedPct.toFixed(2)}% | IS ${isSum.toFixed(2)}% | OOS ${oosSum.toFixed(2)}% | maxDD ${maxDd.toFixed(1)}% | avgWR ${avgWr.toFixed(0)}% | avgPF ${avgPf.toFixed(2)} | ${totalTrades} tr | PASS ${pass ? "YES" : "no"}`,
  );
  return { id, pass, chainedPct, maxDd, avgWr, avgPf, totalTrades, oosSum, isSum };
}

console.log(`\n=== SCALP_MR quality validation — ${SYMBOL} @ ${RISK}% risk ===`);
console.log(`Gates: chained >= 8%, maxDD <= 12%, avgWR >= 42%, avgPF >= 1.15, trades >= 6, OOS sum > 0\n`);

const results = [];
results.push(await evalPreset("bnb_5m", "BNB 5m quality (HTF + 2-bar reclaim)", SCALP_MR_BNB_5M, "5m"));
results.push(await evalPreset("bnb_5m_long", "BNB 5m long-only HTF", SCALP_MR_BNB_5M_LONG, "5m"));
results.push(await evalPreset("bnb_15m", "BNB 15m quality", SCALP_MR_BNB_15M, "15m"));

const passed = results.filter((r) => r.pass);
console.log(`\n=== SUMMARY: ${passed.length}/${results.length} presets passed quality gates ===`);
if (!passed.length) {
  console.log("No preset met all gates. Strategy needs more work or different logic.");
} else {
  for (const p of passed) {
    console.log(`  PASS ${p.id}: chained ${p.chainedPct.toFixed(1)}% WR ${p.avgWr.toFixed(0)}% DD ${p.maxDd.toFixed(1)}%`);
  }
}

await closePool?.().catch(() => {});
