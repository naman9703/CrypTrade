#!/usr/bin/env node
/**
 * ETH 2021–22 Phase 4 — ONE change A/B (process-compliant).
 *
 * H1 only: abstain SELL VAL when prior60d>+5% AND prior20d≤−5%
 * (dump-into-residual-bull). From 2026-07-18 regime autopsy.
 *
 * Baseline = ABC adaptive stack (surgical nonVac OFF).
 * Do not stack H2 in this script.
 *
 * Usage (from backend/):
 *   node scripts/backtest-vp-freq-eth-2122-h1-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ETHUSDT";
const TF = "15m";

const WINDOWS = [
  { label: "lock_22_26", from: "2022-06-01", to: "2026-05-31" },
  { label: "oos_21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y_22_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y_23_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "y_24_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "y_25_26", from: "2025-06-01", to: "2026-05-31" },
  { label: "full_20_26", from: "2020-01-01", to: "2026-05-31" },
];

const VARIANTS = [
  {
    label: "v0_abc",
    patch: {
      vpValSellBlockBull60: false,
      vpValSellBlockBull60Dump: false,
      vpValSellBlockBull60NonVac: false,
    },
  },
  {
    label: "v1_h1_dump_only",
    patch: {
      vpValSellBlockBull60: false,
      vpValSellBlockBull60Dump: true,
      vpValSellBull60Pct: 0.05,
      vpValSellBull60DumpPrior20dPct: -0.05,
      vpValSellBlockBull60NonVac: false,
    },
  },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const cache = new Map();
async function load(from, to) {
  const k = `${from}|${to}`;
  if (cache.has(k)) return cache.get(k);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try {
    funding = await readFundingRates(SYMBOL, padFrom, toMs);
  } catch {
    funding = [];
  }
  const v = { candles, funding, fromMs, toMs };
  cache.set(k, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs, toMs } = await load(from, to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    ...patch,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const m = computeAllMetrics({
    trades: closed,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: 100,
  });
  return {
    n: closed.length,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    wr: (m.winRate ?? 0) * 100,
    net: closed.reduce((s, t) => s + Number(t.netPnl ?? 0), 0),
  };
}

const report = { generatedAt: new Date().toISOString(), variants: {} };
for (const v of VARIANTS) {
  console.error(`\n=== ${v.label} ===`);
  report.variants[v.label] = {};
  for (const w of WINDOWS) {
    console.error(`  ${w.label}…`);
    const r = await run(w.from, w.to, v.patch);
    report.variants[v.label][w.label] = r;
    console.log(
      `${v.label.padEnd(18)} ${w.label.padEnd(12)} n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(1).padStart(7)}% dd=${r.dd.toFixed(1).padStart(5)}% net=$${r.net.toFixed(1)}`,
    );
  }
}

const out = path.resolve(__dirname, ".vp-freq-eth-2122-h1-ab.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("wrote", out);
await closePool?.();
