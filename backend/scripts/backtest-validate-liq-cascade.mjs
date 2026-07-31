#!/usr/bin/env node
/**
 * LIQ_CASCADE — walk-forward + Monte Carlo + 4-gate validation harness.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/backtest-validate-liq-cascade.mjs
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
const LIQ_INTERVAL = process.env.LIQ_INTERVAL || "5min";
const LIQ_SOURCE = process.env.LIQ_SOURCE || "coinalyze";
const DIRECTION = process.env.DIRECTION || null; // "fade" | "continuation"
const MIN_OI_DROP = process.env.MIN_OI_DROP != null ? Number(process.env.MIN_OI_DROP) : null;

// If FROM/TO given (short liq-data coverage), split 60/40 into IS/OOS; no HOLD.
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
  hydrateLiqCascadeCfg,
  liqCascadePadFromMs,
  buildLiqCascadeBacktestAdapter,
} = await import("../src/strategy/liqCascadeIntraday.js");
const { LIQ_CASCADE_BTC_1M } = await import("../src/strategy/presets/liqCascadeOptimized.js");
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
  const padFrom = liqCascadePadFromMs(from, TF);
  const slice = candlesAll.filter((c) => Number(c.ts) >= padFrom && Number(c.ts) < to);
  const funding = fundingAll.filter((f) => Number(f.ts ?? f.time) >= padFrom && Number(f.ts ?? f.time) < to);
  const overrides = {
    ...LIQ_CASCADE_BTC_1M,
    symbol: SYMBOL,
    riskPerTrade: RISK,
    liqCascadeInterval: LIQ_INTERVAL,
    liqCascadeLiqSource: LIQ_SOURCE,
  };
  if (DIRECTION) overrides.liqCascadeDirectionMode = DIRECTION;
  if (MIN_OI_DROP != null) overrides.liqCascadeMinOiDropPct = MIN_OI_DROP;
  if (process.env.OVERRIDES) Object.assign(overrides, JSON.parse(process.env.OVERRIDES));
  let cfg = await hydrateLiqCascadeCfg(overrides, SYMBOL, from, to);
  cfg = { ...cfg, backtestSignalStartMs: from, maxDailyLoss: 0, riskConsecutiveLossLimit: 0 };
  const adapter = buildLiqCascadeBacktestAdapter(slice, cfg, TF, {
    liqSeries: cfg._liqCascadeLiqSeries ?? [],
    oiSeries: cfg._liqCascadeOiSeries ?? [],
  });
  const sim = await runSimulation({
    strategyKey: "LIQ_CASCADE",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { LIQ_CASCADE: adapter },
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
  const row = {
    label,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    calmar: +Number(calmar).toFixed(2),
    rs,
  };
  console.log(
    `${label.padEnd(5)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% pfR=${String(row.pfR).padStart(6)} calmar=${row.calmar}`,
  );
  return row;
}

console.log(`=== LIQ_CASCADE validate ${SYMBOL} ${TF} @ ${RISK}% source=${LIQ_SOURCE} interval=${LIQ_INTERVAL} ===`);
const fullFrom = liqCascadePadFromMs(WINDOWS.FULL[0], TF);
const fullTo = WINDOWS.FULL[1];
const candlesAll = await readCandles(SYMBOL, TF, fullFrom, fullTo, { market: "futures" });
const fundingAll = await readFundingRates(SYMBOL, fullFrom, fullTo).catch(() => []);

const results = {};
for (const [label, [from, to]] of Object.entries(WINDOWS)) {
  results[label] = await runWindow(label, from, to, candlesAll, fundingAll);
}

const fullRs = results.FULL.rs;
const splits = purgedWalkForwardSplits(fullRs.length, { folds: 4, embargo: 2, mode: "rolling", minTrain: 20 });
const foldStats = [];
for (const s of splits) {
  const train = fullRs.slice(s.trainStart, s.trainEnd);
  const test = fullRs.slice(s.testStart, s.testEnd);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const trainM = mean(train);
  const testM = mean(test);
  const deg = trainM !== 0 ? ((trainM - testM) / Math.abs(trainM)) * 100 : 0;
  foldStats.push({ fold: s.fold, trainN: train.length, testN: test.length, trainMeanR: +trainM.toFixed(3), testMeanR: +testM.toFixed(3), degPct: +deg.toFixed(1) });
}
const avgDeg = foldStats.length ? foldStats.reduce((a, f) => a + f.degPct, 0) / foldStats.length : 999;

const mc = monteCarloBootstrap(results.OOS.rs, { paths: 2000, riskFrac: RISK / 100, seed: 20260729 });
const gates = acceptanceGates({
  oosReturnPct: results.OOS.retPct,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: results.FULL.calmar,
  walkForwardDegradationPct: avgDeg,
});

console.log("\n══ Gates ══");
for (const [k, g] of Object.entries(gates.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${k}: ${g.value} (need ${g.threshold})`);
}
console.log(`  ALL = ${gates.allPass ? "PASS" : "FAIL"}`);
const freqOk = results.OOS.tw >= 2 && results.FULL.tw >= 1.5;
console.log(`Frequency: OOS tw=${results.OOS.tw} FULL tw=${results.FULL.tw} → ${freqOk ? "OK" : "FAIL"}`);

const verdict =
  gates.allPass && freqOk && results.OOS.n >= 30
    ? "ACCEPT_RESEARCH_SLEEVE"
    : gates.gates.oosPositive?.pass && results.OOS.n >= 10
      ? "PROMISING_PARTIAL"
      : "REJECT";

console.log(`\nVERDICT: ${verdict}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-cascade-validate.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      results: Object.fromEntries(Object.entries(results).map(([k, v]) => {
        const { rs, ...rest } = v;
        return [k, rest];
      })),
      walkForward: { folds: foldStats, avgDegPct: +avgDeg.toFixed(1) },
      monteCarlo: mc,
      gates,
      freqOk,
      verdict,
    },
    null,
    2,
  ),
);

const decisionPath = path.join(__dirname, ".research-decisions/liq-cascade-validate-lastrun.md");
fs.writeFileSync(
  decisionPath,
  `# LIQ_CASCADE — Phase 0 + validation (${new Date().toISOString().slice(0, 10)})

**Status:** \`${verdict}\`
**Symbol:** ${SYMBOL} ${TF} @ ${RISK}% risk
**Script:** \`backtest-validate-liq-cascade.mjs\`, \`research-liq-cascade-phase0.mjs\`

## Results (FULL / OOS)

| Window | n | tw/wk | ret | Calmar | PF(R) |
|--------|---|-------|-----|--------|-------|
| FULL | ${results.FULL.n} | ${results.FULL.tw} | ${results.FULL.retPct}% | ${results.FULL.calmar} | ${results.FULL.pfR} |
| OOS | ${results.OOS.n} | ${results.OOS.tw} | ${results.OOS.retPct}% | — | ${results.OOS.pfR} |

## Gates

- oosPositive: ${gates.gates.oosPositive.pass ? "PASS" : "FAIL"} (${results.OOS.retPct}%)
- mcP5Positive: ${gates.gates.mcP5Positive.pass ? "PASS" : "FAIL"} (${mc.p5ReturnPct}%)
- calmarOver1: ${gates.gates.calmarOver1.pass ? "PASS" : "FAIL"} (${results.FULL.calmar})
- wfDegradationOk: ${gates.gates.wfDegradationOk.pass ? "PASS" : "FAIL"} (${avgDeg.toFixed(1)}%)
- Frequency ≥2/wk: ${freqOk ? "PASS" : "FAIL"}

## Notes

- Bar-close backtest uses Coinalyze ${process.env.LIQ_INTERVAL || "5min"} aggregated liquidations + OI (not tick-level forceOrder history).
- Live tick executor (\`liqCascadeLiveEngine.js\`) is paper-gated; requires \`liqCascadeLiveTickEnabled\` and blocks LIVE unless \`LIQ_CASCADE_LIVE_ALLOW=1\`.
- Do not deploy until OOS n≥30 and all gates pass.
`,
);

console.log(`Wrote ${decisionPath}`);
await closePool?.();
