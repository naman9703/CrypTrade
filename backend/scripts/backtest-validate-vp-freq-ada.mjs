#!/usr/bin/env node
/**
 * ADA VOLUME_PROFILE_FREQ certification harness.
 *
 * Frozen locked preset — no param sweep. Chronological expanding purged WF +
 * Monte Carlo + acceptance gates + funding + cost stresses + year table.
 *
 * Usage:
 *   node scripts/backtest-validate-vp-freq-ada.mjs
 *   FROM=2021-01-01 TO=2026-05-31 FOLDS=5 node scripts/backtest-validate-vp-freq-ada.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "ADAUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
const START_USDT = Number(process.env.START_USDT || 100);
const FOLDS = Math.max(3, Math.floor(Number(process.env.FOLDS || 5)));
const RISK_PCT = Number(process.env.RISK_PCT || 2.5);
const LEVERAGE = Number(process.env.LEVERAGE || 12);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ADA_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);
const { liquidityCrunchCostModel } = await import("../src/backtest/engine/stressScenarios.js");

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
    ...VOLUME_PROFILE_FREQ_ADA_15M,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    ...over,
  };
}

async function runWindow(candles, funding, cfg, signalStartMs = null) {
  const runCfg = {
    ...cfg,
    backtestSignalStartMs: signalStartMs ?? cfg.backtestSignalStartMs ?? null,
  };
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, runCfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: runCfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START_USDT,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  return { sim, m, closed };
}

function yearTable(closed) {
  const years = {};
  let eq = START_USDT;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

console.log(`\n=== ADA VP FREQ certification — ${SYMBOL} ${TF} ${FROM}→${TO} ===`);
console.log(`locked preset · risk%=${RISK_PCT} lev=${LEVERAGE}x · expanding WF folds=${FOLDS}\n`);

const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ADA_15M);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
if (!candles?.length) {
  console.error("No candles — abort");
  await closePool?.();
  process.exit(1);
}

let funding = [];
try {
  funding = await readFundingRates(SYMBOL, padFrom, toMs);
} catch {
  funding = [];
}
console.log(`candles=${candles.length} funding=${funding.length} first=${new Date(candles[0].ts).toISOString()} last=${new Date(candles.at(-1).ts).toISOString()}`);

let signalStartIdx = 0;
for (let i = 0; i < candles.length; i++) {
  if (candles[i].ts >= fromMs) {
    signalStartIdx = i;
    break;
  }
}

const cfg = baseCfg({ backtestSignalStartMs: fromMs });
const { sim, m, closed } = await runWindow(candles, funding, cfg, fromMs);
const weeks = (toMs - fromMs) / (7 * 86_400_000);
const tPerWk = closed.length / weeks;
const years = yearTable(closed);
const negYears = Object.entries(years).filter(([, v]) => v.retPct < 0).map(([y]) => y);

console.log(
  `FULL: trades=${closed.length} (${tPerWk.toFixed(2)}/wk) net=${fmt(m.totalReturnPct)}% CAGR=${fmt(m.cagrPct)}% Calmar=${fmt(m.calmar, 2)} maxDD=${fmt(m.maxDrawdownPct)}% Sharpe=${fmt(m.sharpe, 2)} PF=${fmt(m.profitFactor, 2)} WR=${fmt((m.winRate || 0) * 100, 0)}%`,
);
console.log(`  years: ${Object.entries(years).map(([y, v]) => `${y}=${fmt(v.retPct)}%/${v.n}`).join("  ")}`);
console.log(`  negYears=${negYears.join(",") || "none"}`);

const rstats = rMultipleStats(sim.trades);
const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
if (!mc.insufficient) {
  console.log(
    `MC(1% risk): ret p5=${fmt(mc.p5ReturnPct)}% p50=${fmt(mc.p50ReturnPct)}% p95=${fmt(mc.p95ReturnPct)}%  maxDD p95=${fmt(mc.p95MaxDdPct)}% ruin=${fmt(mc.riskOfRuinPct)}%`,
  );
} else {
  console.log(`MC: insufficient trades (${rstats.rCount})`);
}

const signalBars = candles.length - signalStartIdx;
const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
const splits = purgedWalkForwardSplits(signalBars, {
  folds: FOLDS,
  embargo,
  mode: "expanding",
  minTrain: Math.floor(96 * 30),
});

let trainExp = 0;
let testExp = 0;
let testRetSum = 0;
let oosTrades = 0;
const foldRows = [];
console.log(`\nWF expanding folds=${splits.length} embargo=${embargo}bars (~1d)`);
for (const s of splits) {
  const trainEndAbs = signalStartIdx + s.trainEnd;
  const testStartAbs = signalStartIdx + s.testStart;
  const testEndAbs = signalStartIdx + s.testEnd;
  const trainSlice = candles.slice(0, trainEndAbs);
  const testSlice = candles.slice(0, testEndAbs);
  const trainSignalStart = candles[signalStartIdx + s.trainStart]?.ts ?? fromMs;
  const testSignalStart = candles[testStartAbs]?.ts ?? fromMs;

  const tr = await runWindow(trainSlice, funding, baseCfg(), trainSignalStart);
  const te = await runWindow(testSlice, funding, baseCfg(), testSignalStart);
  const teClosed = te.closed.filter((t) => {
    const ts = Number(t.entryTs ?? t.entry_time);
    return ts >= testSignalStart && ts < (candles[testEndAbs - 1]?.ts ?? toMs) + stepMs;
  });
  let teEq = START_USDT;
  let tePeak = START_USDT;
  let teDd = 0;
  let teWins = 0;
  for (const t of teClosed) {
    const pnl = Number(t.netPnl ?? 0);
    teEq += pnl;
    tePeak = Math.max(tePeak, teEq);
    teDd = Math.max(teDd, tePeak > 0 ? ((tePeak - teEq) / tePeak) * 100 : 0);
    if (pnl > 0) teWins++;
  }
  const teRet = teEq - START_USDT;
  const teExpFold = teClosed.length ? teRet / teClosed.length : 0;
  trainExp += tr.m.expectancy || 0;
  testExp += teExpFold;
  testRetSum += teRet;
  oosTrades += teClosed.length;
  foldRows.push({
    fold: s.fold,
    trainN: tr.closed.length,
    testN: teClosed.length,
    testRet: teRet,
    testDd: teDd,
    testWr: teClosed.length ? (teWins / teClosed.length) * 100 : 0,
    from: new Date(testSignalStart).toISOString().slice(0, 10),
    to: new Date(candles[testEndAbs - 1]?.ts ?? toMs).toISOString().slice(0, 10),
  });
  console.log(
    `  fold ${s.fold}: ${foldRows.at(-1).from}→${foldRows.at(-1).to}  trainN=${tr.closed.length} testN=${teClosed.length} testRet=${fmt(teRet)}% DD=${fmt(teDd)}% WR=${fmt(foldRows.at(-1).testWr, 0)}%`,
  );
}

const avgTr = splits.length ? trainExp / splits.length : 0;
const avgTe = splits.length ? testExp / splits.length : 0;
const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;
const gate = acceptanceGates({
  oosReturnPct: testRetSum,
  mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
  calmar: m.calmar ?? -1,
  walkForwardDegradationPct: wfDeg,
});

const freqOk = tPerWk >= 2;
const nOk = oosTrades >= 30;
const extraGates = {
  oosTradesGe30: { pass: nOk, value: oosTrades, threshold: ">= 30" },
  frequencyDeployable: {
    pass: freqOk,
    value: Number(tPerWk.toFixed(3)),
    threshold: ">= 2/wk",
  },
  noCatastrophicYear: {
    pass: !Object.values(years).some((v) => v.retPct <= -25),
    value: negYears,
    threshold: "no year ret <= -25%",
  },
};

console.log(`\nWF: degradation=${fmt(wfDeg)}% OOSsumRet=${fmt(testRetSum)}% OOStrades=${oosTrades}`);
console.log(
  `GATES: ${Object.entries(gate.gates)
    .map(([k, gg]) => `${gg.pass ? "PASS" : "FAIL"}:${k}`)
    .join(" ")}`,
);
console.log(
  `EXTRA: ${Object.entries(extraGates)
    .map(([k, gg]) => `${gg.pass ? "PASS" : "FAIL"}:${k}`)
    .join(" ")}`,
);

const costVariants = [
  { label: "slip_x2", patch: { slippagePct: 0.001 } },
  { label: "slip_x4", patch: { slippagePct: 0.002 } },
  { label: "liq_crunch", patch: liquidityCrunchCostModel({ slippagePct: 0.0005 }) },
];
const costRows = [];
console.log("\nCOST STRESS (full window):");
for (const v of costVariants) {
  const r = await runWindow(candles, funding, baseCfg(v.patch), fromMs);
  costRows.push({
    label: v.label,
    n: r.closed.length,
    ret: r.m.totalReturnPct,
    dd: r.m.maxDrawdownPct,
  });
  console.log(`  ${v.label.padEnd(12)} N=${r.closed.length} ret=${fmt(r.m.totalReturnPct)}% DD=${fmt(r.m.maxDrawdownPct)}%`);
}

const allPass = gate.allPass && extraGates.oosTradesGe30.pass && extraGates.noCatastrophicYear.pass;
const sleeve =
  gate.allPass &&
  extraGates.oosTradesGe30.pass &&
  extraGates.noCatastrophicYear.pass &&
  !extraGates.frequencyDeployable.pass;
const verdict = allPass && extraGates.frequencyDeployable.pass
  ? "CERTIFY_CANDIDATE"
  : sleeve
    ? "RESEARCH_SLEEVE_LOW_FREQ"
    : "REJECT_CERTIFICATION";

console.log(`\nVERDICT: ${verdict} (gates=${gate.allPass ? "pass" : "fail"} freq=${extraGates.frequencyDeployable.pass ? "ok" : "low"})`);

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  timeframe: TF,
  window: { from: FROM, to: TO },
  preset: "VOLUME_PROFILE_FREQ_ADA_15M",
  full: {
    trades: closed.length,
    tPerWk,
    returnPct: m.totalReturnPct,
    cagrPct: m.cagrPct,
    calmar: m.calmar,
    maxDdPct: m.maxDrawdownPct,
    sharpe: m.sharpe,
    profitFactor: m.profitFactor,
    winRate: m.winRate,
    years,
    negYears,
  },
  monteCarlo: mc,
  walkForward: { folds: foldRows, degradationPct: wfDeg, oosReturnSum: testRetSum, oosTrades },
  gates: gate,
  extraGates,
  costStress: costRows,
  verdict,
};

const outPath = path.resolve(__dirname, ".vp-freq-ada-certification.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("wrote", outPath);

await closePool?.();
process.exitCode = verdict === "REJECT_CERTIFICATION" ? 2 : 0;
