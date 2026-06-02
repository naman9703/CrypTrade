#!/usr/bin/env node
/**
 * Post-bracket-fix pivot tests — ICT-aligned configs, internal TP2, regime calibration.
 * Usage: node scripts/backtest-smc-ict-pivot.mjs [inSampleFrom] [inSampleTo]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const inFrom = Date.parse(args[0] || "2026-01-01");
const inTo = Date.parse(args[1] || "2026-05-27");
const oosFrom = Date.parse("2025-06-01");
const oosTo = Date.parse("2025-12-31");
const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";

const {
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_PDH_FVG_MID_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { atrPercentileAt } = await import("../src/strategy/techniques/smcRegime.js");

function segmentStats(trades, label) {
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const winRate = n ? wins / n : 0;
  const avgWin = wins ? pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0) / wins / 100 : 0;
  const losses = n - wins;
  const avgLoss = losses ? Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0) / losses / 100) : 0;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  return {
    label,
    entries: n,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    avgWinR: Math.round(avgWin * 100) / 100,
    avgLossR: Math.round(avgLoss * 100) / 100,
    expectancyPerTradePct: Math.round((winRate * avgWin - (1 - winRate) * avgLoss) * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
  };
}

async function runWindow(rawCfg, candles, windowFrom, windowTo, tag) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...rawCfg, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: tf,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = out.trades.filter((t) => t.entryTs >= windowFrom && t.entryTs <= windowTo);
  return { tag, trades, summary: segmentStats(trades, tag) };
}

function atrDistributionAtEntries(candles, trades, pre) {
  const pcts = [];
  for (const t of trades) {
    const idx = candles.findIndex((c) => c.ts === t.entryTs);
    if (idx < 0) continue;
    const p = atrPercentileAt(candles, pre, idx, 2880);
    if (p != null) pcts.push(p);
  }
  if (!pcts.length) return { n: 0, median: null, p25: null, p75: null };
  pcts.sort((a, b) => a - b);
  const q = (p) => pcts[Math.floor(p * (pcts.length - 1))];
  return {
    n: pcts.length,
    median: Math.round(q(0.5) * 10) / 10,
    p25: Math.round(q(0.25) * 10) / 10,
    p75: Math.round(q(0.75) * 10) / 10,
    mean: Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10,
  };
}

const configs = [
  { tag: "sweep_broken_baseline", cfg: INTRADAY_PRO_ICT_15M },
  {
    tag: "choch_fvg_mid_all_levels",
    cfg: {
      ...INTRADAY_PRO_ICT_15M,
      intradaySmcRequireChoch: true,
      intradaySmcRequireRetrace: true,
      intradaySmcFvgEntryMode: "midpoint",
      intradaySmcEntryZoneMode: "FVG",
      intradaySmcChochStrict: false,
    },
  },
  { tag: "pdh_pdl_choch_fvg_mid", cfg: { ...INTRADAY_PRO_ICT_PDH_FVG_MID_15M, intradaySmcTp2Mode: "opposing" } },
  { tag: "pdh_pdl_choch_fvg_mid_internal_tp2", cfg: INTRADAY_PRO_ICT_PDH_FVG_MID_15M },
  {
    tag: "pdh_pdl_choch_fvg_mid_regime_40_80",
    cfg: {
      ...INTRADAY_PRO_ICT_PDH_FVG_MID_15M,
      intradaySmcRegimeFilterEnabled: true,
      intradaySmcRegimeAtrPctMin: 40,
      intradaySmcRegimeAtrPctMax: 80,
    },
  },
];

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const inCandles = await readCandles(symbol, tf, inFrom - 5 * 864e5, inTo);
const oosCandles = await readCandles(symbol, tf, oosFrom - 5 * 864e5, oosTo);
await closePool();

process.stderr.write("Running in-sample pivot matrix...\n");
const inSample = [];
for (const { tag, cfg } of configs) {
  process.stderr.write(`  ${tag}...\n`);
  inSample.push(await runWindow(cfg, inCandles, inFrom, inTo, tag));
}

process.stderr.write("Running OOS on top configs...\n");
const oosTags = ["pdh_pdl_choch_fvg_mid_internal_tp2", "pdh_pdl_choch_fvg_mid_regime_40_80"];
const oosResults = [];
for (const tag of oosTags) {
  const c = configs.find((x) => x.tag === tag);
  if (c) oosResults.push(await runWindow(c.cfg, oosCandles, oosFrom, oosTo, `${tag}_oos`));
}

const preIn = precomputeIntraday(inCandles);
const preOos = precomputeIntraday(oosCandles);
const baselineTrades = inSample.find((r) => r.tag === "sweep_broken_baseline")?.trades ?? [];
const pivotTrades = inSample.find((r) => r.tag === "pdh_pdl_choch_fvg_mid_internal_tp2")?.trades ?? [];

const report = {
  note: "+32% was phantom (opposingLevel=0); −41.6% sweep is corrected baseline with real brackets",
  windows: {
    inSample: { from: new Date(inFrom).toISOString().slice(0, 10), to: new Date(inTo).toISOString().slice(0, 10) },
    oos: { from: new Date(oosFrom).toISOString().slice(0, 10), to: new Date(oosTo).toISOString().slice(0, 10) },
  },
  inSample: inSample.map((r) => r.summary),
  oos: oosResults.map((r) => r.summary),
  atrCalibration: {
    inSampleBaselineEntries: atrDistributionAtEntries(inCandles, baselineTrades, preIn),
    inSamplePivotEntries: atrDistributionAtEntries(inCandles, pivotTrades, preIn),
    oosBaselineProxy: atrDistributionAtEntries(
      oosCandles,
      (await runWindow(INTRADAY_PRO_ICT_15M, oosCandles, oosFrom, oosTo, "oos_sweep")).trades,
      preOos,
    ),
  },
  verdict: {},
};

const best = [...inSample].sort((a, b) => b.summary.returnPct - a.summary.returnPct)[0];
report.verdict.bestInSample = best?.summary ?? null;
report.verdict.phantomBaseline =
  "Prior +32% used broken TP2 (opposingLevel=0); all absolute returns must use corrected brackets";
report.verdict.nextStep =
  best?.summary?.returnPct > 0
    ? "Validate best config on 12mo pre-tuning data before asset transfer"
    : "TP2 internal + regime gate calibration; extend CHoCH+FVG-mid sample on longer history";

const outPath = path.resolve(__dirname, "../.data/smc-ict-pivot.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
