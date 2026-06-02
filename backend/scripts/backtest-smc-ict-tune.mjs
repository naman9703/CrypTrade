#!/usr/bin/env node
/**
 * SMC/ICT tuning harness — full-sim grid ranked by composite objective with a
 * hard trade-frequency floor (intraday needs ~6-7 trades/week).
 * Usage: node scripts/backtest-smc-ict-tune.mjs [from] [to] [minPerWeek]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const minPerWeek = Number(args[2] || 2);
const weeks = (toMs - fromMs) / (7 * 864e5);
const MIN_TRADES = Math.floor(minPerWeek * weeks);

const { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import(
  "../src/strategy/intradayPro.js",
);
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

function baseCfg(overrides = {}) {
  return fillSmcSoloPresetDefaults({
    ...INTRADAY_PRO_ICT_15M,
    symbol,
    timeframe: tf,
    intradaySmcIctProfile: "balanced",
    intradaySmcRequireMss: true,
    intradaySmcRequireRetrace: true,
    intradaySmcRequireChoch: true,
    intradaySmcChochStrict: false,
    ...overrides,
  });
}

async function sim(overrides) {
  const cfg = baseCfg(overrides);
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
  const entries = new Set(trades.map((t) => t.entryTs));
  // Win rate by distinct entry: an entry wins if its summed netPnl > 0.
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const entryPnls = [...byEntry.values()];
  const wins = entryPnls.filter((p) => p > 0).length;
  const grossWin = entryPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(entryPnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const pnl = entryPnls.reduce((a, b) => a + b, 0);
  const startEq = 10_000;
  let peak = startEq;
  let eq = startEq;
  let maxDd = 0;
  const ordered = trades.slice().sort((a, b) => a.exitTs - b.exitTs);
  for (const t of ordered) {
    eq += Number(t.netPnl ?? 0);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  const nEntries = entries.size;
  return {
    entries: nEntries,
    perWeek: Math.round((nEntries / weeks) * 10) / 10,
    winRatePct: nEntries ? Math.round((wins / nEntries) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / startEq) * 10000) / 100,
    pnlUsdt: Math.round(pnl * 100) / 100,
    maxDdPct: Math.round(maxDd * 10000) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
  };
}

/** Composite: reward return + win rate, penalize drawdown; require frequency floor. */
function score(m) {
  if (m.entries < MIN_TRADES) return -1e9;
  const ret = m.returnPct;
  const wr = m.winRatePct;
  const dd = Math.max(0.5, m.maxDdPct);
  const pf = m.profitFactor ?? 0;
  return ret * 0.5 + wr * 1.5 + pf * 10 - dd * 1.0;
}

const variants = [];
let id = 0;
const STAGE = process.argv.includes("--refine") ? "refine" : "coarse";
const profileVals =
  STAGE === "refine"
    ? ["balanced", "sweep"]
    : ["balanced", "sweep", "full"];
// Focused grid over the knobs that drive frequency + win rate.
const killzones = STAGE === "refine" ? ["ALL", "NY", "OVERLAP"] : ["ALL"];
const adxVals = STAGE === "refine" ? [0, 8, 12, 15, 18] : [0];
const rrVals = STAGE === "refine" ? [0, 1, 1.5, 2, 2.5] : [0, 1.5];
const mssVals = [true];
const retraceVals = [true];
const htfReqVals = [true, false];
const tp1Vals = [true, false];
const beVals = STAGE === "refine" ? [true, false] : [true];
const entryZones = STAGE === "refine" ? ["EITHER", "FVG", "OB"] : ["EITHER"];

for (const profile of profileVals)
  for (const kz of killzones)
    for (const adx of adxVals)
      for (const rr of rrVals)
        for (const mss of mssVals)
          for (const retrace of retraceVals)
            for (const htfReq of htfReqVals)
              for (const tp1 of tp1Vals)
                for (const be of beVals)
                  for (const ez of entryZones) {
                    const chochOff = profile === "sweep" || profile === "lite";
                    variants.push({
                      id: id++,
                      overrides: {
                        intradaySmcIctProfile: profile,
                        intradaySmcRequireChoch: profile === "full" || profile === "balanced",
                        intradaySmcChochStrict: profile === "full" || profile === "ict2022",
                        intradaySmcRequireBos: profile === "full" || profile === "ict2022",
                        ...(chochOff
                          ? { intradaySmcRequireChoch: false, intradaySmcChochStrict: false }
                          : {}),
                        intradaySmcKillzoneMode: kz,
                      intradaySmcMinAdx: adx,
                      intradaySmcMinRr: rr,
                      intradayLiqMinRr: rr,
                      intradaySmcRequireMss: mss,
                      intradaySmcRequireRetrace: retrace,
                      intradaySmcRequireFvgRetrace: retrace,
                      intradaySmcRequireHtfBias: htfReq,
                      intradaySmcEntryZoneMode: ez,
                      intradayLiqTp1Enabled: tp1,
                      intradayLiqPartialTp: tp1,
                      intradayLiqTp2Enabled: true,
                      intradayLiqBreakevenAfterPartial: be,
                    },
                  });
                }

process.stderr.write(
  `Tuning ${variants.length} configs on ${symbol} ${tf} (${weeks.toFixed(1)}w, floor=${MIN_TRADES} trades)...\n`,
);

const results = [];
const t0 = Date.now();
for (const v of variants) {
  const m = await sim(v.overrides);
  results.push({ ...v, m, score: score(m) });
  process.stderr.write(
    `  ${v.id + 1}/${variants.length} (${((Date.now() - t0) / 1000).toFixed(0)}s) ` +
      `entries=${m.entries} wr=${m.winRatePct}% ret=${m.returnPct}%\n`,
  );
}

results.sort((a, b) => b.score - a.score);

function fmt(r) {
  const o = r.overrides;
  return {
    score: Math.round(r.score * 10) / 10,
    profile: o.intradaySmcIctProfile,
    kz: o.intradaySmcKillzoneMode,
    adx: o.intradaySmcMinAdx,
    rr: o.intradaySmcMinRr,
    mss: o.intradaySmcRequireMss,
    retrace: o.intradaySmcRequireRetrace,
    htfReq: o.intradaySmcRequireHtfBias,
    ez: o.intradaySmcEntryZoneMode,
    tp1: o.intradayLiqTp1Enabled,
    be: o.intradayLiqBreakevenAfterPartial,
    ...r.m,
  };
}

const passing = results.filter((r) => r.m.entries >= MIN_TRADES);
console.log(
  JSON.stringify(
    {
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      weeks: Math.round(weeks * 10) / 10,
      minTradesFloor: MIN_TRADES,
      configsTested: variants.length,
      passingFrequency: passing.length,
      top15: results.slice(0, 15).map(fmt),
      bestByReturn: [...passing].sort((a, b) => b.m.returnPct - a.m.returnPct).slice(0, 5).map(fmt),
      bestByWinRate: [...passing].sort((a, b) => b.m.winRatePct - a.m.winRatePct).slice(0, 5).map(fmt),
    },
    null,
    2,
  ),
);
