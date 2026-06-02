#!/usr/bin/env node
/**
 * One-week SR_INTRADAY gate isolation sweep — each run enables a single intraday gate.
 * Usage: npm run backtest:intraday-gates -- BNBUSDT 2026-05-11 2026-05-18
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = (process.argv[2] || "BNBUSDT").toUpperCase();
const fromArg = process.argv[3] || "2026-05-11";
const toArg = process.argv[4] || "2026-05-18";
const fromMs = Date.parse(fromArg);
const toMs = Date.parse(toArg);
const tf = "15m";

if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  console.error("Invalid date range");
  process.exit(1);
}

const { INTRADAY_PRO_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const GATE_SCENARIOS = [
  { label: "ALL_ON (baseline)", gates: { all: true } },
  { label: "liquidity_only", gates: { liquidity: true } },
  { label: "session_only", gates: { session: true } },
  { label: "fib_only", gates: { fib: true } },
  { label: "vp_only", gates: { vp: true } },
  { label: "orderflow_only", gates: { orderFlow: true } },
  { label: "htf_regime_only", gates: { htfRegime: true } },
];

function gateCfg(scenario) {
  const base = {
    ...INTRADAY_PRO_15M,
    symbol,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    intradaySoloGateTest: true,
    intradayRequireSessionReclaim: false,
    intradayRequireFibOrVp: false,
    intradayMinTechniqueCount: 1,
    srIntradayMinScore: 5,
  };
  if (scenario.gates.all) {
    return {
      ...base,
      intradayGateLiquidity: true,
      intradayGateSession: true,
      intradayGateFib: true,
      intradayGateVp: true,
      intradayGateOrderFlow: true,
      intradayGateHtfRegime: true,
      intradayRequireSessionReclaim: true,
      intradayRequireFibOrVp: true,
      intradayMinTechniqueCount: 3,
      intradaySoloGateTest: false,
      srIntradayMinScore: 9,
    };
  }
  return {
    ...base,
    intradayGateLiquidity: Boolean(scenario.gates.liquidity),
    intradayGateSession: Boolean(scenario.gates.session),
    intradayGateFib: Boolean(scenario.gates.fib),
    intradayGateVp: Boolean(scenario.gates.vp),
    intradayGateOrderFlow: Boolean(scenario.gates.orderFlow),
    intradayGateHtfRegime: Boolean(scenario.gates.htfRegime),
  };
}

async function runScenario(label, cfg) {
  const candles = await readCandles(symbol, tf, fromMs, toMs);
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
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  const setups = {};
  for (const t of sim.trades) {
    const r = String(t.entryReason || "").replace(/^ipro_/, "").split("+")[0];
    setups[r] = (setups[r] || 0) + 1;
  }
  return {
    label,
    n: m.totalTrades,
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +(Math.abs(m.maxDrawdownPct ?? 0)).toFixed(1),
    setups: Object.entries(setups)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ") || "—",
  };
}

if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });

console.log(`\nSR_INTRADAY gate sweep · ${symbol} ${tf}`);
console.log(`${fromArg} → ${toArg}\n`);
console.log("label                  n    WR%    ret%    PF    DD%   top setups");
console.log("─".repeat(78));

const rows = [];
for (const sc of GATE_SCENARIOS) {
  const row = await runScenario(sc.label, gateCfg(sc));
  rows.push(row);
  console.log(
    `${row.label.padEnd(22)} ${String(row.n).padStart(3)} ${String(row.wr).padStart(6)} ${String(row.ret).padStart(7)} ${String(row.pf).padStart(6)} ${String(row.dd).padStart(6)}  ${row.setups}`,
  );
}

const best = [...rows].filter((r) => r.n > 0).sort((a, b) => b.ret - a.ret)[0];
console.log("\nBest return (≥1 trade):", best ?? "no trades");
await closePool?.();
