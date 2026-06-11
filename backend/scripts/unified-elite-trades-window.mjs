#!/usr/bin/env node
/**
 * UNIFIED_ELITE — list trades and signal funnel for a date window (default BNB 1h Jun 1–3 2026).
 * Usage: node scripts/unified-elite-trades-window.mjs [SYMBOL] [FROM] [TO]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const sym = (process.argv[2] || "BNBUSDT").toUpperCase();
const fromStr = process.argv[3] || "2026-06-01";
const toStr = process.argv[4] || "2026-06-04"; // exclusive end → includes all of Jun 3
const tf = "1h";

const windowFrom = new Date(`${fromStr}T00:00:00.000Z`).getTime();
const windowTo = new Date(`${toStr}T00:00:00.000Z`).getTime();
const warmupMs = 14 * 24 * 60 * 60 * 1000;
const loadFrom = windowFrom - warmupMs;

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildRegimeSeries, REGIMES } = await import("../src/strategy/regimeEngine.js");
const { buildEliteStSignalSeries, buildEliteStOptsFromCfg, normalizeEliteStRunCfg } = await import(
  "../src/strategy/supertrendElite.js",
);
const { buildUnifiedEliteOptsFromCfg } = await import("../src/strategy/unifiedElite.js");
const { UNIFIED_ELITE_BNB_1H } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const cfg = normalizeEliteStRunCfg({
  ...UNIFIED_ELITE_BNB_1H,
  symbol: sym,
  timeframe: tf,
  marketMode: "FUTURES",
});

const candles = await readCandles(sym, tf, loadFrom, windowTo);
if (!candles.length) {
  console.error(`No ${sym} ${tf} data`);
  await closePool();
  process.exit(1);
}

const adapters = await buildBacktestAdapters({
  strategyKey: "UNIFIED_ELITE",
  cfg,
  symbol: sym,
  tf,
  candles,
  fromMs: loadFrom,
});
const adapter = adapters.UNIFIED_ELITE;

const regimeSeries = buildRegimeSeries(candles);
const eliteSeries = buildEliteStSignalSeries(candles, buildEliteStOptsFromCfg(cfg));
const unifiedOpts = buildUnifiedEliteOptsFromCfg(cfg);

function inWindow(ts) {
  return ts >= windowFrom && ts < windowTo;
}

function fmtTs(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// ── Signal funnel (entries in window) ─────────────────────────────────────────
const eliteInWindow = [];
const unifiedTaken = [];
const unifiedBlocked = [];

for (let i = 0; i < candles.length; i++) {
  const bar = candles[i];
  if (!inWindow(bar.ts)) continue;

  const elite = eliteSeries[i];
  const reg = regimeSeries[i]?.regime ?? "?";
  const gateMode = unifiedOpts.unifiedRegimeGateMode ?? "skip_squeeze_only";
  const isSqueeze = reg === REGIMES.SQUEEZE;
  const isVolatile = reg === REGIMES.VOLATILE_AVOID;
  const shouldSkip =
    gateMode === "skip_volatile_squeeze" ? isSqueeze || isVolatile : isSqueeze;

  if (elite?.action === "BUY" || elite?.action === "SELL") {
    eliteInWindow.push({ i, ts: bar.ts, side: elite.action, reason: elite.reason, regime: reg });
  }

  const sig = adapter(bar, i);
  if (sig?.action === "BUY" || sig?.action === "SELL") {
    unifiedTaken.push({
      i,
      ts: bar.ts,
      side: sig.action,
      reason: sig.reason,
      regime: reg,
      riskScale: sig.riskScale ?? 1,
      layer: sig.signal_context?.layer ?? "elite",
      close: bar.close,
    });
  } else if (elite && shouldSkip && unifiedOpts.unifiedRegimeGate) {
    unifiedBlocked.push({ ts: bar.ts, side: elite.action, regime: reg, why: `regime gate (${reg})` });
  } else if (elite && reg === REGIMES.RANGE && !sig) {
    unifiedBlocked.push({ ts: bar.ts, side: elite.action, regime: reg, why: "RANGE — elite path off; no LIQ+SR supplement" });
  }
}

// ── Full simulation (trades entering in window) ───────────────────────────────
const sim = await runSimulation({
  strategyKey: "UNIFIED_ELITE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 1000,
  timeframe: tf,
  adapters: { UNIFIED_ELITE: adapter },
  symbol: sym,
});

const tradesInWindow = sim.trades.filter((t) => inWindow(t.entryTs));

console.log(`\n=== UNIFIED_ELITE trades — ${sym} ${tf} ===`);
console.log(`Window: ${fromStr} → ${toStr} (exclusive)  |  bars in window: ${candles.filter((c) => inWindow(c.ts)).length}`);
console.log(`Preset: regime=skip_squeeze_only, liq scale ${unifiedOpts.unifiedLiqScaleFactor}×, LIQ+SR supplement ${unifiedOpts.unifiedLiqSrEnabled}\n`);

console.log(`── Signal funnel (${eliteInWindow.length} raw Elite flips in window) ──`);
if (!eliteInWindow.length) {
  console.log("  No Supertrend Elite flips passed all 5 gates in this window.\n");
} else {
  for (const e of eliteInWindow) {
    const taken = unifiedTaken.find((u) => u.ts === e.ts);
    const blocked = unifiedBlocked.find((b) => b.ts === e.ts);
    const status = taken ? `TAKEN ${taken.reason} risk×${taken.riskScale}` : blocked ? `SKIP — ${blocked.why}` : "SKIP — adapter null";
    console.log(`  ${fmtTs(e.ts)}  ${e.side.padEnd(4)}  regime=${e.regime.padEnd(14)}  ${status}`);
  }
  console.log("");
}

console.log(`── Executed trades (${tradesInWindow.length} entries in window) ──`);
if (!tradesInWindow.length) {
  console.log("  No trades opened in this window.\n");
} else {
  let n = 0;
  for (const t of tradesInWindow) {
    n++;
    const net = Number(t.netPnl ?? 0);
    const win = net > 0 ? "WIN" : "LOSS";
    console.log(`\n  Trade #${n}  ${win}`);
    console.log(`    Entry:  ${fmtTs(t.entryTs)}  ${t.direction}  @ ${Number(t.entryPrice).toFixed(4)}`);
    console.log(`    Exit:   ${fmtTs(t.exitTs)}  ${t.exitReason ?? "—"}  @ ${Number(t.exitPrice).toFixed(4)}`);
    console.log(`    Net:    ${net >= 0 ? "+" : ""}${net.toFixed(2)} USDT (${(Number(t.netPnlPct ?? 0) * 100).toFixed(2)}%)`);
    if (t.signalReason) console.log(`    Signal: ${t.signalReason}`);
  }
  const sumNet = tradesInWindow.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);
  console.log(`\n  Window PnL sum: ${sumNet >= 0 ? "+" : ""}${sumNet.toFixed(2)} USDT on $1000 start\n`);
}

await closePool();
