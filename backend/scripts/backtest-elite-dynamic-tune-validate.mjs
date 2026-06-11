#!/usr/bin/env node
/**
 * Validate profile-driven Elite auto-tune vs legacy AUTO (ADX-only) across coins.
 *
 * Usage (from backend/):
 *   node scripts/backtest-elite-dynamic-tune-validate.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-10";
const SYMBOLS = (process.env.SYMBOLS ||
  "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,TRXUSDT,INJUSDT,TIAUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

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
const { SUPERTREND_ELITE_AUTO_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

async function runSym(sym, legacy = false) {
  const candles = await readCandles(sym, "1h", fromMs, toMs, { market: "futures" });
  if (!candles.length) return null;
  const preset = {
    ...SUPERTREND_ELITE_AUTO_1H_PRESET,
    eliteStAutoFullTune: !legacy,
    ...(legacy ? { eliteStHtf1hSepMode: "ADX", supertrendMultiplier: 3, eliteStHtf4hMultiplier: 3 } : {}),
  };
  const cfg = prepareEliteRunCfg(
    { ...preset, symbol: sym, riskPerTrade: 5, futuresLeverage: 10 },
    sym,
    candles,
  );
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: "1h",
    adapters: {
      SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(cfg)),
    },
    symbol: sym,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "1h",
    startingEquity: 1000,
  });
  const n = sim.trades.filter((t) => t.exitReason !== "tp1_partial").length;
  const tuning = cfg._eliteDynamicTuning ?? {};
  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    n,
    sep: cfg.eliteStHtf1hSepMode,
    stM: cfg.supertrendMultiplier,
    tuning,
  };
}

console.log(`\nElite dynamic auto-tune validation  ${FROM} → ${TO}\n`);
console.log(
  `${"Symbol".padEnd(10)}${"Legacy%".padStart(9)}${"Dynamic%".padStart(10)}${"Lift".padStart(8)}${"Sep".padStart(12)}${"ST m".padStart(6)}`,
);
console.log("-".repeat(58));

let legSum = 0;
let dynSum = 0;
let legPos = 0;
let dynPos = 0;
let n = 0;

for (const sym of SYMBOLS) {
  const leg = await runSym(sym, true);
  const dyn = await runSym(sym, false);
  if (!leg || !dyn) continue;
  n++;
  legSum += leg.ret;
  dynSum += dyn.ret;
  if (leg.ret > 0) legPos++;
  if (dyn.ret > 0) dynPos++;
  console.log(
    `${sym.padEnd(10)}${leg.ret.toFixed(1).padStart(9)}${dyn.ret.toFixed(1).padStart(10)}${(dyn.ret - leg.ret).toFixed(1).padStart(8)}${String(dyn.sep).padStart(12)}${String(dyn.stM).padStart(6)}`,
  );
}

console.log("-".repeat(58));
console.log(
  `Avg ret: legacy ${(legSum / n).toFixed(1)}%  dynamic ${(dynSum / n).toFixed(1)}%  |  profitable ${legPos}→${dynPos}/${n}`,
);

await closePool?.().catch(() => {});
process.exit(0);
