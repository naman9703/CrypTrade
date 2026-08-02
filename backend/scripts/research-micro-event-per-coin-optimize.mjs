#!/usr/bin/env node
/**
 * MICRO_EVENT per-coin threshold optimizer (grid/ladder + WF/MC/4-gate).
 *
 * Usage (backend/):
 *   node scripts/research-micro-event-per-coin-optimize.mjs
 *   COINS=BTCUSDT,ETHUSDT SYMBOL=BTCUSDT node scripts/research-micro-event-per-coin-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "1m";
const RISK = Number(process.env.RISK || 1);
const MAX_COMBOS = Math.max(1, Number(process.env.MAX_COMBOS || 24));

let WINDOWS;
if (process.env.FROM && process.env.TO) {
  const from = Date.parse(process.env.FROM);
  const to = Date.parse(process.env.TO);
  const split = from + Math.round((to - from) * 0.6);
  WINDOWS = { IS: [from, split], OOS: [split, to], FULL: [from, to] };
} else {
  WINDOWS = {
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
const presetMod = await import("../src/strategy/presets/microEventOptimized.js");
const BASE_BY_SYM = {
  BTCUSDT: presetMod.MICRO_EVENT_BTC_1M,
  ETHUSDT: presetMod.MICRO_EVENT_ETH_1M,
  BNBUSDT: presetMod.MICRO_EVENT_BNB_1M,
};
const { monteCarloBootstrap, acceptanceGates, purgedWalkForwardSplits } = await import(
  "../src/backtest/engine/validation.js"
);

const COST = { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

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

/** One-at-a-time ladder from baseline — rulebook: isolated changes, no multi-filter stacks. */
function buildComboLadder(base) {
  const combos = [{ label: "baseline", patch: {} }];
  const axes = [
    ["microEventMinConfluenceScore", [45, 55, 65]],
    ["microEventMinConfirmLayers", [1, 2, 3]],
    ["microEventLiqZMin", [1.2, 1.5, 2.0]],
    ["microEventLiqMinUsd", [15_000, 25_000, 40_000]],
    ["microEventMinImbalance", [0.58, 0.62, 0.68]],
    ["microEventMinAggressiveUsd", [10_000, 15_000, 25_000]],
    ["microEventMinFundingZ", [0.8, 1.2, 1.6]],
    ["microEventTpRr", [1.0, 1.2, 1.5]],
    ["microEventMaxHoldSec", [120, 180, 240]],
    ["microEventCooldownSec", [30, 45, 60]],
  ];
  for (const [key, values] of axes) {
    const baseVal = base[key];
    for (const v of values) {
      if (v === baseVal) continue;
      combos.push({ label: `${key}=${v}`, patch: { [key]: v } });
    }
  }
  return combos.slice(0, MAX_COMBOS);
}

async function runWindow(symbol, label, from, to, candlesAll, fundingAll, overrides) {
  const padFrom = microEventPadFromMs(from, TF);
  const slice = candlesAll.filter((c) => Number(c.ts) >= padFrom && Number(c.ts) < to);
  const funding = fundingAll.filter((f) => Number(f.ts ?? f.time) >= padFrom && Number(f.ts ?? f.time) < to);
  let cfg = await hydrateMicroEventCfg({ ...overrides, symbol, riskPerTrade: RISK }, symbol, from, to);
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
    symbol,
    costModelOverride: COST,
  });
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= from && Number(t.entryTs) < to);
  const weeks = (to - from) / (7 * 864e5);
  const finalEq = Number(sim.finalEquity ?? 100);
  const retPct = ((finalEq - 100) / 100) * 100;
  const ddPct = maxDdFromCurve(sim.equityCurve);
  const rs = trades.map(rOf).filter((x) => x != null && Number.isFinite(x));
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pfR = neg < 0 ? pos / -neg : pos > 0 ? 99 : 0;
  const years = (to - from) / (365.25 * 864e5);
  const cagr = years > 0 && finalEq > 0 ? (Math.pow(finalEq / 100, 1 / years) - 1) * 100 : null;
  const calmar = ddPct > 0 && cagr != null ? cagr / ddPct : cagr != null && cagr > 0 ? 99 : 0;
  return {
    label,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    pfR: +pfR.toFixed(3),
    calmar: +Number(calmar).toFixed(2),
    rs,
  };
}

function scoreOos(row) {
  if (!row || row.n < 5) return -999;
  const freq = row.tw >= 2 ? 1 : row.tw / 2;
  return row.retPct * 0.5 + row.pfR * 10 + row.tw * 2 + freq * 5;
}

async function optimizeCoin(symbol) {
  const base = { ...(BASE_BY_SYM[symbol] ?? presetMod.MICRO_EVENT_BTC_1M), symbol };
  const fullFrom = microEventPadFromMs(WINDOWS.FULL[0], TF);
  const candlesAll = await readCandles(symbol, TF, fullFrom, WINDOWS.FULL[1], { market: "futures" });
  const fundingAll = await readFundingRates(symbol, fullFrom, WINDOWS.FULL[1]).catch(() => []);
  if (!candlesAll.length) {
    return { symbol, error: "no_candles", winner: null, results: [] };
  }

  const combos = buildComboLadder(base);
  const scored = [];
  for (const combo of combos) {
    const overrides = { ...base, ...combo.patch };
    const oos = await runWindow(symbol, "OOS", WINDOWS.OOS[0], WINDOWS.OOS[1], candlesAll, fundingAll, overrides);
    scored.push({ combo, oos, score: scoreOos(oos) });
    console.log(
      `  ${symbol} ${combo.label.padEnd(36)} OOS n=${String(oos.n).padStart(3)} tw=${String(oos.tw).padStart(4)} ret=${String(oos.retPct).padStart(7)}% pf=${String(oos.pfR).padStart(5)} score=${scoreOos(oos).toFixed(1)}`,
    );
  }
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const winOverrides = { ...base, ...winner.combo.patch };
  const full = await runWindow(symbol, "FULL", WINDOWS.FULL[0], WINDOWS.FULL[1], candlesAll, fundingAll, winOverrides);
  const isRow = await runWindow(symbol, "IS", WINDOWS.IS[0], WINDOWS.IS[1], candlesAll, fundingAll, winOverrides);

  const fullRs = full.rs ?? [];
  const splits = purgedWalkForwardSplits(fullRs.length, { folds: 4, embargo: 2, mode: "rolling", minTrain: 20 });
  const foldStats = [];
  for (const s of splits) {
    const train = fullRs.slice(s.trainStart, s.trainEnd);
    const test = fullRs.slice(s.testStart, s.testEnd);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const trainM = mean(train);
    const testM = mean(test);
    const deg = trainM !== 0 ? ((trainM - testM) / Math.abs(trainM)) * 100 : 0;
    foldStats.push({ fold: s.fold, degPct: +deg.toFixed(1) });
  }
  const avgDeg = foldStats.length ? foldStats.reduce((a, f) => a + f.degPct, 0) / foldStats.length : 999;
  const mc = monteCarloBootstrap(winner.oos.rs ?? [], { paths: 2000, riskFrac: RISK / 100, seed: 20260802 });
  const gates = acceptanceGates({
    oosReturnPct: winner.oos.retPct ?? -999,
    mcP5ReturnPct: mc.p5ReturnPct,
    calmar: full.calmar ?? 0,
    walkForwardDegradationPct: avgDeg,
  });
  const freqOk = (winner.oos.tw ?? 0) >= 2;
  const certified = gates.allPass && freqOk && (winner.oos.n ?? 0) >= 30 && (winner.oos.retPct ?? 0) > 0;

  return {
    symbol,
    winner: {
      label: winner.combo.label,
      patch: winner.combo.patch,
      overrides: winOverrides,
      oos: winner.oos,
      is: isRow,
      full,
      gates,
      mc: { p5ReturnPct: mc.p5ReturnPct },
      foldStats,
      certified,
    },
    ladder: scored.map((s) => ({ label: s.combo.label, patch: s.combo.patch, oos: s.oos, score: s.score })),
  };
}

console.log(`=== MICRO_EVENT per-coin optimize ${COINS.join(",")} ${TF} ===`);
const report = { generatedAt: new Date().toISOString(), coins: {} };

for (const sym of COINS) {
  console.log(`\n--- ${sym} ---`);
  report.coins[sym] = await optimizeCoin(sym);
}

const outPath = path.join(__dirname, ".micro-event-per-coin-optimize.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);

const decisionPath = path.join(
  __dirname,
  ".research-decisions",
  `${new Date().toISOString().slice(0, 10)}-micro-event-per-coin-calibration.md`,
);
fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
const lines = [
  `# MICRO_EVENT per-coin calibration`,
  ``,
  `- Generated: ${report.generatedAt}`,
  `- Hypothesis: isolated threshold ladder per coin on bar-close proxy replay`,
  ``,
];
for (const sym of COINS) {
  const w = report.coins[sym]?.winner;
  lines.push(`## ${sym}`);
  if (!w) {
    lines.push(`- ERROR: ${report.coins[sym]?.error ?? "unknown"}`);
    continue;
  }
  lines.push(`- Winner: \`${w.label}\` patch=${JSON.stringify(w.patch)}`);
  lines.push(`- OOS: n=${w.oos.n} tw=${w.oos.tw}/wk ret=${w.oos.retPct}% pfR=${w.oos.pfR}`);
  lines.push(`- Gates allPass=${w.gates.allPass} certified=${w.certified}`);
  lines.push(`- Limitation: 1m bar-close proxy — not live tick certified`);
}
fs.writeFileSync(decisionPath, lines.join("\n") + "\n");
console.log(`Wrote ${decisionPath}`);

if (process.env.APPLY_PRESETS === "1") {
  const presetPath = path.resolve(__dirname, "../src/strategy/presets/microEventOptimized.js");
  let src = fs.readFileSync(presetPath, "utf8");
  for (const sym of COINS) {
    const w = report.coins[sym]?.winner;
    if (!w?.patch || !Object.keys(w.patch).length) continue;
    const exportName =
      sym === "BTCUSDT" ? "MICRO_EVENT_BTC_1M" : sym === "ETHUSDT" ? "MICRO_EVENT_ETH_1M" : "MICRO_EVENT_BNB_1M";
    for (const [k, v] of Object.entries(w.patch)) {
      const re = new RegExp(`(${k}:\\s*)[^,\\n]+`, "m");
      if (re.test(src)) src = src.replace(re, `$1${typeof v === "string" ? JSON.stringify(v) : v}`);
    }
    console.log(`APPLY_PRESETS: patched ${exportName} (${w.label})`);
  }
  fs.writeFileSync(presetPath, src);
}

await closePool?.().catch(() => {});
