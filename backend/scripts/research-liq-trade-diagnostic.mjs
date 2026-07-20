#!/usr/bin/env node
/**
 * Multi-coin LIQ trade diagnostic — classify wins/losses by market structure (not parameter fit).
 * Usage: cd backend && node scripts/research-liq-trade-diagnostic.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TF = "15m";
const COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "LINKUSDT"];
const WINDOWS = {
  train: { from: Date.parse("2024-01-01"), to: Date.parse("2025-06-01"), label: "train" },
  val: { from: Date.parse("2025-06-01"), to: Date.parse("2025-12-01"), label: "val" },
  oos: { from: Date.parse("2025-12-01"), to: Date.parse("2026-06-01"), label: "oos" },
};
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
const { listSessionLiquiditySetups } = await import("../src/strategy/techniques/liquidity.js");
const { barsSinceDisplacement } = await import("../src/strategy/techniques/liquidity.js");

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

function classifyTrade(ctx) {
  const tags = [];
  if (ctx.sameBarReclaim) tags.push("same_bar_reclaim");
  if (ctx.slowReclaim) tags.push("slow_reclaim");
  if (ctx.fastReclaim) tags.push("fast_reclaim");
  if (ctx.lowExtension) tags.push("low_sweep_extension");
  if (ctx.fakeReclaim) tags.push("fake_reclaim");
  if (ctx.weakReclaimBody) tags.push("weak_reclaim_body");
  if (ctx.counterHtf) tags.push("counter_htf");
  if (ctx.chopAdx) tags.push("chop_low_adx");
  if (ctx.exhaustedAdx) tags.push("exhausted_high_adx");
  if (ctx.lowVolume) tags.push("low_volume");
  if (ctx.noDisplacement) tags.push("no_displacement");
  if (ctx.postDisplacement) tags.push("post_displacement");
  if (ctx.localLevel) tags.push("local_level");
  if (ctx.deadVolatility) tags.push("dead_volatility");
  if (!tags.length) tags.push("unclassified");
  return tags;
}

function enrichTrade(trade, candles, pre, opts) {
  const entryTs = trade.entryTs;
  let idx = candles.findIndex((c) => c.ts === entryTs);
  if (idx < 0) {
    idx = candles.findIndex((c) => c.ts > entryTs);
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
  if (!setup) return null;

  const bar = candles[idx];
  const dayStart = dayStartIndex(candles, idx);
  const reclaimBars = idx - setup.sweepStartIdx;
  const range = Math.max(1e-9, bar.high - bar.low);
  const bodyRatio = Math.abs(bar.close - bar.open) / range;
  const volAvg = avgVolume(candles, idx);
  const volRatio = volAvg > 0 ? Number(bar.volume) / volAvg : 1;
  const adx = Number(pre.adxSeries?.[idx] ?? 0);
  const atr = Number(pre.atrSeries?.[idx] ?? 0);
  const atrPrev = Number(pre.atrSeries?.[Math.max(0, idx - 5)] ?? atr);
  const impulse = maxImpulseAtrMult(candles, setup.sweepStartIdx, idx, pre.atrSeries);
  const dispSince = barsSinceDisplacement(candles, idx, dayStart, pre, opts);
  const htfUp = pre.htfUp?.[idx];
  const htfDown = pre.htfDown?.[idx];
  const counterHtf = (side === "BUY" && htfDown) || (side === "SELL" && htfUp);
  const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);

  const ctx = {
    symbol: opts.symbol,
    pnl: Number(trade.netPnl ?? 0),
    win: Number(trade.netPnl ?? 0) > 0,
    exit: trade.exitReason,
    side,
    levelType: setup.levelType,
    extension: setup.extension,
    reclaimBars,
    sameBarReclaim: setup.reclaimIdx === setup.sweepStartIdx,
    slowReclaim: reclaimBars > 8,
    fastReclaim: reclaimBars <= 2,
    lowExtension: setup.extension + 1e-6 < minExt,
    fakeReclaim: reclaimedThenFailed(candles, idx, side, setup.level),
    weakReclaimBody: bodyRatio < 0.35,
    counterHtf,
    chopAdx: adx > 0 && adx < 18,
    exhaustedAdx: adx > 40,
    lowVolume: volRatio < 0.85,
    noDisplacement: impulse < 1.25,
    postDisplacement: dispSince < Number(opts.intradayLiqPostDisplacementCooldownBars ?? 0),
    localLevel: !["pdh", "pdl", "session_high", "session_low"].includes(setup.levelType),
    deadVolatility: atrPrev > 0 && atr / atrPrev < 0.85,
    session: sessionBucket(entryTs),
    adx,
    volRatio,
    impulse,
    htfTrend: htfUp ? "up" : htfDown ? "down" : "flat",
    liqQuality: setup.liqQuality,
  };
  ctx.tags = classifyTrade(ctx);
  return ctx;
}

async function runCoinWindow(symbol, win) {
  const candles = await readCandles(symbol, TF, win.from, win.to, { market: "futures" });
  if (candles.length < 500) return { symbol, win: win.label, skip: "insufficient_data", n: candles.length };

  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    {
      ...INTRADAY_PRO_LIQ_15M,
      symbol,
      timeframe: TF,
      intradayGateLiquidity: true,
      intradayGateSession: false,
      trailingStopLossAuto: false,
    },
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
    startingUsdt: START,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });

  const enriched = [];
  for (const t of sim.trades) {
    const row = enrichTrade(t, candles, pre, { ...cfg, symbol });
    if (row) enriched.push(row);
  }

  return {
    symbol,
    win: win.label,
    trades: sim.trades.length,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    dd: Number(m.maxDrawdownPct ?? 0),
    enriched,
  };
}

function summarizeTagStats(rows) {
  const byTag = new Map();
  for (const r of rows) {
    for (const tag of r.tags) {
      const b = byTag.get(tag) ?? { n: 0, wins: 0, pnl: 0, losses: 0 };
      b.n++;
      b.pnl += r.pnl;
      if (r.win) b.wins++;
      else b.losses++;
      byTag.set(tag, b);
    }
  }
  return [...byTag.entries()]
    .map(([tag, s]) => ({
      tag,
      n: s.n,
      wr: s.n ? (s.wins / s.n) * 100 : 0,
      avgPnl: s.n ? s.pnl / s.n : 0,
      totalPnl: s.pnl,
      lossRate: s.n ? (s.losses / s.n) * 100 : 0,
    }))
    .sort((a, b) => b.n - a.n);
}

console.log("\nLIQ trade diagnostic — multi-coin, train/val/oos\n");
const allRows = [];
const summaries = [];

for (const symbol of COINS) {
  for (const win of Object.values(WINDOWS)) {
    process.stdout.write(`\r  ${symbol} ${win.label}…`);
    try {
      const r = await runCoinWindow(symbol, win);
      summaries.push(r);
      if (r.enriched) allRows.push(...r.enriched.map((e) => ({ ...e, window: win.label })));
    } catch (e) {
      summaries.push({ symbol, win: win.label, error: String(e.message ?? e) });
    }
  }
}
console.log("\n");

console.log("=== Window performance (base INTRADAY_PRO_LIQ_15M) ===");
console.log(`${"coin".padEnd(10)} ${"win".padEnd(6)} ${"n".padStart(4)} ${"ret%".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(6)}`);
for (const s of summaries.filter((x) => !x.skip && !x.error)) {
  console.log(
    `${s.symbol.padEnd(10)} ${s.win.padEnd(6)} ${String(s.trades).padStart(4)} ${s.ret.toFixed(2).padStart(8)} ${s.pf.toFixed(2).padStart(6)} ${s.wr.toFixed(1).padStart(6)}`,
  );
}

const losses = allRows.filter((r) => !r.win);
const wins = allRows.filter((r) => r.win);
console.log(`\n=== Enriched trades: ${allRows.length} total, ${wins.length} wins, ${losses.length} losses ===`);

const tagStats = summarizeTagStats(allRows);
console.log("\n=== Tag frequency (all trades) ===");
console.log(`${"tag".padEnd(22)} ${"n".padStart(5)} ${"WR%".padStart(6)} ${"avg$".padStart(8)} ${"loss%".padStart(7)}`);
for (const t of tagStats.slice(0, 15)) {
  console.log(
    `${t.tag.padEnd(22)} ${String(t.n).padStart(5)} ${t.wr.toFixed(1).padStart(6)} ${t.avgPnl.toFixed(3).padStart(8)} ${t.lossRate.toFixed(1).padStart(7)}`,
  );
}

const lossTagStats = summarizeTagStats(losses);
console.log("\n=== Dominant tags on LOSERS only ===");
for (const t of lossTagStats.sort((a, b) => b.n - a.n).slice(0, 12)) {
  console.log(`${t.tag.padEnd(22)} n=${String(t.n).padStart(4)} avg$=${t.avgPnl.toFixed(3)}`);
}

function bucket(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[key] ?? "?");
    const b = m.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    b.n++;
    b.pnl += r.pnl;
    if (r.win) b.wins++;
    m.set(k, b);
  }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
}

console.log("\n=== By level type ===");
for (const [k, v] of bucket(allRows, "levelType")) {
  console.log(`  ${k.padEnd(14)} n=${v.n} WR=${((v.wins / v.n) * 100).toFixed(1)}% net=$${v.pnl.toFixed(2)}`);
}

console.log("\n=== By session ===");
for (const [k, v] of bucket(allRows, "session")) {
  console.log(`  ${k.padEnd(10)} n=${v.n} WR=${((v.wins / v.n) * 100).toFixed(1)}% net=$${v.pnl.toFixed(2)}`);
}

console.log("\n=== no_displacement vs has displacement ===");
const noDisp = allRows.filter((r) => r.tags.includes("no_displacement"));
const hasDisp = allRows.filter((r) => !r.tags.includes("no_displacement"));
const stat = (arr) => ({
  n: arr.length,
  wr: arr.length ? (arr.filter((x) => x.win).length / arr.length) * 100 : 0,
  pnl: arr.reduce((a, x) => a + x.pnl, 0),
});
console.log("  no_displacement", stat(noDisp));
console.log("  has_displacement", stat(hasDisp));

console.log("\n=== fake_reclaim vs not ===");
const fake = allRows.filter((r) => r.tags.includes("fake_reclaim"));
const notFake = allRows.filter((r) => !r.tags.includes("fake_reclaim"));
console.log("  fake_reclaim", stat(fake));
console.log("  not_fake", stat(notFake));

await closePool();
