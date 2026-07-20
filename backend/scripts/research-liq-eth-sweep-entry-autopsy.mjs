#!/usr/bin/env node
/**
 * ETH SWEEP_RECLAIM entry autopsy — per-trade technical diagnosis + funnel + config matrix.
 * Usage: cd backend && node scripts/research-liq-eth-sweep-entry-autopsy.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const FROM_MS = Date.parse("2025-06-01");
const TO_MS = Date.parse("2026-06-01");
const STARTING = 100;

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_ETH_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js",
);
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
const {
  listSessionLiquiditySetups,
  scanSessionLiquidityCycles,
  computeLiqEntryContextScore,
  maxSweepCycleImpulseAtr,
  reclaimHeldThrough,
  passesLiqChochGate,
  utcDayId,
  dayStartIndex,
} = await import("../src/strategy/techniques/liquidity.js");
const { isBreakdownDay, isBreakoutDay } = await import("../src/strategy/techniques/liquidityTrendContinuation.js");
const { buildLiqMarketContext } = await import("../src/strategy/techniques/liq/marketState.js");
const { computeSweepQuality } = await import("../src/strategy/techniques/liq/sweepQuality.js");
const { detectChochInRange } = await import("../src/strategy/techniques/structureShift.js");

const candles = await readCandles(SYMBOL, TF, FROM_MS - 21 * 864e5, TO_MS, { market: "futures" });
const WARMUP = 100;

function baseCfg(overrides = {}) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    {
      ...INTRADAY_PRO_LIQ_ETH_15M,
      symbol: SYMBOL,
      timeframe: TF,
      intradayGateLiquidity: true,
      intradayGateSession: false,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      backtestTrailMicroTf: "5m",
      ...overrides,
    },
    materializeIntradayPanelOnCfg,
  );
  return mergeAdaptiveCfg(cfg, candles);
}

async function runCfg(label, overrides = {}) {
  const cfg = baseCfg(overrides);
  const trailMicro = await buildTrailMicroContext({
    symbol: SYMBOL,
    fromMs: FROM_MS,
    toMs: TO_MS,
    cfg,
    trailEnabled: true,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: STARTING,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: STARTING,
  });
  return { label, cfg, sim, m };
}

function liqOf(t) {
  return t.liqContext ?? {};
}

function fmtPct(n, d = 2) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—";
}

function diagnoseTrade(t, pre, cfg) {
  const l = liqOf(t);
  const entryTs = Number(t.entryTs);
  let idx = candles.findIndex((c) => c.ts === entryTs);
  if (idx < 0) {
    idx = candles.findIndex((c) => Math.abs(c.ts - entryTs) < 900_000);
  }
  if (idx < 0) return null;

  const dayStart = dayStartIndex(candles, idx);
  const ctx = buildLiqMarketContext(candles, idx, pre, cfg);
  const breakdown = isBreakdownDay(candles, idx, pre);
  const breakout = isBreakoutDay(candles, idx, pre);
  const htfUp = Boolean(pre.htfUp?.[idx]);
  const htfDown = Boolean(pre.htfDown?.[idx]);
  const adx = Number(pre.adxSeries?.[idx]);

  const side = t.direction;
  const levelType = l.levelType ?? "?";
  const fakePattern = [];
  if (side === "BUY" && levelType === "pdl" && breakdown) fakePattern.push("PDL_fade_on_breakdown_day");
  if (side === "SELL" && levelType === "pdh" && breakout) fakePattern.push("PDH_fade_on_breakout_day");
  if (side === "BUY" && htfDown) fakePattern.push("BUY_vs_HTF_down");
  if (side === "SELL" && htfUp) fakePattern.push("SELL_vs_HTF_up");
  if (side === "BUY" && levelType === "pdl" && !htfUp) fakePattern.push("PDL_without_HTF_up");
  if (side === "SELL" && levelType === "pdh" && !htfDown) fakePattern.push("PDH_without_HTF_down");

  const sweepStart = l.sweepStartIdx ?? l.sweepIdx;
  const reclaimIdx = l.reclaimIdx;
  let impulse = null;
  let choch = null;
  let sq = null;
  if (Number.isFinite(sweepStart) && Number.isFinite(reclaimIdx)) {
    impulse = maxSweepCycleImpulseAtr(candles, sweepStart, reclaimIdx, pre);
    choch = detectChochInRange(candles, sweepStart, idx, side, cfg);
    sq = computeSweepQuality(
      candles,
      { sweepStartIdx: sweepStart, reclaimIdx, level: l.level, wick: l.wick, extension: l.extension },
      side,
      pre,
      cfg,
    );
  }

  const barsAfter = [];
  for (let j = idx + 1; j <= Math.min(candles.length - 1, idx + 8); j++) {
    const b = candles[j];
    barsAfter.push({
      d: j - idx,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      against:
        side === "BUY" ? b.close < t.entryPrice : b.close > t.entryPrice,
    });
  }
  const immediateFail = barsAfter.slice(0, 3).filter((b) => b.against).length;

  return {
    n: t.tradeNumber,
    dir: side,
    pnl: Number(t.netPnl),
    win: Number(t.netPnl) > 0,
    exit: t.exitReason,
    entry: new Date(entryTs).toISOString().slice(0, 16),
    level: levelType,
    daySit: ctx.daySituation,
    breakdown,
    breakout,
    htfUp,
    htfDown,
    adx,
    ext: l.extension,
    body: l.reclaimBodyRatio,
    entryScore: l.entryScore,
    impulse,
    chochOk: choch?.ok,
    sweepVol: sq?.sweepVolSpike,
    sweepVel: sq?.sweepVelocityAtr,
    attempts: l.attemptCount ?? sq?.attemptCount,
    sameBar: l.sameBarReclaim,
    holdBars: idx - (reclaimIdx ?? idx),
    fakePattern,
    immediateFail,
    mfe: t.mfePct,
    mae: t.maePct,
  };
}

// ── Funnel on baseline cfg ─────────────────────────────────────────────
const baselineCfg = baseCfg();
const pre = precomputeIntraday(candles);
const liqOpts = { ...baselineCfg, sweepPct: baselineCfg.srIntradaySweepPct, _liqPre: pre };

let rawCycles = 0;
let afterReclaimStrength = 0;
let afterDisplacement = 0;
let afterEntryScore = 0;
let afterHtfTrendPullback = 0;

for (let i = WARMUP; i < candles.length; i++) {
  if (new Date(candles[i].ts) < FROM_MS || new Date(candles[i].ts) > TO_MS) continue;
  for (const side of ["BUY", "SELL"]) {
    const setups = listSessionLiquiditySetups(candles, i, side, pre, liqOpts);
    for (const s of setups) {
      if (s.reclaimIdx !== i - (baselineCfg.intradayLiqReclaimHoldBars ?? 0)) continue;
      rawCycles++;
      const impulse = maxSweepCycleImpulseAtr(candles, s.sweepStartIdx, s.reclaimIdx, pre);
      if (impulse >= 1.2) afterDisplacement++;
      if ((s.entryScore ?? s.score ?? 0) >= 45) afterEntryScore++;
      if (
        (side === "BUY" && pre.htfUp?.[i]) ||
        (side === "SELL" && pre.htfDown?.[i])
      ) {
        afterHtfTrendPullback++;
      }
      afterReclaimStrength++;
    }
  }
}

console.log("\n═══ ETH SWEEP_RECLAIM ENTRY AUTOPSY ═══");
console.log(`Window: ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}`);
console.log("\n── Signal funnel (baseline ETH preset) ──");
console.log(`  Raw reclaim signals at entry bar:     ${rawCycles}`);
console.log(`  + reclaim strength pass:              ${afterReclaimStrength}`);
console.log(`  + displacement impulse ≥ 1.2 ATR:     ${afterDisplacement}`);
console.log(`  + entry score ≥ 45:                   ${afterEntryScore}`);
console.log(`  + HTF trend_pullback align:           ${afterHtfTrendPullback}`);

// ── Baseline backtest + per-trade diagnosis ───────────────────────────
const baseline = await runCfg("BASELINE_ETH_PRESET");
console.log("\n── Baseline backtest ──");
console.log(
  `  n=${baseline.m.totalTrades} ret=${baseline.m.totalReturnPct?.toFixed(1)}% WR=${((baseline.m.winRate ?? 0) * 100).toFixed(0)}% PF=${baseline.m.profitFactor?.toFixed(2)}`,
);

const diagnoses = baseline.sim.trades.map((t) => diagnoseTrade(t, pre, baseline.cfg)).filter(Boolean);
const wins = diagnoses.filter((d) => d.win);
const losses = diagnoses.filter((d) => !d.win);

console.log("\n── Per-trade diagnosis ──");
console.log(
  " # | entry          | side | level | pnl    | exit       | day      | HTF    | impulse | choch | vol× | fake flags",
);
for (const d of diagnoses) {
  const htf = d.dir === "BUY" ? (d.htfUp ? "up" : "dn") : d.htfDown ? "dn" : "up";
  console.log(
    `${String(d.n).padStart(2)} | ${d.entry} | ${d.dir.padEnd(4)} | ${String(d.level).padEnd(5)} | ${d.pnl.toFixed(2).padStart(6)} | ${String(d.exit).padEnd(10)} | ${String(d.daySit ?? "?").padEnd(8)} | ${htf.padEnd(6)} | ${(d.impulse ?? 0).toFixed(2).padStart(7)} | ${d.chochOk ? "Y" : "N"} | ${(d.sweepVol ?? 0).toFixed(1).padStart(4)} | ${d.fakePattern.join(",") || "—"}`,
  );
}

function patternCount(arr, key) {
  const m = new Map();
  for (const d of arr) {
    for (const p of d[key] ?? []) {
      m.set(p, (m.get(p) ?? 0) + 1);
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

console.log("\n── Loser fake-pattern counts ──");
for (const [p, n] of patternCount(losses, "fakePattern")) {
  console.log(`  ${p}: ${n}/${losses.length} losers`);
}

const avg = (arr, k) => (arr.length ? arr.reduce((s, d) => s + (Number(d[k]) || 0), 0) / arr.length : 0);
console.log("\n── Winner vs loser averages ──");
console.log(
  `  impulse ATR:  wins=${avg(wins, "impulse").toFixed(2)}  losses=${avg(losses, "impulse").toFixed(2)}`,
);
console.log(
  `  sweep vol×:   wins=${avg(wins, "sweepVol").toFixed(2)}  losses=${avg(losses, "sweepVol").toFixed(2)}`,
);
console.log(
  `  extension:    wins=${avg(wins, "ext").toFixed(4)}  losses=${avg(losses, "ext").toFixed(4)}`,
);
console.log(
  `  entry score:  wins=${avg(wins, "entryScore").toFixed(1)}  losses=${avg(losses, "entryScore").toFixed(1)}`,
);
console.log(
  `  immediate fail bars (0-3): wins=${avg(wins, "immediateFail").toFixed(1)} losses=${avg(losses, "immediateFail").toFixed(1)}`,
);

// ── Config matrix ─────────────────────────────────────────────────────
const variants = [
  ["BASELINE", {}],
  ["fade_not_trend_pullback", { intradayLiqEntryMode: "fade", intradayLiqVetoCounterTrend: false }],
  ["fade+choch", { intradayLiqEntryMode: "fade", intradayLiqRequireChoch: true, intradayLiqVetoCounterTrend: false }],
  ["no_onePick", { intradayLiqOnePickPerDay: false, srIntradayMaxTradesPerDay: 3 }],
  ["no_entry_score", { intradayLiqUseEntryScore: false, intradayLiqMinQuality: 0 }],
  ["no_displacement", { intradayLiqRequireSweepDisplacement: false }],
  ["no_adx_band", { intradayLiqMinAdx: 0, intradayLiqMaxAdx: 0 }],
  ["no_session_extreme", { intradayLiqSessionExtreme: false }],
  ["no_htf_required", { intradayLiqRequireHtfAlign: false }],
  ["classical_fade_loose", {
    intradayLiqEntryMode: "fade",
    intradayLiqVetoCounterTrend: false,
    intradayLiqRequireSweepDisplacement: false,
    intradayLiqUseEntryScore: false,
    intradayLiqOnePickPerDay: false,
    intradayLiqMinAdx: 0,
    intradayLiqMaxAdx: 0,
    intradayLiqSessionExtreme: false,
    intradayLiqMinReclaimBodyRatio: 0.35,
    intradayLiqMinRr: 0,
  }],
  ["PROPOSED_v2", {
    intradayLiqEntryMode: "fade",
    intradayLiqVetoCounterTrend: true,
    intradayLiqBreakdownDayBias: true,
    intradayLiqRequireChoch: true,
    intradayLiqRequireSweepDisplacement: true,
    intradayLiqSweepDisplacementMinAtrMult: 1.5,
    intradayLiqSweepMinVolRatio: 1.2,
    intradayLiqMinReclaimBodyRatio: 0.45,
    intradayLiqReclaimHoldBars: 1,
    intradayLiqUseEntryScore: true,
    intradayLiqMinEntryScore: 50,
    intradayLiqOnePickPerDay: false,
    srIntradayMaxTradesPerDay: 2,
    intradayLiqMinAdx: 0,
    intradayLiqMaxAdx: 0,
    intradayLiqSessionExtreme: false,
    intradayLiqMinRr: 0,
  }],
  ["PROPOSED_v3_more_trades", {
    intradayLiqEntryMode: "fade",
    intradayLiqVetoCounterTrend: true,
    intradayLiqBreakdownDayBias: true,
    intradayLiqRequireChoch: false,
    intradayLiqRequireSweepDisplacement: true,
    intradayLiqSweepDisplacementMinAtrMult: 1.2,
    intradayLiqSweepMinVolRatio: 1.0,
    intradayLiqMinReclaimBodyRatio: 0.4,
    intradayLiqReclaimHoldBars: 1,
    intradayLiqUseEntryScore: false,
    intradayLiqMinQuality: 0,
    intradayLiqOnePickPerDay: false,
    srIntradayMaxTradesPerDay: 2,
    intradayLiqMinAdx: 0,
    intradayLiqMaxAdx: 0,
    intradayLiqSessionExtreme: true,
    intradayLiqMinRr: 0,
    intradayLiqPdhPdlOnly: false,
  }],
];

console.log("\n── Config matrix (entry-focused, same exit/trail) ──");
console.log("  label                          | n   | ret%   | WR%  | PF   | t/day");
const days = (TO_MS - FROM_MS) / 864e5;
for (const [label, ov] of variants) {
  const r = await runCfg(label, ov);
  const tpd = (r.m.totalTrades / days).toFixed(2);
  console.log(
    `  ${label.padEnd(30)} | ${String(r.m.totalTrades).padStart(3)} | ${(r.m.totalReturnPct ?? 0).toFixed(1).padStart(6)} | ${((r.m.winRate ?? 0) * 100).toFixed(0).padStart(4)} | ${(r.m.profitFactor ?? 0).toFixed(2).padStart(4)} | ${tpd}`,
  );
}

await closePool();
