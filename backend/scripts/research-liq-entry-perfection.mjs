#!/usr/bin/env node
/**
 * Entry perfection audit — was the trade a valid setup at entry, and did price
 * behave as the setup predicts? Exit/trail intentionally excluded.
 *
 * Usage: cd backend && node scripts/research-liq-entry-perfection.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TF = "15m";
const FROM = Date.parse("2025-06-01");
const TO = Date.parse("2026-06-01");
const COINS = ["BNBUSDT", "BTCUSDT"];

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js",
);
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  listSessionLiquiditySetups,
  scanSessionLiquidityCycles,
  reclaimHeldThrough,
  reclaimHeldOnBar,
  passesLiqSweepDisplacement,
  computeLiqEntryContextScore,
  maxSweepCycleImpulseAtr,
} = await import("../src/strategy/techniques/liquidity.js");
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js",
);

function findBarIdx(candles, ts) {
  let idx = candles.findIndex((c) => c.ts === ts);
  if (idx < 0) {
    idx = candles.findIndex((c) => c.ts > ts);
    if (idx > 0) idx--;
  }
  return idx;
}

function dayStartIndex(candles, idx) {
  const day = Math.floor(candles[idx].ts / 86_400_000);
  for (let j = idx; j >= 0; j--) {
    if (Math.floor(candles[j].ts / 86_400_000) < day) return j + 1;
  }
  return 0;
}

function mfeInBars(candles, entryIdx, side, entryPx, bars) {
  let best = 0;
  const end = Math.min(candles.length - 1, entryIdx + bars);
  for (let j = entryIdx + 1; j <= end; j++) {
    const b = candles[j];
    const move = side === "BUY" ? (b.high - entryPx) / entryPx : (entryPx - b.low) / entryPx;
    best = Math.max(best, move);
  }
  return best * 100;
}

function levelHeldBars(candles, entryIdx, side, level, maxBars) {
  let held = 0;
  for (let j = entryIdx + 1; j <= Math.min(candles.length - 1, entryIdx + maxBars); j++) {
    if (!reclaimHeldOnBar(candles, j, side, level)) break;
    held++;
  }
  return held;
}

function resolveCycle(candles, idx, side, pre, liq, opts) {
  const levelType = liq.levelType;
  const level = side === "BUY" ? pre.prevDayLow?.[idx] : pre.prevDayHigh?.[idx];
  const opp = side === "BUY" ? pre.prevDayHigh?.[idx] : pre.prevDayLow?.[idx];
  const lt = side === "BUY" ? "pdl" : "pdh";
  if (!(level > 0) || !(opp > 0)) return null;
  const dayStart = dayStartIndex(candles, idx);
  const cycles = scanSessionLiquidityCycles(
    candles,
    idx,
    side,
    level,
    opp,
    lt,
    Number(opts.srIntradaySweepPct ?? 0.001),
    dayStart,
    opts,
  );
  const reclaimIdx = Number(liq.reclaimIdx ?? idx);
  return (
    cycles.find((c) => c.levelType === levelType && Math.abs(c.reclaimIdx - reclaimIdx) <= 2) ??
    cycles.find((c) => c.levelType === levelType) ??
    cycles[0] ??
    null
  );
}

function auditEntry(trade, candles, pre, opts) {
  const idx = findBarIdx(candles, trade.entryTs);
  if (idx < 2) return null;

  const side = trade.direction;
  const liq = trade.liqContext ?? {};
  const entryPx = Number(trade.entryPrice ?? candles[idx]?.close ?? 0);
  const level = Number(liq.level ?? 0);
  const slPx = Number(trade.initialSlPrice ?? liq.slPrice ?? trade.slPrice ?? 0);
  const riskPct =
    entryPx > 0 && slPx > 0
      ? side === "BUY"
        ? (entryPx - slPx) / entryPx
        : (slPx - entryPx) / entryPx
      : Number(liq.slPct ?? 0);

  const cycle = resolveCycle(candles, idx, side, pre, liq, opts);
  const reclaimIdx = cycle?.reclaimIdx ?? Number(liq.reclaimIdx ?? idx);
  const reclaimBar = candles[reclaimIdx];
  const entryBar = candles[idx];
  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
  const minBody = Number(opts.intradayLiqMinReclaimBodyRatio ?? 0);
  const range = reclaimBar ? Math.max(1e-9, reclaimBar.high - reclaimBar.low) : 1;
  const bodyRatio = reclaimBar ? Math.abs(reclaimBar.close - reclaimBar.open) / range : 0;

  const impulse = cycle
    ? maxSweepCycleImpulseAtr(candles, cycle.sweepStartIdx, idx, pre)
    : 0;
  const dispRequired =
    opts.intradayLiqRequireSweepDisplacement === true ||
    Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 0) > 0;
  const dispOk = cycle
    ? passesLiqSweepDisplacement(cycle, candles, pre, opts, idx)
    : !dispRequired;

  const entryCtx = cycle
    ? computeLiqEntryContextScore(candles, cycle, side, pre, opts, idx, reclaimBar)
    : null;

  const checklist = {
    sweepExtension: cycle ? cycle.extension + 1e-6 >= minExt : null,
    reclaimBody: minBody <= 0 || bodyRatio + 1e-6 >= minBody,
    reclaimDirection:
      !reclaimBar ||
      (side === "BUY" ? reclaimBar.close > reclaimBar.open : reclaimBar.close < reclaimBar.open),
    reclaimHold: level > 0 ? reclaimHeldThrough(candles, reclaimIdx, idx, side, level) : null,
    notSameBarReclaim:
      opts.intradayLiqRejectSameBarReclaim !== true || reclaimIdx !== cycle?.sweepStartIdx,
    displacement: dispOk,
    entryScorePass:
      opts.intradayLiqUseEntryScore !== true ||
      (entryCtx && entryCtx.score >= Number(opts.intradayLiqMinEntryScore ?? 52)),
  };

  const structuralKeys = Object.keys(checklist).filter((k) => checklist[k] !== null);
  const structuralPass = structuralKeys.filter((k) => checklist[k] === true).length;
  const entryStructuralPct = structuralKeys.length
    ? (structuralPass / structuralKeys.length) * 100
    : 0;
  const entryPerfect = structuralKeys.length > 0 && structuralPass === structuralKeys.length;

  const held3 = level > 0 ? levelHeldBars(candles, idx, side, level, 3) : 0;
  const held8 = level > 0 ? levelHeldBars(candles, idx, side, level, 8) : 0;
  const mfe4 = mfeInBars(candles, idx, side, entryPx, 4);
  const mfe12 = mfeInBars(candles, idx, side, entryPx, 12);
  const mfe24 = mfeInBars(candles, idx, side, entryPx, 24);
  const halfR = riskPct > 0 ? riskPct * 50 : 0.5;
  const oneR = riskPct > 0 ? riskPct * 100 : 1.0;

  const followThrough = {
    levelHeld3Bars: held3 >= 3,
    levelHeld8Bars: held8 >= 8,
    mfe4Pct: mfe4,
    mfe12Pct: mfe12,
    mfe24Pct: mfe24,
    hitHalfR4: mfe4 >= halfR,
    hit1R12: mfe12 >= oneR,
    immediateRebreak: held3 === 0,
  };

  // Setup "worked" = structural reclaim held and price developed toward target zone
  const setupWorked = followThrough.levelHeld3Bars && (followThrough.hitHalfR4 || mfe12 >= 0.4);

  let entryVerdict = "imperfect";
  if (entryPerfect && setupWorked) entryVerdict = "perfect_worked";
  else if (entryPerfect && !setupWorked) entryVerdict = "perfect_failed_follow";
  else if (!entryPerfect && setupWorked) entryVerdict = "imperfect_worked";
  else entryVerdict = "imperfect_failed";

  return {
    symbol: opts.symbol,
    tradeId: trade.tradeNumber ?? trade.entryTs,
    ts: trade.entryTs,
    side,
    levelType: liq.levelType ?? cycle?.levelType ?? "?",
    pnl: Number(trade.netPnl ?? 0),
    win: Number(trade.netPnl ?? 0) > 0,
    exit: trade.exitReason,
    entryPerfect,
    entryStructuralPct,
    checklist,
    impulse,
    extension: cycle?.extension ?? null,
    reclaimBars: cycle ? idx - cycle.sweepStartIdx : null,
    entryScore: entryCtx?.score ?? liq.liqQuality ?? null,
    entryBreakdown: entryCtx?.breakdown ?? null,
    riskPct: riskPct * 100,
    dayRegime: isBreakdownDay(candles, idx, pre)
      ? "breakdown"
      : isBreakoutDay(candles, idx, pre)
        ? "breakout"
        : "neutral",
    followThrough,
    setupWorked,
    entryVerdict,
    mfeTrade: Number(trade.mfePct ?? 0) * 100,
  };
}

async function runCoin(symbol) {
  const candles = await readCandles(symbol, TF, FROM, TO, { market: "futures" });
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, symbol, timeframe: TF, trailingStopLossAuto: false },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const pre = precomputeIntraday(candles);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  });
  const rows = [];
  for (const t of sim.trades) {
    const row = auditEntry(t, candles, pre, { ...cfg, symbol });
    if (row) rows.push(row);
  }
  return { symbol, rows, n: sim.trades.length };
}

function pct(n, d) {
  return d ? ((n / d) * 100).toFixed(1) : "—";
}

function summarize(rows) {
  const n = rows.length;
  const perfect = rows.filter((r) => r.entryPerfect).length;
  const worked = rows.filter((r) => r.setupWorked).length;
  const perfectWorked = rows.filter((r) => r.entryVerdict === "perfect_worked").length;
  const perfectFail = rows.filter((r) => r.entryVerdict === "perfect_failed_follow").length;
  const imperfectFail = rows.filter((r) => r.entryVerdict === "imperfect_failed").length;
  const wins = rows.filter((r) => r.win).length;
  const perfectWins = rows.filter((r) => r.entryPerfect && r.win).length;
  const workedWins = rows.filter((r) => r.setupWorked && r.win).length;
  const workedLosses = rows.filter((r) => r.setupWorked && !r.win).length;
  const failFollowLosses = rows.filter((r) => r.entryVerdict === "perfect_failed_follow").length;

  return {
    n,
    perfect,
    worked,
    perfectWorked,
    perfectFail,
    imperfectFail,
    wins,
    perfectWins,
    workedWins,
    workedLosses,
    failFollowLosses,
    avgMfe12: rows.reduce((a, r) => a + r.followThrough.mfe12Pct, 0) / Math.max(1, n),
    avgHeld3: rows.reduce((a, r) => a + (r.followThrough.levelHeld3Bars ? 1 : 0), 0) / Math.max(1, n),
    checklistRates: Object.fromEntries(
      ["sweepExtension", "reclaimBody", "reclaimDirection", "reclaimHold", "displacement", "entryScorePass"].map(
        (k) => [k, rows.filter((r) => r.checklist[k] === true).length],
      ),
    ),
  };
}

console.log("\n=== LIQ entry perfection audit (exit/trail excluded) ===\n");
console.log(`Window: Jun 2025 – Jun 2026 | Preset: INTRADAY_PRO_LIQ_15M partial TP\n`);

const data = {};
for (const sym of COINS) {
  process.stdout.write(`Auditing ${sym}…\n`);
  data[sym] = await runCoin(sym);
}

for (const sym of COINS) {
  const s = summarize(data[sym].rows);
  console.log(`\n--- ${sym} (${s.n} trades) ---`);
  console.log(`Structurally perfect entry: ${s.perfect}/${s.n} (${pct(s.perfect, s.n)}%)`);
  console.log(`Setup worked post-entry:   ${s.worked}/${s.n} (${pct(s.worked, s.n)}%)`);
  console.log(`  perfect + worked:        ${s.perfectWorked} (${pct(s.perfectWorked, s.n)}%)`);
  console.log(`  perfect + no follow:     ${s.perfectFail} (${pct(s.perfectFail, s.n)}%)`);
  console.log(`  imperfect + failed:      ${s.imperfectFail} (${pct(s.imperfectFail, s.n)}%)`);
  console.log(`Win rate: ${pct(s.wins, s.n)}% | Wins when entry perfect: ${pct(s.perfectWins, s.perfect)}%`);
  console.log(`Wins when setup worked: ${s.workedWins}/${s.worked} | Losses when setup worked: ${s.workedLosses}`);
  console.log(`Avg MFE first 12 bars: ${s.avgMfe12.toFixed(2)}% | Level held 3 bars: ${(s.avgHeld3 * 100).toFixed(0)}%`);
  console.log("Checklist pass rates:");
  for (const [k, v] of Object.entries(s.checklistRates)) {
    console.log(`  ${k.padEnd(18)} ${v}/${s.n} (${pct(v, s.n)}%)`);
  }
}

console.log("\n--- BNB vs BTC: why divergence? ---");
const bnb = data.BNBUSDT.rows;
const btc = data.BTCUSDT.rows;
const cmp = (key, fn = (r) => r[key]) => {
  const b = bnb.map(fn).filter((v) => Number.isFinite(v));
  const t = btc.map(fn).filter((v) => Number.isFinite(v));
  const mb = b.length ? b.reduce((a, x) => a + x, 0) / b.length : null;
  const mt = t.length ? t.reduce((a, x) => a + x, 0) / t.length : null;
  return { key, bnb: mb, btc: mt, delta: mb != null && mt != null ? mt - mb : null };
};
const metrics = [
  cmp("entryStructuralPct"),
  cmp("impulse"),
  cmp("extension"),
  cmp("reclaimBars"),
  cmp("entryScore"),
  cmp("followThrough", (r) => r.followThrough.mfe12Pct),
  cmp("followThrough", (r) => (r.followThrough.levelHeld3Bars ? 1 : 0)),
  cmp("followThrough", (r) => (r.followThrough.hitHalfR4 ? 1 : 0)),
  cmp("setupWorked", (r) => (r.setupWorked ? 1 : 0)),
];
console.log(`${"metric".padEnd(22)} ${"BNB".padStart(8)} ${"BTC".padStart(8)} ${"Δ".padStart(8)}`);
for (const m of metrics) {
  const f = (v) => (v == null ? "—" : typeof v === "number" && v < 2 ? v.toFixed(3) : v.toFixed(2));
  console.log(`${m.key.padEnd(22)} ${f(m.bnb).padStart(8)} ${f(m.btc).padStart(8)} ${f(m.delta).padStart(8)}`);
}

console.log("\n--- BTC entry verdict breakdown ---");
const verdicts = ["perfect_worked", "perfect_failed_follow", "imperfect_worked", "imperfect_failed"];
for (const v of verdicts) {
  const sub = btc.filter((r) => r.entryVerdict === v);
  const pnl = sub.reduce((a, r) => a + r.pnl, 0);
  console.log(
    `  ${v.padEnd(24)} n=${String(sub.length).padStart(2)} totalPnL=$${pnl.toFixed(2)} avgMFE12=${sub.length ? (sub.reduce((a, r) => a + r.followThrough.mfe12Pct, 0) / sub.length).toFixed(2) : "—"}%`,
  );
}

console.log("\n--- BTC imperfect entries (structural fail) ---");
for (const r of btc.filter((t) => !t.entryPerfect)) {
  const fails = Object.entries(r.checklist).filter(([, v]) => v === false).map(([k]) => k);
  console.log(
    `  ${new Date(r.ts).toISOString().slice(0, 16)} ${r.side} ${r.levelType} fails=[${fails.join(",")}] worked=${r.setupWorked} pnl=${r.pnl.toFixed(2)}`,
  );
}

console.log("\n--- BTC: perfect entry but setup didn't follow through ---");
for (const r of btc.filter((t) => t.entryVerdict === "perfect_failed_follow")) {
  console.log(
    `  ${new Date(r.ts).toISOString().slice(0, 16)} ${r.side} ${r.levelType} held3=${r.followThrough.levelHeld3Bars} mfe12=${r.followThrough.mfe12Pct.toFixed(2)}% impulse=${r.impulse.toFixed(2)} regime=${r.dayRegime} pnl=${r.pnl.toFixed(2)} exit=${r.exit}`,
  );
}

console.log("\n--- Note on trail (deferred) ---");
console.log(
  "Trail buffer already supports ATR mode (trailBufferMode: ATR, trailBufferAtrMult per coin). Tuning deferred until entry edge is understood.",
);

await closePool();
