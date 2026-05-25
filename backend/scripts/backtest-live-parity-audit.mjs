#!/usr/bin/env node
/**
 * Audit last backtest vs live-trading parity: replay run, verify math, list gaps.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runIdArg = process.argv[2];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

let runId = runIdArg;
if (!runId) {
  runId = (
    await pool.query(
      `SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    )
  ).rows[0]?.id;
}

const run = (
  await pool.query(
    `SELECT id, symbol, timeframe, start_date, end_date, initial_capital, final_capital,
            total_trades, metrics, config_snapshot, gate_mode, cost_model, engine_type
       FROM backtest_runs WHERE id = $1`,
    [runId],
  )
).rows[0];

const cfg = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const persisted = (
  await pool.query(
    `SELECT trade_number, direction, entry_time, exit_time, entry_price, exit_price, quantity,
            exit_reason, net_pnl, gross_pnl, fees_usdt, funding_paid, slippage_cost, signal_context
       FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  )
).rows;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { resolveCostModel } = await import("../src/backtest/engine/costModel.js");

const symbol = run.symbol;
const tf = run.timeframe;
const strategyKey = cfg.manualStrategy || run.engine_type || "HTF_RSI";
const candles = await readCandles(symbol, tf, fromMs, toMs);
const fundingRates =
  cfg.marketMode === "FUTURES" ? await readFundingRates(symbol, fromMs, toMs).catch(() => []) : [];
const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
const sim = await runSimulation({
  strategyKey,
  candles,
  cfg,
  costModelOverride: run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {},
  gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
  fundingRates,
  startingUsdt: Number(run.initial_capital),
  timeframe: tf,
  adapters,
  symbol,
});

const cm = resolveCostModel(cfg, run.cost_model ?? {});
const finalEq = sim.equityCurve.at(-1)?.equity ?? 0;
const dbFinal = Number(run.final_capital);
const eqOk = Math.abs(finalEq - dbFinal) < 0.02;

function countReasons(trades) {
  const m = {};
  for (const t of trades) m[t.exit_reason ?? t.exitReason] = (m[t.exit_reason ?? t.exitReason] || 0) + 1;
  return m;
}

const persistedReasons = countReasons(persisted);
const replayReasons = countReasons(sim.trades);

let tradeMatch = 0;
let pnlDrift = 0;
const n = Math.min(persisted.length, sim.trades.length);
for (let i = 0; i < n; i++) {
  const p = persisted[i];
  const s = sim.trades[i];
  if (p.exit_reason === s.exitReason && p.direction === s.direction) tradeMatch++;
  pnlDrift += Math.abs(Number(p.net_pnl) - Number(s.netPnl));
}

const gatesOff = [
  ["intelligenceGateEnabled", cfg.intelligenceGateEnabled],
  ["gate_mode (run)", run.gate_mode],
  ["marketDecision.enabled", cfg.marketDecision?.enabled],
  ["signalStrengthGatesTrades", cfg.signalStrengthGatesTrades],
  ["supertrendMoveQualityGate", cfg.supertrendMoveQualityGate],
  ["supertrendBreakoutConfirm", cfg.supertrendBreakoutConfirm],
];

const liveGaps = [
  {
    area: "Capital pool",
    backtest: cfg.backtestPositionSizing || "RISK_AT_SL",
    live:
      "Uses allowedBudgetUsdt + multi-coin split; not full-equity compounding on one symbol unless configured",
    match: cfg.backtestPositionSizing !== "FULL_EQUITY_MARGIN" ? "partial" : "GAP",
  },
  {
    area: "Entry fill",
    backtest: "Signal on bar[i] close → fill bar[i+1] open + slippage",
    live: "Mark/book-ticker, IOC limits, slippage caps (supertrendFuturesMaxEntrySlippagePct)",
    match: "approx",
  },
  {
    area: "Intra-bar exits",
    backtest: "OHLC extremes; SL before liq; trail after favorable extreme",
    live: "Tick/mark stream; bracket orders",
    match: "approx",
  },
  {
    area: "Trailing",
    backtest: "Same trailingStopLoss.js tier ladder (trailingSim.js)",
    live: "Same lib, tick-driven",
    match: "yes",
  },
  {
    area: "Fees",
    backtest: `taker ${cm.takerOpenFeeRate}/${cm.takerCloseFeeRate}, slip ${cm.slippagePct}`,
    live: "tradeHistory*FeeRate + actual fill",
    match: "approx",
  },
  {
    area: "Funding",
    backtest: `historical rates (${fundingRates.length} rows)`,
    live: "8h funding events",
    match: fundingRates.length > 0 ? "yes" : "missing data",
  },
  {
    area: "Multi-symbol",
    backtest: `Single symbol ${symbol}`,
    live: `Universe ${(cfg.universeCustomSymbols || []).length} coins, rotation`,
    match: "GAP",
  },
  {
    area: "HTF_RSI signals",
    backtest: "Flip-only adapter (one trade per HTF leg)",
    live: "Same strategy module; may re-enter on cooldown paths",
    match: "approx",
  },
];

console.log("═".repeat(72));
console.log("BACKTEST LIVE-PARITY AUDIT");
console.log("Run:", run.id);
console.log(`${symbol} ${tf} · ${String(run.start_date).slice(0, 10)} → ${String(run.end_date).slice(0, 10)}`);
console.log(`Capital $${run.initial_capital} → DB $${dbFinal.toFixed(2)} · Replay $${finalEq.toFixed(2)} ${eqOk ? "✓" : "✗ MISMATCH"}`);
console.log(`Trades: DB ${persisted.length} · Replay ${sim.trades.length}`);
console.log("═".repeat(72));

console.log("\n1. REPLAY FIDELITY (current engine vs stored run)");
console.log("   Exit reasons DB:  ", JSON.stringify(persistedReasons));
console.log("   Exit reasons replay:", JSON.stringify(replayReasons));
console.log(`   Matched exit+direction (first ${n}): ${tradeMatch}/${n}`);
console.log(`   Sum |PnL drift| on matched count: $${pnlDrift.toFixed(2)}`);

console.log("\n2. COMPOUNDING CHECK (first 5 trades)");
let eq = Number(run.initial_capital);
for (const p of persisted.slice(0, 5)) {
  const sc = typeof p.signal_context === "string" ? JSON.parse(p.signal_context) : p.signal_context ?? {};
  const atEntry = Number(sc.equityAtEntry ?? 0);
  const ok = Math.abs(atEntry - eq) < 0.02;
  console.log(
    `   #${p.trade_number} eq@entry ${atEntry.toFixed(2)} (expect ${eq.toFixed(2)}) ${ok ? "✓" : "✗"} → net ${Number(p.net_pnl).toFixed(2)}`,
  );
  eq += Number(p.net_pnl);
}

console.log("\n3. GATES / FILTERS (backtest vs live config)");
for (const [k, v] of gatesOff) console.log(`   ${k}: ${v}`);

console.log("\n4. LIVE PARITY MATRIX");
for (const g of liveGaps) {
  console.log(`   [${g.match}] ${g.area}`);
  console.log(`        Backtest: ${g.backtest}`);
  console.log(`        Live:     ${g.live}`);
}

const sizing = cfg.backtestPositionSizing;
const lev = cfg.futuresLeverage ?? 50;
const slPct = (Number(cfg.supertrendFuturesFixedSlPct) * 100).toFixed(2);
console.log("\n5. REALISM WARNINGS");
if (sizing === "FULL_EQUITY_MARGIN" && lev >= 20) {
  console.log(
    `   ⚠ FULL_EQUITY_MARGIN @ ${lev}x compounds entire equity every trade — live rarely deploys 100% margin per signal on one coin.`,
  );
}
if (Number(run.metrics?.totalReturnPct) > 10000) {
  console.log(
    `   ⚠ Return ${Number(run.metrics?.totalReturnPct).toFixed(0)}% is a compounded backtest artifact, not a forecast.`,
  );
}
if (run.gate_mode === "off" && cfg.intelligenceGateEnabled === false) {
  console.log("   ⚠ Intelligence gate OFF — live may veto/size-scale entries the backtest always takes.");
}

await closePool();
