#!/usr/bin/env node
/**
 * Compare legacy vs strict session liquidity sweep on BNB 15m.
 * Usage: npm run backtest:liq-strict -- BNBUSDT 2026-05-19 2026-05-27
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = (process.argv[2] || "BNBUSDT").toUpperCase();
const fromMs = Date.parse(`${process.argv[3] || "2026-05-19"}T00:00:00.000Z`);
const toMs = Date.parse(`${process.argv[4] || "2026-05-27"}T00:00:00.000Z`);
const tf = "15m";

if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
  console.error("Invalid dates");
  process.exit(1);
}

const { INTRADAY_PRO_LIQ_15M, fillLiqSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectIntradayPicks } = await import("../src/strategy/intradayPro.js");

if (!getPool?.()) {
  await initPool({ info: () => {}, warn: () => {}, error: console.error });
}

const warmupFrom = fromMs - 5 * 86_400_000;
await ensureKlines(symbol, tf, { from: warmupFrom, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, warmupFrom, toMs);

async function runLabel(cfg, label) {
  const merged = fillLiqSoloPresetDefaults({
    ...INTRADAY_PRO_LIQ_15M,
    ...cfg,
    symbol,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
  });
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg: merged,
    symbol,
    tf,
    candles,
    fromMs: warmupFrom,
  });
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
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
  return {
    label,
    trades: m.totalTrades ?? sim.trades.length,
    winRate: (m.winRate ?? 0) * 100,
    totalReturnPct: m.totalReturnPct ?? 0,
    profitFactor: m.profitFactor ?? 0,
    maxDrawdownPct: Math.abs(m.maxDrawdownPct ?? 0),
    tradeList: sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs),
  };
}

const strictCfg = { ...INTRADAY_PRO_LIQ_15M, intradayLiqStrictMode: true };
const legacyCfg = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqStrictMode: false,
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0.012,
};

const strictSignals = selectIntradayPicks(candles, strictCfg);
const legacySignals = selectIntradayPicks(candles, legacyCfg);

const inRange = (ts) => ts >= fromMs && ts < toMs;
const listSignals = (picks, label) => {
  const rows = [];
  for (let i = 0; i < candles.length; i++) {
    const sig = picks.series[i];
    if (!sig || !inRange(candles[i].ts)) continue;
    rows.push({
      time: new Date(candles[i].ts).toISOString(),
      side: sig.action,
      techniques: sig.techniques?.join("+"),
      sl: sig.liqBrackets?.slPrice,
      tp: sig.liqBrackets?.tpPrice,
      level: sig.liqBrackets?.level,
    });
  }
  console.log(`\n${label} signals (${rows.length}):`);
  for (const r of rows) console.log(" ", r.time.slice(0, 16), r.side, r.techniques, "SL", r.sl, "TP", r.tp);
};

listSignals(strictSignals, "STRICT");
listSignals(legacySignals, "LEGACY (micro-swing)");

const results = await Promise.all([
  runLabel(strictCfg, "strict_session_liq"),
  runLabel(legacyCfg, "legacy_micro_swing"),
]);

console.log("\n=== BACKTEST RESULTS ===");
for (const r of results) {
  console.log(
    `${r.label}: trades=${r.trades} WR=${r.winRate?.toFixed?.(1)}% ret=${r.totalReturnPct?.toFixed?.(2)}% PF=${r.profitFactor?.toFixed?.(2)} maxDD=${r.maxDrawdownPct?.toFixed?.(2)}%`,
  );
  for (const t of r.tradeList || []) {
    const pnl = t.pnlPct != null ? `${(t.pnlPct * 100).toFixed(2)}%` : "—";
    console.log(
      `  ${new Date(t.entryTs).toISOString().slice(0, 16)} ${t.side} entry=${t.entryPrice?.toFixed?.(2)} SL=${t.slPrice?.toFixed?.(2)} TP=${t.tpPrice?.toFixed?.(2)} → ${t.exitReason} ${pnl}`,
    );
  }
}

await closePool?.();
