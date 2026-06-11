#!/usr/bin/env node
/**
 * Combined CRT+TBS + SUPERTREND_ELITE portfolio on a shared account.
 *
 * Runs both strategies on the same coin universe, merges trades chronologically,
 * and replays with per-strategy risk sizing (R-multiple compounding).
 *
 * Usage:
 *   node scripts/backtest-crt-st-portfolio.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT FROM=2025-06-01 TO=2026-06-05 node scripts/backtest-crt-st-portfolio.mjs
 *   CRT_PRESET=balanced  # v2 | balanced | freq
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const CRT_PRESET = String(process.env.CRT_PRESET || "balanced").toLowerCase();
const CRT_RISK = Number(process.env.CRT_RISK || 2);
const ST_RISK = Number(process.env.ST_RISK || 10);
const ST_MULT = Number(process.env.ST_MULT || 3.0);
const ST_MIN_ADX = Number(process.env.ST_MIN_ADX || 20);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg, crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const {
  CRT_TBS_BNB_15M,
  CRT_TBS_BNB_15M_BALANCED,
  CRT_TBS_BNB_15M_FREQ,
} = await import("../src/strategy/presets/crtTbsOptimized.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const calDays = (toMs - fromMs) / 86_400_000;

const CRT_PRESETS = {
  v2: CRT_TBS_BNB_15M,
  balanced: CRT_TBS_BNB_15M_BALANCED,
  freq: CRT_TBS_BNB_15M_FREQ,
};
const crtBase = CRT_PRESETS[CRT_PRESET] || CRT_TBS_BNB_15M_BALANCED;

const crtCost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

function stCfg(sym) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: ST_RISK,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: true,
    supertrendFuturesFixedSlPct: 0,
    supertrendFuturesFixedTpPct: 0,
    supertrendWilderAtr: true,
    supertrendPeriod: 10,
    supertrendMultiplier: ST_MULT,
    eliteStRequireHtf4hAlign: true,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: ST_MIN_ADX,
    eliteStRequireAdxRising: true,
    eliteStMinVolumeVsAvg: 1.5,
    eliteStRequireAtrExpansion: true,
    manualStrategy: "SUPERTREND_ELITE",
  };
}

function collectCrtEntries(sim, sym) {
  const entries = aggregateSituationEntries(sim.trades, fromMs, toMs);
  const out = [];
  for (const e of entries) {
    const legs = sim.trades.filter(
      (t) => t.entryTs === e.ts && String(t.direction).toUpperCase() === String(e.dir).toUpperCase(),
    );
    const first = legs[0];
    if (!first) continue;
    const risk = Number(first.initialRiskUsd) || 0;
    if (risk <= 0) continue;
    const lastExit = Math.max(...legs.map((l) => Number(l.exitTs ?? l.entryTs)));
    out.push({
      ts: lastExit,
      entryTs: e.ts,
      R: e.pnlUsdt / risk,
      sym,
      strategy: "CRT_TBS",
      dir: String(e.dir).toUpperCase(),
      riskPct: CRT_RISK,
    });
  }
  return out;
}

/** ST trail exits often have initialRiskUsd=0; fall back to equity × risk%. */
function stTradeRiskUsd(t, riskPct) {
  const slRisk = Number(t.initialRiskUsd) || 0;
  if (slRisk > 0) return slRisk;
  const eq = Number(t.equityAtEntry) || 1000;
  return eq * (riskPct / 100);
}

function collectStEntries(sim, sym) {
  const out = [];
  for (const t of sim.trades) {
    if (t.exitReason === "tp1_partial") continue;
    if (t.entryTs < fromMs || t.entryTs >= toMs) continue;
    const risk = stTradeRiskUsd(t, ST_RISK);
    if (risk <= 0) continue;
    out.push({
      ts: Number(t.exitTs ?? t.entryTs),
      entryTs: t.entryTs,
      R: Number(t.netPnl ?? 0) / risk,
      sym,
      strategy: "SUPERTREND_ELITE",
      dir: String(t.direction).toUpperCase(),
      riskPct: ST_RISK,
    });
  }
  return out;
}

const allTrades = [];
const perCoin = {};
const perStrategy = { CRT_TBS: [], SUPERTREND_ELITE: [] };
let monthsSpan = 0;

for (const sym of SYMBOLS) {
  const crtFrom = crtTbsPadFromMs(fromMs, TF);
  let candles;
  try {
    candles = await readCandles(sym, TF, crtFrom, toMs, { market: "futures" });
  } catch {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
  if (!candles?.length) {
    console.log(`[skip] ${sym}: empty`);
    continue;
  }

  const span = (candles[candles.length - 1].ts - candles[0].ts) / (30.44 * 86_400_000);
  monthsSpan = Math.max(monthsSpan, span);

  const crtCfg = resolveCrtTbsCfg({ ...crtBase, symbol: sym, timeframe: TF, riskPerTrade: CRT_RISK });
  const crtAdapter = buildCrtTbsBacktestAdapter(candles, crtCfg, TF);
  const crtSim = await runSimulation({
    strategyKey: "CRT_TBS",
    candles,
    cfg: { ...crtCfg, symbol: sym },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: TF,
    adapters: { CRT_TBS: crtAdapter },
    symbol: sym,
    costModelOverride: crtCost,
  });
  const crtEntries = collectCrtEntries(crtSim, sym);

  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {}
  const stC = stCfg(sym);
  const stAdapter = buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(stC));
  const stSim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles,
    cfg: stC,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 1000,
    timeframe: TF,
    adapters: { SUPERTREND_ELITE: stAdapter },
    symbol: sym,
  });
  const stEntries = collectStEntries(stSim, sym);

  perCoin[sym] = { crt: crtEntries.length, st: stEntries.length };
  perStrategy.CRT_TBS.push(...crtEntries);
  perStrategy.SUPERTREND_ELITE.push(...stEntries);
  allTrades.push(...crtEntries, ...stEntries);
}

allTrades.sort((a, b) => a.ts - b.ts);

function replay(trades, riskScale = 1) {
  let eq = 1000;
  let peak = 1000;
  let maxDD = 0;
  for (const t of trades) {
    const frac = (t.riskPct / 100) * riskScale;
    eq *= 1 + t.R * frac;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const ret = (eq / 1000 - 1) * 100;
  const cagr = monthsSpan > 0 ? (Math.pow(eq / 1000, 12 / monthsSpan) - 1) * 100 : 0;
  const monthly = monthsSpan > 0 ? (Math.pow(eq / 1000, 1 / monthsSpan) - 1) * 100 : 0;
  return { ret, cagr, monthly, maxDD, finalEq: eq };
}

function stats(trades) {
  const days = new Set(trades.map((t) => new Date(t.entryTs).toISOString().slice(0, 10)));
  const longs = trades.filter((t) => t.dir === "BUY" || t.dir === "LONG").length;
  const shorts = trades.filter((t) => t.dir === "SELL" || t.dir === "SHORT").length;
  const wins = trades.filter((t) => t.R > 0).length;
  return {
    n: trades.length,
    longs,
    shorts,
    wr: trades.length ? (wins / trades.length) * 100 : 0,
    tpd: trades.length / calDays,
    activeDays: days.size,
    tpdActive: days.size ? trades.length / days.size : 0,
  };
}

const f = (n, d = 1) => Number(n ?? 0).toFixed(d);

console.log(`\n=== CRT+TBS + SUPERTREND_ELITE COMBINED PORTFOLIO ===`);
console.log(`${SYMBOLS.join(", ")} · ${TF} · ${FROM} → ${TO}`);
console.log(`CRT preset=${CRT_PRESET} @ ${CRT_RISK}% risk · ST m${ST_MULT}/adx${ST_MIN_ADX} @ ${ST_RISK}% risk\n`);

console.log("Per-coin trade count:");
console.log(`${"coin".padEnd(10)}${"CRT".padStart(6)}${"ST".padStart(6)}${"total".padStart(8)}`);
let totCrt = 0;
let totSt = 0;
for (const [sym, v] of Object.entries(perCoin)) {
  const t = v.crt + v.st;
  console.log(`${sym.padEnd(10)}${String(v.crt).padStart(6)}${String(v.st).padStart(6)}${String(t).padStart(8)}`);
  totCrt += v.crt;
  totSt += v.st;
}
console.log(`${"TOTAL".padEnd(10)}${String(totCrt).padStart(6)}${String(totSt).padStart(6)}${String(totCrt + totSt).padStart(8)}\n`);

for (const [name, trades] of [
  ["CRT_TBS only", perStrategy.CRT_TBS],
  ["SUPERTREND_ELITE only", perStrategy.SUPERTREND_ELITE],
  ["COMBINED", allTrades],
]) {
  const s = stats(trades);
  const r = replay(trades, name === "COMBINED" ? 1 : 1);
  console.log(`--- ${name} ---`);
  console.log(
    `  entries=${s.n}  long=${s.longs}  short=${s.shorts}  WR=${f(s.wr, 0)}%  ` +
      `trades/cal-day=${f(s.tpd, 3)}  trades/active-day=${f(s.tpdActive, 2)}`,
  );
  console.log(`  return=${f(r.ret)}%  monthly≈${f(r.monthly)}%  maxDD=${f(r.maxDD)}%  final=$${f(r.finalEq, 0)}\n`);
}

// LONG vs BOTH on BNB for CRT shorts explanation
const bnbCandles = await readCandles("BNBUSDT", TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });
for (const [label, sides] of [
  ["CRT LONG only", "LONG"],
  ["CRT BOTH sides", "BOTH"],
]) {
  const cfg = resolveCrtTbsCfg({ ...crtBase, symbol: "BNBUSDT", timeframe: TF, riskPerTrade: CRT_RISK, crtTradeSides: sides });
  const adapter = buildCrtTbsBacktestAdapter(bnbCandles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "CRT_TBS",
    candles: bnbCandles,
    cfg: { ...cfg, symbol: "BNBUSDT" },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: TF,
    adapters: { CRT_TBS: adapter },
    symbol: "BNBUSDT",
    costModelOverride: crtCost,
  });
  const entries = collectCrtEntries(sim, "BNBUSDT");
  const s = stats(entries);
  const r = replay(entries);
  console.log(
    `BNB ${label}: n=${s.n} long=${s.longs} short=${s.shorts} ret=${f(r.ret)}% ` +
      `(set crtTradeSides:BOTH in UI to enable shorts)`,
  );
}

await closePool?.();
