#!/usr/bin/env node
/**
 * Phase 3B — portfolio simulator (equal-weight baseline, Null Policy).
 *
 * Usage:
 *   cd backend && node scripts/research-phase3b-portfolio-sim.mjs
 *   RISK_PCT=5 node scripts/research-phase3b-portfolio-sim.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,BNBUSDT,ETHUSDT,LINKUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim());
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 10_000);
const RISK_PCT = Number(process.env.RISK_PCT || 5);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * 0.75;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const {
  portfolioReplay,
  portfolioSliceReplay,
  tradesToREvents,
  tradesToTimelineEvents,
} = await import("../src/backtest/engine/portfolioReplay.js");
const { NULL_POLICY } = await import("./lib/portfolioPolicy.js");

function eliteCfg(sym) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: true,
    supertrendWilderAtr: true,
    supertrendPeriod: 10,
    supertrendMultiplier: 3.0,
    eliteStRequireHtf4hAlign: true,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: 20,
    eliteStRequireAdxRising: true,
    eliteStMinVolumeVsAvg: 1.5,
    eliteStRequireAtrExpansion: true,
  };
}

async function collectEvents(sliceFrom, sliceTo) {
  const events = [];
  const timeline = [];
  const exposureBySymbol = {};
  for (const sym of SYMBOLS) {
    const candles = await readCandles(sym, TF, sliceFrom, sliceTo, { market: "futures" });
    if (!candles?.length) continue;
    let funding = [];
    try {
      funding = await readFundingRates(sym, sliceFrom, sliceTo);
    } catch {
      funding = [];
    }
    const c = eliteCfg(sym);
    const sim = await runSimulation({
      strategyKey: "SUPERTREND_ELITE",
      candles,
      cfg: c,
      gateMode: "off",
      fundingRates: funding,
      startingUsdt: 1000,
      timeframe: TF,
      adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(c)) },
      symbol: sym,
    });
    events.push(...tradesToREvents(sym, sim.trades, RISK_PCT));
    timeline.push(...tradesToTimelineEvents(sym, sim.trades));
    exposureBySymbol[sym] = sim.trades.filter((t) => t.exitReason !== "tp1_partial").length;
  }
  return { events, timeline, exposureBySymbol };
}

function summarize(replay, m, label) {
  return {
    label,
    trades: m.totalTrades,
    returnPct: m.totalReturnPct,
    cagrPct: m.cagrPct,
    maxDdPct: m.maxDrawdownPct,
    calmar: m.calmar,
    pf: m.profitFactor,
    expectancy: m.expectancy,
    finalEquity: m.finalEquity,
    winRate: m.winRate,
  };
}

async function runPolicy({ events, timeline, sliceFrom, policy }) {
  if (policy === "null") {
    // Independent per-coin — sum returns (no shared compounding)
    let totalPnl = 0;
    let trades = 0;
    for (const sym of SYMBOLS) {
      const symEv = timeline.filter((e) => e.symbol === sym);
      totalPnl += symEv.reduce((s, e) => s + (Number(e.rawTrade?.netPnl) || 0), 0);
      trades += symEv.length;
    }
    return {
      label: "Null Policy",
      trades,
      returnPct: (totalPnl / START_USDT) * 100,
      finalEquity: START_USDT + totalPnl,
      maxDdPct: null,
      note: "Independent coin sims — no shared account",
    };
  }
  if (policy === "r_multiple") {
    const replay = portfolioReplay({
      events,
      startingUsdt: START_USDT,
      riskFrac: RISK_PCT / 100,
      startTs: sliceFrom,
    });
    const m = computeAllMetrics({
      trades: replay.trades,
      equityCurve: replay.equityCurve,
      tf: TF,
      startingEquity: START_USDT,
      fromMs: sliceFrom,
      toMs,
    });
    return summarize(replay, m, `R-multiple portfolio (${RISK_PCT}% risk)`);
  }
  const replay = portfolioSliceReplay({
    events: timeline,
    startingUsdt: START_USDT,
    coinCount: SYMBOLS.length,
    startTs: sliceFrom,
  });
  const m = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf: TF,
    startingEquity: START_USDT,
    fromMs: sliceFrom,
    toMs,
  });
  return {
    ...summarize(replay, m, "Equal-weight slice"),
    avgUtilizationPct: replay.trades.length
      ? (replay.trades.reduce((s, t) => s + (t.marginUsdt || 0), 0) / replay.trades.length / START_USDT) * 100
      : 0,
    maxConcurrentEstimate: SYMBOLS.length,
  };
}

const full = await collectEvents(fromMs, toMs);
const holdout = await collectEvents(holdoutMs, toMs);

const policies = {
  full: {
    null: await runPolicy({ ...full, sliceFrom: fromMs, policy: "null" }),
    equalWeight: await runPolicy({ ...full, sliceFrom: fromMs, policy: "equal_weight" }),
    rMultiple: await runPolicy({ ...full, sliceFrom: fromMs, policy: "r_multiple" }),
  },
  holdout: {
    null: await runPolicy({ ...holdout, sliceFrom: holdoutMs, policy: "null" }),
    equalWeight: await runPolicy({ ...holdout, sliceFrom: holdoutMs, policy: "equal_weight" }),
    rMultiple: await runPolicy({ ...holdout, sliceFrom: holdoutMs, policy: "r_multiple" }),
  },
};

const report = {
  generatedAt: new Date().toISOString(),
  phase: "3B",
  strategy: "SUPERTREND_ELITE",
  symbols: SYMBOLS,
  from: FROM,
  to: TO,
  holdoutFrom: new Date(holdoutMs).toISOString().slice(0, 10),
  startingUsdt: START_USDT,
  riskPct: RISK_PCT,
  nullPolicy: NULL_POLICY.description,
  exposureBySymbol: full.exposureBySymbol,
  policies,
};

const OUT_JSON = path.join(__dirname, ".research-phase3b-portfolio-sim.json");
const OUT_MD = path.join(__dirname, ".research-phase3b-portfolio-sim.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(d));
const lines = [
  "# Phase 3B Portfolio Simulator",
  "",
  `**SUPERTREND_ELITE** · ${SYMBOLS.join(", ")} · ${FROM} → ${TO}`,
  "",
  "## Full window",
  "",
  "| Policy | Return% | MaxDD% | Calmar | Trades | Final $ |",
  "|--------|---------|--------|--------|--------|---------|",
];
for (const p of Object.values(policies.full)) {
  lines.push(
    `| ${p.label} | ${fmt(p.returnPct)} | ${fmt(p.maxDdPct)} | ${fmt(p.calmar, 2)} | ${p.trades ?? "—"} | ${fmt(p.finalEquity, 0)} |`,
  );
}
lines.push("", "## Holdout (last 25%)", "", "| Policy | Return% | MaxDD% | Calmar | Trades |", "|--------|---------|--------|--------|--------|");
for (const p of Object.values(policies.holdout)) {
  lines.push(`| ${p.label} | ${fmt(p.returnPct)} | ${fmt(p.maxDdPct)} | ${fmt(p.calmar, 2)} | ${p.trades ?? "—"} |`);
}
fs.writeFileSync(OUT_MD, lines.join("\n"));
console.log(lines.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
