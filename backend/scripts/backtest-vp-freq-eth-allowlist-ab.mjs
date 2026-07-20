#!/usr/bin/env node
/**
 * ETH VP FREQ — prepared-cell allowlist A/B across year windows + cost stress.
 *
 * From the ETH prepared-regime matrix (2020-2026): deny-family (BTC-style) does
 * NOT stop 2020-2022 bleed; bleed lives in thin/unseen/unknown cells. Fold-wise
 * WF shows the `prepared` bucket positive every fold. This tests strict
 * allowlist-only variants to pick the ETH-native prepared set.
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
const RISK_PCT = 2.5;
const LEVERAGE = 12;

// Prepared cells (full-history matrix labels). Doctrine validated by fold-wise WF.
const PREPARED = [
  "SELL|val_breakdown|bull_chop|vacuum",
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|vah_breakout|weak_bear|vacuum",
  "SELL|val_breakdown|bear_trend|tight",
  "BUY|va_rejection|bull_trend|tight",
  "SELL|val_breakdown|bull_trend|vacuum",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
];
// Biggest single net contributor, labeled fragile_positive (bear vacuum VAL).
const FRAGILE_BEAR_VAC = "SELL|val_breakdown|bear_trend|vacuum";

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
  { label: "v0_locked", patch: {} },
  {
    label: "v1_prepared_only",
    patch: { vpPreparedAllowlistOnly: true, vpPreparedCellKeys: PREPARED },
  },
  {
    label: "v2_prepared_plus_bearvac",
    patch: { vpPreparedAllowlistOnly: true, vpPreparedCellKeys: [...PREPARED, FRAGILE_BEAR_VAC] },
  },
];

const COST = [
  { label: "base", patch: {} },
  { label: "slip_x2", patch: { slippagePct: 0.001 } },
  { label: "slip_x4", patch: { slippagePct: 0.002 } },
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

function baseCfg(patch = {}) {
  return {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    ...patch,
  };
}

// Cache candles/funding per window.
const cache = new Map();
async function loadWindow(from, to) {
  const kkey = `${from}|${to}`;
  if (cache.has(kkey)) return cache.get(kkey);
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
  cache.set(kkey, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs, toMs } = await loadWindow(from, to);
  if (!candles?.length) return null;
  const cfg = baseCfg({ ...patch, backtestSignalStartMs: fromMs });
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
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return {
    n: closed.length,
    tPerWk: closed.length / weeks,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    calmar: m.calmar,
    pf: m.profitFactor,
    wr: (m.winRate || 0) * 100,
  };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = { generatedAt: new Date().toISOString(), preparedCells: PREPARED, fragileBearVac: FRAGILE_BEAR_VAC, windows: {}, cost: {} };

console.log("\n=== ETH allowlist A/B — year windows ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} (${w.from} → ${w.to}) ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.patch);
    out.windows[w.label][v.label] = r;
    if (!r) { console.log(`  ${v.label}: no data`); continue; }
    console.log(
      `  ${v.label.padEnd(26)} N=${String(r.n).padStart(3)} ${fmt(r.tPerWk, 2)}/wk ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)} WR=${fmt(r.wr, 0)}%`,
    );
  }
  console.log("");
}

console.log("=== COST STRESS (full window) ===\n");
for (const v of VARIANTS) {
  out.cost[v.label] = {};
  const parts = [];
  for (const c of COST) {
    const r = await run("2020-01-01", "2026-05-31", { ...v.patch, ...c.patch });
    out.cost[v.label][c.label] = r;
    parts.push(`${c.label}=${fmt(r.ret)}%/DD${fmt(r.dd)}`);
  }
  console.log(`  ${v.label.padEnd(26)} ${parts.join("  ")}`);
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-allowlist-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\nwrote", outPath);

await closePool?.();
