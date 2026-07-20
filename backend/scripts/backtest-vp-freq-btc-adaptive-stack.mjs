#!/usr/bin/env node
/**
 * BTC VP FREQ — lean adaptive A/B (candles loaded once).
 * Prior partial: macroAdapt helps (-72%→-41%); chop trail HURTS; wick mixed.
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

const baseCfg = {
  ...VOLUME_PROFILE_FREQ_BTC_15M,
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
const padFrom = volumeProfilePadFromMs(fromMs, "15m", baseCfg);
const candles = await readCandles("BTCUSDT", "15m", padFrom, toMs, { market: "futures" });
console.error(`candles=${candles.length}`);

async function runCfg(label, patch) {
  const cfg = { ...baseCfg, ...patch };
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
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  let wins = 0;
  const bySetup = {};
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
    const k = String(t.entryReason ?? t.vpSetup ?? "?");
    if (!bySetup[k]) bySetup[k] = { n: 0, net: 0 };
    bySetup[k].n += 1;
    bySetup[k].net += pnl;
  }
  const years = summarizeByYear(closed);
  const focus = ["2022-23", "2023-24", "2024-25", "2025-26"];
  console.log(`\n=== ${label} ===`);
  console.log(
    `N=${closed.length} ret=${(eq - 100).toFixed(1)}% DD=${maxDd.toFixed(1)}% WR=${((wins / (closed.length || 1)) * 100).toFixed(0)}%`,
  );
  for (const y of focus) {
    const r = years[y];
    if (!r) {
      console.log(`  ${y}: (none)`);
      continue;
    }
    console.log(`  ${y}: n=${r.n} wr=${r.wr.toFixed(0)}% ret=${r.retPct.toFixed(1)}% net=$${r.net.toFixed(1)}`);
  }
  console.log("  setups", JSON.stringify(bySetup));
  return {
    label,
    n: closed.length,
    ret: eq - 100,
    dd: maxDd,
    wr: (wins / (closed.length || 1)) * 100,
    years,
    bySetup,
  };
}

const MACRO = {
  vpSellMacroAdapt: true,
  vpSellMinHtfSepPct: 0.0015,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
};

const results = [];
results.push(await runCfg("0_baseline", {}));
results.push(await runCfg("A_macroAdapt", { ...MACRO }));
results.push(
  await runCfg("AB_macro_nonBear", {
    ...MACRO,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
  }),
);
results.push(
  await runCfg("AF_macro_weakBear", {
    ...MACRO,
    vpSellWeakBearMinHtfSepPct: 0.005,
    vpSellWeakBearPrior20dFloorPct: -0.1,
  }),
);
results.push(
  await runCfg("ABF_macro_nonBear_weak", {
    ...MACRO,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
    vpSellWeakBearMinHtfSepPct: 0.005,
    vpSellWeakBearPrior20dFloorPct: -0.1,
  }),
);
results.push(
  await runCfg("G_global_sell_htf05", {
    vpSellMinHtfSepPct: 0.005,
    vpMinHtfSepPct: 0.005,
  }),
);
results.push(
  await runCfg("A_plus_htf03_soft", {
    ...MACRO,
    vpSellMinHtfSepPct: 0.003,
    vpSellMacroBullMinHtfSepPct: 0.005,
  }),
);
results.push(
  await runCfg("A_plus_rej_ext_block", {
    ...MACRO,
    vpRejectionSellBlockExtendedDown: true,
    vpRejectionExtendedPriorPct: 0.05,
  }),
);
results.push(
  await runCfg("A_plus_sell_only_va_rej", {
    ...MACRO,
    // Drop BUY va_rejection via setups that still allow SELL rejection through engine;
    // if both sides share setup name, use extended-down + wick instead.
    vpRejectionMinWickRatio: 0.35,
    vpRejectionSellBlockExtendedDown: true,
    vpRejectionExtendedPriorPct: 0.05,
  }),
);
results.push(
  await runCfg("ABF_plus_rej_quality", {
    ...MACRO,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
    vpSellWeakBearMinHtfSepPct: 0.005,
    vpSellWeakBearPrior20dFloorPct: -0.1,
    vpRejectionMinWickRatio: 0.35,
    vpRejectionSellBlockExtendedDown: true,
    vpRejectionExtendedPriorPct: 0.05,
  }),
);
results.push(
  await runCfg("H_val_only_shorts", {
    ...MACRO,
    vpSellNonBearMinHtfSepPct: 0.005,
    vpSellBearPrior60dPct: -0.05,
    vpAllowedSetups: ["val_breakdown"],
  }),
);

const outPath = path.resolve(__dirname, ".vp-freq-btc-adaptive-stack.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.error("\nwrote", outPath);
await closePool?.();
