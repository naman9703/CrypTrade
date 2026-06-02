#!/usr/bin/env node
/** Diagnose why fib-only produces few trades. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-26");

const { INTRADAY_PRO_FIB_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday, selectIntradayPicks, buildIntradayOptsFromCfg, WARMUP } = await import("../src/strategy/intradayPro.js");
const { evaluateFibRetraceBar, evaluateFibRetraceSetup } = await import("../src/strategy/techniques/fibonacci.js");
const { resolveIntradayGates, resolveIntradayMinScore } = await import("../src/strategy/intradayGates.js");

const cfg = { ...INTRADAY_PRO_FIB_15M, symbol, timeframe: tf };
const opts = buildIntradayOptsFromCfg(cfg);
const gates = resolveIntradayGates(cfg);
const minScore = resolveIntradayMinScore(cfg, gates);

await initPool({ info: () => {}, warn: () => {}, error: console.error });
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const pre = precomputeIntraday(candles);

let barOnly = 0;
let setup = 0;
let vetoOff = 0;
const failRr = { n: 0 };

for (let i = WARMUP; i < candles.length; i++) {
  const barSig = evaluateFibRetraceBar(candles, i, opts, pre);
  if (barSig) barOnly++;
  const s = evaluateFibRetraceSetup(candles, i, opts, pre);
  if (s) setup++;
  const noVeto = evaluateFibRetraceSetup(candles, i, { ...opts, intradayFibLearnedRulesEnabled: false }, pre);
  if (noVeto) vetoOff++;
}

const picks = selectIntradayPicks(candles, cfg);
const tradingDays = new Set();
for (let i = WARMUP; i < candles.length; i++) {
  const d = new Date(candles[i].ts).toISOString().slice(0, 10);
  tradingDays.add(d);
}

console.log("\n=== FIB TRADE FUNNEL (current preset) ===\n");
console.log("Bars", candles.length, "warmup from", WARMUP);
console.log("Calendar days in range", tradingDays.size);
console.log("1. evaluateFibRetraceBar (no vetoes)", barOnly);
console.log("2. evaluateFibRetraceSetup (vetoes ON)", setup);
console.log("3. same, vetoes OFF", vetoOff, "→ veto blocked", setup - vetoOff < 0 ? 0 : barOnly - setup);
console.log("4. selectIntradayPicks candidates (score>=" + minScore + ")", picks.candidateCount);
console.log("5. picked after max/day=" + cfg.srIntradayMaxTradesPerDay + " gap=" + cfg.srIntradayMinBarGap, picks.pickedCount);
console.log("   trades/day if uniform", (picks.pickedCount / tradingDays.size).toFixed(3));
console.log("\nKey filters:", {
  minScore,
  intradayFibMinScore: cfg.intradayFibMinScore,
  minRr: cfg.intradayFibMinRr,
  minLegAtr: cfg.intradayFibMinLegAtrMult,
  minAdx: cfg.intradayFibMinAdx,
  maxBarsSwing: cfg.intradayFibMaxBarsSinceSwing,
  tpMode: cfg.intradayFibTpMode,
  extensionFrac: cfg.intradayFibExtensionFrac,
  ratios: cfg.intradayFibAllowedRatios,
  retrace: [cfg.intradayFibMinRetraceRatio, cfg.intradayFibMaxRetraceRatio],
  htfAlign: cfg.intradayFibRequireHtfAlign,
  learnedRules: cfg.intradayFibLearnedRulesEnabled,
  maxPerDay: cfg.srIntradayMaxTradesPerDay,
});

// Looser profile for target frequency
const loose = {
  ...cfg,
  intradayFibMinLegAtrMult: 2,
  intradayFibMinRr: 1.25,
  intradayFibMinAdx: 18,
  intradayFibMaxBarsSinceSwing: 28,
  intradayFibLearnedRulesEnabled: false,
  intradayFibAllowedRatios: [0.5, 0.618],
  intradayFibMinRetraceRatio: 0.48,
  intradayFibMaxRetraceRatio: 0.72,
  intradayFibMinScore: 8,
  srIntradayMaxTradesPerDay: 3,
  intradayFibTpMode: "partial_leg",
  intradayFibPartialLegFrac: 0.45,
};
const picksLoose = selectIntradayPicks(candles, loose);
console.log("\n=== LOOSER (research profile) ===");
console.log("candidates", picksLoose.candidateCount, "picked", picksLoose.pickedCount);
console.log("~trades/day", (picksLoose.pickedCount / tradingDays.size).toFixed(2));

await closePool();
