#!/usr/bin/env node
/**
 * Hard A/B: risk economics on BUYBD+comp≥0.75.
 *
 * Hypothesis (exit-risk autopsy): residual DD / left-tail is loss-cluster driven.
 * Soft drop of 3rd+ consecutive losers: meanR 0.077→0.265, synDD 26→9%.
 * Engine already has causal guards (rest-of-day after N consec losses; max daily loss).
 * Preset sets them but research validation had them OFF — measure honest effect.
 *
 * One family, isolated variants (guards only — no entry changes):
 *   baseline      guards off
 *   consec3       riskConsecutiveLossLimit=3
 *   daily3        maxDailyLoss=3%
 *   both          consec3 + daily3 (preset-as-designed)
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-risk-guard-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const PAD = 150 * 864e5;
const WINDOWS = {
  HOLD: [Date.parse("2023-07-01"), Date.parse("2024-07-01")],
  IS: [Date.parse("2024-07-01"), Date.parse("2025-07-01")],
  OOS: [Date.parse("2025-07-01"), Date.parse("2026-07-24")],
  FULL: [Date.parse("2023-07-01"), Date.parse("2026-07-24")],
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
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
function halfKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
}
function maxDdFromCurve(curve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve ?? []) {
    const e = Number(p.equity ?? 0);
    if (e > peak) peak = e;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
  }
  return maxDd;
}

const candlesAll = await readCandles(SYMBOL, TF, WINDOWS.FULL[0] - PAD, WINDOWS.FULL[1], {
  market: "futures",
});
const fundingAll = await readFundingRates(SYMBOL, WINDOWS.FULL[0] - PAD, WINDOWS.FULL[1]).catch(() => []);

async function runOne(id, from, to, guardPatch) {
  clearIntradayAdapterCache?.();
  const slice = candlesAll.filter((c) => Number(c.ts) >= from - PAD && Number(c.ts) < to);
  const funding = fundingAll.filter(
    (f) => Number(f.ts ?? f.time) >= from - PAD && Number(f.ts ?? f.time) < to,
  );
  let cfg = {
    ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
    backtestSignalStartMs: from,
    ...guardPatch,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(slice, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
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
  const calmar = ddPct > 0 && cagr != null ? cagr / ddPct : 0;
  const halves = {};
  for (const h of [...new Set(trades.map((t) => halfKey(t.entryTs)))].sort()) {
    const hrs = trades
      .filter((t) => halfKey(t.entryTs) === h)
      .map(rOf)
      .filter((x) => x != null);
    halves[h] = {
      n: hrs.length,
      meanR: hrs.length ? +(hrs.reduce((a, b) => a + b, 0) / hrs.length).toFixed(3) : null,
    };
  }
  return {
    id,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    cagr: cagr != null ? +cagr.toFixed(2) : null,
    calmar: +Number(calmar).toFixed(2),
    halves,
    rs,
    riskOverlay: sim.riskOverlayReplay ?? null,
  };
}

const VARIANTS = [
  ["baseline", {}],
  ["consec3", { riskConsecutiveLossLimit: 3 }],
  ["daily3", { maxDailyLoss: 3, maxDailyLossUnit: "PCT" }],
  ["both", { riskConsecutiveLossLimit: 3, maxDailyLoss: 3, maxDailyLossUnit: "PCT" }],
];

console.log("=== Hard A/B: risk guards on BUYBD+comp≥0.75 ===\n");
const matrix = {};
for (const [vid, patch] of VARIANTS) {
  console.log(`── ${vid} ──`);
  matrix[vid] = {};
  for (const [wlabel, [from, to]] of Object.entries(WINDOWS)) {
    const row = await runOne(`${vid}/${wlabel}`, from, to, patch);
    matrix[vid][wlabel] = row;
    const halfStr =
      wlabel === "FULL"
        ? " | " +
          Object.entries(row.halves)
            .map(([h, m]) => `${h}:${m.meanR}(n${m.n})`)
            .join(" ")
        : "";
    console.log(
      `  ${wlabel.padEnd(5)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% pfR=${String(row.pfR).padStart(6)} meanR=${String(row.meanR).padStart(7)} calmar=${String(row.calmar).padStart(5)}${halfStr}`,
    );
  }
  console.log("");
}

// Pick best by: OOS ret>0, FULL calmar, no red half, tw≥1.5 OOS
function score(vid) {
  const f = matrix[vid].FULL;
  const o = matrix[vid].OOS;
  const red = Object.values(f.halves).filter((m) => m.n >= 10 && (m.meanR ?? 0) < -0.05).length;
  if (!(o.retPct > 0) || red > 0) return -999;
  return f.calmar * 10 + o.meanR * 5 + (o.tw >= 1.7 ? 1 : 0);
}
const ranked = VARIANTS.map(([v]) => v).sort((a, b) => score(b) - score(a));
const best = ranked[0];
console.log(`best by score: ${best} (score=${score(best).toFixed(2)})`);

// Full validate best
const bestFull = matrix[best].FULL;
const bestOos = matrix[best].OOS;
const splits = purgedWalkForwardSplits(bestFull.rs.length, {
  folds: 4,
  embargo: 2,
  mode: "rolling",
  minTrain: 30,
});
const foldStats = [];
for (const s of splits) {
  const train = bestFull.rs.slice(s.trainStart, s.trainEnd);
  const test = bestFull.rs.slice(s.testStart, s.testEnd);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const trainM = mean(train);
  const testM = mean(test);
  const deg = trainM !== 0 ? ((trainM - testM) / Math.abs(trainM)) * 100 : 0;
  foldStats.push({ fold: s.fold, trainMeanR: +trainM.toFixed(3), testMeanR: +testM.toFixed(3), degPct: +deg.toFixed(1) });
}
const avgDeg = foldStats.length ? foldStats.reduce((a, f) => a + f.degPct, 0) / foldStats.length : 999;
const mc = monteCarloBootstrap(bestOos.rs, { paths: 2000, riskFrac: 0.025, seed: 20260725 });
const gates = acceptanceGates({
  oosReturnPct: bestOos.retPct,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: bestFull.calmar,
  walkForwardDegradationPct: avgDeg,
});
const redHalves = Object.entries(bestFull.halves).filter(([, m]) => m.n >= 10 && (m.meanR ?? 0) < -0.05);
const freqOk = bestOos.tw >= 1.7 && matrix[best].HOLD.tw >= 1.5 && bestFull.tw >= 1.7;

console.log(`\n══ Validate best=${best} ══`);
console.log(
  `MC OOS: p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}% medianDD=${mc.medianMaxDdPct.toFixed(1)}%`,
);
console.log(`WF avg deg=${avgDeg.toFixed(1)}%`);
for (const [k, g] of Object.entries(gates.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${k}: ${Number(g.value).toFixed?.(2) ?? g.value} (need ${g.threshold})`);
}
console.log(`  ALL=${gates.allPass ? "PASS" : "FAIL"} freqOk=${freqOk} redHalves=${redHalves.length}`);

const verdict =
  gates.allPass && freqOk && redHalves.length === 0
    ? "ACCEPT_GATES"
    : gates.gates.oosPositive.pass && bestFull.calmar > matrix.baseline.FULL.calmar
      ? "IMPROVES_PARTIAL"
      : "REJECT";
console.log(`VERDICT: ${verdict}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-risk-guard-ab.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      matrix: Object.fromEntries(
        Object.entries(matrix).map(([vid, wins]) => [
          vid,
          Object.fromEntries(
            Object.entries(wins).map(([w, row]) => {
              const { rs, ...rest } = row;
              return [w, rest];
            }),
          ),
        ]),
      ),
      best,
      walkForward: { folds: foldStats, avgDegPct: +avgDeg.toFixed(1) },
      monteCarlo: mc,
      gates,
      freqOk,
      redHalves: redHalves.map(([h, m]) => ({ h, ...m })),
      verdict,
    },
    null,
    2,
  ),
);
console.log("Wrote .liq-buybd-risk-guard-ab.json");
await closePool?.();
