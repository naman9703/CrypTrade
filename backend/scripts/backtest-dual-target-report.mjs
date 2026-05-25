#!/usr/bin/env node
/**
 * Report: configs with WR>=80% and return>=1000% (or best WR>=80% by return).
 * Requires DB + ohlcv_candles (docker compose -f docker-compose.db.yml up -d).
 *
 *   node scripts/backtest-dual-target-report.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MIN_WR = 80;
const MIN_RET = 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) {
  await initPool({ info: () => {}, warn: () => {}, error: console.error });
}

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const {
  SUPERTREND_INTEL_80WR_PRESET,
  SUPERTREND_INTEL_80WR_WIDE_SL_PRESET,
} = await import("../src/strategy/presets/supertrendIntel80Wr.js");

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-20").getTime();

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const gateFn = await buildIntelligenceReplay({
  symbol,
  fromMs,
  toMs,
  candles,
  timeframe: tf,
  strictMode: false,
});

async function test(label, cfg) {
  const full = { symbol, timeframe: tf, marketMode: "FUTURES", ...cfg };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SUPERTREND",
    cfg: full,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SUPERTREND",
    candles,
    cfg: full,
    gateMode: "approx",
    gateFn,
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
  const wr = (m.winRate ?? 0) * 100;
  const ret = m.totalReturnPct ?? 0;
  const exits = {};
  for (const t of sim.trades) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  return { label, wr, ret, n: m.totalTrades ?? 0, pf: m.profitFactor, exits, cfg: full };
}

const presets = [
  ["80WR default", SUPERTREND_INTEL_80WR_PRESET],
  ["80WR wide SL", SUPERTREND_INTEL_80WR_WIDE_SL_PRESET],
];

const rows = [];
for (const [label, cfg] of presets) {
  rows.push(await test(label, cfg));
}

const dualHits = rows.filter((r) => r.wr >= MIN_WR && r.ret >= MIN_RET && r.n >= 5);
const wr80 = rows.filter((r) => r.wr >= MIN_WR && r.n >= 5).sort((a, b) => b.ret - a.ret);

console.log(`\n=== ${symbol} ${tf} Jan–May 2026 ===\n`);
for (const r of rows) {
  const ok = r.wr >= MIN_WR && r.ret >= MIN_RET ? "★ DUAL" : r.wr >= MIN_WR ? "WR ok" : "";
  console.log(
    `${ok} ${r.label}: ${r.n} trades WR ${r.wr.toFixed(1)}% ret ${r.ret.toFixed(1)}% PF ${(r.pf ?? 0).toFixed(2)} exits ${JSON.stringify(r.exits)}`,
  );
}

console.log(`\nDual target (WR≥${MIN_WR}% & ret≥${MIN_RET}%): ${dualHits.length} hit(s)`);
if (wr80[0]) {
  console.log(`\nBest WR≥${MIN_WR}%: ${wr80[0].label} → ret ${wr80[0].ret.toFixed(1)}%`);
  console.log("\nApply via Trading tab → ★ ST + Intel 80% WR, or botConfig:");
  console.log(JSON.stringify(wr80[0].cfg, null, 2));
}

await closePool?.();
