#!/usr/bin/env node
/**
 * Per-coin SR_INTRADAY liquidity-solo tune + OOS validation.
 *
 * - 5 random months (3 tune, 2 hold-out OOS by default)
 * - Grid search liquidity params on tune months
 * - Top candidates validated on OOS months + acceptance gates (MC + purged WF)
 *
 * Usage (from backend/):
 *   SYMBOL=BNBUSDT node scripts/backtest-liq-per-coin-oos.mjs
 *   SYMBOL=BTCUSDT MONTHS=2025-04,2025-08,2025-11,2026-02,2026-05 node scripts/backtest-liq-per-coin-oos.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = process.env.SYMBOL || process.env.SYMBOLS?.split(",")[0] || "BNBUSDT";
const TF = process.env.TF || "15m";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);
const TUNE_MONTHS = Math.max(1, Number(process.env.TUNE_MONTHS || 3));
const TOP_N = Math.max(1, Number(process.env.TOP_N || 8));

const DEFAULT_MONTHS = ["2025-03", "2025-07", "2025-10", "2026-01", "2026-04"];
const MONTHS = String(process.env.MONTHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_MONTHS = MONTHS.length ? MONTHS : DEFAULT_MONTHS;

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const to = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { from, to, label: ym };
}

const windows = TEST_MONTHS.map(monthWindow);
const tuneWindows = windows.slice(0, TUNE_MONTHS);
const oosWindows = windows.slice(TUNE_MONTHS);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);
const {
  INTRADAY_PRO_LIQ_15M,
  fillLiqSoloPresetDefaults,
  materializeIntradayEngineCfg,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

/** Hand-picked liquidity variants before full grid (faster first pass). */
const LOOSE_VARIANTS = [
  { label: "preset_default", patch: {} },
  {
    label: "loose_reclaim",
    patch: {
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinWickRatio: 0,
      intradayLiqMinRr: 0,
      intradayLiqMinScore: 5,
      intradayLiqRequireHtfAlign: false,
      intradayLiqMinReclaimBodyRatio: 0,
    },
  },
  {
    label: "loose_session_ext",
    patch: {
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinRr: 1.0,
      intradayLiqMinScore: 5,
      intradayLiqRequireHtfAlign: false,
      intradayLiqSessionExtreme: true,
      intradayLiqSessionExtremeMinTouches: 2,
      intradayLiqSessionExtremeMinExtensionPct: 0.001,
    },
  },
  {
    label: "moderate_htf",
    patch: {
      intradayLiqMinSweepExtensionPct: 0.005,
      intradayLiqMinRr: 1.25,
      intradayLiqMinReclaimBodyRatio: 0.25,
      intradayLiqRequireHtfAlign: true,
      intradayLiqMinHtfSep: 0.0005,
      intradayLiqMinScore: 5,
    },
  },
  {
    label: "sniper_strict",
    patch: {
      intradayLiqMinSweepExtensionPct: 0.008,
      intradayLiqMinRr: 1.5,
      intradayLiqMinReclaimBodyRatio: 0.35,
      intradayLiqRequireHtfAlign: true,
      intradayLiqMinHtfSep: 0.0008,
      intradayLiqOnePickPerDay: true,
    },
  },
  {
    label: "no_partial_tp",
    patch: {
      intradayLiqMinSweepExtensionPct: 0.005,
      intradayLiqMinRr: 1.25,
      intradayLiqRequireHtfAlign: false,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: true,
      intradayLiqBreakevenAfterPartial: false,
    },
  },
  {
    label: "higher_freq",
    patch: {
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinRr: 1.0,
      intradayLiqMinReclaimBodyRatio: 0,
      intradayLiqRequireHtfAlign: false,
      intradayLiqOnePickPerDay: false,
      intradayLiqMaxTradesPerSidePerDay: 2,
      srIntradayMaxTradesPerDay: 5,
      intradayLiqMinScore: 4,
    },
  },
  {
    label: "session_tight_rr15",
    patch: {
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.004,
      intradayLiqMinRr: 1.5,
      intradayLiqMinScore: 6,
      intradayLiqRequireHtfAlign: false,
      intradayLiqSessionExtreme: true,
      intradayLiqOnePickPerDay: true,
      intradayLiqMinReclaimBodyRatio: 0.25,
    },
  },
  {
    label: "session_sniper",
    patch: {
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.005,
      intradayLiqMinRr: 1.75,
      intradayLiqMinScore: 7,
      intradayLiqRequireHtfAlign: false,
      intradayLiqSessionExtreme: true,
      intradayLiqOnePickPerDay: true,
      intradayLiqMinReclaimBodyRatio: 0.35,
    },
  },
  {
    label: "session_one_pick",
    patch: {
      srIntradaySweepPct: 0.001,
      intradayLiqMinSweepExtensionPct: 0.003,
      intradayLiqMinRr: 1.25,
      intradayLiqMinScore: 6,
      intradayLiqRequireHtfAlign: false,
      intradayLiqSessionExtreme: true,
      intradayLiqOnePickPerDay: true,
      intradayLiqMaxTradesPerSidePerDay: 1,
      srIntradayMaxTradesPerDay: 2,
    },
  },
  {
    label: "sr_aplus",
    patch: {
      intradaySrAPlusMode: true,
      intradayGateInstitutionalSr: true,
      intradayGateSession: true,
      intradayGateHtfRegime: true,
      intradayLiqMinSweepExtensionPct: 0.004,
      intradayLiqMinRr: 2.0,
      intradaySrMinVolRatio: 1.15,
    },
  },
];

function buildGrid() {
  const mode = String(process.env.GRID || "coarse").toLowerCase();
  const grid = [];
  if (mode === "loose") {
    return LOOSE_VARIANTS.map((v) => ({ ...v.patch, __label: v.label }));
  }
  if (mode === "eth_session") {
    for (const ext of [0.002, 0.003, 0.004, 0.005, 0.006, 0.008]) {
      for (const rr of [1.0, 1.25, 1.5, 1.75, 2.0]) {
        for (const body of [0, 0.25, 0.35]) {
          for (const score of [5, 6, 7, 8]) {
            for (const pick of [true, false]) {
              grid.push({
                srIntradaySweepPct: 0.001,
                intradayLiqMinSweepExtensionPct: ext,
                intradayLiqMinRr: rr,
                intradayLiqMinReclaimBodyRatio: body,
                intradayLiqMinScore: score,
                intradayLiqRequireHtfAlign: false,
                intradayLiqSessionExtreme: true,
                intradayLiqSessionExtremeMinTouches: 2,
                intradayLiqSessionExtremeMinExtensionPct: 0.001,
                intradayLiqOnePickPerDay: pick,
                srIntradayMaxTradesPerDay: pick ? 2 : 4,
              });
            }
          }
        }
      }
    }
    return grid;
  }
  const full = mode === "full";
  const sweepExt = full
    ? [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01]
    : [0.001, 0.002, 0.003, 0.004, 0.006, 0.008, 0.01];
  const minRr = full ? [0, 1.0, 1.25, 1.5, 1.75, 2.0] : [0, 1.0, 1.5, 2.0];
  const bodyRatio = full ? [0, 0.2, 0.35] : [0, 0.25, 0.35];
  const htfModes = full
    ? [
        { intradayLiqRequireHtfAlign: false, intradayLiqMinHtfSep: 0 },
        { intradayLiqRequireHtfAlign: true, intradayLiqMinHtfSep: 0.0005 },
        { intradayLiqRequireHtfAlign: true, intradayLiqMinHtfSep: 0.0008 },
      ]
    : [
        { intradayLiqRequireHtfAlign: false, intradayLiqMinHtfSep: 0 },
        { intradayLiqRequireHtfAlign: true, intradayLiqMinHtfSep: 0.0008 },
      ];
  const minScore = full ? [4, 5, 6, 7] : [4, 5, 6];
  const onePick = full ? [true, false] : [true, false];
  const maxTrades = full ? [2, 3, 4] : [3, 4];

  for (const ext of sweepExt) {
    for (const rr of minRr) {
      for (const body of bodyRatio) {
        for (const htf of htfModes) {
          for (const score of minScore) {
            for (const pick of onePick) {
              for (const maxTd of maxTrades) {
                grid.push({
                  intradayLiqMinSweepExtensionPct: ext,
                  intradayLiqMinRr: rr,
                  intradayLiqMinReclaimBodyRatio: body,
                  intradayLiqMinScore: score,
                  intradayLiqOnePickPerDay: pick,
                  srIntradayMaxTradesPerDay: maxTd,
                  ...htf,
                });
              }
            }
          }
        }
      }
    }
  }
  return grid;
}

const GRID = buildGrid();

const common = {
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  marketMode: "FUTURES",
  symbol: SYMBOL,
  timeframe: TF,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  futuresLeverage: LEVERAGE,
};

const candleCache = new Map();

async function loadCandles(window) {
  const key = `${SYMBOL}|${window.label}`;
  if (candleCache.has(key)) return candleCache.get(key);
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const warmupMs = 21 * 86_400_000;
  const candles = await readCandles(SYMBOL, TF, fromMs - warmupMs, toMs, { market: "futures" });
  const v = { candles, fromMs, toMs };
  candleCache.set(key, v);
  return v;
}

function logicalTrades(trades, fromMs, toMs) {
  const seen = new Set();
  let n = 0;
  for (const t of trades) {
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const key = `${ts}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
  }
  return n;
}

function scoreTune(rows) {
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) return -1e9;
  const ret = ok.reduce((s, r) => s + r.ret, 0) / ok.length;
  const dd = ok.reduce((s, r) => s + r.dd, 0) / ok.length;
  const trades = ok.reduce((s, r) => s + r.trades, 0) / ok.length;
  const pf = ok.reduce((s, r) => s + (Number.isFinite(r.pf) ? r.pf : 0), 0) / ok.length;
  const posMonths = ok.filter((r) => r.ret > 0).length;
  // Reward positive months, PF, return; penalize DD and too-few trades
  return ret * 2 + pf * 5 + posMonths * 3 - dd * 0.8 - Math.max(0, 8 - trades) * 2;
}

async function runMonth(window, tunePatch) {
  const { candles, fromMs, toMs } = await loadCandles(window);
  if (!candles?.length) return { error: "no_candles", label: window.label };

  const base = fillLiqSoloPresetDefaults({
    ...INTRADAY_PRO_LIQ_15M,
    ...common,
    ...tunePatch,
    backtestSignalStartMs: fromMs,
  });
  const cfg = await materializeIntradayEngineCfg(base);

  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: Number(candles[0]?.ts) || fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: { slippagePct: 0.0005 },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const inWin = sim.trades.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  const metrics = computeAllMetrics({
    trades: inWin,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const trades = logicalTrades(sim.trades, fromMs, toMs);
  return {
    label: window.label,
    trades,
    ret: Number(metrics.totalReturnPct ?? 0),
    pf: Number(metrics.profitFactor ?? 0),
    wr: Number(metrics.winRate ?? 0) * 100,
    dd: Number(metrics.maxDrawdownPct ?? 0),
    avgR: Number(metrics.expectancyR ?? 0),
    calmar: Number(metrics.calmar ?? 0),
    sim,
    metrics,
  };
}

async function validateGates(tunePatch) {
  const fromMs = Date.parse(windows[0].from) - 21 * 86_400_000;
  const toMs = Date.parse(windows.at(-1).to);
  const candles = await readCandles(SYMBOL, TF, fromMs, toMs, { market: "futures" });
  let fundingRates = [];
  try {
    fundingRates = await readFundingRates(SYMBOL, fromMs, toMs);
  } catch {
    fundingRates = [];
  }

  const base = fillLiqSoloPresetDefaults({
    ...INTRADAY_PRO_LIQ_15M,
    ...common,
    ...tunePatch,
    backtestSignalStartMs: Date.parse(windows[0].from),
  });
  const cfg = await materializeIntradayEngineCfg(base);

  async function runSlice(slice, fundSlice) {
    const adapters = await buildBacktestAdapters({
      strategyKey: "SR_INTRADAY",
      cfg,
      symbol: SYMBOL,
      tf: TF,
      candles: slice,
      fromMs: slice[0]?.ts,
    });
    return runSimulation({
      strategyKey: "SR_INTRADAY",
      candles: slice,
      cfg,
      gateMode: "off",
      fundingRates: fundSlice,
      startingUsdt: START,
      timeframe: TF,
      symbol: SYMBOL,
      adapters,
    });
  }

  const sim = await runSlice(candles, fundingRates);
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });

  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 2000, riskFrac: RISK / 100, ruinDrawdownPct: 50 });

  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });

  let trainExpSum = 0;
  let testExpSum = 0;
  let testRetSum = 0;
  for (const s of splits) {
    const trainSlice = candles.slice(s.trainStart, s.trainEnd);
    const testSlice = candles.slice(s.testStart, s.testEnd);
    const ft = fundingRates.filter((f) => f.ts >= trainSlice[0]?.ts && f.ts <= trainSlice.at(-1)?.ts);
    const fe = fundingRates.filter((f) => f.ts >= testSlice[0]?.ts && f.ts <= testSlice.at(-1)?.ts);
    const tr = await runSlice(trainSlice, ft);
    const te = await runSlice(testSlice, fe);
    const trM = computeAllMetrics({ trades: tr.trades, equityCurve: tr.equityCurve, tf: TF, startingEquity: START });
    const teM = computeAllMetrics({ trades: te.trades, equityCurve: te.equityCurve, tf: TF, startingEquity: START });
    trainExpSum += trM.expectancy || 0;
    testExpSum += teM.expectancy || 0;
    testRetSum += teM.totalReturnPct || 0;
  }
  const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
  const avgTestExp = splits.length ? testExpSum / splits.length : 0;
  const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;

  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });

  return {
    full: {
      trades: m.totalTrades,
      ret: m.totalReturnPct ?? 0,
      calmar: m.calmar ?? 0,
      dd: m.maxDrawdownPct ?? 0,
      pf: m.profitFactor ?? 0,
    },
    mc: mc.insufficient ? { insufficient: true, rCount: rstats.rCount } : { p5: mc.p5ReturnPct, p50: mc.p50ReturnPct },
    wf: { degradationPct: wfDeg, oosRetSum: testRetSum },
    gate,
  };
}

console.log(`\n${"=".repeat(72)}`);
console.log(`LIQ per-coin OOS tune | ${SYMBOL} ${TF}`);
console.log(`Months: ${TEST_MONTHS.join(", ")} | tune=${tuneWindows.map((w) => w.label).join(",")} | oos=${oosWindows.map((w) => w.label).join(",")}`);
console.log(`Grid size: ${GRID.length} | risk=${RISK}% lev=${LEVERAGE}x`);

const ranked = [];
let done = 0;
for (const patch of GRID) {
  done++;
  if (done % 50 === 0) process.stderr.write(`  grid ${done}/${GRID.length}\n`);
  const tuneRows = [];
  for (const w of tuneWindows) {
    tuneRows.push(await runMonth(w, patch));
  }
  const sc = scoreTune(tuneRows);
  const avgRet = tuneRows.filter((r) => !r.error).reduce((s, r) => s + r.ret, 0) / Math.max(1, tuneRows.filter((r) => !r.error).length);
  const avgTr = tuneRows.filter((r) => !r.error).reduce((s, r) => s + r.trades, 0) / Math.max(1, tuneRows.filter((r) => !r.error).length);
  ranked.push({ patch, sc, tuneRows, avgRet, avgTr });
}

ranked.sort((a, b) => b.sc - a.sc);
const top = ranked.slice(0, TOP_N);

console.log(`\n--- TOP ${TOP_N} on tune months ---`);
for (const [i, row] of top.entries()) {
  const p = row.patch;
  console.log(
    `#${i + 1} score=${row.sc.toFixed(1)} tuneRet=${row.avgRet.toFixed(2)}% tr/mo=${row.avgTr.toFixed(1)} ` +
      `ext=${(p.intradayLiqMinSweepExtensionPct * 100).toFixed(2)}% rr=${p.intradayLiqMinRr} body=${p.intradayLiqMinReclaimBodyRatio} ` +
      `htf=${p.intradayLiqRequireHtfAlign ? p.intradayLiqMinHtfSep : "off"} score=${p.intradayLiqMinScore} pick=${p.intradayLiqOnePickPerDay} maxTd=${p.srIntradayMaxTradesPerDay}`,
  );
}

console.log(`\n--- OOS hold-out (${oosWindows.map((w) => w.label).join(", ")}) ---`);
const oosResults = [];
for (const [i, row] of top.entries()) {
  const oosRows = [];
  for (const w of oosWindows) {
    oosRows.push(await runMonth(w, row.patch));
  }
  const ok = oosRows.filter((r) => !r.error);
  const avgRet = ok.length ? ok.reduce((s, r) => s + r.ret, 0) / ok.length : -999;
  const avgTr = ok.length ? ok.reduce((s, r) => s + r.trades, 0) / ok.length : 0;
  const pos = ok.filter((r) => r.ret > 0).length;
  oosResults.push({ idx: i, patch: row.patch, avgRet, avgTr, pos, oosRows, tuneScore: row.sc });
  console.log(
    `#${i + 1} oosRet=${avgRet.toFixed(2)}% tr/mo=${avgTr.toFixed(1)} posMo=${pos}/${oosWindows.length} ` +
      `months=${oosRows.map((r) => `${r.label}:${r.ret.toFixed(1)}%/${r.trades}tr`).join(" ")}`,
  );
}

oosResults.sort((a, b) => {
  const aScore = a.avgRet * 2 + a.pos * 5 + a.avgTr;
  const bScore = b.avgRet * 2 + b.pos * 5 + b.avgTr;
  return bScore - aScore;
});

console.log(`\n--- ACCEPTANCE GATES (top OOS candidates) ---`);
let bestPass = null;
for (const cand of oosResults.slice(0, 5)) {
  const v = await validateGates(cand.patch);
  const pass = v.gate.allPass;
  console.log(
    `#${cand.idx + 1} gates=${pass ? "PASS" : "FAIL"} fullRet=${v.full.ret.toFixed(1)}% calmar=${v.full.calmar.toFixed(2)} ` +
      `mcP5=${v.mc.insufficient ? "n/a" : v.mc.p5.toFixed(1)}% wfDeg=${v.wf.degradationPct.toFixed(1)}% oosWF=${v.wf.oosRetSum.toFixed(1)}%`,
  );
  for (const [name, g] of Object.entries(v.gate.gates)) {
    console.log(`    ${g.pass ? "PASS" : "FAIL"} ${name}: ${Number(g.value).toFixed(2)} (need ${g.threshold})`);
  }
  if (pass && !bestPass) bestPass = { cand, v };
}

const bestOos = oosResults[0];
const allMonthRows = [];
for (const w of windows) {
  allMonthRows.push(await runMonth(w, bestOos.patch));
}
const okAll = allMonthRows.filter((r) => !r.error);
const summary = {
  symbol: SYMBOL,
  months: TEST_MONTHS,
  tuneMonths: tuneWindows.map((w) => w.label),
  oosMonths: oosWindows.map((w) => w.label),
  bestPatch: bestOos.patch,
  tuneScore: bestOos.tuneScore,
  oosAvgRetMo: bestOos.avgRet,
  oosAvgTradesMo: bestOos.avgTr,
  all5AvgRetMo: okAll.reduce((s, r) => s + r.ret, 0) / okAll.length,
  all5AvgTradesMo: okAll.reduce((s, r) => s + r.trades, 0) / okAll.length,
  monthly: allMonthRows.map((r) => ({
    month: r.label,
    ret: r.ret,
    trades: r.trades,
    pf: r.pf,
    dd: r.dd,
  })),
  passesGates: Boolean(bestPass),
  gateDetail: bestPass?.v.gate ?? null,
};

console.log(`\n${"=".repeat(72)}`);
console.log("BEST CANDIDATE SUMMARY");
console.log(JSON.stringify(summary, null, 2));

await closePool?.();
