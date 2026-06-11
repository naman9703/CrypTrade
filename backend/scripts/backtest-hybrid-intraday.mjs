#!/usr/bin/env node
/**
 * Hybrid intraday account: SUPERTREND_ELITE (validated yearly edge) + LIQ_DAILY (breakdown catches).
 * Replays both trade streams on ONE shared BNB account with compounding risk.
 *
 * Usage: node scripts/backtest-hybrid-intraday.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2.5);
const START = Number(process.env.START || 100);

const { INTRADAY_PRO_LIQ_DAILY_15M, fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } =
  await import("../src/strategy/presets/srIntradayOptimized.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padMs = 21 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs);
const funding = await readFundingRates(SYMBOL, fromMs - padMs, toMs);
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

async function runLiq() {
  clearIntradayAdapterCache();
  const merged = mergeAdaptiveCfg(
    fillLiqSoloPresetDefaults(
      fillFibSoloPresetDefaults({ ...INTRADAY_PRO_LIQ_DAILY_15M, symbol: SYMBOL, timeframe: TF }),
    ),
    candles,
  );
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: { ...merged, symbol: SYMBOL, timeframe: TF, marketMode: "FUTURES", riskPerTrade: RISK, futuresLeverage: 12, backtestPositionSizing: "RISK_AT_SL" },
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  return sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
}

async function runElite() {
  const eliteCfg = {
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK,
    slippagePct: 0.0005,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: true,
    supertrendFuturesFixedSlPct: 0,
    supertrendFuturesFixedTpPct: 0,
    supertrendWilderAtr: true,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    eliteStMinAdx: 20,
    eliteStRequireAdxRising: true,
    eliteStMinVolumeVsAvg: 1.5,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStRequireHtf4hAlign: true,
    eliteStRequireAtrExpansion: true,
  };
  const opts = buildEliteStOptsFromCfg(eliteCfg);
  const sim = await runSimulation({
    candles,
    strategyKey: "SUPERTREND_ELITE",
    cfg: eliteCfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, opts, TF) },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  return sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
}

function aggregateByEntry(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!m.has(k)) m.set(k, { ts: t.entryTs, dir: t.direction, pnl: 0, src: t.entryReason });
    m.get(k).pnl += Number(t.netPnl);
  }
  return [...m.values()];
}

function monthlyPnl(entries) {
  const by = new Map();
  for (const e of entries) {
    const m = new Date(e.ts).toISOString().slice(0, 7);
    by.set(m, (by.get(m) || 0) + e.pnl);
  }
  return by;
}

const liqTrades = await runLiq();
const eliteTrades = await runElite();
const liqEntries = aggregateByEntry(liqTrades);
const eliteEntries = aggregateByEntry(eliteTrades);

console.log(`\n=== HYBRID ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% risk ===\n`);
console.log(`LIQ_DAILY:   ${liqEntries.length} entries, ${liqEntries.reduce((a, t) => a + t.pnl, 0).toFixed(2)}%`);
console.log(`ELITE:       ${eliteEntries.length} entries, ${eliteEntries.reduce((a, t) => a + t.pnl, 0).toFixed(2)}%`);

// Merge chronologically on shared equity (simple sequential compounding)
let equity = START;
const merged = [...liqEntries, ...eliteEntries].sort((a, b) => a.ts - b.ts);
const scaled = [];
for (const e of merged) {
  const src = (e.src || "").includes("liq") || (e.src || "").includes("ipro") ? "LIQ" : "ELITE";
  const scale = equity / START;
  const pnlUsd = (e.pnl / 100) * START * scale;
  equity += pnlUsd;
  scaled.push({ ...e, src, pnlUsd, equity });
}

const hybridRet = ((equity - START) / START) * 100;
const byMonth = new Map();
for (const e of scaled) {
  const m = new Date(e.ts).toISOString().slice(0, 7);
  byMonth.set(m, (byMonth.get(m) || 0) + (e.pnlUsd / START) * 100);
}
const posMo = [...byMonth.values()].filter((v) => v > 0).length;

console.log(`\nHYBRID (shared equity): ${hybridRet.toFixed(2)}% | Positive months: ${posMo}/${byMonth.size}`);
for (const [m, p] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
}

console.log("\n--- Jun 1–4 2026 (hybrid) ---");
for (const e of scaled.filter((t) => t.ts >= Date.parse("2026-06-01") && t.ts < Date.parse("2026-06-05"))) {
  console.log(
    `  ${new Date(e.ts).toISOString().slice(0, 16)} ${e.src} ${e.dir} ${e.pnlUsd >= 0 ? "+" : ""}${((e.pnlUsd / START) * 100).toFixed(2)}%`,
  );
}

await closePool();
