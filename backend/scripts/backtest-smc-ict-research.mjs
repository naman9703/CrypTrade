#!/usr/bin/env node
/**
 * SMC/ICT research sweep — rank configs by return, win rate, composite, ICT-fundamental score.
 * Usage: node scripts/backtest-smc-ict-research.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const argv = process.argv.slice(2);
const skipFunnel = argv.includes("--skip-funnel");
const args = argv.filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const weeks = (toMs - fromMs) / (7 * 864e5);
const WARMUP = 100;

const {
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  buildIntradayBacktestAdapter,
  mergeAdaptiveCfg,
  precomputeIntraday,
  buildIntradayOptsFromCfg,
} = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { countSmcFunnelStages } = await import("../src/strategy/evaluateSmcIctSetup.js");
const { attachSmcHtfToPre } = await import("../src/strategy/techniques/htfBias.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

function smcScore(m) {
  if (m.entries < 8) return m.returnPct * 0.3 + m.winRatePct * 0.5 - m.maxDdPct;
  return m.returnPct * 0.45 + m.winRatePct * 1.2 + (m.profitFactor ?? 0) * 8 - m.maxDdPct * 0.8;
}

function ictFundamentalScore(cfg) {
  let s = 0;
  const p = String(cfg.intradaySmcIctProfile ?? "sweep").toLowerCase();
  if (cfg.intradaySmcRequireChoch) s += 1;
  if (cfg.intradaySmcRequireMss) s += 1;
  if (cfg.intradaySmcRequireRetrace) s += 1;
  if (cfg.intradaySmcKillzoneMode !== "ALL") s += 1;
  if (cfg.intradaySmcHtfBiasMode === "parallel" || cfg.intradaySmcHtfBiasMode === "structure") s += 1;
  if (cfg.intradaySmcRequirePremiumDiscount) s += 1;
  if (p === "full" || p === "ict2022") s += 1;
  if (cfg.intradaySmcPickMode === "daily_sniper" || cfg.intradaySmcOneTradePerDay) s += 0.5;
  return Math.round(s * 10) / 10;
}

async function sim(rawCfg, tag) {
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
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  let peak = 10_000;
  let eq = 10_000;
  let maxDd = 0;
  for (const t of trades.slice().sort((a, b) => a.exitTs - b.exitTs)) {
    eq += Number(t.netPnl ?? 0);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  const m = {
    tag,
    profile: cfg.intradaySmcIctProfile,
    kz: cfg.intradaySmcKillzoneMode,
    choch: cfg.intradaySmcRequireChoch === true,
    mss: cfg.intradaySmcRequireMss === true,
    retrace: cfg.intradaySmcRequireRetrace === true,
    pd: cfg.intradaySmcRequirePremiumDiscount === true,
    htf: `${cfg.intradaySmcHtfBiasMode}/${cfg.intradaySmcHtfStrictness}`,
    pick: cfg.intradaySmcPickMode,
    ictScore: ictFundamentalScore(cfg),
    entries: n,
    perWeek: Math.round((n / weeks) * 10) / 10,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    maxDdPct: Math.round(maxDd * 10000) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
  };
  m.composite = Math.round(smcScore(m) * 10) / 10;
  return m;
}

function profilePatch(profile) {
  if (profile === "full") {
    return {
      intradaySmcIctProfile: "full",
      intradaySmcRequireChoch: true,
      intradaySmcChochStrict: true,
      intradaySmcRequireMss: true,
      intradaySmcRequireBos: true,
      intradaySmcRequireRetrace: true,
      intradaySmcRequirePremiumDiscount: true,
    };
  }
  if (profile === "balanced") {
    return {
      intradaySmcIctProfile: "balanced",
      intradaySmcRequireChoch: true,
      intradaySmcChochStrict: false,
      intradaySmcRequireMss: true,
      intradaySmcRequireRetrace: true,
      intradaySmcRequirePremiumDiscount: false,
    };
  }
  return {
    intradaySmcIctProfile: "sweep",
    intradaySmcRequireChoch: false,
    intradaySmcRequireMss: false,
    intradaySmcRequireRetrace: false,
    intradaySmcRequirePremiumDiscount: false,
  };
}

const variants = [
  { tag: "preset_sweep", ...INTRADAY_PRO_ICT_15M },
  { tag: "preset_full", ...INTRADAY_PRO_ICT_FULL_15M },
  {
    tag: "strict_all_gates_on_sweep",
    ...INTRADAY_PRO_ICT_15M,
    intradaySmcRequireChoch: true,
    intradaySmcChochStrict: true,
    intradaySmcRequireMss: true,
    intradaySmcRequireRetrace: true,
    intradaySmcRequirePremiumDiscount: true,
    intradaySmcKillzoneMode: "LONDON_NY",
    intradaySmcHtfBiasMode: "parallel",
    intradaySmcHtfStrictness: "both",
    intradaySmcPickMode: "daily_sniper",
    intradaySmcOneTradePerDay: true,
  },
];

for (const profile of ["sweep", "balanced", "full"]) {
  for (const kz of ["ALL", "LONDON_NY", "NY"]) {
    for (const pick of ["per_signal", "daily_sniper"]) {
      for (const htf of [
        { intradaySmcHtfBiasMode: "ema", intradaySmcHtfStrictness: "either" },
        { intradaySmcHtfBiasMode: "parallel", intradaySmcHtfStrictness: "both" },
      ]) {
        variants.push({
          ...INTRADAY_PRO_ICT_15M,
          ...profilePatch(profile),
          intradaySmcKillzoneMode: kz,
          intradaySmcPickMode: pick,
          intradaySmcOneTradePerDay: pick !== "per_signal",
          ...htf,
        });
      }
    }
  }
}

process.stderr.write(`Simulating ${variants.length} configs on ${symbol} ${tf}...\n`);
const results = [];
const t0 = Date.now();
for (let i = 0; i < variants.length; i++) {
  const v = variants[i];
  const tag =
    v.tag ??
    `${v.intradaySmcIctProfile}_${v.intradaySmcKillzoneMode}_${v.intradaySmcPickMode}_${v.intradaySmcHtfBiasMode}`;
  results.push(await sim(v, tag));
  process.stderr.write(
    `  ${i + 1}/${variants.length} (${((Date.now() - t0) / 1000).toFixed(0)}s) ${tag} ret=${results.at(-1).returnPct}% wr=${results.at(-1).winRatePct}%\n`,
  );
}

const byReturn = [...results].sort((a, b) => b.returnPct - a.returnPct || b.winRatePct - a.winRatePct);
const byWr = [...results].filter((r) => r.entries >= 8).sort((a, b) => b.winRatePct - a.winRatePct || b.returnPct - a.returnPct);
const byComposite = [...results].sort((a, b) => b.composite - a.composite);
const byIct = [...results]
  .filter((r) => r.entries >= 8)
  .sort((a, b) => (b.ictScore !== a.ictScore ? b.ictScore - a.ictScore : b.returnPct - a.returnPct));

const pre = precomputeIntraday(candles);
attachSmcHtfToPre(candles, pre);

function funnelFor(cfgRaw, tag) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...cfgRaw, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
  const opts = buildIntradayOptsFromCfg(cfg);
  const c = {
    tag,
    passHtf: 0,
    passKz: 0,
    passVol: 0,
    hasCycle: 0,
    passChoch: 0,
    passMss: 0,
    hasPd: 0,
    inZone: 0,
    passSetup: 0,
    bars: 0,
  };
  for (let i = WARMUP; i < candles.length; i++) {
    if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
    c.bars++;
    for (const side of ["BUY", "SELL"]) {
      const st = countSmcFunnelStages(candles, i, side, pre, opts);
      if (st.passHtf) c.passHtf++;
      if (st.passKz) c.passKz++;
      if (st.passVol) c.passVol++;
      if (st.hasCycle) c.hasCycle++;
      if (st.passChoch) c.passChoch++;
      if (st.passMss) c.passMss++;
      if (st.hasPd) c.hasPd++;
      if (st.inZone) c.inZone++;
      if (st.passSetup) c.passSetup++;
    }
  }
  return c;
}

const bestReturnTag = byReturn[0]?.tag;
const bestReturnCfg = variants.find((v) => (v.tag ?? "") === bestReturnTag) ?? INTRADAY_PRO_ICT_15M;

function buildReport(funnels = null) {
  return {
    window: {
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      weeks: Math.round(weeks * 10) / 10,
      riskPerTrade: "2.5%",
    },
    configsTested: results.length,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    allResults: results,
    presetSweep: results.find((r) => r.tag === "preset_sweep"),
    presetFull: results.find((r) => r.tag === "preset_full"),
    strictAllGates: results.find((r) => r.tag === "strict_all_gates_on_sweep"),
    top5Return: byReturn.slice(0, 5),
    top5WinRateMin8Trades: byWr.slice(0, 5),
    top5Composite: byComposite.slice(0, 5),
    top5IctFundamentalsMin8Trades: byIct.slice(0, 5),
    funnels,
  };
}

const outPath = path.resolve(__dirname, "../.data/smc-ict-research.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });

function writeReport(report) {
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

writeReport(buildReport(null));
process.stderr.write(`Wrote sim results → ${outPath}\n`);

if (skipFunnel) {
  console.log(JSON.stringify(buildReport(null), null, 2));
  process.exit(0);
}

process.stderr.write("Computing funnel stages (4 configs, ~10 min)...\n");
const funnels = [
  funnelFor(INTRADAY_PRO_ICT_15M, "preset_sweep"),
  funnelFor(INTRADAY_PRO_ICT_FULL_15M, "preset_full"),
  funnelFor(bestReturnCfg, `best_return_${bestReturnTag}`),
  funnelFor(
    {
      ...INTRADAY_PRO_ICT_15M,
      ...profilePatch("balanced"),
      intradaySmcKillzoneMode: "ALL",
      intradaySmcPickMode: "per_signal",
      intradaySmcHtfBiasMode: "ema",
      intradaySmcHtfStrictness: "either",
    },
    "balanced_ALL_per_signal_ema",
  ),
];

const report = buildReport(funnels);
writeReport(report);
console.log(JSON.stringify(report, null, 2));
