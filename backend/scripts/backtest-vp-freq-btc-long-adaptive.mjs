#!/usr/bin/env node
/**
 * BTC VP FREQ — adaptive LONG reopen A/B (not blanket short-only).
 *
 * Autopsy (.vp-freq-btc-long-autopsy.json):
 * - BUY va_rejection already allowed & strong (+$47 / 5t) — was never the problem
 * - VAH banned after 1y funnel; multi-year: VAH flat (−$1.7) but
 *   vacuum/bear VAH bleeds; structured + bull VAH wins
 * - 2025–26 bear: VAH −$8; 2022–23: VAH +$9.6 — regime-conditional, not "BTC can't long"
 *
 * Hypothesis: reopen VAH with BTC-native long gates (bear/vacuum block), keep shorts lock.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = "2022-06-01";
const TO = "2026-05-31";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function yearBucket(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function summarizeByYear(trades) {
  const years = {};
  let eq = 100;
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const y = yearBucket(Number(t.entryTs ?? t.entry_time));
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq, buyN: 0, buyNet: 0, sellN: 0, sellNet: 0 };
    const pnl = Number(t.netPnl ?? 0);
    const side = String(t.direction ?? t.side).toUpperCase();
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    if (side === "BUY") {
      years[y].buyN += 1;
      years[y].buyNet += pnl;
    } else {
      years[y].sellN += 1;
      years[y].sellNet += pnl;
    }
    eq += pnl;
    years[y].end = eq;
  }
  for (const y of Object.keys(years)) {
    const r = years[y];
    r.wr = r.n ? (r.wins / r.n) * 100 : 0;
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

const OPEN_SETUPS = ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc"];

const baseRun = {
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

console.error("loading candles once…");
const candles = await readCandles(
  "BTCUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
  toMs,
  { market: "futures" },
);
console.error(`candles=${candles.length}`);

async function runCfg(label, patch) {
  const cfg = { ...VOLUME_PROFILE_FREQ_BTC_15M, ...patch, ...baseRun };
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
  let eq = 100, peak = 100, maxDd = 0, wins = 0, buyN = 0, buyNet = 0, sellN = 0, sellNet = 0;
  const bySetup = {};
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const side = String(t.direction ?? t.side).toUpperCase();
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    if (side === "BUY") {
      buyN += 1;
      buyNet += pnl;
    } else {
      sellN += 1;
      sellNet += pnl;
    }
    const k = `${side}:${String(t.entryReason ?? "?").replace(/^vp_/, "")}`;
    if (!bySetup[k]) bySetup[k] = { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  const years = summarizeByYear(closed);
  const focus = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const neg = focus.filter((y) => (years[y]?.retPct ?? 0) < 0);
  const tw = closed.length / ((toMs - fromMs) / (7 * 86_400_000));
  console.log(`\n=== ${label} ===`);
  console.log(
    `N=${closed.length} ${tw.toFixed(2)}/wk ret=${(eq - 100).toFixed(1)}% DD=${maxDd.toFixed(1)}% WR=${((wins / (closed.length || 1)) * 100).toFixed(0)}% neg=${neg.join(",") || "none"}`,
  );
  console.log(`  BUY n=${buyN} net=$${buyNet.toFixed(1)} | SELL n=${sellN} net=$${sellNet.toFixed(1)}`);
  for (const y of focus) {
    const r = years[y];
    if (!r) continue;
    console.log(
      `  ${y}: n=${r.n} ret=${r.retPct.toFixed(1)}% buy=${r.buyN}/$${r.buyNet.toFixed(1)} sell=${r.sellN}/$${r.sellNet.toFixed(1)}`,
    );
  }
  console.log("  setups", JSON.stringify(bySetup));
  return {
    label,
    n: closed.length,
    tPerWk: +tw.toFixed(2),
    ret: eq - 100,
    dd: maxDd,
    wr: (wins / (closed.length || 1)) * 100,
    buyN,
    buyNet,
    sellN,
    sellNet,
    neg,
    years,
    bySetup,
  };
}

const results = [];

results.push(await runCfg("0_shorts_locked", {}));

results.push(
  await runCfg("A_open_vah_raw", {
    vpAllowedSetups: OPEN_SETUPS,
  }),
);

results.push(
  await runCfg("B_vah_block_bear", {
    vpAllowedSetups: OPEN_SETUPS,
    // reuse ETH vacuum/bear long gates
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: true,
    vpBuyVacuumBullPriorPct: 0.05,
    vpBuyVacuumPriorLookback: 96 * 60,
  }),
);

results.push(
  await runCfg("C_vah_vacuum_cap_all", {
    vpAllowedSetups: OPEN_SETUPS,
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: false,
  }),
);

results.push(
  await runCfg("D_vah_chase08", {
    vpAllowedSetups: OPEN_SETUPS,
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
  }),
);

results.push(
  await runCfg("E_vah_bear_vac_chase", {
    vpAllowedSetups: OPEN_SETUPS,
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: true,
    vpBuyVacuumBullPriorPct: 0.05,
    vpBuyVacuumPriorLookback: 96 * 60,
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
  }),
);

results.push(
  await runCfg("F_vah_vac_pullback", {
    vpAllowedSetups: OPEN_SETUPS,
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: true,
    vpBuyVacuumBullPriorPct: 0.05,
    vpBuyVacuumPriorLookback: 96 * 60,
    vpBuyVacuumMaxPrior5dPct: 0.01,
    vpBuyVacuumPrior5dLookback: 96 * 5,
  }),
);

results.push(
  await runCfg("G_vah_bull_only_macro", {
    vpAllowedSetups: OPEN_SETUPS,
    // stronger: only allow VAH when path structured OR use non-bull vacuum block
    // + require prior60d > -5% for VAH via vacuum non-bull already
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: true,
    vpBuyVacuumBullPriorPct: 0.05,
    vpBuyVacuumPriorLookback: 96 * 60,
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
    vpBuyVacuumMaxPrior5dPct: 0.01,
    vpBuyVacuumPrior5dLookback: 96 * 5,
  }),
);

// Soften short VAL p60 to free slots? No — separate. Try max3 with best long stack.
results.push(
  await runCfg("H_best_long_max3", {
    vpAllowedSetups: OPEN_SETUPS,
    vpBuyBreakoutMaxPathPct: 0.02,
    vpBuyBreakoutMaxPathNonBullOnly: true,
    vpBuyVacuumBullPriorPct: 0.05,
    vpBuyVacuumPriorLookback: 96 * 60,
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
    vpBuyVacuumMaxPrior5dPct: 0.01,
    vpBuyVacuumPrior5dLookback: 96 * 5,
    vpMaxTradesPerDay: 3,
  }),
);

const outPath = path.resolve(__dirname, ".vp-freq-btc-long-adaptive.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.error("\nwrote", outPath);
await closePool?.();
