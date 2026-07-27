#!/usr/bin/env node
/**
 * AAVE cert-repair Phase C — fine HTF ladder on year-clean no_bearVac stack.
 *
 * Best so far: htf20_no_bearVac — YEAR CLEAN, n=46, cal 1.48, oosN=27, wfDeg=44%.
 * Need: oosN≥30 and wfDeg<35%. Try HTF 0.015–0.022 + sellExt + bleed without bearVac.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-cert-repair-htf.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "AAVEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const FOLDS = 5;

const BLEED_NO_BEAR = [
  "SELL|va_rejection|weak_bear|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_chop|structured",
  "SELL|va_rejection|bull_chop|vacuum",
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const { purgedWalkForwardSplits, acceptanceGates, monteCarloBootstrap } = await import(
  "../src/backtest/engine/validation.js"
);
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function baseCfg(over = {}) {
  return {
    ...VOLUME_PROFILE_BASE,
    ...VOLUME_PROFILE_FREQ_CORE,
    vpPlaybook: "CUSTOM",
    vpMinAdx: 0.0001,
    symbol: SYMBOL,
    timeframe: TF,
    vpAllowedSetups: ["va_rejection"],
    vpNoveltyEnabled: false,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    vpRequireHtfAlign: true,
    vpMinScore: 7,
    vpMinBarGap: 2,
    vpMaxTradesPerDay: 2,
    vpRejectionSellBlockExtendedDown: true,
    vpRejectionExtendedPriorPct: 0.05,
    vpPreparedBlockCellKeys: BLEED_NO_BEAR,
    ...over,
  };
}

async function runWindow(candles, funding, cfg, signalStartMs) {
  const runCfg = { ...cfg, backtestSignalStartMs: signalStartMs ?? null };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: runCfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, runCfg, TF) },
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const closed = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  return { sim, m, closed };
}

function summarizeFull(closed, m) {
  const years = {};
  let eq = START;
  for (const t of closed) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? +(((r.end - r.start) / r.start) * 100).toFixed(2) : 0;
  const weeks = (toMs - fromMs) / (7 * 864e5);
  const earlyN = (years["2020-21"]?.n ?? 0) + (years["2021-22"]?.n ?? 0);
  const negYears = Object.entries(years).filter(([, v]) => v.retPct < 0).map(([y, v]) => `${y}=${v.retPct}%`);
  return {
    n: closed.length,
    tw: +(closed.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    years,
    negYears,
    earlyShare: closed.length ? +(earlyN / closed.length).toFixed(2) : 0,
    catYear: Object.values(years).some((v) => v.retPct <= -25),
  };
}

async function wfMc(candles, funding, signalStartIdx, cfg, calmar) {
  const { sim } = await runWindow(candles, funding, cfg, fromMs);
  const rs = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rs.rValues, { paths: 2000, riskFrac: 0.01, ruinDrawdownPct: 50 });
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length - signalStartIdx, {
    folds: FOLDS,
    embargo,
    mode: "expanding",
    minTrain: Math.floor(96 * 30),
  });
  let trainExp = 0,
    testExp = 0,
    testRetSum = 0,
    oosTrades = 0;
  const folds = [];
  for (const s of splits) {
    const trainEndAbs = signalStartIdx + s.trainEnd;
    const testStartAbs = signalStartIdx + s.testStart;
    const testEndAbs = signalStartIdx + s.testEnd;
    const trainSignalStart = candles[signalStartIdx + s.trainStart]?.ts ?? fromMs;
    const testSignalStart = candles[testStartAbs]?.ts ?? fromMs;
    const tr = await runWindow(candles.slice(0, trainEndAbs), funding, cfg, trainSignalStart);
    const te = await runWindow(candles.slice(0, testEndAbs), funding, cfg, testSignalStart);
    const teClosed = te.closed.filter((t) => {
      const ts = Number(t.entryTs);
      return ts >= testSignalStart && ts < (candles[testEndAbs - 1]?.ts ?? toMs) + stepMs;
    });
    let teEq = START;
    for (const t of teClosed) teEq += Number(t.netPnl ?? 0);
    const teRet = teEq - START;
    trainExp += tr.m.expectancy || 0;
    testExp += teClosed.length ? teRet / teClosed.length : 0;
    testRetSum += teRet;
    oosTrades += teClosed.length;
    folds.push({ fold: s.fold, testN: teClosed.length, testRet: +teRet.toFixed(2) });
  }
  const avgTr = splits.length ? trainExp / splits.length : 0;
  const avgTe = splits.length ? testExp / splits.length : 0;
  const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;
  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar,
    walkForwardDegradationPct: wfDeg,
  });
  return {
    oosTrades,
    wfDeg: +wfDeg.toFixed(1),
    oosSum: +testRetSum.toFixed(2),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(2),
    folds,
    corePass: gate.allPass,
    sleeveOk: gate.allPass && oosTrades >= 30,
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, baseCfg({ vpMinHtfSepPct: 0.002 }));
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
let signalStartIdx = 0;
for (let i = 0; i < candles.length; i++) {
  if (candles[i].ts >= fromMs) {
    signalStartIdx = i;
    break;
  }
}

const seps = [0.0015, 0.0017, 0.0018, 0.002, 0.0022, 0.0025];
const rows = [];
console.log(`\n══ no_bearVac HTF fine ladder + WF ══`);
for (const sep of seps) {
  const id = `noBear_htf_${String(sep).replace("0.", "")}`;
  console.error(`run ${id}`);
  const cfg = baseCfg({ vpMinHtfSepPct: sep });
  const { m, closed } = await runWindow(candles, funding, cfg, fromMs);
  const full = summarizeFull(closed, m);
  const wf = await wfMc(candles, funding, signalStartIdx, cfg, m.calmar ?? -1);
  const row = { id, sep, over: { vpMinHtfSepPct: sep, vpPreparedBlockCellKeys: BLEED_NO_BEAR }, ...full, ...wf };
  rows.push(row);
  console.log(
    `${id} n=${row.n} early=${row.earlyShare} cal=${row.calmar} oosN=${row.oosTrades} wfDeg=${row.wfDeg}% mcP5=${row.mcP5} | RED:${row.negYears.join(",") || "none"} | core=${row.corePass} sleeve=${row.sleeveOk} folds=${row.folds.map((f) => f.testN).join("/")}`,
  );
}

rows.sort(
  (a, b) =>
    Number(b.sleeveOk) - Number(a.sleeveOk) ||
    Number(b.corePass) - Number(a.corePass) ||
    Number(b.negYears.length === 0) - Number(a.negYears.length === 0) ||
    Number(b.oosTrades >= 30) - Number(a.oosTrades >= 30) ||
    a.wfDeg - b.wfDeg ||
    b.calmar - a.calmar,
);
const best = rows.find((r) => r.sleeveOk) || rows.find((r) => r.corePass) || rows[0];
fs.writeFileSync(
  path.join(__dirname, ".vp-freq-aave-cert-repair-htf.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), rows, best }, null, 2),
);
console.log(`\n══ Best: ${best?.id} sleeve=${best?.sleeveOk} core=${best?.corePass} yearClean=${best?.negYears?.length === 0} ══`);
await closePool?.();
