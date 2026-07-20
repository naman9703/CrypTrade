#!/usr/bin/env node
/**
 * BTC FREQ — operational gate ablation on locked regime stack.
 * Hypothesis: max/day, bar gap, score throttle N without the return lift of HTF/p60.
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
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq };
    const pnl = Number(t.netPnl ?? 0);
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
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
  let eq = 100, peak = 100, maxDd = 0, wins = 0;
  const bySetup = {};
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const k = String(t.entryReason ?? "?");
    if (!bySetup[k]) bySetup[k] = { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  const years = summarizeByYear(closed);
  const focus = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const neg = focus.filter((y) => (years[y]?.retPct ?? 0) < 0);
  const tw = closed.length / ((toMs - fromMs) / (7 * 86_400_000));
  console.log(
    `${label.padEnd(32)} N=${String(closed.length).padStart(3)} ${tw.toFixed(2)}/wk ret=${(eq - 100).toFixed(1).padStart(6)}% DD=${maxDd.toFixed(1).padStart(5)}% neg=${neg.join(",") || "none"}`,
  );
  for (const y of focus) {
    const r = years[y];
    if (r) console.log(`  ${y}: n=${r.n} ret=${r.retPct.toFixed(1)}%`);
  }
  return {
    label,
    n: closed.length,
    tPerWk: +tw.toFixed(2),
    ret: eq - 100,
    dd: maxDd,
    neg,
    years,
    bySetup,
  };
}

const results = [];
results.push(await runCfg("locked", {}));
results.push(await runCfg("maxDay2", { vpMaxTradesPerDay: 2 }));
results.push(await runCfg("maxDay3", { vpMaxTradesPerDay: 3 }));
results.push(await runCfg("gap2", { vpMinBarGap: 2 }));
results.push(await runCfg("gap1", { vpMinBarGap: 1 }));
results.push(await runCfg("gap0", { vpMinBarGap: 0 }));
results.push(await runCfg("score6", { vpMinScore: 6 }));
results.push(await runCfg("score5", { vpMinScore: 5 }));
results.push(await runCfg("max2_gap1", { vpMaxTradesPerDay: 2, vpMinBarGap: 1 }));
results.push(await runCfg("max2_gap1_score6", { vpMaxTradesPerDay: 2, vpMinBarGap: 1, vpMinScore: 6 }));
results.push(await runCfg("max3_gap0_score5", { vpMaxTradesPerDay: 3, vpMinBarGap: 0, vpMinScore: 5 }));
// Drop weakBear only (ablation said +3t / -14pp) — confirm not worth
results.push(
  await runCfg("no_weakBear_max2_gap1", {
    vpSellWeakBearMinHtfSepPct: 0,
    vpMaxTradesPerDay: 2,
    vpMinBarGap: 1,
  }),
);
// Keep weakBear; drop macroAdapt (redundant at htf=0.5 bull floor?)
results.push(
  await runCfg("no_macro_max2_gap1", {
    vpSellMacroAdapt: false,
    vpMaxTradesPerDay: 2,
    vpMinBarGap: 1,
  }),
);
// Soften HTF to 0.4 with ops open (all-green at +32% N=34 before)
results.push(
  await runCfg("htf04_max2_gap1", {
    vpMinHtfSepPct: 0.004,
    vpSellMinHtfSepPct: 0.004,
    vpMaxTradesPerDay: 2,
    vpMinBarGap: 1,
  }),
);
results.push(
  await runCfg("htf04_weak08_max2_gap1", {
    vpMinHtfSepPct: 0.004,
    vpSellMinHtfSepPct: 0.004,
    vpSellWeakBearMinHtfSepPct: 0.008,
    vpMaxTradesPerDay: 2,
    vpMinBarGap: 1,
  }),
);

const outPath = path.resolve(__dirname, ".vp-freq-btc-ops-ablation.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.error("wrote", outPath);
await closePool?.();
