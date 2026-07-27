#!/usr/bin/env node
/**
 * AAVE cert-repair Phase D — cut early train expectancy to fix WF degradation.
 *
 * Best year-clean: noBear htf0.20 — oosN=27 wfDeg=44% (need <35% and oosN≥30).
 * Best oosN: noBear htf0.18 — oosN=33 wfDeg=46% cal1.31 but 2023-24 −2%.
 *
 * Hypothesis: 2020-21 BUY bull_trend vacuum blow-offs inflate train expectancy,
 * so (trainExp-testExp)/|trainExp| stays high even when OOS sum is positive.
 * Cap BUY prior60 / body / or deny BUY bull_trend vacuum on noBear base.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-cert-repair-early.mjs
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
const { VOLUME_PROFILE_BASE, VOLUME_PROFILE_FREQ_CORE, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js"
);

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
    vpMinHtfSepPct: 0.002,
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

function fullSum(closed, m) {
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
  const y21 = years["2020-21"]?.retPct ?? 0;
  return {
    n: closed.length,
    tw: +(closed.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    years,
    negYears: Object.entries(years).filter(([, v]) => v.retPct < 0).map(([y, v]) => `${y}=${v.retPct}%`),
    earlyShare: closed.length ? +(earlyN / closed.length).toFixed(2) : 0,
    y2021: y21,
    catYear: Object.values(years).some((v) => v.retPct <= -25),
  };
}

async function wfMc(candles, funding, signalStartIdx, cfg, calmar) {
  const { sim } = await runWindow(candles, funding, cfg, fromMs);
  const mc = monteCarloBootstrap(rMultipleStats(sim.trades).rValues, {
    paths: 2000,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const splits = purgedWalkForwardSplits(candles.length - signalStartIdx, {
    folds: FOLDS,
    embargo: Math.max(1, Math.round(86_400_000 / stepMs)),
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
    folds.push({ fold: s.fold, testN: teClosed.length, testRet: +teRet.toFixed(2), trainExp: +(tr.m.expectancy || 0).toFixed(3) });
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
    avgTrainExp: +avgTr.toFixed(3),
    avgTestExp: +avgTe.toFixed(3),
    oosSum: +testRetSum.toFixed(2),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(2),
    folds,
    corePass: gate.allPass,
    sleeveOk: gate.allPass && oosTrades >= 30,
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, baseCfg());
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

const variants = [
  { id: "H0_noBear_htf20", over: {} },
  { id: "htf18", over: { vpMinHtfSepPct: 0.0018 } },
  { id: "htf20_buyP60_100", over: { vpBuyRejectionMaxPrior60dPct: 1.0 } },
  { id: "htf20_buyP60_050", over: { vpBuyRejectionMaxPrior60dPct: 0.5 } },
  { id: "htf20_buyBody25", over: { vpBuyRejectionMinBody: 0.25 } },
  {
    id: "htf20_deny_BUY_bullVac",
    over: {
      vpPreparedBlockCellKeys: [...BLEED_NO_BEAR, "BUY|va_rejection|bull_trend|vacuum"],
    },
  },
  {
    id: "htf18_buyP60_100",
    over: { vpMinHtfSepPct: 0.0018, vpBuyRejectionMaxPrior60dPct: 1.0 },
  },
  {
    id: "htf18_buyP60_050",
    over: { vpMinHtfSepPct: 0.0018, vpBuyRejectionMaxPrior60dPct: 0.5 },
  },
  {
    id: "htf18_deny_BUY_bullVac",
    over: {
      vpMinHtfSepPct: 0.0018,
      vpPreparedBlockCellKeys: [...BLEED_NO_BEAR, "BUY|va_rejection|bull_trend|vacuum"],
    },
  },
  {
    id: "htf15_buyP60_050",
    over: { vpMinHtfSepPct: 0.0015, vpBuyRejectionMaxPrior60dPct: 0.5 },
  },
];

console.log(`\n══ Phase D — early-expectancy cut ══`);
const rows = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const cfg = baseCfg(v.over);
  const { m, closed } = await runWindow(candles, funding, cfg, fromMs);
  const full = fullSum(closed, m);
  const wf = await wfMc(candles, funding, signalStartIdx, cfg, m.calmar ?? -1);
  const row = { id: v.id, over: v.over, ...full, ...wf };
  rows.push(row);
  console.log(
    `${v.id}\n  n=${row.n} y21=${row.y2021}% early=${row.earlyShare} cal=${row.calmar} trainExp=${row.avgTrainExp} testExp=${row.avgTestExp}\n  oosN=${row.oosTrades} wfDeg=${row.wfDeg}% mcP5=${row.mcP5} | RED:${row.negYears.join(",") || "none"} | core=${row.corePass} sleeve=${row.sleeveOk}`,
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
fs.writeFileSync(path.join(__dirname, ".vp-freq-aave-cert-repair-early.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows, best }, null, 2));
console.log(`\n══ Best: ${best?.id} sleeve=${best?.sleeveOk} core=${best?.corePass} wfDeg=${best?.wfDeg} oosN=${best?.oosTrades} ══`);
await closePool?.();
