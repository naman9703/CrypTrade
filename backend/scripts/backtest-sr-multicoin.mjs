#!/usr/bin/env node
/**
 * Multi-coin SR_INTRADAY (liquidity-solo, STRICT — same quality bar as the live run).
 * Demonstrates the legitimate way to raise trade frequency: run the same edge across
 * several symbols instead of loosening filters on one. Risk shown at 3%/trade.
 *
 * Usage: node scripts/backtest-sr-multicoin.mjs [from] [to] [riskPct]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const tf = "15m";
const fromArg = process.argv[2] || "2026-05-01";
const toArg = process.argv[3] || "2026-06-04";
const riskPct = Number(process.argv[4] || 3);
const SYMBOLS = ["BNBUSDT", "BTCUSDT", "ETHUSDT", "XRPUSDT", "LINKUSDT"];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runRow = (
  await pool.query(
    "SELECT config_snapshot FROM backtest_runs WHERE status='done' AND symbol='BNBUSDT' AND timeframe='15m' ORDER BY finished_at DESC LIMIT 1",
  )
).rows[0];
const BASE = runRow?.config_snapshot?.bot ?? runRow?.config_snapshot ?? {};

const fromMs = Date.parse(fromArg);
const toMs = Date.parse(toArg);

function logical(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = new Date(t.entryTs).toISOString().slice(0, 16) + ":" + t.direction;
    m.set(k, (m.get(k) || 0) + Number(t.netPnl));
  }
  return [...m.values()];
}

async function runCoin(symbol) {
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) return null;
  const cfg = { ...BASE, symbol, timeframe: tf, manualStrategy: "SR_INTRADAY", strategyMode: "MANUAL", marketMode: "FUTURES", riskPerTrade: riskPct };
  const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol, tf, candles, fromMs });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY", candles, cfg, gateMode: "off", fundingRates: [],
    startingUsdt: 100, timeframe: tf, adapters, symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  const entries = logical(sim.trades);
  const wins = entries.filter((p) => p > 0).length;
  const days = new Set(candles.filter((c) => c.ts >= fromMs).map((c) => utcDayId(c.ts))).size;
  return {
    symbol, n: entries.length, days, perDay: entries.length / Math.max(1, days),
    wr: entries.length ? (wins / entries.length) * 100 : 0,
    ret: m.totalReturnPct ?? 0, dd: Math.abs(m.maxDrawdownPct ?? 0),
    netPnlUsd: entries.reduce((a, b) => a + b, 0),
  };
}

console.log(`\n=== MULTI-COIN SR_INTRADAY (STRICT, same filters) · ${tf} · risk ${riskPct}% ===`);
console.log(`${fromArg} → ${toArg}\n`);
console.log("symbol      n   /day   WR%    ret%   DD%");
console.log("─".repeat(46));

let totN = 0;
let totPnl = 0;
let days = 0;
for (const s of SYMBOLS) {
  const r = await runCoin(s);
  if (!r) {
    console.log(`${s.padEnd(10)} (no data)`);
    continue;
  }
  days = Math.max(days, r.days);
  totN += r.n;
  totPnl += r.netPnlUsd;
  console.log(
    `${r.symbol.padEnd(10)} ${String(r.n).padStart(2)} ${r.perDay.toFixed(2).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${r.ret.toFixed(1).padStart(7)} ${r.dd.toFixed(1).padStart(6)}`,
  );
}
console.log("─".repeat(46));
console.log(
  `PORTFOLIO  ${String(totN).padStart(2)} ${(totN / Math.max(1, days)).toFixed(2).padStart(6)}   —     —      —   (equal-weight $100/coin)`,
);
console.log(
  `Aggregate trades/day across ${SYMBOLS.length} coins = ${(totN / Math.max(1, days)).toFixed(2)} · total net on 5×$100 = $${totPnl.toFixed(2)}`,
);
console.log("Same strict quality bar — frequency comes from breadth, not looser filters.");

await closePool?.();
