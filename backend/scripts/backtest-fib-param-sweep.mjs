#!/usr/bin/env node
/**
 * Fib parameter sweep — BNB 15m, technical best-practice ranges (not curve-fit to one run).
 * Phase 1: TP mode × leg size × min R:R
 * Phase 2: Refine top configs with confirm bar, ADX, swing freshness, BE
 * Usage: npm run backtest:fib-sweep -- [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BNBUSDT";
const tf = "15m";
const fromArg = process.argv[2] || "2026-01-01";
const toArg = process.argv[3] || "2026-05-26";
const fromMs = Date.parse(fromArg);
const toMs = Date.parse(toArg);
const START_EQ = 100;

const { INTRADAY_PRO_FIB_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

function fibCfg(extra = {}) {
  return {
    ...INTRADAY_PRO_FIB_15M,
    symbol,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    supertrendFuturesFixedSlPct: 0,
    supertrendFuturesFixedTpPct: 0,
    ...extra,
  };
}

function objective(m) {
  const n = m.totalTrades ?? 0;
  if (n < 4) return -1e6;
  if (n > 45) return -5e5;
  const ret = Number(m.totalReturnPct ?? 0);
  const pf = Math.min(Number(m.profitFactor ?? 0), 6);
  const dd = Number(m.maxDrawdownPct ?? 99);
  const sharpe = Number(m.sharpeRatio ?? 0);
  const wr = Number(m.winRate ?? 0);
  return ret * 2.2 + pf * 18 + sharpe * 6 + wr * 12 - Math.max(0, dd - 14) * 2;
}

const TP_MODES = [
  { intradayFibTpMode: "partial_leg", intradayFibPartialLegFrac: 0.38 },
  { intradayFibTpMode: "partial_leg", intradayFibPartialLegFrac: 0.45 },
  { intradayFibTpMode: "partial_leg", intradayFibPartialLegFrac: 0.5 },
  { intradayFibTpMode: "extension", intradayFibExtensionFrac: 0.272 },
  { intradayFibTpMode: "extension", intradayFibExtensionFrac: 0.618 },
  { intradayFibTpMode: "leg" },
];

function labelOf(p) {
  const tp =
    p.intradayFibTpMode === "partial_leg"
      ? `p${p.intradayFibPartialLegFrac}`
      : p.intradayFibTpMode === "extension"
        ? `x${p.intradayFibExtensionFrac}`
        : "leg";
  return `tp=${tp}|atr=${p.intradayFibMinLegAtrMult}|rr=${p.intradayFibMinRr}|cfm=${p.intradayFibConfirmNextBar ? 1 : 0}|adx=${p.intradayFibMinAdx}|sw=${p.intradayFibMaxBarsSinceSwing}|be=${p.backtestBreakevenAtMfePct ?? 0}`;
}

let candles = null;

async function runOne(params) {
  if (!candles) candles = await readCandles(symbol, tf, fromMs, toMs);
  const cfg = fibCfg(params);
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START_EQ,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: START_EQ,
  });
  return {
    label: labelOf(params),
    params,
    n: m.totalTrades ?? 0,
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +(m.maxDrawdownPct ?? 0).toFixed(2),
    sharpe: +(m.sharpeRatio ?? 0).toFixed(2),
    score: +objective(m).toFixed(2),
  };
}

await initPool({ info: () => {}, warn: console.warn, error: console.error });
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });

console.log(`\nFib param sweep · ${symbol} ${tf} · ${fromArg} → ${toArg}\n`);

const phase1 = [];
const legAtr = [2.5, 3, 3.5, 4];
const minRr = [1.5, 1.75, 2];

console.log("Phase 1: TP × leg ATR × min R:R …");
for (const tp of TP_MODES) {
  for (const la of legAtr) {
    for (const rr of minRr) {
      phase1.push(
        await runOne({
          ...tp,
          intradayFibMinLegAtrMult: la,
          intradayFibMinRr: rr,
          intradayFibConfirmNextBar: false,
          intradayFibMinAdx: 22,
          intradayFibMaxBarsSinceSwing: 22,
        }),
      );
    }
  }
}

phase1.sort((a, b) => b.score - a.score);
const seeds = phase1.filter((r) => r.n >= 4).slice(0, 6);
console.log(`\nPhase 1 top seeds (${seeds.length}):\n`);
for (const r of seeds) {
  console.log(`  ${r.label}  n=${r.n} WR=${r.wr}% ret=${r.ret}% PF=${r.pf} score=${r.score}`);
}

const phase2 = [];
console.log("\nPhase 2: refine confirm / ADX / swing age / BE …");
for (const seed of seeds) {
  const base = { ...seed.params };
  for (const c of [false, true]) {
    for (const a of [20, 24]) {
      for (const mb of [18, 24]) {
        for (const be of [0, 0.002, 0.0035]) {
          phase2.push(
            await runOne({
              ...base,
              intradayFibConfirmNextBar: c,
              intradayFibMinAdx: a,
              intradayFibMaxBarsSinceSwing: mb,
              backtestBreakevenAtMfePct: be,
            }),
          );
        }
      }
    }
  }
}

const all = [...phase2].sort((a, b) => b.score - a.score);
const viable = all.filter((r) => r.n >= 4);

console.log("\n=== TOP 10 FINAL ===\n");
for (const r of viable.slice(0, 10)) {
  console.log(
    `${r.label.padEnd(58)} n=${String(r.n).padStart(2)} WR=${String(r.wr).padStart(5)}% ret=${String(r.ret).padStart(7)}% PF=${r.pf} score=${r.score}`,
  );
}

const best = viable[0];
const outPath = path.resolve(__dirname, "../data/fib-sweep-latest.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    { from: fromArg, to: toArg, best, top10: viable.slice(0, 10), phase1Top: seeds, ranAt: new Date().toISOString() },
    null,
    2,
  ),
);

if (best) {
  console.log(`\n=== RECOMMENDED PRESET PARAMS ===\n`);
  console.log(JSON.stringify(best.params, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

await closePool();
