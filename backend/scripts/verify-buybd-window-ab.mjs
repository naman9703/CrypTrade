#!/usr/bin/env node
/**
 * Reconcile the UI backtest window against the research windows for the BNB
 * BUYBD sleeve, and isolate the preset's risk guards (daily loss / loss streak /
 * per-day caps) from the pure research overlay.
 *
 * Usage (backend/): node scripts/verify-buybd-window-ab.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const SYMBOL = "BNBUSDT";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

const RESEARCH_OVERLAY = {
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.3,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
  intradayLiqDaySituationBias: "buy_breakdown",
};

const WINDOWS = [
  ["UI 2026 YTD", Date.parse("2026-01-01"), Date.parse("2026-07-24")],
  ["Y1 research", Date.parse("2025-07-01"), Date.parse("2026-07-01")],
  ["HOLD research", Date.parse("2024-07-01"), Date.parse("2025-07-01")],
  ["2025 H2", Date.parse("2025-07-01"), Date.parse("2026-01-01")],
];

const VARIANTS = [
  ["research overlay", { ...INTRADAY_PRO_LIQ_CORE_15M, ...RESEARCH_OVERLAY, maxDailyLoss: 0 }],
  ["preset as saved", { ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M }],
  ["preset, guards off", {
    ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
  }],
];

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
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
  };
}

async function runSim(candles, funding, base, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...base,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: lo,
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
  return metrics(sim.trades, lo, hi);
}

const lo = Math.min(...WINDOWS.map((w) => w[1])) - 30 * 864e5;
const hi = Math.max(...WINDOWS.map((w) => w[2]));
const candles = await readCandles(SYMBOL, TF, lo, hi, { market: "futures" });
const funding = await readFundingRates(SYMBOL, lo, hi).catch(() => []);

for (const [wName, wLo, wHi] of WINDOWS) {
  console.log(`\n=== ${wName} (${new Date(wLo).toISOString().slice(0, 10)} → ${new Date(wHi).toISOString().slice(0, 10)}) ===`);
  for (const [vName, base] of VARIANTS) {
    const m = await runSim(candles, funding, base, wLo, wHi);
    console.log(`${vName.padEnd(20)} n=${String(m.n).padStart(3)} tw=${String(m.tw).padStart(5)} ret=${String(m.ret).padStart(7)}% pf=${m.pf}`);
  }
}
await closePool?.();
