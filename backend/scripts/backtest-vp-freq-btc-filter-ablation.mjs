#!/usr/bin/env node
/**
 * BTC FREQ — filter ablation: which locks cut N without helping return?
 * Start from locked stack; remove ONE filter at a time; also try slim stacks.
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
  VOLUME_PROFILE_FREQ_CORE,
  VOLUME_PROFILE_BASE,
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

const LOCKED = { ...VOLUME_PROFILE_FREQ_BTC_15M };

/** Pre-lock short list with old soft HTF (funnel baseline). */
const OLD_SOFT = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: "BTCUSDT",
  timeframe: "15m",
  vpAllowedSetups: ["lvn_vacuum", "val_breakdown", "va_rejection", "naked_poc"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpValBreakdownMinVolRatio: 1.0,
  vpMinBreakoutBody: 0.28,
  vpMinBreakoutCloseStrength: 0.45,
  vpMinBarGap: 3,
  vpMaxTradesPerDay: 1,
};

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
  volumeProfilePadFromMs(fromMs, "15m", { ...LOCKED, ...baseRun }),
  toMs,
  { market: "futures" },
);
console.error(`candles=${candles.length}`);

async function runCfg(label, preset) {
  const cfg = { ...preset, ...baseRun };
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
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    eq += pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    if (pnl > 0) wins += 1;
  }
  const years = summarizeByYear(closed);
  const focus = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const neg = focus.filter((y) => (years[y]?.retPct ?? 0) < 0);
  const tw = closed.length / ((toMs - fromMs) / (7 * 86_400_000));
  const row = {
    label,
    n: closed.length,
    tPerWk: +tw.toFixed(2),
    ret: +(eq - 100).toFixed(1),
    dd: +maxDd.toFixed(1),
    wr: +((wins / (closed.length || 1)) * 100).toFixed(1),
    negYears: neg,
    years: Object.fromEntries(
      focus.map((y) => {
        const r = years[y];
        return [y, r ? { n: r.n, ret: +r.retPct.toFixed(1) } : null];
      }),
    ),
  };
  console.log(
    `${label.padEnd(28)} N=${String(row.n).padStart(3)} ${row.tPerWk}/wk ret=${String(row.ret).padStart(6)}% DD=${String(row.dd).padStart(5)}% neg=${neg.join(",") || "none"}`,
  );
  return row;
}

const results = [];

results.push(await runCfg("0_old_soft_015", OLD_SOFT));
results.push(await runCfg("1_locked", LOCKED));

// Ablate one locked filter at a time
results.push(
  await runCfg("ablate_weakBear", {
    ...LOCKED,
    vpSellWeakBearMinHtfSepPct: 0,
    vpSellWeakBearPrior20dFloorPct: undefined,
  }),
);
results.push(
  await runCfg("ablate_macroAdapt", {
    ...LOCKED,
    vpSellMacroAdapt: false,
    vpSellMacroBullMinHtfSepPct: undefined,
  }),
);
results.push(
  await runCfg("ablate_p60_VAL", {
    ...LOCKED,
    vpValSellRequirePrior60dBear: false,
    vpValSellPrior60dBearPct: undefined,
  }),
);
results.push(
  await runCfg("ablate_htf_to_015", {
    ...LOCKED,
    vpMinHtfSepPct: 0.0015,
    vpSellMinHtfSepPct: 0.0015,
  }),
);
results.push(
  await runCfg("ablate_htf_to_03", {
    ...LOCKED,
    vpMinHtfSepPct: 0.003,
    vpSellMinHtfSepPct: 0.003,
  }),
);
results.push(
  await runCfg("ablate_htf_to_04", {
    ...LOCKED,
    vpMinHtfSepPct: 0.004,
    vpSellMinHtfSepPct: 0.004,
  }),
);

// Slim stacks: keep only filters that earn their keep
results.push(
  await runCfg("slim_htf05_only", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
  }),
);
results.push(
  await runCfg("slim_htf05_p60", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
results.push(
  await runCfg("slim_htf05_macro", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpSellMacroAdapt: true,
    vpSellMacroBullMinHtfSepPct: 0.005,
    vpSellMacroPrior20dBullPct: 0.02,
  }),
);
results.push(
  await runCfg("slim_htf05_macro_p60", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpSellMacroAdapt: true,
    vpSellMacroBullMinHtfSepPct: 0.005,
    vpSellMacroPrior20dBullPct: 0.02,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
results.push(
  await runCfg("slim_htf03_p60", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.003,
    vpSellMinHtfSepPct: 0.003,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
results.push(
  await runCfg("slim_htf03_macro_p60", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.003,
    vpSellMinHtfSepPct: 0.003,
    vpSellMacroAdapt: true,
    vpSellMacroBullMinHtfSepPct: 0.005,
    vpSellMacroPrior20dBullPct: 0.02,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
results.push(
  await runCfg("slim_htf015_p60", {
    ...OLD_SOFT,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
results.push(
  await runCfg("slim_p60_only", {
    ...OLD_SOFT,
    vpRequireHtfAlign: false,
    vpMinHtfSepPct: 0,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.05,
  }),
);
// Soften p60 floor to restore VAL N while keeping edge
results.push(
  await runCfg("slim_htf05_p60_m03", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.03,
  }),
);
results.push(
  await runCfg("slim_htf05_p60_m02", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: -0.02,
  }),
);
results.push(
  await runCfg("slim_htf05_p60_0", {
    ...OLD_SOFT,
    vpMinHtfSepPct: 0.005,
    vpSellMinHtfSepPct: 0.005,
    vpValSellRequirePrior60dBear: true,
    vpValSellPrior60dBearPct: 0,
  }),
);

const outPath = path.resolve(__dirname, ".vp-freq-btc-filter-ablation.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.error("wrote", outPath);
await closePool?.();
