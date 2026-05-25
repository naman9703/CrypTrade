#!/usr/bin/env node
/**
 * Compare INTRADAY_PRO_15M vs INTRADAY_PRO_VP_15M on same window.
 * Usage: node scripts/backtest-intraday-vp-compare.mjs [SYMBOL] [TF] [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.argv[4] || "2026-01-01").getTime();
const toMs = new Date(process.argv[5] || "2026-05-18").getTime();
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { mergeAdaptiveCfg, selectIntradayPicks } = await import("../src/strategy/intradayPro.js");
const { INTRADAY_PRO_15M, INTRADAY_PRO_VP_15M } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
if (candles.length < 500) {
  console.error(`Not enough candles: ${candles.length}`);
  process.exit(1);
}

async function runOne(cfg, label) {
  const merged = mergeAdaptiveCfg(
    {
      ...cfg,
      marketMode: "FUTURES",
      strategyMode: "MANUAL",
      manualStrategy: "SR_INTRADAY",
      slippagePct: 0.0005,
    },
    candles,
  );
  const picks = selectIntradayPicks(candles, {
    maxTradesPerDay: merged.srIntradayMaxTradesPerDay,
    minScore: merged.srIntradayMinScore,
    minBarGap: merged.srIntradayMinBarGap,
    volumeProfileEnabled: merged.volumeProfileEnabled,
    volumeProfileGatesEnabled: merged.volumeProfileGatesEnabled,
    volumeProfileSoftGates: merged.volumeProfileSoftGates,
    intradayVpBrackets: merged.intradayVpBrackets,
    vpLookbackBars: merged.vpLookbackBars,
    vpMinRR: merged.vpMinRR,
    requireVpSetup: merged.requireVpSetup,
    intradayLearnedRulesEnabled: merged.intradayLearnedRulesEnabled,
    intradayTierMode: merged.intradayTierMode,
    requireFibOrVp: merged.intradayRequireFibOrVp !== false,
    requireSessionReclaim: merged.intradayRequireSessionReclaim !== false,
  });
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg: merged,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg: merged,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  const vpSetups = {};
  for (const t of sim.trades) {
    const s = t.vpSetup ?? t.meta?.vpSetup ?? "unknown";
    vpSetups[s] = (vpSetups[s] || 0) + 1;
  }
  return {
    label,
    picks: picks.pickedCount,
    candidates: picks.candidateCount,
    trades: m.totalTrades,
    wr: m.winRate,
    ret: m.totalReturnPct,
    pf: m.profitFactor,
    maxDd: m.maxDrawdownPct,
    tpm: (m.totalTrades / days) * 30,
    avgWin: m.avgWinPct,
    avgLoss: m.avgLossPct,
    vpSetups,
  };
}

console.log(`\n${symbol} ${tf}  ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}  (${days.toFixed(0)}d, ${candles.length} bars)\n`);

const results = [];
for (const [label, cfg] of [
  ["Pro (15M)", INTRADAY_PRO_15M],
  ["VP (15M)", INTRADAY_PRO_VP_15M],
]) {
  results.push(await runOne(cfg, label));
}

console.log("Config          | Picks | Cand | Trades | Tr/mo | WR%   | Return% | PF   | MaxDD%");
console.log("----------------|-------|------|--------|-------|-------|---------|------|-------");
for (const r of results) {
  console.log(
    `${r.label.padEnd(15)} | ${String(r.picks).padStart(5)} | ${String(r.candidates).padStart(4)} | ${String(r.trades).padStart(6)} | ${r.tpm.toFixed(1).padStart(5)} | ${(r.wr * 100).toFixed(1).padStart(5)} | ${r.ret.toFixed(2).padStart(7)} | ${r.pf.toFixed(2).padStart(4)} | ${r.maxDd.toFixed(2).padStart(6)}`,
  );
}

console.log("\nSignal filter impact (picks vs executed trades):");
for (const r of results) {
  console.log(`  ${r.label}: ${r.picks} picks → ${r.trades} closed trades`);
}

await closePool?.();
