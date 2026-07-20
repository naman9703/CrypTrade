#!/usr/bin/env node
/**
 * Accurate SR_INTRADAY liquidity sweep+reclaim backtest — baseline vs informational context filter.
 *
 * Preset: INTRADAY_PRO_LIQ_15M (PDH/PDL classical sweep+reclaim, partial @ 1R + opposing pool TP2).
 * Full runSimulation (fees, slippage, funding, liquidity brackets).
 *
 * Usage:
 *   cd backend && node scripts/backtest-liq-context-filter.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const TF = process.env.TF || "15m";
const RISK_PCT = Number(process.env.RISK_PCT || 2);
const START_USDT = Number(process.env.START_USDT || 10_000);
const HOLDOUT_FRAC = Number(process.env.HOLDOUT_FRAC || 0.25);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);
const warmupMs = 21 * 86_400_000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { portfolioReplay, tradesToREvents } = await import("../src/backtest/engine/portfolioReplay.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const {
  ensureObservableData,
  loadObservableSeries,
  observableFeaturesAt,
} = await import("../src/backtest/data/observableFeatures.js");
const {
  buildIntradayContextFilterHook,
  LIQ_CONTEXT_EDGE_V1,
} = await import("../src/backtest/engine/liqContextFilter.js");

function cfgFor(sym) {
  return materializeIntradayEngineCfgSync(
    {
      ...INTRADAY_PRO_LIQ_15M,
      symbol: sym,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      strategyMode: "MANUAL",
      riskPerTrade: RISK_PCT,
      slippagePct: 0.0005,
      trailingStopLossAuto: false,
    },
    materializeIntradayPanelOnCfg,
  );
}

function closedTrades(sim) {
  return (sim.trades || []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
}

function metricsFor(sim, sliceFrom, sliceTo) {
  const all = closedTrades(sim);
  const sliceTrades = all.filter((t) => {
    const ts = Number(t.entryTs);
    return ts >= sliceFrom && ts < sliceTo;
  });
  const eq = (sim.equityCurve || []).filter((p) => p.ts >= sliceFrom && p.ts <= sliceTo);
  const fullM = computeAllMetrics({
    trades: all,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START_USDT,
  });
  const sliceM = computeAllMetrics({
    trades: sliceTrades,
    equityCurve: eq.length ? eq : sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START_USDT,
  });
  const fullR = rMultipleStats(all);
  const sliceR = rMultipleStats(sliceTrades);
  return {
    full: {
      trades: fullM.totalTrades,
      returnPct: fullM.totalReturnPct,
      cagrPct: fullM.cagrPct,
      maxDdPct: fullM.maxDrawdownPct,
      calmar: fullM.calmar,
      winRate: fullM.winRate,
      pf: fullM.profitFactor,
      expectancy: fullM.expectancy,
      expectancyR: fullR.meanR,
    },
    slice: {
      trades: sliceM.totalTrades,
      returnPct: sliceM.totalReturnPct,
      maxDdPct: sliceM.maxDrawdownPct,
      winRate: sliceM.winRate,
      pf: sliceM.profitFactor,
      expectancy: sliceM.expectancy,
      expectancyR: sliceR.meanR,
    },
  };
}

async function runCoin(sym, filterId) {
  process.stdout.write(`  ${sym} [${filterId}] sync + sim...\n`);
  await ensureObservableData(sym, fromMs, toMs);
  const loaded = await loadObservableSeries(sym, fromMs, toMs);
  const obsSeries = {
    observableAt: (ts) =>
      observableFeaturesAt(
        { binance: loaded.binance, bybit: loaded.bybit, coinalyze: loaded.coinalyze },
        ts,
      ),
  };
  const candles = await readCandles(sym, TF, fromMs - warmupMs, toMs, { market: "futures" });
  if (!candles?.length) return { error: "no_candles" };
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs - warmupMs, toMs);
  } catch {
    funding = [];
  }
  clearIntradayAdapterCache();
  let cfg = cfgFor(sym);
  cfg = mergeAdaptiveCfg(cfg, candles);
  const entryFilter = buildIntradayContextFilterHook(obsSeries, filterId);
  const hooks = entryFilter ? { entryFilter } : {};
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF, hooks);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter },
    symbol: sym,
  });
  return {
    filterId,
    symbol: sym,
    train: metricsFor(sim, fromMs, holdoutMs),
    holdout: metricsFor(sim, holdoutMs, toMs),
    full: metricsFor(sim, fromMs, toMs),
    _trades: closedTrades(sim),
  };
}

function portfolioSummary(runs, sliceFrom, sliceTo) {
  const events = [];
  for (const r of runs) {
    if (!r?.symbol) continue;
    const symEv = tradesToREvents(
      r.symbol,
      (r._trades || []).filter((t) => {
        const ts = Number(t.entryTs);
        return ts >= sliceFrom && ts < sliceTo;
      }),
      RISK_PCT,
    );
    events.push(...symEv);
  }
  events.sort((a, b) => a.ts - b.ts);
  if (!events.length) {
    return { trades: 0, returnPct: 0, maxDdPct: 0, winRate: 0, pf: 0, expectancyR: 0 };
  }
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
  });
  const rstats = rMultipleStats(replay.trades);
  return {
    trades: m.totalTrades,
    returnPct: ((replay.finalEquity - START_USDT) / START_USDT) * 100,
    maxDdPct: replay.maxDrawdownPct ?? m.maxDrawdownPct,
    winRate: (m.winRate ?? 0) * (m.winRate <= 1 ? 100 : 1),
    pf: m.profitFactor,
    expectancyR: rstats.meanR,
    finalEquity: replay.finalEquity,
  };
}

const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(d));
const wrPct = (wr) => (wr == null ? 0 : wr <= 1 ? wr * 100 : wr);

console.log(`\n=== SR_INTRADAY Liquidity Sweep+Reclaim — Baseline vs Context Filter ===`);
console.log(`Preset: INTRADAY_PRO_LIQ_15M`);
console.log(`${FROM} → ${TO} | ${COINS.join(", ")} | ${TF} | risk ${RISK_PCT}%`);
console.log(`Filter: ${LIQ_CONTEXT_EDGE_V1.label}\n`);

const report = {
  generatedAt: new Date().toISOString(),
  strategy: "SR_INTRADAY",
  preset: "INTRADAY_PRO_LIQ_15M",
  from: FROM,
  to: TO,
  coins: COINS,
  riskPct: RISK_PCT,
  filter: LIQ_CONTEXT_EDGE_V1,
  perCoin: {},
  portfolio: {},
};

for (const sym of COINS) {
  const baseline = await runCoin(sym, "none");
  const filtered = await runCoin(sym, "edge_v1");
  report.perCoin[sym] = { baseline, filtered };
  console.log(
    `${sym} baseline: trades=${baseline.full?.full?.trades ?? 0} ret=${fmt(baseline.full?.full?.returnPct)}% WR=${fmt(wrPct(baseline.full?.full?.winRate), 0)}%`,
  );
  console.log(
    `${sym} filtered: trades=${filtered.full?.full?.trades ?? 0} ret=${fmt(filtered.full?.full?.returnPct)}% WR=${fmt(wrPct(filtered.full?.full?.winRate), 0)}%`,
  );
}

for (const label of ["baseline", "filtered"]) {
  const runs = COINS.map((s) => report.perCoin[s][label === "baseline" ? "baseline" : "filtered"]);
  report.portfolio[label] = {
    full: portfolioSummary(runs, fromMs, toMs),
    holdout: portfolioSummary(runs, holdoutMs, toMs),
    train: portfolioSummary(runs, fromMs, holdoutMs),
  };
}

const md = [
  "# SR_INTRADAY Liquidity Sweep+Reclaim — Baseline vs Context Filter",
  "",
  `**Strategy:** SR_INTRADAY | **Preset:** INTRADAY_PRO_LIQ_15M (PDH/PDL sweep+reclaim)`,
  `**Window:** ${FROM} → ${TO} | **Coins:** ${COINS.join(", ")} | **TF:** ${TF} | **Risk:** ${RISK_PCT}%`,
  "",
  `**Context filter (\`edge_v1\`):** ${LIQ_CONTEXT_EDGE_V1.label}`,
  "",
  "- Skip if Bybit OI −4h < −3%",
  "- **Long only** if prior-day short liq > long liq (Coinalyze)",
  "- **Long only** if funding z-score < 0",
  "",
  "Full `runSimulation`: liquidity brackets (SL beyond wick, TP1 @ 1R partial, TP2 opposing pool), slippage, funding.",
  "",
  "## Per coin (full year)",
  "",
  "| Coin | Mode | Trades | Return% | MaxDD% | WR% | PF | ExpR |",
  "|------|------|--------|---------|--------|-----|-----|------|",
];

for (const sym of COINS) {
  for (const [mode, key] of [
    ["Baseline", "baseline"],
    ["+ Context", "filtered"],
  ]) {
    const r = report.perCoin[sym][key].full?.full ?? {};
    md.push(
      `| ${sym} | ${mode} | ${r.trades ?? "—"} | ${fmt(r.returnPct)} | ${fmt(r.maxDdPct)} | ${fmt(wrPct(r.winRate), 0)} | ${fmt(r.pf, 2)} | ${fmt(r.expectancyR, 3)} |`,
    );
  }
}

const pb = report.portfolio.baseline;
const pf = report.portfolio.filtered;
md.push(
  "",
  "## Portfolio (shared account, R-multiple compounding)",
  "",
  "| Mode | Period | Trades | Return% | MaxDD% | WR% | PF | ExpR |",
  "|------|--------|--------|---------|--------|-----|-----|------|",
  `| Baseline | Full | ${pb.full.trades} | ${fmt(pb.full.returnPct)} | ${fmt(pb.full.maxDdPct)} | ${fmt(pb.full.winRate, 0)} | ${fmt(pb.full.pf, 2)} | ${fmt(pb.full.expectancyR, 3)} |`,
  `| + Context | Full | ${pf.full.trades} | ${fmt(pf.full.returnPct)} | ${fmt(pf.full.maxDdPct)} | ${fmt(pf.full.winRate, 0)} | ${fmt(pf.full.pf, 2)} | ${fmt(pf.full.expectancyR, 3)} |`,
  `| Baseline | Train (75%) | ${pb.train.trades} | ${fmt(pb.train.returnPct)} | ${fmt(pb.train.maxDdPct)} | ${fmt(pb.train.winRate, 0)} | ${fmt(pb.train.pf, 2)} | ${fmt(pb.train.expectancyR, 3)} |`,
  `| + Context | Train (75%) | ${pf.train.trades} | ${fmt(pf.train.returnPct)} | ${fmt(pf.train.maxDdPct)} | ${fmt(pf.train.winRate, 0)} | ${fmt(pf.train.pf, 2)} | ${fmt(pf.train.expectancyR, 3)} |`,
  `| Baseline | Holdout (25%) | ${pb.holdout.trades} | ${fmt(pb.holdout.returnPct)} | ${fmt(pb.holdout.maxDdPct)} | ${fmt(pb.holdout.winRate, 0)} | ${fmt(pb.holdout.pf, 2)} | ${fmt(pb.holdout.expectancyR, 3)} |`,
  `| + Context | Holdout (25%) | ${pf.holdout.trades} | ${fmt(pf.holdout.returnPct)} | ${fmt(pf.holdout.maxDdPct)} | ${fmt(pf.holdout.winRate, 0)} | ${fmt(pf.holdout.pf, 2)} | ${fmt(pf.holdout.expectancyR, 3)} |`,
);

// Strip _trades before JSON write
const jsonReport = JSON.parse(
  JSON.stringify(report, (k, v) => (k === "_trades" ? undefined : v)),
);

const OUT_JSON = path.join(__dirname, ".backtest-liq-context-filter.json");
const OUT_MD = path.join(__dirname, ".backtest-liq-context-filter.md");
fs.writeFileSync(OUT_JSON, JSON.stringify(jsonReport, null, 2));
fs.writeFileSync(OUT_MD, md.join("\n"));
console.log("\n" + md.join("\n"));
console.log(`\nWrote ${OUT_JSON}`);
await closePool();
