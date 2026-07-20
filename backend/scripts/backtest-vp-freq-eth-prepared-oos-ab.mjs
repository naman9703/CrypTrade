#!/usr/bin/env node
/**
 * ETH VP FREQ — prepared-regime OOS A/B (BTC doctrine, ETH-native cells).
 *
 * No session filters. No random knobs. One architectural question:
 *
 *   Layer 1: deny known unprepared bleed cells (ETH matrix)
 *   Layer 3: abstain on unknown / untrained cells (allowlist prepared+)
 *
 * Compare:
 *   v0  ABC lock only (no prepared regime)
 *   v1  Layer-1 deny unprepared only (unknowns still trade — BTC default Layer 3)
 *   v2  Layer-1 + Layer-3 allowlist (prepared + fragile bear-vacuum VAL)
 *
 * Success: OOS year windows stop catastrophic bleed; frequency only cut when
 * improvement is clear. No certification here.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const SYMBOL = "ETHUSDT";
const START_USDT = 100;

/** ETH matrix unprepared_bleed (2020-2026). Do NOT copy BTC vacuum-VAL-bear. */
const ETH_UNPREPARED = [
  "SELL|val_breakdown|weak_bear|vacuum", // −$23.5 / 30t — primary OOS bleeder
  "BUY|vah_breakout|bull_trend|vacuum", // −$10.6 / 33t — relief-rally chase
  "SELL|val_breakdown|bull_trend|structured", // −$4.9
  "SELL|val_breakdown|weak_bear|structured", // −$1.8
  "SELL|val_breakdown|bull_chop|structured", // −$1.6
];

/** Matrix prepared + fragile_positive bear vacuum VAL (ETH's largest edge, +$46). */
const ETH_PREPARED_PLUS = [
  "SELL|val_breakdown|bull_chop|vacuum",
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|vah_breakout|weak_bear|vacuum",
  "SELL|val_breakdown|bear_trend|tight",
  "BUY|va_rejection|bull_trend|tight",
  "SELL|val_breakdown|bull_trend|vacuum",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
  "SELL|val_breakdown|bear_trend|vacuum",
];

const WINDOWS = [
  { label: "full_2020_26", from: "2020-01-01", to: "2026-05-31" },
  { label: "oos_2020_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "oos_2021_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "oos_2022_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "oos_2023_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "oos_2024_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "oos_2025_26", from: "2025-06-01", to: "2026-05-31" },
];

const VARIANTS = [
  {
    label: "v0_abc_only",
    patch: {
      vpPreparedRegimeOnly: false,
      vpPreparedAllowlistOnly: false,
      vpPreparedBlockCellKeys: [],
      vpPreparedCellKeys: [],
    },
  },
  {
    label: "v1_deny_unprepared",
    patch: {
      vpPreparedRegimeOnly: false,
      vpPreparedAllowlistOnly: false,
      vpPreparedBlockCellKeys: ETH_UNPREPARED,
      vpPreparedCellKeys: [],
      // Explicit off — ETH must not inherit BTC vacuum-VAL-bear / all-vacuum-VAH
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
    },
  },
  {
    label: "v2_deny_plus_allowlist",
    patch: {
      vpPreparedRegimeOnly: false,
      vpPreparedAllowlistOnly: true,
      vpPreparedBlockCellKeys: ETH_UNPREPARED,
      vpPreparedCellKeys: ETH_PREPARED_PLUS,
      vpPreparedBlockVacuumVah: false,
      vpPreparedBlockVacuumValBear: false,
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
  if (!candles?.length) return null;
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
    ...patch,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START_USDT;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return {
    n: closed.length,
    tPerWk: closed.length / weeks,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    calmar: m.calmar,
    pf: m.profitFactor,
    wr: (m.winRate || 0) * 100,
    years,
  };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = {
  generatedAt: new Date().toISOString(),
  ethUnprepared: ETH_UNPREPARED,
  ethPreparedPlus: ETH_PREPARED_PLUS,
  windows: {},
};

console.log("\n=== ETH prepared-regime OOS A/B (BTC doctrine, ETH cells) ===\n");
console.log("ETH unprepared (deny):", ETH_UNPREPARED.join(" | "));
console.log("");

for (const w of WINDOWS) {
  console.log(`--- ${w.label} (${w.from} → ${w.to}) ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.patch);
    out.windows[w.label][v.label] = r;
    if (!r) {
      console.log(`  ${v.label}: no data`);
      continue;
    }
    console.log(
      `  ${v.label.padEnd(24)} N=${String(r.n).padStart(3)} ${fmt(r.tPerWk, 2)}/wk ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`,
    );
    if (w.label === "full_2020_26") {
      const ys = Object.entries(r.years)
        .map(([y, v2]) => `${y}=${fmt(v2.retPct)}%/${v2.n}`)
        .join("  ");
      console.log(`    years: ${ys}`);
    }
  }
  const v0 = out.windows[w.label].v0_abc_only;
  const v1 = out.windows[w.label].v1_deny_unprepared;
  const v2 = out.windows[w.label].v2_deny_plus_allowlist;
  if (v0 && v1 && v2) {
    console.log(
      `  Δv1 vs v0: ret ${v1.ret - v0.ret >= 0 ? "+" : ""}${fmt(v1.ret - v0.ret)}%  N ${v1.n - v0.n}`,
    );
    console.log(
      `  Δv2 vs v0: ret ${v2.ret - v0.ret >= 0 ? "+" : ""}${fmt(v2.ret - v0.ret)}%  N ${v2.n - v0.n}`,
    );
  }
  console.log("");
}

// Verdict helper: catastrophic = year ret <= -25; mild bleed = < 0
function score(r) {
  if (!r?.years) return { cat: 0, neg: 0 };
  const vals = Object.values(r.years);
  return {
    cat: vals.filter((y) => y.retPct <= -25).length,
    neg: vals.filter((y) => y.retPct < 0).length,
  };
}

const full = out.windows.full_2020_26;
if (full) {
  console.log("=== READ ===");
  for (const [lab, r] of Object.entries(full)) {
    const s = score(r);
    console.log(
      `  ${lab.padEnd(24)} catYears=${s.cat} negYears=${s.neg} N=${r.n} ret=${fmt(r.ret)}% DD=${fmt(r.dd)}%`,
    );
  }
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-prepared-oos-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\nwrote", outPath);
await closePool?.();
