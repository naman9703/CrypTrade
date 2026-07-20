#!/usr/bin/env node
/**
 * BTC prepared-regime authorize/abstain — full-sim A/B.
 * Blocks known unprepared bleed cells; unknown stays tradeable until classified.
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
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  const years = {};
  const bySetup = {};
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

const PREPARED = {
  vpPreparedRegimeOnly: true,
  vpPreparedBlockVacuumVah: true,
  vpPreparedBlockVacuumValBear: true,
  vpPreparedVacuumPathPct: 0.02,
};

const VARIANTS = [
  { label: "0_locked", patch: {} },
  { label: "P_prepared_bleed_block", patch: PREPARED },
  {
    label: "P_plus_no_bull_vacuum_cap_redundant",
    patch: {
      ...PREPARED,
      // structured-only longs already implied by prepared vacuum VAH block
      vpBuyBreakoutMaxPathPct: 0.02,
      vpBuyBreakoutMaxPathNonBullOnly: false,
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
    ...VOLUME_PROFILE_FREQ_BTC_15M,
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
  const summary = summarize(closed, fromMs, toMs);
  const negYears = Object.entries(summary.years)
    .filter(([, v]) => v.retPct < 0)
    .map(([y]) => y);
  console.log(
    `${window.tag.padEnd(12)} ${variant.label.padEnd(34)} N=${String(summary.n).padStart(3)} ${summary.tPerWk.toFixed(2)}/wk ret=${summary.ret.toFixed(1).padStart(7)}% DD=${summary.dd.toFixed(1).padStart(5)}% neg=${negYears.join(",") || "none"}`,
  );
  return { window: window.tag, label: variant.label, ...summary, negYears };
}

const results = [];
for (const w of WINDOWS) {
  console.error(`\n=== ${w.tag} ===`);
  for (const v of VARIANTS) results.push(await runOne(w, v));
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-prepared-regime-ab.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.error("wrote", outPath);
await closePool?.();
