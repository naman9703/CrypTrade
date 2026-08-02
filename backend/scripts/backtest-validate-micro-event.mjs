#!/usr/bin/env node
/**
 * MICRO_EVENT — walk-forward + Monte Carlo + 4-gate validation harness.
 *
 * Uses 1m bar-close proxy adapter with force_orders liq bars.
 * Document: sub-minute CVD/book not in historical replay until vision ingest extended.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/backtest-validate-micro-event.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const TF = process.env.TF || "1m";
const RISK = Number(process.env.RISK || 1);

let WINDOWS;
if (process.env.FROM && process.env.TO) {
  const from = Date.parse(process.env.FROM);
  const to = Date.parse(process.env.TO);
  const split = from + Math.round((to - from) * 0.6);
  WINDOWS = { IS: [from, split], OOS: [split, to], FULL: [from, to] };
} else {
  WINDOWS = {
    HOLD: [Date.parse("2024-06-01"), Date.parse("2025-01-01")],
    IS: [Date.parse("2025-01-01"), Date.parse("2025-07-01")],
    OOS: [Date.parse("2025-07-01"), Date.parse("2026-06-01")],
    FULL: [Date.parse("2024-06-01"), Date.parse("2026-06-01")],
  };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  hydrateMicroEventCfg,
  microEventPadFromMs,
  buildMicroEventBacktestAdapter,
} = await import("../src/strategy/microEventIntraday.js");
const { MICRO_EVENT_BTC_1M } = await import("../src/strategy/presets/microEventOptimized.js");
const { monteCarloBootstrap, acceptanceGates, purgedWalkForwardSplits } = await import(
  "../src/backtest/engine/validation.js"
);

function rOf(t) {
  let risk = Number(t.initialRiskUsd ?? 0);
  if (!(risk > 0)) {
    const entry = Number(t.entryPrice ?? t.entryFill);
    const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
      risk = Math.abs(entry - stop) * qty;
    }
  }
  return risk > 0 ? Number(t.netPnl) / risk : null;
}

function maxDdFromCurve(curve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve ?? []) {
    const e = Number(p.equity ?? p.eq ?? 0);
    if (e > peak) peak = e;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
  }
  return maxDd;
}

async function runWindow(label, from, to, candlesAll, fundingAll) {
  const padFrom = microEventPadFromMs(from, TF);
  const slice = candlesAll.filter((c) => Number(c.ts) >= padFrom && Number(c.ts) < to);
  const funding = fundingAll.filter((f) => Number(f.ts ?? f.time) >= padFrom && Number(f.ts ?? f.time) < to);
  const overrides = { ...MICRO_EVENT_BTC_1M, symbol: SYMBOL, riskPerTrade: RISK };
  if (process.env.OVERRIDES) Object.assign(overrides, JSON.parse(process.env.OVERRIDES));
  let cfg = await hydrateMicroEventCfg(overrides, SYMBOL, from, to);
  cfg = { ...cfg, backtestSignalStartMs: from, maxDailyLoss: 0, riskConsecutiveLossLimit: 0 };
  const adapter = buildMicroEventBacktestAdapter(slice, cfg, TF, {
    liqSeries: cfg._microEventLiqSeries ?? [],
  });
  const sim = await runSimulation({
    strategyKey: "MICRO_EVENT",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { MICRO_EVENT: adapter },
    symbol: SYMBOL,
    costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= from && Number(t.entryTs) < to);
  const weeks = (to - from) / (7 * 864e5);
  const finalEq = Number(sim.finalEquity ?? 100);
  const retPct = ((finalEq - 100) / 100) * 100;
  const ddPct = maxDdFromCurve(sim.equityCurve);
  const rs = trades.map(rOf).filter((x) => x != null && Number.isFinite(x));
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pfR = neg < 0 ? pos / -neg : pos > 0 ? 99 : 0;
  const years = (to - from) / (365.25 * 864e5);
  const cagr = years > 0 && finalEq > 0 ? (Math.pow(finalEq / 100, 1 / years) - 1) * 100 : null;
  const calmar = ddPct > 0 && cagr != null ? cagr / ddPct : cagr != null && cagr > 0 ? 99 : 0;
  const holdBars = trades.map((t) => Number(t.holdBars ?? 0)).filter((x) => x > 0);
  const medianHoldBars = holdBars.length
    ? holdBars.sort((a, b) => a - b)[Math.floor(holdBars.length / 2)]
    : null;
  const row = {
    label,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    calmar: +Number(calmar).toFixed(2),
    medianHoldBars,
    rs,
  };
  console.log(
    `${label.padEnd(5)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% pfR=${String(row.pfR).padStart(6)} hold=${medianHoldBars ?? "—"}b`,
  );
  return row;
}

console.log(`=== MICRO_EVENT validate ${SYMBOL} ${TF} @ ${RISK}% ===`);
const fullFrom = microEventPadFromMs(WINDOWS.FULL[0], TF);
const fullTo = WINDOWS.FULL[1];
const candlesAll = await readCandles(SYMBOL, TF, fullFrom, fullTo, { market: "futures" });
const fundingAll = await readFundingRates(SYMBOL, fullFrom, fullTo).catch(() => []);

const results = {};
for (const [label, [from, to]] of Object.entries(WINDOWS)) {
  if (label === "HOLD") continue;
  results[label] = await runWindow(label, from, to, candlesAll, fundingAll);
}

const fullRs = results.FULL?.rs ?? results.OOS?.rs ?? [];
const splits = purgedWalkForwardSplits(fullRs.length, { folds: 4, embargo: 2, mode: "rolling", minTrain: 20 });
const foldStats = [];
for (const s of splits) {
  const train = fullRs.slice(s.trainStart, s.trainEnd);
  const test = fullRs.slice(s.testStart, s.testEnd);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const trainM = mean(train);
  const testM = mean(test);
  const deg = trainM !== 0 ? ((trainM - testM) / Math.abs(trainM)) * 100 : 0;
  foldStats.push({
    fold: s.fold,
    trainN: train.length,
    testN: test.length,
    trainMeanR: +trainM.toFixed(3),
    testMeanR: +testM.toFixed(3),
    degPct: +deg.toFixed(1),
  });
}
const avgDeg = foldStats.length ? foldStats.reduce((a, f) => a + f.degPct, 0) / foldStats.length : 999;

const mc = monteCarloBootstrap(results.OOS?.rs ?? [], { paths: 2000, riskFrac: RISK / 100, seed: 20260729 });
const gates = acceptanceGates({
  oosReturnPct: results.OOS?.retPct ?? -999,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: results.FULL?.calmar ?? 0,
  walkForwardDegradationPct: avgDeg,
});

console.log("\n══ Gates ══");
for (const [k, g] of Object.entries(gates.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${k}: ${g.value} (need ${g.threshold})`);
}
console.log(`  ALL = ${gates.allPass ? "PASS" : "FAIL"}`);
const freqOk = (results.OOS?.tw ?? 0) >= 2 && (results.FULL?.tw ?? 0) >= 1.5;
console.log(`Frequency: OOS tw=${results.OOS?.tw} FULL tw=${results.FULL?.tw} → ${freqOk ? "OK" : "FAIL"}`);
const holdOk = (results.OOS?.medianHoldBars ?? 99) <= 15;
console.log(`Median hold: OOS ${results.OOS?.medianHoldBars ?? "—"} bars (≤15) → ${holdOk ? "OK" : "FAIL"}`);

const verdict =
  gates.allPass && freqOk && holdOk && (results.OOS?.n ?? 0) >= 30
    ? "ACCEPT_RESEARCH_SLEEVE"
    : gates.gates.oosPositive?.pass && (results.OOS?.n ?? 0) >= 10
      ? "PROMISING_PARTIAL"
      : "REJECT";

console.log(`\nVERDICT: ${verdict} (not certified — bar-close proxy until full tick replay)`);

const outPath = path.join(__dirname, ".micro-event-validate.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      tf: TF,
      windows: WINDOWS,
      results,
      foldStats,
      gates,
      mc: { p5ReturnPct: mc.p5ReturnPct, p50ReturnPct: mc.p50ReturnPct },
      verdict,
      limitation: "1m bar-close: liq+CVD+funding+OI replay; book imbalance live-only",
    },
    null,
    2,
  ),
);
console.log(`Wrote ${outPath}`);

const decisionPath = path.join(
  __dirname,
  ".research-decisions",
  `${new Date().toISOString().slice(0, 10)}-micro-event-phase0-validate.md`,
);
fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
fs.writeFileSync(
  decisionPath,
  `# MICRO_EVENT phase0 validate — ${verdict}\n\n- Symbol: ${SYMBOL} ${TF}\n- OOS n=${results.OOS?.n} tw=${results.OOS?.tw} ret=${results.OOS?.retPct}%\n- Gates all=${gates.allPass}\n- Limitation: bar-close liq proxy only\n`,
);

await closePool?.().catch(() => {});
