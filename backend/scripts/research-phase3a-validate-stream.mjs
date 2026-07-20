#!/usr/bin/env node
/**
 * Phase 3A — validate one strategy stream (fixed rules, holdout gates).
 *
 * Usage:
 *   cd backend && node scripts/research-phase3a-validate-stream.mjs --strategy SUPERTREND_ELITE
 *   node scripts/research-phase3a-validate-stream.mjs --strategy SCALP_MR --symbols BNBUSDT --tf 5m
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const STRATEGY = arg("--strategy", "SUPERTREND_ELITE");
const SYMBOLS = arg("--symbols", "BTCUSDT,BNBUSDT,ETHUSDT").split(",").map((s) => s.trim());
const TF = arg("--tf", STRATEGY === "SCALP_MR" ? "5m" : "15m");
const FROM = arg("--from", "2025-01-01");
const TO = arg("--to", "2026-06-01");
const RISK_PCT = Number(arg("--risk", "2"));
const HOLDOUT_FRAC = Number(arg("--holdout-frac", "0.25"));

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const splitMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  normalizeEliteStRunCfg,
  applyEliteStExitContract,
} = await import(
  "../src/strategy/supertrendElite.js",
);
const { resolveScalpMrCfg, buildScalpMrBacktestAdapter, scalpMrPadFromMs } = await import("../src/strategy/scalpMr.js");
const { SCALP_MR_5M_BASE } = await import("../src/strategy/presets/scalpMrOptimized.js");
const { TREND_PULLBACK_SCALP_OPTIMIZED } = await import("../src/strategy/presets/trendPullbackScalpOptimized.js");
const { acceptanceGates } = await import("../src/backtest/engine/validation.js");
const { monteCarloBootstrap } = await import("../src/backtest/engine/validation.js");
const { rMultipleStats } = await import("../src/backtest/engine/metrics.js");

function buildCfg(sym) {
  if (STRATEGY === "SUPERTREND_ELITE") {
    return applyEliteStExitContract(normalizeEliteStRunCfg({
      symbol: sym,
      timeframe: TF,
      manualStrategy: "SUPERTREND_ELITE",
      strategyMode: "MANUAL",
      marketMode: "FUTURES",
      futuresLeverage: 25,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTrade: RISK_PCT,
      riskPerTradeUnit: "PCT",
      slippagePct: 0.0005,
      supertrendWilderAtr: true,
      supertrendPeriod: 10,
      supertrendMultiplier: 3.0,
      eliteStRequireHtf4hAlign: true,
      eliteStRequireHtf1hEmaAlign: true,
      eliteStMinAdx: 20,
      eliteStRequireAdxRising: true,
      eliteStMinVolumeVsAvg: 1.5,
      eliteStRequireAtrExpansion: true,
    }));
  }
  if (STRATEGY === "SCALP_MR") {
    return resolveScalpMrCfg({ ...SCALP_MR_5M_BASE, symbol: sym, timeframe: TF });
  }
  if (STRATEGY === "TREND_PULLBACK") {
    return { ...TREND_PULLBACK_SCALP_OPTIMIZED, symbol: sym, timeframe: TF };
  }
  throw new Error(`unknown_strategy:${STRATEGY}`);
}

async function runWindow(sym, sliceFrom, sliceTo) {
  const padFrom =
    STRATEGY === "SCALP_MR" ? scalpMrPadFromMs(sliceFrom, TF) : sliceFrom;
  const candles = await readCandles(sym, TF, padFrom, sliceTo, { market: "futures" });
  if (!candles?.length) return null;
  const slice = candles.filter((c) => c.ts >= sliceFrom && c.ts < sliceTo);
  if (slice.length < 80) return null;
  let funding = [];
  try {
    funding = await readFundingRates(sym, sliceFrom, sliceTo);
  } catch {
    funding = [];
  }
  const cfg = buildCfg(sym);
  let adapters;
  if (STRATEGY === "SUPERTREND_ELITE") {
    adapters = { SUPERTREND_ELITE: buildEliteStBacktestAdapter(slice, buildEliteStOptsFromCfg(cfg)) };
  } else {
    adapters = await buildBacktestAdapters({
      strategyKey: STRATEGY,
      cfg,
      symbol: sym,
      tf: TF,
      candles: slice,
      fromMs: sliceFrom,
    });
  }
  const sim = await runSimulation({
    strategyKey: STRATEGY,
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 10_000,
    timeframe: TF,
    adapters,
    symbol: sym,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 10_000,
  });
  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 2000, riskFrac: RISK_PCT / 100 });
  return { sim, m, mc, rstats };
}

const report = {
  generatedAt: new Date().toISOString(),
  phase: "3A",
  strategy: STRATEGY,
  symbols: SYMBOLS,
  tf: TF,
  from: FROM,
  to: TO,
  holdoutFrac: HOLDOUT_FRAC,
  riskPct: RISK_PCT,
  coins: {},
  portfolio: { research: null, holdout: null },
};

let researchRetSum = 0;
let holdoutRetSum = 0;

for (const sym of SYMBOLS) {
  const research = await runWindow(sym, fromMs, splitMs);
  const holdout = await runWindow(sym, splitMs, toMs);
  if (!research && !holdout) {
    report.coins[sym] = { error: "no_data" };
    continue;
  }
  const gates = holdout
    ? acceptanceGates({
        oosReturnPct: holdout.m.totalReturnPct ?? 0,
        mcP5ReturnPct: holdout.mc.p5ReturnPct ?? 0,
        calmar: holdout.m.calmar ?? 0,
        wfDegradationPct: 0,
      })
    : null;
  report.coins[sym] = {
    research: research
      ? {
          trades: research.m.totalTrades,
          returnPct: research.m.totalReturnPct,
          maxDdPct: research.m.maxDrawdownPct,
          pf: research.m.profitFactor,
          expectancy: research.m.expectancy,
        }
      : null,
    holdout: holdout
      ? {
          trades: holdout.m.totalTrades,
          returnPct: holdout.m.totalReturnPct,
          maxDdPct: holdout.m.maxDrawdownPct,
          pf: holdout.m.profitFactor,
          expectancy: holdout.m.expectancy,
          gates,
          passes: gates?.allPass ?? false,
        }
      : null,
  };
  if (research?.m?.totalReturnPct) researchRetSum += research.m.totalReturnPct;
  if (holdout?.m?.totalReturnPct) holdoutRetSum += holdout.m.totalReturnPct;
}

report.portfolio = {
  researchReturnPctSum: researchRetSum,
  holdoutReturnPctSum: holdoutRetSum,
  streamStatus:
    holdoutRetSum > 0 ? "holdout_positive" : holdoutRetSum === 0 ? "flat" : "holdout_negative",
};

const OUT_JSON = path.join(__dirname, `.research-phase3a-${STRATEGY.toLowerCase()}.json`);
const OUT_MD = path.join(__dirname, `.research-phase3a-${STRATEGY.toLowerCase()}.md`);
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

const lines = [
  `# Phase 3A Stream Validation — ${STRATEGY}`,
  "",
  `Window: ${FROM} → ${TO} | Holdout: last ${(HOLDOUT_FRAC * 100).toFixed(0)}% | Risk: ${RISK_PCT}%`,
  "",
  "| Symbol | Holdout ret% | PF | MaxDD% | Gates |",
  "|--------|--------------|-----|--------|-------|",
];
for (const [sym, row] of Object.entries(report.coins)) {
  const h = row.holdout;
  if (!h) {
    lines.push(`| ${sym} | — | — | — | no data |`);
    continue;
  }
  lines.push(
    `| ${sym} | ${h.returnPct?.toFixed(1) ?? "—"} | ${h.pf?.toFixed(2) ?? "—"} | ${h.maxDdPct?.toFixed(1) ?? "—"} | ${h.passes ? "✅" : "❌"} |`,
  );
}
lines.push("", `**Portfolio holdout sum return:** ${holdoutRetSum.toFixed(1)}%`, `**Status:** ${report.portfolio.streamStatus}`);
fs.writeFileSync(OUT_MD, lines.join("\n"));
console.log(lines.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
