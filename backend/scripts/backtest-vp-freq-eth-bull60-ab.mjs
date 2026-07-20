#!/usr/bin/env node
/**
 * ETH-native 2021–22 fix A/B — must NOT crush the restored ~485%/166t lock window.
 *
 * Baseline: restored ABC + vacuum-prior5d (no BTC prepared allowlist).
 * Autopsy: SELL VAL in prior60d>5% (bull60) = −$15.9 / 18t in 2021–22.
 *
 * Variants (one ETH-native change family):
 *   v0  restored baseline
 *   v1  vpValSellBlockBull60 — abstain VAL shorts when prior60d > +5%
 *   v2  vpValSellRequirePrior60dBear — VAL shorts only when prior60d ≤ −5%
 *
 * Accept only if: lock window stays ~≥450% / DD≲30% / N≳150 AND 2021–22 improves.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const START = 100;

const WINDOWS = [
  { label: "lock_22_26", from: "2022-06-01", to: "2026-05-31" },
  { label: "oos_21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "oos_20_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "full_20_26", from: "2020-01-01", to: "2026-05-31" },
];

const VARIANTS = [
  { label: "v0_restored", patch: {} },
  {
    label: "v1_block_bull60",
    patch: { vpValSellBlockBull60: true, vpValSellBull60Pct: 0.05 },
  },
  {
    label: "v2_bear_only",
    patch: { vpValSellRequirePrior60dBear: true, vpValSellPrior60dBearPct: -0.05 },
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

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

const cache = new Map();
async function load(from, to) {
  const k = `${from}|${to}`;
  if (cache.has(k)) return cache.get(k);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try { funding = await readFundingRates(SYMBOL, padFrom, toMs); } catch { funding = []; }
  const v = { candles, funding, fromMs, toMs };
  cache.set(k, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs, toMs } = await load(from, to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
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
    vpPreparedAllowlistOnly: false,
    vpPreparedBlockCellKeys: [],
    vpPreparedCellKeys: [],
    vpPreparedRegimeOnly: false,
    ...patch,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: funding,
    startingUsdt: START, timeframe: TF, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1; years[y].net += pnl; eq += pnl; years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return {
    n: closed.length,
    tPerWk: closed.length / weeks,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    calmar: m.calmar,
    years,
  };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = { generatedAt: new Date().toISOString(), windows: {} };

console.log("\n=== ETH-native VAL bull60 A/B (preserve ~485% lock) ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.patch);
    out.windows[w.label][v.label] = r;
    console.log(
      `  ${v.label.padEnd(18)} N=${String(r.n).padStart(3)} ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`,
    );
    if (w.label === "lock_22_26" || w.label === "full_20_26") {
      console.log(
        `    years: ${Object.entries(r.years).map(([y, v2]) => `${y}=${fmt(v2.retPct)}%/${v2.n}`).join("  ")}`,
      );
    }
  }
  console.log("");
}

const lock0 = out.windows.lock_22_26?.v0_restored;
const lock1 = out.windows.lock_22_26?.v1_block_bull60;
const lock2 = out.windows.lock_22_26?.v2_bear_only;
const oos0 = out.windows.oos_21_22?.v0_restored;
const oos1 = out.windows.oos_21_22?.v1_block_bull60;
const oos2 = out.windows.oos_21_22?.v2_bear_only;

function accept(lock, oos, baseLock, baseOos) {
  if (!lock || !oos || !baseLock || !baseOos) return false;
  const lockOk = lock.ret >= baseLock.ret * 0.9 && lock.dd <= Math.max(baseLock.dd * 1.15, 30) && lock.n >= baseLock.n * 0.85;
  const oosOk = oos.ret > baseOos.ret + 5; // meaningful lift
  return lockOk && oosOk;
}

console.log("=== VERDICT ===");
console.log(
  `v1_block_bull60: lockOk+oosLift=${accept(lock1, oos1, lock0, oos0)}  lock ${fmt(lock1?.ret)}% vs ${fmt(lock0?.ret)}%  oos21-22 ${fmt(oos1?.ret)}% vs ${fmt(oos0?.ret)}%`,
);
console.log(
  `v2_bear_only:    lockOk+oosLift=${accept(lock2, oos2, lock0, oos0)}  lock ${fmt(lock2?.ret)}% vs ${fmt(lock0?.ret)}%  oos21-22 ${fmt(oos2?.ret)}% vs ${fmt(oos0?.ret)}%`,
);

const outPath = path.resolve(__dirname, ".vp-freq-eth-bull60-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\nwrote", outPath);
await closePool?.();
