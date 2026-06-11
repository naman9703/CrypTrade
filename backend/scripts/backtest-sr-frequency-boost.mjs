#!/usr/bin/env node
/**
 * SR_INTRADAY frequency-boost study.
 * Goal: raise trade frequency toward ~1/day without killing expectancy.
 * Tests progressive filter relaxations over the focus window AND full history
 * (out-of-window check for overfitting), with realistic futures costs + DD.
 *
 * Usage: node scripts/backtest-sr-frequency-boost.mjs [focusFrom] [focusTo]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BNBUSDT";
const tf = "15m";
const focusFrom = process.argv[2] || "2026-05-01";
const focusTo = process.argv[3] || "2026-06-04";
const fullFrom = "2026-01-01";
const fullTo = "2026-06-04";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

// Base cfg = the exact stored run config (liquidity-solo), for parity with the live run.
const runRow = (
  await pool.query(
    "SELECT config_snapshot FROM backtest_runs WHERE status='done' AND symbol=$1 AND timeframe=$2 ORDER BY finished_at DESC LIMIT 1",
    [symbol, tf],
  )
).rows[0];
const BASE = runRow?.config_snapshot?.bot ?? runRow?.config_snapshot ?? {};

/**
 * Variants relax the ACTUAL frequency caps of the liquidity-solo run:
 *  - intradayLiqOnePickPerDay (true → false) is the dominant limiter
 *  - intradayLiqMinRr (2) and min score gate how many sweeps qualify
 *  - risk sizing controls DD (baseline is an aggressive 10%/trade)
 */
const VARIANTS = [
  { label: "V0 baseline (stored run)", patch: {} },
  {
    label: "V1 multi-pick/day (RR2)",
    patch: { intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 4, srIntradayMinBarGap: 3 },
  },
  {
    label: "V2 multi-pick + RR1.5 sc5",
    patch: { intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 4, srIntradayMinBarGap: 3, intradayLiqMinRr: 1.5, intradayLiqMinScore: 5 },
  },
  {
    label: "V3 multi-pick + RR1.3 + clusters",
    patch: { intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5, srIntradayMinBarGap: 2, intradayLiqMinRr: 1.3, intradayLiqMinScore: 5, intradayLiqSessionExtreme: true },
  },
  {
    label: "V4 = V2 but risk 3% (DD tame)",
    patch: { intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 4, srIntradayMinBarGap: 3, intradayLiqMinRr: 1.5, intradayLiqMinScore: 5, riskPerTrade: 3 },
  },
  {
    label: "V5 = V2 risk3% + HTF align",
    patch: { intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 4, srIntradayMinBarGap: 3, intradayLiqMinRr: 1.5, intradayLiqMinScore: 5, riskPerTrade: 3, intradayLiqRequireHtfAlign: true },
  },
  {
    label: "V6 +session gate (broaden, keep RR2)",
    patch: { intradayGateSession: true, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 4, srIntradayMinBarGap: 3 },
  },
  {
    label: "V7 +session +clusters RR2 risk3%",
    patch: { intradayGateSession: true, intradayLiqSessionExtreme: true, intradayLiqOnePickPerDay: false, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMaxTradesPerDay: 5, srIntradayMinBarGap: 2, riskPerTrade: 3 },
  },
];

function buildCfg(patch) {
  return {
    ...BASE,
    symbol,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    marketMode: "FUTURES",
    ...patch,
  };
}

function tradingDays(candles) {
  const s = new Set();
  for (const c of candles) s.add(utcDayId(c.ts));
  return s.size;
}

/** Collapse partial legs → logical entries for honest WR/n. */
function logicalEntries(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = new Date(t.entryTs).toISOString().slice(0, 16) + ":" + t.direction;
    if (!m.has(k)) m.set(k, 0);
    m.set(k, m.get(k) + Number(t.netPnl));
  }
  return [...m.values()];
}

async function runWindow(cfg, fromMs, toMs) {
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol, tf, candles, fromMs });
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
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  const entries = logicalEntries(sim.trades);
  const wins = entries.filter((p) => p > 0).length;
  const days = tradingDays(candles.filter((c) => c.ts >= fromMs));
  return {
    n: entries.length,
    perDay: entries.length / Math.max(1, days),
    wr: entries.length ? (wins / entries.length) * 100 : 0,
    ret: m.totalReturnPct ?? 0,
    pf: m.profitFactor ?? 0,
    dd: Math.abs(m.maxDrawdownPct ?? 0),
    days,
  };
}

await ensureKlines(symbol, tf, { from: Date.parse(fullFrom), to: Date.parse(fullTo), market: "futures" });

const ffMs = Date.parse(focusFrom);
const ftMs = Date.parse(focusTo);
const fullFMs = Date.parse(fullFrom);
const fullTMs = Date.parse(fullTo);

console.log(`\n=== SR_INTRADAY FREQUENCY-BOOST STUDY · ${symbol} ${tf} ===`);
console.log(`Focus window: ${focusFrom} → ${focusTo}`);
console.log(`Full window:  ${fullFrom} → ${fullTo} (overfit check)\n`);
console.log(
  "variant".padEnd(34) +
    "| focus: n  /day  WR%   ret%   PF   DD%  | full: n  /day  WR%   ret%   PF   DD%",
);
console.log("─".repeat(108));

for (const v of VARIANTS) {
  const cfg = buildCfg(v.patch);
  const f = await runWindow(cfg, ffMs, ftMs);
  const g = await runWindow(cfg, fullFMs, fullTMs);
  const fmt = (x, d = 1) => Number(x).toFixed(d);
  console.log(
    v.label.padEnd(34) +
      `| ${String(f.n).padStart(3)} ${fmt(f.perDay, 2).padStart(5)} ${fmt(f.wr).padStart(5)} ${fmt(f.ret).padStart(6)} ${fmt(f.pf, 2).padStart(5)} ${fmt(f.dd).padStart(5)} ` +
      `| ${String(g.n).padStart(3)} ${fmt(g.perDay, 2).padStart(5)} ${fmt(g.wr).padStart(5)} ${fmt(g.ret).padStart(6)} ${fmt(g.pf, 2).padStart(5)} ${fmt(g.dd).padStart(5)}`,
  );
}

console.log(
  "\nNote: n = logical entries (partials collapsed). Costs: 12x lev, 0.04% taker, 0.05% slippage.",
);
console.log("Focus-only gains that don't hold on the full window = overfitting; prefer variants good on BOTH.");

await closePool?.();
