#!/usr/bin/env node
/**
 * Phase 1 edge-diagnosis research harness.
 *
 * The legacy AND-gated intraday engine (SR_INTRADAY / order-flow / composite)
 * barely trades and loses what little it does. Instead of fighting that gate
 * stack, this harness measures a set of TRANSPARENT, classic baseline signals
 * directly, cost-aware, across coins / windows:
 *
 *   - trend_pullback  : EMA-stacked trend, buy pullback to EMA20 reclaim
 *   - mean_reversion  : fade Bollinger/RSI extremes (range behaviour)
 *   - donchian_break  : breakout of N-bar channel (momentum/expansion)
 *
 * For each it prints expectancy, win rate, PF, fee drag (gross vs net) and the
 * exit-reason breakdown. Goal: prove WHERE money leaks (fees vs signal vs exits)
 * and find at least one coin/TF/technique with a provably positive cost-aware
 * edge — and, critically, show which technique works in which regime (the data
 * that justifies the regime router built in later phases).
 *
 * Usage:
 *   node scripts/backtest-regime-research.mjs                 # default sweep
 *   node scripts/backtest-regime-research.mjs BTCUSDT 15m     # single coin/tf
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const argSym = process.argv[2];
const argTf = process.argv[3];

const SYMBOLS = argSym ? [argSym] : ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
const TF = argTf || "15m";
const OFFLINE = process.env.OFFLINE !== "0";

const WINDOWS = [
  { label: "Q1", from: "2026-01-01", to: "2026-03-01" },
  { label: "Q2", from: "2026-03-01", to: "2026-05-01" },
  { label: "full", from: "2026-01-01", to: "2026-05-18" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildBaselineSignals,
  classifyBarRegime,
  computeIndicators,
} = await import("./lib/researchSignals.mjs");

// (technique, regime) -> { net, n } accumulator, aggregated across all runs.
const regimePnl = {};

// Fixed-percentage brackets per technique (15m calibrated). RR ~2.
const BRACKETS = {
  trend_pullback: { sl: 0.006, tp: 0.012 },
  mean_reversion: { sl: 0.005, tp: 0.0075 },
  donchian_break: { sl: 0.007, tp: 0.014 },
};

function cfgFor(sym, technique) {
  const b = BRACKETS[technique];
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: 5,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1.0,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    supertrendFuturesFixedSlPct: b.sl,
    supertrendFuturesFixedTpPct: b.tp,
    // Everything else off — we want the raw technique edge, no legacy gates.
  };
}

function exitBreakdown(trades) {
  const out = {};
  for (const t of trades) {
    const r = t.exitReason || "unknown";
    if (!out[r]) out[r] = { n: 0, net: 0 };
    out[r].n += 1;
    out[r].net += Number(t.netPnl ?? 0);
  }
  return out;
}

const fmtPct = (x) => `${(Number(x) || 0).toFixed(1)}%`;

const results = [];

for (const sym of SYMBOLS) {
  for (const w of WINDOWS) {
    const fromMs = new Date(w.from).getTime();
    const toMs = new Date(w.to).getTime();
    const days = (toMs - fromMs) / 86_400_000;

    if (!OFFLINE) {
      try {
        await ensureKlines(sym, TF, { from: fromMs, to: toMs, market: "futures" });
      } catch (e) {
        console.log(`[warn] ${sym} ${w.label}: backfill failed (${e?.message}); using DB`);
      }
    }
    const candles = await readCandles(sym, TF, fromMs, toMs);
    if (!candles?.length) {
      console.log(`[skip] ${sym} ${TF} ${w.label}: no candles`);
      continue;
    }

    let fundingRates = [];
    try {
      if (!OFFLINE) await ensureFunding(sym, { from: fromMs, to: toMs });
      fundingRates = await readFundingRates(sym, fromMs, toMs);
    } catch {
      fundingRates = [];
    }

    const signals = buildBaselineSignals(candles);

    // ts -> regime label for per-trade attribution.
    const ind = computeIndicators(candles);
    const tsRegime = new Map();
    for (let i = 0; i < candles.length; i++) tsRegime.set(candles[i].ts, classifyBarRegime(ind, i));

    console.log(`\n=== ${sym} ${TF} ${w.label} (${days.toFixed(0)}d, ${candles.length} bars) ===`);

    for (const technique of Object.keys(signals)) {
      const STRAT = `RESEARCH_${technique}`;
      const cfg = cfgFor(sym, technique);
      const adapters = { [STRAT]: signals[technique] };
      const sim = await runSimulation({
        strategyKey: STRAT,
        candles,
        cfg,
        gateMode: "off",
        fundingRates,
        startingUsdt: 1000,
        timeframe: TF,
        adapters,
        symbol: sym,
      });
      const m = computeAllMetrics({
        trades: sim.trades,
        equityCurve: sim.equityCurve,
        tf: TF,
        startingEquity: 1000,
      });
      const tpd = m.totalTrades / Math.max(1, days);
      const grossPct = (m.totalGrossPnl / 1000) * 100;
      const feeDragPct = (m.totalFees / 1000) * 100;
      const fundDragPct = (m.totalFunding / 1000) * 100;

      results.push({ sym, win: w.label, technique, m, grossPct, feeDragPct, fundDragPct, tpd });

      // Per-regime attribution: bucket each trade by its entry regime. Use only
      // the non-overlapping windows (Q1, Q2) so trades are not double-counted
      // against the overlapping `full` window. Track gross (signal edge) and net.
      if (w.label !== "full") {
        for (const t of sim.trades) {
          const reg = tsRegime.get(Number(t.entryTs)) || "WARMUP";
          const key = `${technique}|${reg}`;
          if (!regimePnl[key]) regimePnl[key] = { gross: 0, net: 0, n: 0, wins: 0 };
          regimePnl[key].gross += Number(t.grossPnl ?? 0);
          regimePnl[key].net += Number(t.netPnl ?? 0);
          regimePnl[key].n += 1;
          if (Number(t.netPnl ?? 0) > 0) regimePnl[key].wins += 1;
        }
      }

      console.log(
        `  [${technique.padEnd(14)}] n=${String(m.totalTrades).padStart(4)} tpd=${tpd.toFixed(2)} ` +
          `wr=${fmtPct((m.winRate || 0) * 100).padStart(6)} PF=${(m.profitFactor || 0).toFixed(2).padStart(5)} ` +
          `net=${fmtPct(m.totalReturnPct).padStart(8)} gross=${fmtPct(grossPct).padStart(8)} ` +
          `fee=${fmtPct(feeDragPct).padStart(6)} DD=${fmtPct(m.maxDrawdownPct).padStart(6)} exp=$${(m.expectancy || 0).toFixed(2)}`,
      );
      const eb = exitBreakdown(sim.trades);
      const ebStr = Object.entries(eb)
        .sort((a, b) => b[1].n - a[1].n)
        .map(([r, v]) => `${r}:${v.n}($${v.net.toFixed(0)})`)
        .join(" ");
      if (ebStr) console.log(`                   exits: ${ebStr}`);
    }
  }
}

console.log(`\n\n========== SUMMARY (sorted by net return) ==========`);
const sorted = [...results].filter((r) => r.m.totalTrades > 0).sort((a, b) => b.m.totalReturnPct - a.m.totalReturnPct);
for (const r of sorted) {
  console.log(
    `${r.sym.padEnd(9)} ${r.win.padEnd(5)} ${r.technique.padEnd(14)} net=${fmtPct(r.m.totalReturnPct).padStart(8)}  ` +
      `PF=${(r.m.profitFactor || 0).toFixed(2).padStart(5)}  wr=${fmtPct((r.m.winRate || 0) * 100).padStart(6)}  ` +
      `n=${String(r.m.totalTrades).padStart(4)}  fee=${fmtPct(r.feeDragPct).padStart(7)}`,
  );
}

console.log(`\n========== DIAGNOSIS (per technique, aggregated over windows) ==========`);
const byTech = {};
for (const r of results) {
  if (r.m.totalTrades === 0) continue;
  const k = r.technique;
  if (!byTech[k]) byTech[k] = { n: 0, gross: 0, net: 0, fee: 0, wins: 0, trades: 0 };
  byTech[k].n += 1;
  byTech[k].gross += r.grossPct;
  byTech[k].net += r.m.totalReturnPct;
  byTech[k].fee += r.feeDragPct;
  byTech[k].wins += (r.m.winRate || 0) * r.m.totalTrades;
  byTech[k].trades += r.m.totalTrades;
}
for (const [k, v] of Object.entries(byTech)) {
  const avgGross = v.gross / v.n;
  const avgNet = v.net / v.n;
  const wr = v.trades ? (v.wins / v.trades) * 100 : 0;
  let verdict;
  if (avgNet > 0) verdict = "EDGE survives costs";
  else if (avgGross > 0) verdict = "FEE/COST DRAG kills a gross-positive signal -> needs higher RR / fewer trades / maker fills";
  else verdict = "NO RAW EDGE (gross negative) -> technique only viable in its own regime, not always-on";
  console.log(
    `${k.padEnd(14)} avgGross=${fmtPct(avgGross).padStart(8)} avgNet=${fmtPct(avgNet).padStart(8)} ` +
      `wr=${fmtPct(wr).padStart(6)} trades=${v.trades} :: ${verdict}`,
  );
}

console.log(`\n========== PER-REGIME GROSS edge (Q1+Q2 non-overlapping) ==========`);
console.log(`(gross = signal edge BEFORE costs; proves which technique earns in which regime -> drives the router)\n`);
const techniques = ["trend_pullback", "mean_reversion", "donchian_break"];
const regimes = ["TREND_UP", "TREND_DOWN", "RANGE", "MIXED"];
const pad = (s, n) => String(s).padStart(n);
console.log(`${"technique".padEnd(16)}${regimes.map((r) => pad(r, 18)).join("")}`);
for (const tech of techniques) {
  let row = tech.padEnd(16);
  for (const reg of regimes) {
    const v = regimePnl[`${tech}|${reg}`];
    if (v && v.n > 0) {
      const wr = ((v.wins / v.n) * 100).toFixed(0);
      row += pad(`g$${v.gross.toFixed(0)}/${v.n}/${wr}%`, 18);
    } else {
      row += pad("-", 18);
    }
  }
  console.log(row);
}
console.log(`\n(cell = grossPnl / numTrades / winRate)`);
console.log(`\nBest gross cell per regime (the playbook each regime should run):`);
for (const reg of regimes) {
  let best = null;
  for (const tech of techniques) {
    const v = regimePnl[`${tech}|${reg}`];
    if (v && v.n >= 10 && (!best || v.gross > best.gross)) best = { tech, ...v };
  }
  if (best) {
    console.log(
      `  ${reg.padEnd(12)} -> ${best.tech.padEnd(15)} gross $${best.gross.toFixed(0)} over ${best.n} trades (wr ${((best.wins / best.n) * 100).toFixed(0)}%)`,
    );
  }
}

await closePool?.();
