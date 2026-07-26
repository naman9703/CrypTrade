#!/usr/bin/env node
/**
 * Hard A/B: range-compression stand-down on BUYBD (prepared-mit).
 *
 * Hypothesis (from half-regime autopsy, .liq-buybd-half-regime-autopsy.json):
 * every red half (2024H1/2025H1/2026H1) improves and no green half turns red
 * when trades taken while 14d/100d avg daily-range ratio < ~0.75 are dropped.
 * Mechanism: compressed regimes starve sweep→reclaim of follow-through fuel →
 * false reclaims (Phase 4 top root cause, 52% of loss $).
 *
 * One change: intradayLiqRangeCompressionMin (engine filter, causal, relative).
 * Sensitivity: 0.70 / 0.75 / 0.80. Full sim, real sizing, guards off.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-compression-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = Date.parse("2023-07-01");
const TO = Date.parse("2026-07-24");
const PAD = 150 * 864e5; // full 100d compression window from day one

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

const candles = await readCandles(SYMBOL, TF, FROM - PAD, TO, { market: "futures" });
const funding = await readFundingRates(SYMBOL, FROM - PAD, TO).catch(() => []);

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
function rMetrics(list) {
  const rs = list.map(rOf).filter((x) => x != null && Number.isFinite(x));
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: rs.length,
    meanR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    pfR: neg < 0 ? +(pos / -neg).toFixed(3) : pos > 0 ? 99 : 0,
    wr: rs.length ? +((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(1) : null,
  };
}

async function runVariant(id, extra) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
    backtestSignalStartMs: FROM,
    ...extra,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
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
    .filter((t) => Number(t.entryTs) >= FROM && Number(t.entryTs) < TO);
  const weeks = (TO - FROM) / (7 * 864e5);
  const retPct = ((Number(sim.finalEquity ?? sim.endingUsdt ?? 100) - 100) / 100) * 100;
  const full = rMetrics(trades);
  const halves = {};
  for (const h of [...new Set(trades.map((t) => halfKey(t.entryTs)))].sort()) {
    halves[h] = rMetrics(trades.filter((t) => halfKey(t.entryTs) === h));
  }
  const row = {
    id,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(1),
    ddPct: +Number(sim.maxDrawdownPct ?? 0).toFixed(1),
    ...full,
    halves,
  };
  const halfStr = Object.entries(halves)
    .map(([h, m]) => `${h}:${m.meanR}(n${m.n})`)
    .join(" ");
  console.log(
    `${id.padEnd(14)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% pfR=${String(row.pfR).padStart(6)} meanR=${String(row.meanR).padStart(7)} wr=${row.wr}%`,
  );
  console.log(`               ${halfStr}`);
  return row;
}

console.log(`=== Hard A/B: compression stand-down on BUYBD | FULL ${new Date(FROM).toISOString().slice(0, 10)}→${new Date(TO).toISOString().slice(0, 10)} ===`);
const rows = [];
rows.push(await runVariant("baseline", {}));
rows.push(await runVariant("comp>=0.70", { intradayLiqRangeCompressionMin: 0.7 }));
rows.push(await runVariant("comp>=0.75", { intradayLiqRangeCompressionMin: 0.75 }));
rows.push(await runVariant("comp>=0.80", { intradayLiqRangeCompressionMin: 0.8 }));

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-compression-ab.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
);
console.log("\nWrote .liq-buybd-compression-ab.json");
await closePool?.();
