#!/usr/bin/env node
/**
 * AAVE cert-repair — Phase A FULL rank (fast), then Phase B WF+MC on top candidates.
 *
 * Root cause: HTF 0.35% N-crush → 53% trades in 2020-21, WF testN 0-5 → deg 70%.
 * Fix: loosen HTF on sellExt+bleed; score by n/earlyShare/calmar/year health.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-cert-repair.mjs
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
const TOP_WF = 4;

const BLEED = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
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
    vpMinHtfSepPct: 0.0015,
    vpMinScore: 7,
    vpMinBarGap: 2,
    vpMaxTradesPerDay: 2,
    vpRejectionSellBlockExtendedDown: true,
    vpRejectionExtendedPriorPct: 0.05,
    vpPreparedBlockCellKeys: BLEED,
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
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const closed = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  return { sim, m, closed };
}

function yearTable(closed) {
  const years = {};
  let eq = START;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) {
    r.retPct = r.start ? +(((r.end - r.start) / r.start) * 100).toFixed(2) : 0;
  }
  return years;
}

function fullMetrics(closed, m) {
  const years = yearTable(closed);
  const weeks = (toMs - fromMs) / (7 * 864e5);
  const earlyN = (years["2020-21"]?.n ?? 0) + (years["2021-22"]?.n ?? 0);
  const negYears = Object.entries(years)
    .filter(([, v]) => v.retPct < 0)
    .map(([y, v]) => `${y}=${v.retPct}%`);
  return {
    n: closed.length,
    tw: +(closed.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
    negYears,
    earlyShare: closed.length ? +(earlyN / closed.length).toFixed(2) : 0,
    catYear: Object.values(years).some((v) => v.retPct <= -25),
  };
}

async function runWfMc(candles, funding, signalStartIdx, cfg, closedFull, mFull) {
  const rstats = rMultipleStats(
    (
      await runWindow(candles, funding, cfg, fromMs)
    ).sim.trades,
  );
  // reuse full run for MC from closedFull via re-sim already done — call MC on fresh rstats
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

  let trainExp = 0;
  let testExp = 0;
  let testRetSum = 0;
  let oosTrades = 0;
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
    folds.push({ fold: s.fold, trainN: tr.closed.length, testN: teClosed.length, testRet: +teRet.toFixed(2) });
  }
  const avgTr = splits.length ? trainExp / splits.length : 0;
  const avgTe = splits.length ? testExp / splits.length : 0;
  const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;
  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: mFull.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  return {
    oosTrades,
    wfDeg: +wfDeg.toFixed(1),
    oosSum: +testRetSum.toFixed(2),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(2),
    folds,
    gates: gate.gates,
    corePass: gate.allPass,
    sleeveOk: gate.allPass && oosTrades >= 30 && !fullMetrics(closedFull, mFull).catYear,
  };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, baseCfg());
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

let signalStartIdx = 0;
for (let i = 0; i < candles.length; i++) {
  if (candles[i].ts >= fromMs) {
    signalStartIdx = i;
    break;
  }
}

const variants = [
  { id: "LOCKED_htf35_REJECT", over: { vpMinHtfSepPct: 0.0035 } },
  { id: "htf15_sellExt_bleed", over: { vpMinHtfSepPct: 0.0015 } },
  { id: "htf20_sellExt_bleed", over: { vpMinHtfSepPct: 0.002 } },
  { id: "htf25_sellExt_bleed", over: { vpMinHtfSepPct: 0.0025 } },
  { id: "htf30_sellExt_bleed", over: { vpMinHtfSepPct: 0.003 } },
  {
    id: "htf15_bleed_only",
    over: { vpMinHtfSepPct: 0.0015, vpRejectionSellBlockExtendedDown: false },
  },
  {
    id: "htf15_no_bearVac",
    over: {
      vpMinHtfSepPct: 0.0015,
      vpPreparedBlockCellKeys: BLEED.filter((k) => k !== "SELL|va_rejection|bear_trend|vacuum"),
    },
  },
  {
    id: "htf20_no_bearVac",
    over: {
      vpMinHtfSepPct: 0.002,
      vpPreparedBlockCellKeys: BLEED.filter((k) => k !== "SELL|va_rejection|bear_trend|vacuum"),
    },
  },
  {
    id: "htf15_bleed_poc",
    over: { vpMinHtfSepPct: 0.0015, vpAllowedSetups: ["va_rejection", "poc_bounce"] },
  },
  {
    id: "htf20_bleed_poc",
    over: { vpMinHtfSepPct: 0.002, vpAllowedSetups: ["va_rejection", "poc_bounce"] },
  },
];

console.log(`\n══ Phase A — FULL rank (restore N / cut earlyShare) ══`);
const phaseA = [];
for (const v of variants) {
  console.error(`FULL ${v.id}`);
  const cfg = baseCfg(v.over);
  const { m, closed } = await runWindow(candles, funding, cfg, fromMs);
  const full = fullMetrics(closed, m);
  phaseA.push({ id: v.id, over: v.over, ...full });
  console.log(
    `${v.id} n=${full.n} tw=${full.tw} ret=${full.ret}% cal=${full.calmar} early=${full.earlyShare} cat=${full.catYear} | RED:${full.negYears.join(",") || "none"}`,
  );
}

// Prefer: more n, earlyShare down from 0.57, calmar high, no cat year, fewer/milder reds
phaseA.sort(
  (a, b) =>
    Number(!b.catYear) - Number(!a.catYear) ||
    Number(b.n >= 45) - Number(a.n >= 45) ||
    Number(b.calmar >= 1) - Number(a.calmar >= 1) ||
    Number(b.earlyShare < 0.45) - Number(a.earlyShare < 0.45) ||
    b.n - a.n ||
    b.calmar - a.calmar ||
    a.negYears.length - b.negYears.length,
);

console.log("\n══ Phase A ranked ══");
for (const r of phaseA) {
  console.log(
    `${r.id.padEnd(26)} n=${r.n} early=${r.earlyShare} cal=${r.calmar} ret=${r.ret}% reds=${r.negYears.length} cat=${r.catYear}`,
  );
}

const top = phaseA.filter((r) => r.id !== "LOCKED_htf35_REJECT").slice(0, TOP_WF);
// always include locked reject for comparison
const locked = phaseA.find((r) => r.id === "LOCKED_htf35_REJECT");
const wfList = [locked, ...top].filter(Boolean);

console.log(`\n══ Phase B — WF+MC on: ${wfList.map((r) => r.id).join(", ")} ══`);
const phaseB = [];
for (const v of wfList) {
  console.error(`WF ${v.id}`);
  const cfg = baseCfg(v.over);
  const { m, closed } = await runWindow(candles, funding, cfg, fromMs);
  const full = fullMetrics(closed, m);
  const wf = await runWfMc(candles, funding, signalStartIdx, cfg, closed, m);
  const row = { id: v.id, over: v.over, ...full, ...wf };
  phaseB.push(row);
  console.log(
    `${v.id}\n  n=${row.n} early=${row.earlyShare} cal=${row.calmar} oosN=${row.oosTrades} wfDeg=${row.wfDeg}% mcP5=${row.mcP5} oosSum=${row.oosSum}%\n  core=${row.corePass} sleeve=${row.sleeveOk} folds=${row.folds.map((f) => f.testN).join("/")} | RED:${row.negYears.join(",") || "none"}`,
  );
}

phaseB.sort(
  (a, b) =>
    Number(b.sleeveOk) - Number(a.sleeveOk) ||
    Number(b.corePass) - Number(a.corePass) ||
    Number(b.oosTrades >= 30) - Number(a.oosTrades >= 30) ||
    a.wfDeg - b.wfDeg ||
    b.calmar - a.calmar,
);

const best = phaseB.find((r) => r.sleeveOk) || phaseB.find((r) => r.corePass && r.oosTrades >= 30) || phaseB[0];
const outPath = path.join(__dirname, ".vp-freq-aave-cert-repair.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      rootCause:
        "HTF 0.35% over-filter → early-year concentration (earlyShare~0.57) + WF fold sparsity (testN 0-5) → degradation 70% / OOS n=13. Not an expectancy failure.",
      phaseA,
      phaseB,
      best: best
        ? {
            id: best.id,
            over: best.over,
            n: best.n,
            oosTrades: best.oosTrades,
            wfDeg: best.wfDeg,
            calmar: best.calmar,
            earlyShare: best.earlyShare,
            corePass: best.corePass,
            sleeveOk: best.sleeveOk,
            negYears: best.negYears,
          }
        : null,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
console.log(`\n══ Best repair: ${best?.id ?? "none"} sleeve=${best?.sleeveOk} core=${best?.corePass} ══`);
await closePool?.();
