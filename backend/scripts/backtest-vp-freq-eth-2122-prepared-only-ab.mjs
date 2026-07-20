#!/usr/bin/env node
/**
 * ETH root-cause fix — prepared-only VAL (bear60) + unprepared BUY rej abstain.
 *
 * Root cause 2021–22: VAL shorts + thin BUY rej outside clean bear / prepared macros.
 * Doctrine: abstain unprepared conditions (reliability > trading ambiguous edge).
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

const H12 = {
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
};

const VARIANTS = [
  { label: "v0_h1_h2", patch: { ...H12 } },
  {
    label: "v1_val_bear60_only",
    patch: {
      ...H12,
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
    },
  },
  {
    label: "v2_bear60_plus_rej_gate",
    patch: {
      ...H12,
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
      vpBuyRejectionBlockUnpreparedMacro: true,
    },
  },
  {
    label: "v3_bear_trend_plus_rej_gate",
    patch: {
      ...H12,
      vpValSellRequireBearTrend: true,
      vpBuyRejectionBlockUnpreparedMacro: true,
    },
  },
  {
    label: "v4_bear60_no_va_rej",
    patch: {
      ...H12,
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "naked_poc"],
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
  const v = { candles, funding, fromMs };
  cache.set(k, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs } = await load(from, to);
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
  // Fresh adapter every run — no cross-variant contamination
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
      `${v.label.padEnd(28)} ${w.label.padEnd(12)} n=${String(r.n).padStart(3)} ret=${r.ret.toFixed(1).padStart(7)}% dd=${r.dd.toFixed(1).padStart(5)}%`,
    );
  }
}

const out = path.resolve(__dirname, ".vp-freq-eth-2122-prepared-only-ab.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("wrote", out);
await closePool?.();
