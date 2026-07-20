#!/usr/bin/env node
/**
 * ETH VP FREQ — OOS year-window audit + prepared-regime parity test.
 *
 * Compares locked ETH preset vs ETH + BTC-style prepared-regime deny cells
 * across the historically problematic OOS windows.
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

const WINDOWS = [
  { label: "full_2020_26", from: "2020-01-01", to: "2026-05-31" },
  { label: "oos_2021_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "oos_2022_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "oos_2023_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "oos_2024_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "oos_2025_26", from: "2025-06-01", to: "2026-05-31" },
];

const VARIANTS = [
  {
    label: "eth_locked",
    patch: {},
  },
  {
    label: "eth_plus_btc_prepared",
    patch: {
      vpPreparedRegimeOnly: true,
      vpPreparedBlockVacuumVah: true,
      vpPreparedBlockVacuumValBear: true,
      vpPreparedVacuumPathPct: 0.02,
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
      vpRejectionExtendedPriorPct: 0,
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

async function runWindow(from, to, patch) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  if (!candles?.length) return null;
  let funding = [];
  try {
    funding = await readFundingRates(SYMBOL, padFrom, toMs);
  } catch {
    funding = [];
  }
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
const out = { generatedAt: new Date().toISOString(), windows: {}, variants: VARIANTS.map((v) => v.label) };

console.log("\n=== ETH VP FREQ OOS year audit ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} (${w.from} → ${w.to}) ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await runWindow(w.from, w.to, v.patch);
    if (!r) {
      console.log(`  ${v.label}: no data`);
      continue;
    }
    out.windows[w.label][v.label] = r;
    console.log(
      `  ${v.label.padEnd(22)} N=${String(r.n).padStart(3)} ${fmt(r.tPerWk, 2)}/wk ret=${fmt(r.ret)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`,
    );
  }
  const locked = out.windows[w.label]?.eth_locked;
  const prep = out.windows[w.label]?.eth_plus_btc_prepared;
  if (locked && prep) {
    const delta = prep.ret - locked.ret;
    console.log(`  delta prepared vs locked: ${delta >= 0 ? "+" : ""}${fmt(delta)}% ret, N ${prep.n - locked.n}`);
  }
  console.log("");
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-oos-audit.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("wrote", outPath);

await closePool?.();
