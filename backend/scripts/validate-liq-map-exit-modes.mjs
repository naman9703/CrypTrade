#!/usr/bin/env node
/**
 * Validate LIQUIDITY_MAP exit models (PARTIAL_RUNNER vs SCALED_FIXED) through the
 * REAL backtest runner with realistic costs — not the research harness.
 *
 * Usage:
 *   SYMBOL=BTCUSDT TF=15m FROM=2026-01-01 TO=2026-06-01 \
 *     node scripts/validate-liq-map-exit-modes.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").trim();
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 10_000);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { LIQUIDITY_MAP_BTC_15M_PRESET, normalizeLiquidityMapRunCfg } = await import(
  "../src/strategy/liquidityMapStrategy.js"
);

const candles = await readCandles(SYMBOL, TF, fromMs - 10 * 86_400_000, toMs);
if (!candles.length) {
  console.error(`[validate] no candles for ${SYMBOL} ${TF}`);
  await closePool?.();
  process.exit(1);
}
const windowCandles = candles.filter((c) => c.ts >= fromMs && c.ts < toMs);

console.log(`\n=== LIQUIDITY_MAP exit-model validation ===`);
console.log(`${SYMBOL} ${TF} ${FROM}->${TO}  bars=${windowCandles.length}  days=${days.toFixed(0)}\n`);

const strategyKey = "LIQUIDITY_MAP";
const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "n/a");

for (const exitMode of ["PARTIAL_RUNNER", "SCALED_FIXED"]) {
  const baseCfg = {
    ...LIQUIDITY_MAP_BTC_15M_PRESET,
    symbol: SYMBOL,
    timeframe: TF,
    liqMapExitMode: exitMode,
  };
  const cfg = { ...baseCfg, ...normalizeLiquidityMapRunCfg(baseCfg) };
  const fromMsAdapter = Number(candles[0]?.ts) || fromMs;
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: fromMsAdapter,
  });

  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });

  const windowTrades = (sim.trades || []).filter((t) => {
    const ts = Number(t.entryTs ?? t.tsEntry ?? t.ts ?? 0);
    return ts >= fromMs && ts < toMs;
  });
  const metrics = computeAllMetrics({
    trades: windowTrades.length ? windowTrades : sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });

  const trades = windowTrades.length || (sim.trades || []).length;
  const exits = (windowTrades.length ? windowTrades : sim.trades || []).reduce((m, t) => {
    const r = String(t.exitReason ?? t.reason ?? "?");
    m[r] = (m[r] || 0) + 1;
    return m;
  }, {});

  console.log(`--- ${exitMode} ---`);
  console.log(
    `  trades=${trades}  /day=${num(trades / days)}  ret%=${num(metrics.totalReturnPct)}  ` +
      `WR%=${num((metrics.winRate ?? 0) * 100)}  PF=${num(metrics.profitFactor)}  ` +
      `maxDD%=${num(metrics.maxDrawdownPct)}  expectancyR=${num(metrics.expectancyR, 3)}`,
  );
  console.log(`  exits=${JSON.stringify(exits)}\n`);
}

await closePool?.();
