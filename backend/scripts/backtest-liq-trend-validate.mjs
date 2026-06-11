#!/usr/bin/env node
/**
 * Validate LIQ_DAILY trend continuation — per-day + monthly/yearly PnL.
 * Usage: node scripts/backtest-liq-trend-validate.mjs
 *        FROM=2025-01-01 TO=2026-06-05 node scripts/backtest-liq-trend-validate.mjs
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

const { INTRADAY_PRO_LIQ_DAILY_15M, fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } =
  await import("../src/strategy/presets/srIntradayOptimized.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padMs = 14 * 86_400_000;
const candles = await readCandles(SYMBOL, TF, fromMs - padMs, toMs);
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
  cfg: {
    ...merged,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
  },
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: TF,
  adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
  symbol: SYMBOL,
  costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
});

const entries = new Map();
for (const t of sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs)) {
  const k = `${t.entryTs}_${t.direction}`;
  if (!entries.has(k)) {
    entries.set(k, {
      ts: t.entryTs,
      dir: t.direction,
      pnl: 0,
      reason: t.entryReason,
      exits: [],
    });
  }
  const e = entries.get(k);
  e.pnl += Number(t.netPnl);
  e.exits.push(t.exitReason);
}

const list = [...entries.values()].sort((a, b) => a.ts - b.ts);
const totalPnl = list.reduce((a, t) => a + t.pnl, 0);
const wins = list.filter((t) => t.pnl > 0).length;

const byDay = new Map();
const byMonth = new Map();
for (const t of list) {
  const d = new Date(t.ts).toISOString().slice(0, 10);
  byDay.set(d, (byDay.get(d) || 0) + t.pnl);
  const m = d.slice(0, 7);
  byMonth.set(m, (byMonth.get(m) || 0) + t.pnl);
}

const trend = list.filter((t) => (t.reason || "").includes("liq_trend_cont"));
const classic = list.filter((t) => !(t.reason || "").includes("liq_trend_cont"));

console.log(`\n=== LIQ_DAILY ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% risk ===`);
console.log(`Entries: ${list.length} | Total: ${totalPnl.toFixed(2)}% | WR: ${((wins / Math.max(1, list.length)) * 100).toFixed(0)}%`);
console.log(
  `Classic: ${classic.length} (${classic.reduce((a, t) => a + t.pnl, 0).toFixed(2)}%) | Trend: ${trend.length} (${trend.reduce((a, t) => a + t.pnl, 0).toFixed(2)}%)`,
);

const posMonths = [...byMonth.values()].filter((v) => v > 0).length;
console.log(`Months: ${byMonth.size} | Positive months: ${posMonths}/${byMonth.size}`);
for (const [m, p] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
}

console.log("\n--- Jun 1–4 2026 ---");
for (const t of list.filter((t) => t.ts >= Date.parse("2026-06-01") && t.ts < Date.parse("2026-06-05"))) {
  console.log(
    `  ${new Date(t.ts).toISOString().slice(0, 16)} ${t.dir} ${t.exits.join("+")} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}% | ${(t.reason || "").slice(0, 50)}`,
  );
}

const losses = list.filter((t) => t.pnl < 0);
console.log(`\n--- Loss autopsy (top ${Math.min(8, losses.length)} by magnitude) ---`);
for (const t of losses.sort((a, b) => a.pnl - b.pnl).slice(0, 8)) {
  const kind = (t.reason || "").includes("trend_disp")
    ? "disp"
    : (t.reason || "").includes("trend_fade")
      ? "fade"
      : (t.reason || "").includes("liq_trend_cont")
        ? "trend"
        : "classic";
  console.log(
    `  ${new Date(t.ts).toISOString().slice(0, 10)} ${t.dir} ${t.pnl.toFixed(2)}% [${kind}] ${t.exits.join("+")}`,
  );
}

await closePool();
