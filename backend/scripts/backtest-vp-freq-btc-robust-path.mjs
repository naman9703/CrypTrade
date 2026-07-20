#!/usr/bin/env node
/**
 * BTC robust path — NOT frequency crush.
 *
 * Diagnosis:
 *   Vacuum path (≥2% to next HVN) is the failure physics (blow-off / squeeze void).
 *   Structured path works. Blocking vacuum removes negative-EV trades (correct) but
 *   looks like "N crush" if we don't restore frequency from positive cells.
 *
 * Practical non-patch plan:
 *   1) Change vacuum BEHAVIOR (retest entry) instead of only deleting trades
 *   2) Expand positive BTC cells (va_rejection / poc) to restore N
 *   3) Novelty: abstain only unrecognized thin-bleed patterns, not all activity
 *
 * Success: OOS 2021-22 not large bleed; lock return ≥ baseline; N not collapsed.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { tag: "oos_2021-22", from: "2021-07-21", to: "2022-06-30" },
  { tag: "lock_2022-26", from: "2022-06-01", to: "2026-05-31" },
  { tag: "full_2021-26", from: "2021-07-21", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function summarize(trades, fromMs, toMs) {
  let eq = 100, peak = 100, maxDd = 0, wins = 0;
  const years = {}, bySetup = {};
  for (const t of trades) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq - pnl };
    years[y].n += 1;
    years[y].net += pnl;
    years[y].end = eq;
    const k = `${String(t.direction ?? t.side).toUpperCase()}:${String(t.entryReason ?? "?").replace(/^vp_/, "")}`;
    bySetup[k] ??= { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return {
    n: trades.length,
    tPerWk: trades.length / ((toMs - fromMs) / (7 * 86_400_000)),
    ret: eq - 100,
    dd: maxDd,
    wr: trades.length ? (wins / trades.length) * 100 : 0,
    years,
    bySetup,
  };
}

/** Baseline without prepared vacuum blocks (pre Layer-1). */
const BASE_NO_PREP = {
  ...VOLUME_PROFILE_FREQ_BTC_15M,
  vpPreparedRegimeOnly: false,
  vpPreparedBlockVacuumVah: false,
  vpPreparedBlockVacuumValBear: false,
};

const VARIANTS = [
  {
    label: "0_pre_prepared",
    patch: { ...BASE_NO_PREP },
  },
  {
    label: "1_prepared_block",
    patch: { ...VOLUME_PROFILE_FREQ_BTC_15M },
  },
  {
    // Behavior fix: keep vacuum opportunities but enter on retest, not chase
    label: "2_vacuum_retest_no_block",
    patch: {
      ...BASE_NO_PREP,
      vpVacuumEntryMode: "retest",
      vpVacuumPathPct: 0.02,
      vpVacuumRetestBars: 8,
      vpVacuumRetestMaxTpPct: 0.015,
    },
  },
  {
    // Prepared block + restore N from positive rejection / bounce family
    label: "3_prep_plus_poc_rej_open",
    patch: {
      ...VOLUME_PROFILE_FREQ_BTC_15M,
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
      vpMinScore: 5,
      vpMaxTradesPerDay: 3,
      vpMinBarGap: 0,
    },
  },
  {
    // Retest vacuum (behavior) + expand positive setups (frequency restore)
    label: "4_retest_plus_expand",
    patch: {
      ...BASE_NO_PREP,
      vpVacuumEntryMode: "retest",
      vpVacuumPathPct: 0.02,
      vpVacuumRetestBars: 8,
      vpVacuumRetestMaxTpPct: 0.015,
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
      vpMinScore: 5,
      vpMaxTradesPerDay: 3,
      vpMinBarGap: 0,
    },
  },
  {
    // Hybrid: block only bear vacuum VAL (worst cell), retest VAH vacuum, expand setups
    label: "5_hybrid_valblock_vahretest_expand",
    patch: {
      ...BASE_NO_PREP,
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: false, // use retest instead of delete
      vpPreparedBlockVacuumValBear: true, // keep worst short bleed cell off
      vpVacuumEntryMode: "retest",
      vpVacuumPathPct: 0.02,
      vpVacuumRetestBars: 8,
      vpVacuumRetestMaxTpPct: 0.015,
      vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc", "poc_bounce"],
      vpMinScore: 5,
      vpMaxTradesPerDay: 3,
      vpMinBarGap: 0,
    },
  },
  {
    // Novelty-first: prepared block + allowlist structured + va_rej only (strict authorize)
    label: "6_allowlist_structured_rej",
    patch: {
      ...VOLUME_PROFILE_FREQ_BTC_15M,
      vpAllowedSetups: ["vah_breakout", "val_breakdown", "va_rejection"],
      // still has vacuum VAH block via prepared; structured VAH/VAL remain
      vpBuyBreakoutMaxPathPct: 0.02,
      vpBuyBreakoutMaxPathNonBullOnly: false,
      vpSellBreakdownMaxPathPct: 0.02,
      vpMinScore: 5,
      vpMaxTradesPerDay: 3,
    },
  },
];

const cache = new Map();
async function getCandles(fromMs, toMs) {
  const key = `${fromMs}:${toMs}`;
  if (cache.has(key)) return cache.get(key);
  const c = await readCandles(
    "BTCUSDT",
    "15m",
    volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
    toMs,
    { market: "futures" },
  );
  cache.set(key, c);
  return c;
}

async function runOne(window, variant) {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const candles = await getCandles(fromMs, toMs);
  const cfg = {
    ...variant.patch,
    symbol: "BTCUSDT",
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    symbol: "BTCUSDT",
    adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const s = summarize(closed, fromMs, toMs);
  const neg = Object.entries(s.years).filter(([, v]) => v.retPct < 0).map(([y]) => y);
  console.log(
    `${window.tag.padEnd(12)} ${variant.label.padEnd(36)} N=${String(s.n).padStart(3)} ${s.tPerWk.toFixed(2)}/wk ret=${s.ret.toFixed(1).padStart(7)}% DD=${s.dd.toFixed(1).padStart(5)}% neg=${neg.join(",") || "none"}`,
  );
  return { window: window.tag, label: variant.label, ...s, negYears: neg };
}

const results = [];
for (const w of WINDOWS) {
  console.error(`\n=== ${w.tag} ===`);
  for (const v of VARIANTS) results.push(await runOne(w, v));
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-robust-path.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      thesis:
        "Vacuum path is failure physics. Fix via retest behavior + expand positive cells; do not equate robustness with N-crush.",
      results,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
