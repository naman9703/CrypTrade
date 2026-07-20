#!/usr/bin/env node
/**
 * Multi-coin PORTFOLIO of SUPERTREND_ELITE under locked trail-only exit contract.
 *
 * Runs the SAME (un-tuned-per-coin) config on every coin, then replays all
 * trades chronologically on ONE shared account with proper compounding. Each
 * trade risks `risk%` of CURRENT shared equity (R-multiple based).
 *
 * Usage:
 *   node scripts/backtest-portfolio-supertrend.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT FROM=2025-01-01 node scripts/backtest-portfolio-supertrend.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const MULT = Number(process.env.MULT || 3.0);
const MIN_ADX = Number(process.env.MIN_ADX || 20);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  applyEliteStExitContract,
} = await import("../src/strategy/supertrendElite.js");
const { resolveTradeRiskUsd } = await import("../src/backtest/engine/portfolioReplay.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

function cfg(sym) {
  return applyEliteStExitContract({
    symbol: sym, marketMode: "FUTURES", futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL", riskPerTrade: 1, riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    supertrendWilderAtr: true, supertrendPeriod: 10, supertrendMultiplier: MULT,
    eliteStRequireHtf4hAlign: true, eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: MIN_ADX, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireAtrExpansion: true,
  });
}

// Collect per-coin trades as R-multiples (netPnl / entry-time dollar risk).
const allTrades = [];
const perCoin = {};
let monthsSpan = 0;
for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
  let funding = [];
  try { funding = await readFundingRates(sym, fromMs, toMs); } catch {}
  const c = cfg(sym);
  const opts = buildEliteStOptsFromCfg(c);
  const adapter = buildEliteStBacktestAdapter(candles, opts);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE", candles, cfg: c, gateMode: "off",
    fundingRates: funding, startingUsdt: 1000, timeframe: TF,
    adapters: { SUPERTREND_ELITE: adapter }, symbol: sym,
  });
  const span = (candles[candles.length - 1].ts - candles[0].ts) / (30.44 * 86400000);
  monthsSpan = Math.max(monthsSpan, span);
  let n = 0, wins = 0, rSum = 0;
  for (const t of sim.trades) {
    if (t.exitReason === "tp1_partial") continue;
    const risk = resolveTradeRiskUsd(t, 1);
    if (risk <= 0) continue;
    const R = Number(t.netPnl ?? 0) / risk;
    allTrades.push({ ts: Number(t.exitTs ?? t.entryTs), R, sym, exitReason: t.exitReason });
    n++; if (R > 0) wins++; rSum += R;
  }
  perCoin[sym] = { n, wr: n ? (wins / n) * 100 : 0, expR: n ? rSum / n : 0, span };
}

allTrades.sort((a, b) => a.ts - b.ts);

function replay(riskFrac) {
  let eq = 1000, peak = 1000, maxDD = 0;
  for (const t of allTrades) {
    eq *= 1 + t.R * riskFrac;
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const ret = (eq / 1000 - 1) * 100;
  const cagr = monthsSpan > 0 ? (Math.pow(eq / 1000, 12 / monthsSpan) - 1) * 100 : 0;
  const calmar = maxDD > 0 ? cagr / maxDD : 0;
  const monthly = monthsSpan > 0 ? (Math.pow(eq / 1000, 1 / monthsSpan) - 1) * 100 : 0;
  return { ret, cagr, monthly, maxDD, calmar, finalEq: eq };
}

const f = (n, d = 1) => Number(n ?? 0).toFixed(d);
console.log(`\n=== SUPERTREND_ELITE PORTFOLIO — ${SYMBOLS.join(", ")} ${TF} ${FROM}->${TO} ===`);
console.log(`uniform config m${MULT}/adx${MIN_ADX} (no per-coin tuning) · span≈${f(monthsSpan)} months\n`);

console.log(`Per-coin edge:`);
console.log(`${"coin".padEnd(10)}${"trades".padStart(8)}${"WR%".padStart(7)}${"expR".padStart(8)}`);
let totalTrades = 0;
for (const [sym, v] of Object.entries(perCoin)) {
  console.log(`${sym.padEnd(10)}${String(v.n).padStart(8)}${f(v.wr, 0).padStart(7)}${f(v.expR, 3).padStart(8)}`);
  totalTrades += v.n;
}
console.log(`${"TOTAL".padEnd(10)}${String(totalTrades).padStart(8)}  (${f(totalTrades / Math.max(1, monthsSpan))}/month across portfolio)\n`);

console.log(`Portfolio (shared account, compounding, risk% of equity per trade):`);
console.log(`${"risk%".padStart(6)}${"totRet%".padStart(10)}${"monthly%".padStart(10)}${"CAGR%".padStart(9)}${"maxDD%".padStart(9)}${"Calmar".padStart(8)}${"finalEq$".padStart(12)}`);
for (const risk of [5, 10, 15, 20, 25, 30]) {
  const r = replay(risk / 100);
  console.log(`${String(risk).padStart(6)}${f(r.ret).padStart(10)}${f(r.monthly).padStart(10)}${f(r.cagr).padStart(9)}${f(r.maxDD).padStart(9)}${f(r.calmar, 2).padStart(8)}${f(r.finalEq, 0).padStart(12)}`);
}

await closePool?.();
