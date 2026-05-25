#!/usr/bin/env node
/**
 * Phase A — Supertrend Elite gate analysis.
 *
 * For every SUPERTREND trade in the most-recent completed backtest run,
 * compute the 5 gate values at signal time and print a table showing
 * which gates each trade passes/fails and whether the trade won or lost.
 *
 * This answers: "Which gates eliminate the most losers while keeping winners?"
 *
 * Usage:
 *   node scripts/backtest-st-elite-analyze.mjs [runId]
 *   node scripts/backtest-st-elite-analyze.mjs --symbol BTCUSDT
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildEliteStSignalSeries, ELITE_ST_DEFAULTS } = await import("../src/strategy/supertrendElite.js");
const { computeSupertrendSeries } = await import("../src/strategy/supertrend.js");
const { ema, adx: computeAdx, atr: computeAtr } = await import("../src/strategy/indicators.js");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let targetRunId = null;
let targetSymbol = "BNBUSDT";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--symbol" && args[i + 1]) { targetSymbol = args[i + 1]; i++; }
  else if (/^\d+$/.test(args[i])) targetRunId = Number(args[i]);
}

// ── Load trades from DB ───────────────────────────────────────────────────────
const pool = getPool();

let runId = targetRunId;
if (!runId) {
  // Pick the most-recent completed SUPERTREND run for the target symbol
  const r = await pool.query(`
    SELECT id, strategy_key, symbol, timeframe, config_snapshot, created_at
    FROM backtest_runs
    WHERE status = 'done'
      AND strategy_key = 'SUPERTREND'
      AND symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [targetSymbol]);
  if (!r.rows.length) {
    console.error(`No completed SUPERTREND backtest run found for ${targetSymbol}. Run a SUPERTREND backtest first.`);
    await closePool?.();
    process.exit(1);
  }
  runId = r.rows[0].id;
  console.log(`Using most-recent SUPERTREND run: id=${runId}  symbol=${r.rows[0].symbol}  tf=${r.rows[0].timeframe}  created=${r.rows[0].created_at}`);
}

// Load the run metadata
const runRow = await pool.query("SELECT * FROM backtest_runs WHERE id = $1", [runId]);
if (!runRow.rows.length) { console.error(`Run ${runId} not found`); await closePool?.(); process.exit(1); }
const run = runRow.rows[0];
console.log(`\nAnalyzing run ${runId}: ${run.strategy_key} on ${run.symbol} ${run.timeframe}`);

// Load trades
const tradesRes = await pool.query(
  "SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY entry_ts ASC",
  [runId]
);
const trades = tradesRes.rows;
if (!trades.length) { console.error("No trades found for this run."); await closePool?.(); process.exit(1); }

const symbol = run.symbol;
const tf = run.timeframe;
const fromTs = Number(trades[0].entry_ts);
const toTs   = Number(trades[trades.length - 1].entry_ts) + 1;

// Load candles covering the full run window (+ 1 month warmup before first trade)
const warmupMs = 30 * 24 * 60 * 60 * 1000;
const candles = await readCandles(symbol, tf, fromTs - warmupMs, toTs + 86400000);
console.log(`Loaded ${candles.length} ${tf} candles for gate computation\n`);

// Build full gate series (all 5 gates active)
const fullSeries = buildEliteStSignalSeries(candles, {
  ...ELITE_ST_DEFAULTS,
  liqSweepEnabled: true,
});

// Build a ts→index map for fast lookup
const tsToIdx = new Map(candles.map((c, i) => [c.ts, i]));

// Build comparison series with each gate individually disabled (for impact analysis)
const gateVariants = [
  { name: "no_adx",    opts: { ...ELITE_ST_DEFAULTS, minAdx: 0, requireAdxRising: false } },
  { name: "no_vol",    opts: { ...ELITE_ST_DEFAULTS, minVolumeVsAvg: 0 } },
  { name: "no_htf1h",  opts: { ...ELITE_ST_DEFAULTS, requireHtf1hEmaAlign: false } },
  { name: "no_htf4h",  opts: { ...ELITE_ST_DEFAULTS, requireHtf4hAlign: false } },
  { name: "no_atr",    opts: { ...ELITE_ST_DEFAULTS, requireAtrExpansion: false } },
  { name: "all_gates", opts: { ...ELITE_ST_DEFAULTS } },
];

const variantSeries = {};
for (const v of gateVariants) {
  variantSeries[v.name] = buildEliteStSignalSeries(candles, v.opts);
}

// ── Per-trade analysis ────────────────────────────────────────────────────────
const rows = [];
let wins = 0, losses = 0;
let gateStats = { adx: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 }, vol: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 }, htf1h: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 }, htf4h: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 }, atr: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 }, all5: { keepW: 0, keepL: 0, filterW: 0, filterL: 0 } };

for (const t of trades) {
  const entryTs = Number(t.entry_ts);
  let idx = tsToIdx.get(entryTs);
  // Try finding the signal bar (1 bar before entry since entry fills at next bar open)
  if (idx == null) {
    // Scan nearby bars
    for (let off = -4; off <= 1; off++) {
      const near = candles.find((c, ci) => Math.abs(c.ts - entryTs) < 60000 * 20 && Math.abs(ci - (idx ?? 0)) < 3);
      if (near) { idx = tsToIdx.get(near.ts); break; }
    }
  }
  const signalIdx = idx != null ? Math.max(0, idx - 1) : null;

  const netPnl = Number(t.net_pnl ?? t.pnl ?? 0);
  const isWin  = netPnl > 0;
  if (isWin) wins++; else losses++;

  let gateRow = { adx: null, vol: null, htf1h: null, htf4h: null, atr: null };
  let allPass = false;
  let liqSweep = false;

  if (signalIdx != null) {
    const sig = fullSeries[signalIdx];
    allPass = sig != null && sig.action === t.side;
    if (sig?.gates) {
      gateRow = {
        adx:   sig.gates.adx?.pass   ?? false,
        vol:   sig.gates.volume?.pass ?? false,
        htf1h: sig.gates.htf1h?.pass  ?? false,
        htf4h: sig.gates.htf4h?.pass  ?? false,
        atr:   sig.gates.atr?.pass    ?? false,
      };
      liqSweep = sig.hasSweep === true;
    }

    // Count gate impact
    const vs = variantSeries;
    const mark = (key, seriesName, win) => {
      const passesWithout = vs[seriesName][signalIdx]?.action === t.side;
      const passesWith = gateRow[key] === true;
      const g = gateStats[key];
      if (passesWith) { if (win) g.keepW++; else g.keepL++; }
      else            { if (win) g.filterW++; else g.filterL++; }
    };
    mark("adx",   "no_adx",   isWin);
    mark("vol",   "no_vol",   isWin);
    mark("htf1h", "no_htf1h", isWin);
    mark("htf4h", "no_htf4h", isWin);
    mark("atr",   "no_atr",   isWin);

    const all5 = gateStats.all5;
    if (allPass) { if (isWin) all5.keepW++; else all5.keepL++; }
    else         { if (isWin) all5.filterW++; else all5.filterL++; }
  }

  rows.push({
    entryTs: new Date(entryTs).toISOString().slice(0, 16),
    side: t.side,
    netPnl: netPnl.toFixed(2),
    result: isWin ? "WIN" : "LOSS",
    adx:   gateRow.adx  == null ? "?" : gateRow.adx   ? "✓" : "✗",
    vol:   gateRow.vol  == null ? "?" : gateRow.vol    ? "✓" : "✗",
    htf1h: gateRow.htf1h == null ? "?" : gateRow.htf1h ? "✓" : "✗",
    htf4h: gateRow.htf4h == null ? "?" : gateRow.htf4h ? "✓" : "✗",
    atr:   gateRow.atr  == null ? "?" : gateRow.atr    ? "✓" : "✗",
    all5:  allPass ? "✓" : "✗",
    liq:   liqSweep ? "★" : " ",
    exitReason: t.exit_reason,
  });
}

// ── Print trade table (last 40 trades for readability) ───────────────────────
console.log("─".repeat(110));
console.log("TRADE ANALYSIS  (ADX / Vol / 1H-EMA / 4H-ST / ATR expansion / All-5 gates  ★=liquidity-sweep)");
console.log("─".repeat(110));
console.log(
  "EntryTime".padEnd(18) +
  "Side".padEnd(6) +
  "PnL".padStart(8) +
  "  Result  " +
  "ADX".padEnd(5) +
  "Vol".padEnd(5) +
  "1H-E".padEnd(6) +
  "4H-ST".padEnd(7) +
  "ATR".padEnd(5) +
  "All5".padEnd(6) +
  "Liq  ExitReason"
);
console.log("─".repeat(110));

const showRows = rows.length > 60 ? rows.slice(-60) : rows;
for (const r of showRows) {
  console.log(
    r.entryTs.padEnd(18) +
    r.side.padEnd(6) +
    String(r.netPnl).padStart(8) +
    `  ${r.result.padEnd(6)}  ` +
    r.adx.padEnd(5) +
    r.vol.padEnd(5) +
    r.htf1h.padEnd(6) +
    r.htf4h.padEnd(7) +
    r.atr.padEnd(5) +
    r.all5.padEnd(6) +
    `${r.liq}    ${r.exitReason}`
  );
}

// ── Gate impact summary ───────────────────────────────────────────────────────
const total = wins + losses;
console.log("\n" + "═".repeat(90));
console.log(`BASELINE: ${total} trades  WR ${((wins / total) * 100).toFixed(1)}%  (${wins} wins, ${losses} losses)`);
console.log("═".repeat(90));
console.log("\nGATE IMPACT (how each gate individually filters when all others are also applied):");
console.log("─".repeat(90));
console.log(
  "Gate".padEnd(10) +
  "Kept-W".padEnd(10) +
  "Kept-L".padEnd(10) +
  "Filt-W".padEnd(10) +
  "Filt-L".padEnd(10) +
  "Trades-after".padEnd(14) +
  "WR-after".padEnd(10) +
  "Verdict"
);
console.log("─".repeat(90));

const gateNames = ["adx", "vol", "htf1h", "htf4h", "atr", "all5"];
const gateLabels = { adx: "ADX≥25↑", vol: "Vol≥1.5x", htf1h: "1H-EMA", htf4h: "4H-ST", atr: "ATR-exp", all5: "ALL 5" };
for (const g of gateNames) {
  const s = gateStats[g];
  const after = s.keepW + s.keepL;
  const wr = after > 0 ? ((s.keepW / after) * 100).toFixed(1) : "n/a";
  const filtPct = total > 0 ? (((s.filterW + s.filterL) / total) * 100).toFixed(1) : "0";
  const verdict = s.filterL > s.filterW ? "✓ good" : s.filterL === s.filterW ? "neutral" : "⚠ hurts";
  console.log(
    (gateLabels[g] || g).padEnd(10) +
    String(s.keepW).padEnd(10) +
    String(s.keepL).padEnd(10) +
    String(s.filterW).padEnd(10) +
    String(s.filterL).padEnd(10) +
    String(after).padEnd(14) +
    `${wr}%`.padEnd(10) +
    `filters ${filtPct}% → ${verdict}`
  );
}

console.log("\n" + "═".repeat(90));
const a5 = gateStats.all5;
const a5Total = a5.keepW + a5.keepL;
const a5Wr = a5Total > 0 ? ((a5.keepW / a5Total) * 100).toFixed(1) : "n/a";
console.log(`ALL 5 GATES combined: ${a5Total} trades remain  WR ${a5Wr}%  (target: ~100 trades, 80%+ WR)`);
if (a5Wr !== "n/a" && Number(a5Wr) >= 80 && a5Total <= 130) {
  console.log("✅ TARGET ACHIEVED — run backtest-st-elite-sweep.mjs to validate across windows");
} else {
  const wr5 = Number(a5Wr);
  if (wr5 < 80) console.log(`⚠ WR below target (${a5Wr}%). Suggest tightening ADX ≥ 28 or adding liq-sweep requirement.`);
  if (a5Total > 130) console.log(`⚠ Too many trades (${a5Total}). Suggest raising minVolumeVsAvg or minAdx.`);
}

await closePool?.();
