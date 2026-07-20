#!/usr/bin/env node
/**
 * ETH LIQ regime-router validation — compare broken trail-only vs canonical preset.
 * Walk-forward: H2 2025 (Jun–Dec) vs H1 2026 (Jan–May) + full year.
 *
 *   cd backend && node scripts/backtest-liq-eth-regime-validate.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const START = 100;

const WINDOWS = [
  { label: "H2 2025", from: "2025-06-01", to: "2026-01-01" },
  { label: "H1 2026", from: "2026-01-01", to: "2026-06-01" },
  { label: "Full year", from: "2025-06-01", to: "2026-06-01" },
];

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_ETH_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { query } = await import("../src/db/query.js");

/** User's broken config from run 748868af — trail-only, vetoes off, minRr dead. */
const USER_BROKEN = {
  riskPerTrade: 3.5,
  intradayLiqMinRr: 2,
  intradayLiqMinQuality: 10,
  intradayLiqMaxTpRr: 3.35,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  trailingStopLossAuto: true,
  trailOnlyAfterTp2Fill: false,
  intradayLiqMinReclaimClosePct: 0,
  intradayLiqVetoCounterTrend: false,
  intradayLiqTrendContinuation: false,
};

function ms(d) {
  return new Date(`${d}T00:00:00.000Z`).getTime();
}

function summarize(sim, fromMs, toMs) {
  const trades = sim.trades.filter((t) => {
    const x = Number(t.exitTs ?? t.exitTime ?? t.exit_time);
    return x >= fromMs && x < toMs;
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  let net = 0;
  let sl = 0;
  let tp1 = 0;
  let tp2 = 0;
  let trail = 0;
  for (const t of trades) {
    net += Number(t.netPnl ?? 0);
    const r = t.exitReason ?? "";
    if (r === "sl") sl++;
    else if (r === "tp1" || r === "partial") tp1++;
    else if (r === "tp" || r === "tp2") tp2++;
    else if (r === "trail") trail++;
  }
  return {
    n: trades.length,
    net: +net.toFixed(2),
    retPct: +Number(m.totalReturnPct ?? 0).toFixed(2),
    dd: +Number(m.maxDrawdownPct ?? 0).toFixed(1),
    pf: +Number(m.profitFactor ?? 0).toFixed(2),
    sl,
    tp1,
    tp2,
    trail,
  };
}

async function runCfg(name, basePatch, fromMs, toMs) {
  clearIntradayAdapterCache();
  const cfg = materializeIntradayEngineCfgSync(
    {
      ...INTRADAY_PRO_LIQ_ETH_15M,
      ...basePatch,
      symbol: SYMBOL,
      timeframe: TF,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
    },
    materializeIntradayPanelOnCfg,
  );
  const pad = 21 * 86400000;
  await ensureKlines(SYMBOL, TF, { from: fromMs - pad, to: toMs, market: "futures" }).catch(() => {});
  await ensureFunding(SYMBOL, { from: fromMs - pad, to: toMs }).catch(() => {});
  const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
  const fundingRates = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: fromMs - pad,
  }).catch(() => ({}));

  let trailMicro = null;
  if (cfg.trailingStopLossAuto === true) {
    const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
    trailMicro = await buildTrailMicroContext({
      symbol: SYMBOL,
      fromMs: fromMs - pad,
      toMs,
      cfg,
      trailEnabled: true,
    });
  }

  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
    trailMicro,
  });
  return summarize(sim, fromMs, toMs);
}

const CONFIGS = [
  { name: "user_trail_only", patch: USER_BROKEN },
  { name: "eth_preset_router", patch: {} },
];

console.log("\nETH LIQ regime-router validation\n");

for (const w of WINDOWS) {
  const fromMs = ms(w.from);
  const toMs = ms(w.to);
  console.log(`── ${w.label} (${w.from} → ${w.to}) ──`);
  for (const c of CONFIGS) {
    const s = await runCfg(c.name, c.patch, fromMs, toMs);
    console.log(
      `  ${c.name.padEnd(20)} n=${String(s.n).padStart(2)} net=$${String(s.net).padStart(7)} ret=${String(s.retPct).padStart(6)}% DD=${String(s.dd).padStart(5)}% PF=${s.pf}  sl=${s.sl} tp1=${s.tp1} tp2=${s.tp2} trail=${s.trail}`,
    );
  }
  console.log("");
}

await closePool().catch(() => {});
