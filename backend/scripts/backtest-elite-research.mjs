#!/usr/bin/env node
/**
 * Deep loss analysis on last DB runs + elite strategy sweep (confluence / HTF_RSI / regime).
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runId = process.argv[2] || (
  await pool.query(`SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC LIMIT 1 OFFSET 1`)
).rows[0]?.id;

if (!runId) {
  console.error("No run found");
  process.exit(1);
}

const run = (await pool.query(`SELECT * FROM backtest_runs WHERE id=$1`, [runId])).rows[0];
const cfg = run.config_snapshot?.bot || run.config_snapshot || {};
const trades = (
  await pool.query(
    `SELECT trade_number, direction, net_pnl, entry_time, exit_time, exit_reason, mae_pct, mfe_pct, bars_held, signal_context
     FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`,
    [runId],
  )
).rows;

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { evaluateTrendHtfStRegime } = await import("../src/strategy/trendHtfStRegime.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildHtfRsiSignalSeries } = await import("../src/strategy/htfRsi.js");
const { buildTrendHtfStSignalSeries, buildTrendHtfStQualityOpts } = await import("../src/strategy/trendHtfSt.js");

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);

console.log(`\n══ Run ${runId.slice(0, 8)} ${run.symbol} ${run.timeframe} ══`);
console.log(`Period: ${run.start_date?.toISOString?.()?.slice(0, 10)} → ${run.end_date?.toISOString?.()?.slice(0, 10)}`);
console.log(`Trades: ${trades.length} WR: ${run.win_rate_pct}% risk: ${cfg.riskPerTrade}% regime: ${cfg.trendHtfStRegimeGate}\n`);

function parseSc(row) {
  const sc = row.signal_context;
  if (!sc) return {};
  return typeof sc === "string" ? JSON.parse(sc) : sc;
}

function findSigIdx(entryTime) {
  const t = new Date(entryTime).getTime();
  let i = candles.findIndex((c) => c.ts >= t);
  return Math.max(0, i - 1);
}

const h2Start = new Date("2025-06-01").getTime();
const h2End = new Date("2025-12-31T23:59:59").getTime();

const losses = [];
const wins = [];
for (const t of trades) {
  const entryMs = new Date(t.entry_time).getTime();
  const enriched = {
    ...t,
    net_pnl: Number(t.net_pnl),
    mae: Number(t.mae_pct),
    mfe: Number(t.mfe_pct),
    bars: t.bars_held,
    inH2: entryMs >= h2Start && entryMs <= h2End,
    sc: parseSc(t),
  };
  const i = findSigIdx(t.entry_time);
  enriched.regime = evaluateTrendHtfStRegime(candles, i, t.direction, cfg);
  if (enriched.net_pnl < 0) losses.push(enriched);
  else wins.push(enriched);
}

const h2Losses = losses.filter((t) => t.inH2);
const h2Wins = wins.filter((t) => t.inH2);

console.log("── Loss breakdown (full run) ──");
const byReason = {};
for (const t of losses) {
  byReason[t.exit_reason] = (byReason[t.exit_reason] || 0) + 1;
}
console.log("Exit reasons:", byReason);

const lossPatterns = {};
for (const t of losses) {
  const p = t.sc?.lossPattern || "unknown";
  lossPatterns[p] = (lossPatterns[p] || 0) + 1;
}
console.log("Loss patterns:", lossPatterns);

console.log("\n── H2 2025 only ──");
console.log(`Losses: ${h2Losses.length} Wins: ${h2Wins.length} WR: ${((h2Wins.length / (h2Losses.length + h2Wins.length)) * 100).toFixed(1)}%`);

const flagLoss = {};
for (const t of h2Losses) {
  for (const f of t.regime?.flags || []) flagLoss[f] = (flagLoss[f] || 0) + 1;
}
console.log("\nRegime flags on H2 losses:");
for (const [f, n] of Object.entries(flagLoss).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f}: ${n}/${h2Losses.length}`);
}

console.log("\n── Root cause buckets (H2 losses) ──");
const buckets = {
  WHIPSAW: h2Losses.filter((t) => Number(t.mfe) >= 1 && t.exit_reason === "sl").length,
  INSTANT: h2Losses.filter((t) => Number(t.mfe) < 0.35 && t.bars <= 4).length,
  CHOP_ENTRY: h2Losses.filter((t) => t.regime?.structuralRisk === "CHOP_ZONE").length,
  CROSS_ENTRY: h2Losses.filter((t) => t.regime?.flags?.includes("HTF_EMA_CROSS_RECENT")).length,
  HIGH_RISK_20: cfg.riskPerTrade >= 15,
};
console.log(buckets);

console.log("\nSample H2 losses (worst 8):");
for (const t of h2Losses.sort((a, b) => a.net_pnl - b.net_pnl).slice(0, 8)) {
  const r = t.regime;
  console.log(
    `  #${t.trade_number} ${t.direction} ${t.exit_reason} bars=${t.bars} mfe=${t.mfe?.toFixed?.(1)}% pnl=${t.net_pnl.toFixed(2)} macro=${r?.macroMode} risk=${r?.structuralRisk} flags=${r?.flags?.slice(0, 3).join(",")}`,
  );
}

// Precompute signal series for confluence
const htfRsiSeries = buildHtfRsiSignalSeries(candles);
const trendOpts = buildTrendHtfStQualityOpts({ ...cfg, trendHtfStRegimeGate: true });
const trendSeries = buildTrendHtfStSignalSeries(candles, {
  period: 10,
  multiplier: 2.5,
  ...trendOpts,
});

function confluenceAt(i) {
  const h = htfRsiSeries[i];
  const t = trendSeries[i];
  if (!h || !t) return null;
  if (h.action === t.action) return h.action;
  return null;
}

async function simStrategy(strategyKey, extraCfg, label) {
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: strategyKey,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: 7,
    riskPerTradeUnit: "PCT_EQUITY",
    ...extraCfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: full,
    symbol: run.symbol,
    tf: run.timeframe,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: run.timeframe,
    adapters,
    symbol: run.symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: run.timeframe,
    startingEquity: 100,
  });
  return { label, wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0, sim };
}

console.log("\n══ Strategy sweep (7% risk) ──\n");

const windows = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan26", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

async function simWindow(label, from, to, strategyKey, extraCfg) {
  const fMs = new Date(from).getTime();
  const tMs = new Date(to).getTime();
  const c = await readCandles(run.symbol, run.timeframe, fMs, tMs);
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: strategyKey,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: 7,
    ...extraCfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: full,
    symbol: run.symbol,
    tf: run.timeframe,
    candles: c,
    fromMs: fMs,
  });
  const sim = await runSimulation({
    strategyKey,
    candles: c,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: run.timeframe,
    adapters,
    symbol: run.symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: run.timeframe, startingEquity: 100 });
  return { wr: (m.winRate ?? 0) * 100, ret: m.totalReturnPct ?? 0, n: m.totalTrades ?? 0 };
}

const strategies = [
  ["TREND_HTF_ST+regime", "TREND_HTF_ST", { trendHtfStRegimeGate: true }],
  ["HTF_RSI", "HTF_RSI", { supertrendFuturesFixedSlPct: 0.006, supertrendFuturesFixedTpPct: 0.018 }],
  ["HTF_RSI tight", "HTF_RSI", { supertrendFuturesFixedSlPct: 0.005, supertrendFuturesFixedTpPct: 0.012 }],
];

for (const [name, key, cfgExtra] of strategies) {
  const parts = [];
  for (const [w, f, t] of windows) {
    const r = await simWindow(w, f, t, key, cfgExtra);
    parts.push(`${w}=${r.ret.toFixed(0)}%/${r.wr.toFixed(0)}%`);
  }
  console.log(`${name.padEnd(22)} ${parts.join(" | ")}`);
}

// Count confluence opportunities
let confSignals = 0;
let confH2 = 0;
for (let i = 80; i < candles.length; i++) {
  const c = confluenceAt(i);
  if (!c) continue;
  confSignals++;
  if (candles[i].ts >= h2Start && candles[i].ts <= h2End) confH2++;
}
console.log(`\nConfluence signal bars (HTF_RSI + TREND agree): ${confSignals} (H2: ${confH2})`);

await closePool();
