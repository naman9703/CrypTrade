#!/usr/bin/env node
/**
 * LINKUSDT SUPERTREND_ELITE 1H tune + validation.
 *
 * Usage (from backend/):
 *   node scripts/backtest-elite-link-tune.mjs
 *   FROM=2025-06-01 TO=2026-06-10 RISK=5 LEV=10 node scripts/backtest-elite-link-tune.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYM = "LINKUSDT";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-10";
const RISK = Number(process.env.RISK || 5);
const LEV = Number(process.env.LEV || 10);
const START = Number(process.env.START || 1000);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  prepareEliteRunCfg,
} = await import("../src/strategy/supertrendElite.js");
const {
  SUPERTREND_ELITE_AUTO_1H_PRESET,
  SUPERTREND_ELITE_LINK_1H_PRESET,
  SUPERTREND_ELITE_ADX_1H_PRESET,
} = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const candles = await readCandles(SYM, "1h", fromMs, toMs, { market: "futures" });
if (!candles.length) {
  console.error("No candles — check DB / date range");
  process.exit(1);
}

async function run(label, preset, slice = candles) {
  const cfg = prepareEliteRunCfg(
    { ...preset, riskPerTrade: RISK, futuresLeverage: LEV },
    SYM,
    slice,
  );
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: "1h",
    adapters: {
      SUPERTREND_ELITE: buildEliteStBacktestAdapter(slice, buildEliteStOptsFromCfg(cfg)),
    },
    symbol: SYM,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "1h",
    startingEquity: START,
  });
  const trades = sim.trades.filter((t) => t.exitReason !== "tp1_partial");
  const liq = trades.filter((t) => t.exitReason === "liq").length;
  return {
    label,
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRatePct ?? m.winRate ?? 0),
    n: trades.length,
    liq,
    stM: cfg.supertrendMultiplier,
    h4M: cfg.eliteStHtf4hMultiplier,
    sep: cfg.eliteStHtf1hSepMode,
  };
}

function fmt(n, d = 1) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

console.log(`\nLINKUSDT SUPERTREND_ELITE tune`);
console.log(`Window: ${FROM} → ${TO}  |  ${candles.length} bars  |  Risk ${RISK}%  Lev ${LEV}×  Start $${START}\n`);

const h2End = new Date("2026-01-01").getTime();
const h2 = candles.filter((c) => c.ts < h2End);
const h1 = candles.filter((c) => c.ts >= h2End);

const configs = [
  ["AUTO default", SUPERTREND_ELITE_AUTO_1H_PRESET],
  ["LINK tuned (AUTO m3.5)", SUPERTREND_ELITE_LINK_1H_PRESET],
  ["ADX sep only", SUPERTREND_ELITE_ADX_1H_PRESET],
];

for (const [sliceName, slice] of [
  ["Full window", candles],
  ["H2 2025 (train)", h2],
  ["2026 H1 (OOS)", h1],
]) {
  console.log(`── ${sliceName} ──`);
  console.log(
    `${"Config".padEnd(22)}${"Ret%".padStart(8)}${"DD%".padStart(8)}${"PF".padStart(7)}${"Tr".padStart(5)}${"Liq".padStart(5)}${"ST m".padStart(6)}`,
  );
  for (const [label, preset] of configs) {
    const r = await run(label, preset, slice);
    console.log(
      `${r.label.padEnd(22)}${fmt(r.ret).padStart(8)}${fmt(r.dd).padStart(8)}${fmt(r.pf, 2).padStart(7)}${String(r.n).padStart(5)}${String(r.liq).padStart(5)}${fmt(r.stM, 1).padStart(6)}`,
    );
  }
  console.log();
}

// ST multiplier sweep on AUTO
console.log("── ST multiplier sweep (AUTO calibrate) ──");
for (const m of [3, 3.5, 4]) {
  const r = await run(
    `AUTO m${m}`,
    { ...SUPERTREND_ELITE_AUTO_1H_PRESET, supertrendMultiplier: m, eliteStHtf4hMultiplier: m },
  );
  console.log(`  m=${m}: ret ${fmt(r.ret)}%  DD ${fmt(r.dd)}%  PF ${fmt(r.pf, 2)}  ${r.n} trades`);
}

await closePool?.().catch(() => {});
process.exit(0);
