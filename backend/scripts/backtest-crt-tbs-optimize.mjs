#!/usr/bin/env node
/**
 * CRT+TBS grid search — frequency vs return (BNB 15m, 1y window).
 * Usage: node scripts/backtest-crt-tbs-optimize.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg, crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const { CRT_TBS_BNB_15M, CRT_TBS_BNB_15M_FREQ } = await import("../src/strategy/presets/crtTbsOptimized.js");
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const calDays = (toMs - fromMs) / 86_400_000;
const candles = await readCandles(SYMBOL, TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

async function runOne(label, extra) {
  const cfg = resolveCrtTbsCfg({
    ...CRT_TBS_BNB_15M,
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    ...extra,
  });
  const adapter = buildCrtTbsBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "CRT_TBS",
    cfg: { ...cfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { CRT_TBS: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const list = aggregateSituationEntries(sim.trades, fromMs, toMs);
  const wins = list.filter((t) => t.pnlPct > 0).length;
  const activeDays = new Set(list.map((t) => new Date(t.ts).toISOString().slice(0, 10))).size;
  return {
    label,
    ret: m.totalReturnPct ?? 0,
    n: list.length,
    wr: list.length ? (wins / list.length) * 100 : 0,
    dd: m.maxDrawdownPct ?? 0,
    pf: m.profitFactor ?? 0,
    tpd: list.length / calDays,
    activeDays,
    score: (m.totalReturnPct ?? 0) + list.length / calDays * 8,
  };
}

const grid = [
  ["v2_deployed", {}],
  ["v2_freq_preset", CRT_TBS_BNB_15M_FREQ],
  ["london_eq_rr05", { intradaySmcKillzoneMode: "LONDON", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.5 }],
  ["london_eq_rr03", { intradaySmcKillzoneMode: "LONDON", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.3 }],
  ["london_choch_or_bos", { intradaySmcKillzoneMode: "LONDON", crtStructureMode: "choch_or_bos" }],
  ["ln_ny_eq_rr03", { intradaySmcKillzoneMode: "LONDON_NY", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.3 }],
  ["ln_ny_choch_or_bos_eq", { intradaySmcKillzoneMode: "LONDON_NY", crtStructureMode: "choch_or_bos", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.3 }],
  ["bos_only_london", { crtStructureMode: "bos", crtRequireChoch: false, intradaySmcKillzoneMode: "LONDON" }],
  ["choch12_london_eq", { crtChochMaxBars: 12, intradaySmcKillzoneMode: "LONDON", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.5 }],
  ["max3_gap2_ln_ny", { crtMaxTradesPerDay: 3, crtMinBarGap: 2, intradaySmcKillzoneMode: "LONDON_NY", crtRequireEntryBelowEq: true, crtMinRrToTp2: 0.3 }],
];

const results = [];
for (const [label, extra] of grid) {
  results.push(await runOne(label, extra));
}

results.sort((a, b) => b.score - a.score);

console.log(`\n=== CRT+TBS OPTIMIZE ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% ===\n`);
console.log(
  "label".padEnd(28),
  "ret%".padStart(7),
  "n".padStart(5),
  "tpd".padStart(6),
  "wr%".padStart(6),
  "dd%".padStart(6),
  "pf".padStart(5),
  "score".padStart(7),
);
for (const r of results) {
  console.log(
    r.label.padEnd(28),
    r.ret.toFixed(1).padStart(7),
    String(r.n).padStart(5),
    r.tpd.toFixed(3).padStart(6),
    r.wr.toFixed(0).padStart(6),
    r.dd.toFixed(1).padStart(6),
    (r.pf ?? 0).toFixed(2).padStart(5),
    r.score.toFixed(1).padStart(7),
  );
}

const bestRet = [...results].sort((a, b) => b.ret - a.ret)[0];
const bestFreq = [...results].filter((r) => r.ret > 0).sort((a, b) => b.tpd - a.tpd)[0];
console.log("\nBest return:", bestRet?.label, bestRet?.ret.toFixed(1) + "%", "n=" + bestRet?.n);
console.log("Best freq (ret>0):", bestFreq?.label, "tpd=" + bestFreq?.tpd.toFixed(3), "ret=" + bestFreq?.ret.toFixed(1) + "%");

await closePool();
