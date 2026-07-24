#!/usr/bin/env node
/**
 * LIQ_CORE root-cause → dead-trade exit A/B (keeps entries; compresses failed paths).
 *
 * WHY (from trade autopsy): never_green + sl_no_follow ≈ majority of loss $;
 * entry context filters cut N without flipping PF≥1. Optimum = post-entry risk
 * compression when MFE fails to prove the reclaim.
 *
 * Usage (from backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-core-rootcause-deadtrade.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const OOS_END = process.env.OOS_END || "2025-10-01";
const SYMBOL = (process.env.SYMBOL || "BNBUSDT").toUpperCase();
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const oosEndMs = Date.parse(OOS_END);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  if (String(t.exitReason || "").includes("time_stop")) return "time_stop_gave_back";
  if (mfe >= 0.01) return "gave_back_after_mfe";
  return "other_loss";
}

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: "15m", startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  const byFail = {};
  for (const t of s) {
    const k = failClass(t);
    byFail[k] ??= { n: 0, pnl: 0 };
    byFail[k].n += 1;
    byFail[k].pnl += Number(t.netPnl ?? 0);
  }
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    byFail,
  };
}

async function runSim(over = {}) {
  clearIntradayAdapterCache?.();
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(SYMBOL, "15m", { from: fromMs, to: toMs, market: "futures" });
  }
  const candles = await readCandles(SYMBOL, "15m", fromMs - 21 * 864e5, toMs, { market: "futures" });
  const funding = await readFundingRates(SYMBOL, fromMs - 21 * 864e5, toMs).catch(() => []);
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, "15m");
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: "15m",
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const variants = [
  ["H0_x4", {}],
  ["D1_b4_mfe05_loss055", { intradayLiqDeadTradeExitBars: 4, intradayLiqDeadTradeMinMfeR: 0.5, intradayLiqDeadTradeMaxLossR: 0.55 }],
  ["D2_b8_mfe05_loss055", { intradayLiqDeadTradeExitBars: 8, intradayLiqDeadTradeMinMfeR: 0.5, intradayLiqDeadTradeMaxLossR: 0.55 }],
  ["D3_b4_mfe03_loss04", { intradayLiqDeadTradeExitBars: 4, intradayLiqDeadTradeMinMfeR: 0.3, intradayLiqDeadTradeMaxLossR: 0.4 }],
  ["D4_b6_mfe05_loss04", { intradayLiqDeadTradeExitBars: 6, intradayLiqDeadTradeMinMfeR: 0.5, intradayLiqDeadTradeMaxLossR: 0.4 }],
  ["T1_maxTpRr2", { intradayLiqMaxTpRr: 2 }],
  ["T2_maxTpRr15", { intradayLiqMaxTpRr: 1.5 }],
  ["X_D1_plus_tpRr2", {
    intradayLiqDeadTradeExitBars: 4,
    intradayLiqDeadTradeMinMfeR: 0.5,
    intradayLiqDeadTradeMaxLossR: 0.55,
    intradayLiqMaxTpRr: 2,
  }],
];

const rows = [];
let baseTw = 7.3;
for (const [id, over] of variants) {
  process.stderr.write(`${id}\n`);
  const trades = await runSim(over);
  const full = metrics(trades, fromMs, toMs);
  const oos = metrics(trades, fromMs, oosEndMs);
  const hold = metrics(trades, oosEndMs, toMs);
  if (id === "H0_x4") baseTw = full.tw;
  const freqOk = full.tw >= baseTw * 0.6;
  const better = full.pf > (rows[0]?.full?.pf ?? 0) && full.ret > (rows[0]?.full?.ret ?? -999);
  rows.push({ id, full, oos, hold, freqOk, better });
  console.log(
    `${id.padEnd(22)} n=${String(full.n).padStart(3)} tw=${full.tw} ret=${String(full.ret).padStart(8)} pf=${full.pf} | OOS pf=${oos.pf} ret=${oos.ret} | freqOk=${freqOk}`,
  );
  const inst = (full.byFail.never_green?.pnl ?? 0) + (full.byFail.sl_no_follow?.pnl ?? 0);
  console.log(`  instant_fail_pnl=${inst.toFixed(2)} winners=${(full.byFail.winner?.pnl ?? 0).toFixed(2)}`);
}

const out = path.join(__dirname, ".liq-core-rootcause-deadtrade.json");
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, rows }, null, 2));
console.error(`wrote ${out}`);
await closePool?.();
