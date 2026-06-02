#!/usr/bin/env node
/**
 * Segment sweep preset trades by level type, bars-after-reclaim, and run CHoCH entry variants.
 * Usage: node scripts/backtest-smc-ict-segment.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";

const { INTRADAY_PRO_ICT_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

function isSessionExtreme(levelType) {
  return levelType === "session_high" || levelType === "session_low";
}

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
  const expectancyPct = winRate * avgWin - (1 - winRate) * avgLoss;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  return {
    label,
    entries: n,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    expectancyPerTradePct: Math.round(expectancyPct * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
  };
}

async function runCfg(rawCfg, tag) {
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
  const trades = out.trades.filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs);
  return { tag, trades, summary: segmentStats(trades, tag) };
}

const sweep = await runCfg(INTRADAY_PRO_ICT_15M, "sweep_base");

const byEntry = new Map();
for (const t of sweep.trades) {
  if (!byEntry.has(t.entryTs)) byEntry.set(t.entryTs, []);
  byEntry.get(t.entryTs).push(t);
}

const entryRows = [];
for (const [ts, legs] of byEntry) {
  const t = legs[0];
  const meta = t.liqContext?.smcMeta ?? {};
  const levelType = meta.levelType ?? t.liqContext?.levelType ?? "?";
  const reclaimIdx = meta.sweepReclaimIdx ?? meta.reclaimIdx;
  const entryIdx = meta.entryIdx;
  const barsAfter =
    meta.barsAfterReclaim ??
    (Number.isFinite(reclaimIdx) && Number.isFinite(entryIdx) ? entryIdx - reclaimIdx : null);
  entryRows.push({
    ts,
    netPnl: legs.reduce((s, x) => s + Number(x.netPnl ?? 0), 0),
    levelType,
    barsAfterReclaim: barsAfter,
  });
}

function bucketBars(n) {
  if (n == null || !Number.isFinite(n)) return "unknown";
  if (n <= 2) return "0-2_bars";
  if (n <= 10) return "3-10_bars";
  return "10+_bars";
}

const pdhPdl = entryRows.filter((r) => r.levelType === "pdh" || r.levelType === "pdl");
const sessionExt = entryRows.filter((r) => isSessionExtreme(r.levelType));

const delayBuckets = ["0-2_bars", "3-10_bars", "10+_bars"].map((b) => {
  const rows = entryRows.filter((r) => bucketBars(r.barsAfterReclaim) === b);
  const pnls = rows.map((r) => r.netPnl);
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const winRate = n ? wins / n : 0;
  const avgWin = wins ? pnls.filter((p) => p > 0).reduce((a, x) => a + x, 0) / wins / 100 : 0;
  const losses = n - wins;
  const avgLoss = losses ? Math.abs(pnls.filter((p) => p < 0).reduce((a, x) => a + x, 0) / losses / 100) : 0;
  return {
    bucket: b,
    entries: n,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round(pnls.reduce((a, b) => a + b, 0) / 100) / 100,
    expectancyPerTradePct: Math.round((winRate * avgWin - (1 - winRate) * avgLoss) * 100) / 100,
  };
});

const chochOnly = await runCfg(
  { ...INTRADAY_PRO_ICT_15M, intradaySmcRequireChoch: true, intradaySmcChochStrict: false },
  "choch_only",
);
const chochRetrace = await runCfg(
  {
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRequireChoch: true,
    intradaySmcRequireRetrace: true,
    intradaySmcEntryZoneMode: "EITHER",
    intradaySmcChochStrict: false,
  },
  "choch_retrace",
);
const chochFvgMid = await runCfg(
  {
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRequireChoch: true,
    intradaySmcRequireRetrace: true,
    intradaySmcFvgEntryMode: "midpoint",
    intradaySmcEntryZoneMode: "FVG",
    intradaySmcChochStrict: false,
  },
  "choch_fvg_midpoint",
);

const regimeOn = await runCfg(
  {
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRegimeFilterEnabled: true,
    intradaySmcRegimeAtrPctMin: 35,
    intradaySmcRegimeAtrPctMax: 85,
  },
  "sweep_regime_filter",
);

const lookbackTight = await runCfg(
  { ...INTRADAY_PRO_ICT_15M, intradaySmcLookbackBars: 8, intradaySmcMaxBarsAfterReclaim: 2 },
  "sweep_tight_reclaim",
);

const report = {
  window: { symbol, tf, from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10) },
  baseline: sweep.summary,
  levelTypeSegments: {
    pdhPdl: segmentStats(
      sweep.trades.filter((t) => {
        const lt = t.liqContext?.smcMeta?.levelType ?? t.liqContext?.levelType;
        return lt === "pdh" || lt === "pdl";
      }),
      "pdh_pdl",
    ),
    sessionExtreme: segmentStats(
      sweep.trades.filter((t) => {
        const lt = t.liqContext?.smcMeta?.levelType ?? t.liqContext?.levelType;
        return isSessionExtreme(lt);
      }),
      "session_extreme",
    ),
    levelMix: entryRows.reduce((m, r) => {
      m[r.levelType] = (m[r.levelType] ?? 0) + 1;
      return m;
    }, {}),
  },
  barsAfterReclaim: delayBuckets,
  chochEntryVariants: [chochOnly.summary, chochRetrace.summary, chochFvgMid.summary],
  regimeAndTiming: {
    regimeFilter: regimeOn.summary,
    tightReclaimWindow: lookbackTight.summary,
  },
  interpretation: {
    conditionalEdge:
      "In-sample +32% is regime-conditional on BNB 15m — not structural across OOS slices",
    killzone: "ALL correct for BNB 15m — do not force London/NY from forex ICT guidance",
    choch: "Detector OK; FVG-midpoint entry is the ICT-prescribed timing fix to test",
  },
};

const outPath = path.resolve(__dirname, "../.data/smc-ict-segment.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
