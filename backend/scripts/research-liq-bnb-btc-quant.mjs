#!/usr/bin/env node
/**
 * Quantitative LIQ research — BNB vs BTC feature comparison, regime clustering,
 * exit efficiency, entry-score expectancy curves. Not parameter sweeps.
 *
 * Usage: cd backend && node scripts/research-liq-bnb-btc-quant.mjs
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
const START = 100;

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
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
const { listSessionLiquiditySetups, barsSinceDisplacement } = await import(
  "../src/strategy/techniques/liquidity.js",
);
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js",
);

function utcHour(ts) {
  return Math.floor((ts % 86_400_000) / 3_600_000);
}

function sessionBucket(ts) {
  const h = utcHour(ts);
  if (h >= 0 && h < 8) return "asia";
  if (h >= 8 && h < 13) return "london";
  if (h >= 13 && h < 17) return "overlap";
  if (h >= 17 && h < 22) return "ny";
  return "late";
}

function dayStartIndex(candles, idx) {
  const day = Math.floor(candles[idx].ts / 86_400_000);
  for (let j = idx; j >= 0; j--) {
    if (Math.floor(candles[j].ts / 86_400_000) < day) return j + 1;
  }
  return 0;
}

function avgVolume(candles, idx, lookback = 20) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = Number(candles[j]?.volume);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function maxImpulseAtrMult(candles, fromIdx, toIdx, atrSeries) {
  let best = 0;
  for (let j = fromIdx; j <= toIdx; j++) {
    const atr = Number(atrSeries[j] ?? 0);
    if (atr <= 0) continue;
    const range = Number(candles[j].high) - Number(candles[j].low);
    best = Math.max(best, range / atr);
  }
  return best;
}

function reclaimedThenFailed(candles, idx, side, level, bars = 3) {
  for (let j = idx + 1; j <= Math.min(candles.length - 1, idx + bars); j++) {
    const c = candles[j];
    if (side === "BUY" && c.close < level) return true;
    if (side === "SELL" && c.close > level) return true;
  }
  return false;
}

function detectRegime15m(adx) {
  if (adx >= 25) return "trending";
  if (adx >= 18) return "developing";
  return "compression";
}

function atrPercentile(atrSeries, idx, lookback = 96 * 5) {
  const cur = Number(atrSeries[idx] ?? 0);
  if (cur <= 0) return 50;
  const slice = [];
  for (let j = Math.max(0, idx - lookback); j <= idx; j++) {
    const v = Number(atrSeries[j] ?? 0);
    if (v > 0) slice.push(v);
  }
  if (!slice.length) return 50;
  const below = slice.filter((v) => v <= cur).length;
  return (below / slice.length) * 100;
}

function dayRegime(candles, idx, pre) {
  if (isBreakdownDay(candles, idx, pre)) return "breakdown";
  if (isBreakoutDay(candles, idx, pre)) return "breakout";
  return "neutral";
}

function classifyFailure(trade, mfePct) {
  const exit = String(trade.exitReason ?? "").toLowerCase();
  const mfe = Number(mfePct ?? 0) * 100;
  const pnl = Number(trade.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe < 0.15) return "never_green";
  if (exit.includes("sl")) return mfe >= 0.5 ? "sl_after_profit" : "sl_no_follow";
  if (exit.includes("trail")) return mfe >= 0.3 ? "trail_gave_back" : "trail_scratch";
  if (exit.includes("time_stop")) return mfe >= 0.5 ? "time_stop_gave_back" : "time_stop_scratch";
  if (exit.includes("be")) return "breakeven_after_partial";
  return "other_loss";
}

function enrichTrade(trade, candles, pre, opts) {
  let idx = candles.findIndex((c) => c.ts === trade.entryTs);
  if (idx < 0) {
    idx = candles.findIndex((c) => c.ts > trade.entryTs);
    if (idx > 0) idx--;
  }
  if (idx < 1) return null;

  const side = trade.direction;
  const liq = trade.liqContext ?? {};
  const setups = listSessionLiquiditySetups(candles, idx, side, pre, opts);
  const setup =
    setups.find((s) => s.levelType === liq.levelType) ??
    setups.sort((a, b) => b.liqQuality - a.liqQuality)[0] ??
    null;

  const bar = candles[idx];
  const dayStart = dayStartIndex(candles, idx);
  const reclaimBars = setup ? idx - setup.sweepStartIdx : null;
  const range = Math.max(1e-9, bar.high - bar.low);
  const bodyRatio = Math.abs(bar.close - bar.open) / range;
  const volAvg = avgVolume(candles, idx);
  const volRatio = volAvg > 0 ? Number(bar.volume) / volAvg : 1;
  const adx = Number(pre.adxSeries?.[idx] ?? 0);
  const atr = Number(pre.atrSeries?.[idx] ?? 0);
  const atrPrev = Number(pre.atrSeries?.[Math.max(0, idx - 5)] ?? atr);
  const atrRatio = atrPrev > 0 ? atr / atrPrev : 1;
  const impulse = setup
    ? maxImpulseAtrMult(candles, setup.sweepStartIdx, idx, pre.atrSeries)
    : 0;
  const dispSince = barsSinceDisplacement(candles, idx, dayStart, pre, opts);
  const htfUp = pre.htfUp?.[idx];
  const htfDown = pre.htfDown?.[idx];
  const htfSep = Number(pre.htfSep?.[idx] ?? 0);
  const entryScore = Number(setup?.liqQuality ?? liq.liqQuality ?? 0);
  const mfePct = Number(trade.mfePct ?? 0);
  const maePct = Number(trade.maePct ?? 0);
  const pnl = Number(trade.netPnl ?? 0);
  const equity = Number(trade.equityAtEntry ?? START);
  const pnlPct = equity > 0 ? (pnl / equity) * 100 : 0;
  const mfeDollar = equity * mfePct;
  const exitEff =
    mfeDollar > 0.01 ? Math.max(-2, Math.min(2, pnl / mfeDollar)) : pnl > 0 ? 1 : 0;
  const givebackPct = mfePct > 0 ? Math.max(0, (mfePct - Math.max(0, pnl / equity)) / mfePct) * 100 : 0;

  return {
    symbol: opts.symbol,
    tradeId: trade.tradeNumber ?? trade.entryTs,
    pnl,
    pnlPct,
    win: pnl > 0,
    exit: trade.exitReason,
    failure: classifyFailure(trade, mfePct),
    side,
    levelType: setup?.levelType ?? liq.levelType ?? "?",
    liquidityClass: ["pdh", "pdl"].includes(setup?.levelType ?? liq.levelType)
      ? "daily"
      : ["session_high", "session_low"].includes(setup?.levelType ?? liq.levelType)
        ? "session"
        : "other",
    extension: setup?.extension ?? null,
    reclaimBars,
    sweepSpeed: reclaimBars == null ? null : reclaimBars <= 2 ? "fast" : reclaimBars <= 8 ? "medium" : "slow",
    bodyRatio,
    volRatio,
    adx,
    regime15m: detectRegime15m(adx),
    dayRegime: dayRegime(candles, idx, pre),
    volState: atrRatio < 0.9 ? "compression" : atrRatio > 1.1 ? "expansion" : "normal",
    atrPctile: atrPercentile(pre.atrSeries, idx),
    impulse,
    displacement: impulse >= 1.25 ? "strong" : impulse >= 1.0 ? "moderate" : "weak",
    dispSince,
    htfTrend: htfUp ? "up" : htfDown ? "down" : "flat",
    htfSep,
    counterHtf: (side === "BUY" && htfDown) || (side === "SELL" && htfUp),
    fakeReclaim: setup ? reclaimedThenFailed(candles, idx, side, setup.level) : null,
    session: sessionBucket(trade.entryTs),
    entryScore,
    mfePct: mfePct * 100,
    maePct: maePct * 100,
    barsHeld: trade.barsHeld ?? 0,
    exitEff,
    givebackPct,
  };
}

async function runCoin(symbol, cfgPatch = {}, trail = false) {
  const candles = await readCandles(symbol, TF, FROM, TO, { market: "futures" });
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, ...cfgPatch, symbol, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const pre = precomputeIntraday(candles);
  const trailMicro = trail
    ? await buildTrailMicroContext({ symbol, fromMs: FROM, toMs: TO, cfg, trailEnabled: true })
    : null;
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const rows = [];
  for (const t of sim.trades) {
    const row = enrichTrade(t, candles, pre, { ...cfg, symbol });
    if (row) rows.push(row);
  }
  return { symbol, rows, metrics: m, n: sim.trades.length, trail };
}

function mean(arr, key) {
  const vals = arr.map((r) => Number(r[key])).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

function bucketStats(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[key] ?? "?");
    const b = m.get(k) ?? { n: 0, pnl: 0, wins: 0, mfe: 0 };
    b.n++;
    b.pnl += r.pnl;
    if (r.win) b.wins++;
    b.mfe += r.mfePct;
    m.set(k, b);
  }
  return [...m.entries()]
    .map(([k, v]) => ({
      key: k,
      n: v.n,
      wr: (v.wins / v.n) * 100,
      avgPnl: v.pnl / v.n,
      totalPnl: v.pnl,
      avgMfe: v.mfe / v.n,
    }))
    .sort((a, b) => b.n - a.n);
}

function scoreBins(rows) {
  const bins = [
    [0, 60],
    [60, 70],
    [70, 80],
    [80, 90],
    [90, 101],
  ];
  return bins.map(([lo, hi]) => {
    const sub = rows.filter((r) => r.entryScore >= lo && r.entryScore < hi);
    return {
      range: `${lo}-${hi - 1}`,
      n: sub.length,
      wr: sub.length ? (sub.filter((x) => x.win).length / sub.length) * 100 : 0,
      avgPnl: sub.length ? sub.reduce((a, x) => a + x.pnl, 0) / sub.length : 0,
      totalPnl: sub.reduce((a, x) => a + x.pnl, 0),
    };
  });
}

function featureImportance(rows) {
  const features = [
    "entryScore",
    "extension",
    "reclaimBars",
    "bodyRatio",
    "volRatio",
    "adx",
    "impulse",
    "htfSep",
    "atrPctile",
    "mfePct",
    "maePct",
    "givebackPct",
  ];
  const pnls = rows.map((r) => r.pnl);
  return features
    .map((f) => {
      const xs = rows.map((r) => Number(r[f])).filter((v) => Number.isFinite(v));
      const ys = rows.filter((r) => Number.isFinite(Number(r[f]))).map((r) => r.pnl);
      const corr = pearson(xs, ys);
      return { feature: f, corr, n: xs.length };
    })
    .filter((x) => x.n >= 8)
    .sort((a, b) => Math.abs(b.corr ?? 0) - Math.abs(a.corr ?? 0));
}

function compareFeature(coinA, coinB, key) {
  const aAll = mean(coinA, key);
  const bAll = mean(coinB, key);
  const aWin = mean(coinA.filter((r) => r.win), key);
  const bWin = mean(coinB.filter((r) => r.win), key);
  const aLoss = mean(coinA.filter((r) => !r.win), key);
  const bLoss = mean(coinB.filter((r) => !r.win), key);
  return { key, bnb: aAll, btc: bAll, delta: bAll != null && aAll != null ? bAll - aAll : null, bnbWin: aWin, btcWin: bWin, bnbLoss: aLoss, btcLoss: bLoss };
}

console.log("\n=== LIQ quantitative research: BNB vs BTC ===\n");
console.log(`Window: ${new Date(FROM).toISOString().slice(0, 10)} → ${new Date(TO).toISOString().slice(0, 10)}`);
console.log("Preset: INTRADAY_PRO_LIQ_15M (partial TP, breakdown bias fixed)\n");

const results = {};
for (const sym of COINS) {
  process.stdout.write(`Running ${sym} partial TP…\n`);
  results[sym] = await runCoin(sym, {}, false);
}

const bnb = results.BNBUSDT.rows;
const btc = results.BTCUSDT.rows;

console.log("\n--- Headline ---");
for (const sym of COINS) {
  const r = results[sym];
  console.log(
    `${sym}: n=${r.n} ret=${Number(r.metrics.totalReturnPct).toFixed(2)}% WR=${(Number(r.metrics.winRate) * 100).toFixed(1)}% PF=${Number(r.metrics.profitFactor).toFixed(2)}`,
  );
}

console.log("\n--- WHY BNB vs BTC? Feature means (all trades) ---");
const compareKeys = [
  "entryScore",
  "extension",
  "reclaimBars",
  "bodyRatio",
  "volRatio",
  "adx",
  "impulse",
  "htfSep",
  "atrPctile",
  "mfePct",
  "maePct",
  "barsHeld",
  "givebackPct",
  "exitEff",
];
console.log(`${"feature".padEnd(16)} ${"BNB".padStart(8)} ${"BTC".padStart(8)} ${"Δ".padStart(8)} ${"BNB W".padStart(8)} ${"BTC W".padStart(8)} ${"BNB L".padStart(8)} ${"BTC L".padStart(8)}`);
for (const k of compareKeys) {
  const c = compareFeature(bnb, btc, k);
  const fmt = (v) => (v == null ? "—" : v.toFixed(3));
  console.log(
    `${k.padEnd(16)} ${fmt(c.bnb).padStart(8)} ${fmt(c.btc).padStart(8)} ${fmt(c.delta).padStart(8)} ${fmt(c.bnbWin).padStart(8)} ${fmt(c.btcWin).padStart(8)} ${fmt(c.bnbLoss).padStart(8)} ${fmt(c.btcLoss).padStart(8)}`,
  );
}

console.log("\n--- BTC winners vs losers (feature divergence) ---");
const btcW = btc.filter((r) => r.win);
const btcL = btc.filter((r) => !r.win);
console.log(`${"feature".padEnd(16)} ${"winners".padStart(10)} ${"losers".padStart(10)} ${"Δ".padStart(10)}`);
for (const k of compareKeys) {
  const w = mean(btcW, k);
  const l = mean(btcL, k);
  const d = w != null && l != null ? w - l : null;
  const fmt = (v) => (v == null ? "—" : v.toFixed(3));
  console.log(`${k.padEnd(16)} ${fmt(w).padStart(10)} ${fmt(l).padStart(10)} ${fmt(d).padStart(10)}`);
}

console.log("\n--- BTC feature correlation with PnL ---");
for (const f of featureImportance(btc)) {
  console.log(`  ${f.feature.padEnd(16)} r=${(f.corr ?? 0).toFixed(3)} n=${f.n}`);
}

console.log("\n--- BTC entry score → conditional expectancy ---");
for (const b of scoreBins(btc)) {
  console.log(
    `  score ${b.range.padEnd(8)} n=${String(b.n).padStart(3)} WR=${b.wr.toFixed(1).padStart(5)}% avg$=${b.avgPnl.toFixed(3)} total=$${b.totalPnl.toFixed(2)}`,
  );
}

console.log("\n--- BTC market regime buckets ---");
for (const label of ["regime15m", "dayRegime", "volState", "liquidityClass", "session", "htfTrend", "displacement", "sweepSpeed"]) {
  console.log(`\n  [${label}]`);
  for (const b of bucketStats(btc, label)) {
    console.log(
      `    ${b.key.padEnd(14)} n=${String(b.n).padStart(3)} WR=${b.wr.toFixed(0).padStart(3)}% avg$=${b.avgPnl.toFixed(3)} total=$${b.totalPnl.toFixed(2)} avgMFE=${b.avgMfe.toFixed(2)}%`,
    );
  }
}

console.log("\n--- BTC failure clustering ---");
for (const b of bucketStats(btc, "failure")) {
  console.log(`  ${b.key.padEnd(22)} n=${String(b.n).padStart(3)} avg$=${b.avgPnl.toFixed(3)} avgMFE=${b.avgMfe.toFixed(2)}%`);
}

console.log("\n--- Exit efficiency (realized / MFE dollar) ---");
for (const sym of COINS) {
  const rows = results[sym].rows;
  const winners = rows.filter((r) => r.win);
  const losers = rows.filter((r) => !r.win);
  console.log(
    `${sym}: winners exitEff=${mean(winners, "exitEff")?.toFixed(2) ?? "—"} giveback=${mean(winners, "givebackPct")?.toFixed(1) ?? "—"}% | losers exitEff=${mean(losers, "exitEff")?.toFixed(2) ?? "—"} avgMFE=${mean(losers, "mfePct")?.toFixed(2) ?? "—"}%`,
  );
}

console.log("\n--- BTC: partial TP vs trail-only (exit hypothesis) ---");
const btcTrail = await runCoin("BTCUSDT", {
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  intradayLiqMinRr: 0,
  intradayLiqRequireSweepDisplacement: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  backtestTrailMicroTf: "5m",
}, true);

console.log(
  `partial: n=${results.BTCUSDT.n} ret=${Number(results.BTCUSDT.metrics.totalReturnPct).toFixed(2)}% avgMFE=${mean(btc, "mfePct")?.toFixed(2)}% avgExitEff=${mean(btc, "exitEff")?.toFixed(2)}`,
);
console.log(
  `trail:   n=${btcTrail.n} ret=${Number(btcTrail.metrics.totalReturnPct).toFixed(2)}% avgMFE=${mean(btcTrail.rows, "mfePct")?.toFixed(2)}% avgExitEff=${mean(btcTrail.rows, "exitEff")?.toFixed(2)} WR=${(Number(btcTrail.metrics.winRate) * 100).toFixed(1)}%`,
);
console.log("Trail failure modes:");
for (const b of bucketStats(btcTrail.rows, "failure")) {
  console.log(`  ${b.key.padEnd(22)} n=${b.n} avgMFE=${b.avgMfe.toFixed(2)}%`);
}

console.log("\n--- BNB regime buckets (same preset, for contrast) ---");
for (const label of ["regime15m", "dayRegime", "displacement", "levelType"]) {
  console.log(`\n  [${label}] BNB`);
  for (const b of bucketStats(bnb, label).slice(0, 5)) {
    console.log(
      `    ${b.key.padEnd(14)} n=${String(b.n).padStart(3)} WR=${b.wr.toFixed(0).padStart(3)}% total=$${b.totalPnl.toFixed(2)}`,
    );
  }
  console.log(`  [${label}] BTC`);
  for (const b of bucketStats(btc, label).slice(0, 5)) {
    console.log(
      `    ${b.key.padEnd(14)} n=${String(b.n).padStart(3)} WR=${b.wr.toFixed(0).padStart(3)}% total=$${b.totalPnl.toFixed(2)}`,
    );
  }
}

console.log("\n--- Research status (defensible summary) ---");
console.log("• Bug fixed: breakdown-day veto was blocking classical setups on BTC.");
console.log(`• Current implementation: BTC ${results.BTCUSDT.n} trades (~${(results.BTCUSDT.n / 12).toFixed(1)}/mo), all tested micro-params negative in prior sweep.`);
console.log("• Root cause of BTC negative expectancy: NOT identified — requires regime/exit hypotheses above.");
console.log("• Entry score correlation on BTC:", featureImportance(btc).find((f) => f.feature === "entryScore")?.corr?.toFixed(3) ?? "n/a");

await closePool();
