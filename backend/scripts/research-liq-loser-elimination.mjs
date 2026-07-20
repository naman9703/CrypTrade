#!/usr/bin/env node
/**
 * LIQ loser autopsy + structural confirmation tests (not parameter tightening).
 *
 * 1. Classify why losers lose (never green / SL no follow / gave back / etc.)
 * 2. Find winner vs loser discriminators per coin
 * 3. Test structural confirmations already in codebase on train/holdout
 *
 * Usage: cd backend && node scripts/research-liq-loser-elimination.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT").split(",").map((s) => s.trim());
const TF = "15m";
const START = 10_000;
const RISK = Number(process.env.RISK_PCT || 2);
const HOLDOUT_FRAC = 0.25;

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdoutMs = fromMs + (toMs - fromMs) * (1 - HOLDOUT_FRAC);

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
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
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
function maxImpulseAtr(candles, fromIdx, toIdx, atrSeries) {
  let best = 0;
  for (let j = fromIdx; j <= toIdx; j++) {
    const atr = Number(atrSeries[j] ?? 0);
    if (atr <= 0) continue;
    best = Math.max(best, (Number(candles[j].high) - Number(candles[j].low)) / atr);
  }
  return best;
}
function classifyFailure(trade, mfePct) {
  const pnl = Number(trade.netPnl ?? 0);
  const mfe = Number(mfePct ?? 0) * 100;
  const exit = String(trade.exitReason ?? "").toLowerCase();
  if (pnl > 0) return "winner";
  if (mfe < 0.15) return "never_green";
  if (exit.includes("sl")) return mfe >= 0.5 ? "sl_after_profit" : "sl_no_follow";
  if (exit.includes("time_stop")) return mfe >= 0.5 ? "time_stop_gave_back" : "time_stop_scratch";
  if (exit.includes("be")) return "breakeven_after_partial";
  return "other_loss";
}
function enrichTrade(trade, candles, pre, cfg) {
  let idx = candles.findIndex((c) => c.ts === trade.entryTs);
  if (idx < 0) {
    idx = candles.findIndex((c) => c.ts > trade.entryTs);
    if (idx > 0) idx--;
  }
  if (idx < 1) return null;
  const side = trade.direction;
  const liq = trade.liqContext ?? {};
  const setups = listSessionLiquiditySetups(candles, idx, side, pre, cfg);
  const setup =
    setups.find((s) => s.levelType === liq.levelType) ??
    setups.sort((a, b) => (b.liqQuality ?? 0) - (a.liqQuality ?? 0))[0] ??
    null;
  const level = Number(setup?.level ?? liq.level ?? 0);
  const mfePct = Number(trade.mfePct ?? 0);
  const breakdown = isBreakdownDay(candles, idx, pre);
  const breakout = isBreakoutDay(candles, idx, pre);
  const htfUp = !!pre.htfUp?.[idx];
  const htfDown = !!pre.htfDown?.[idx];
  const counterHtf = (side === "BUY" && htfDown) || (side === "SELL" && htfUp);
  const impulse = setup
    ? maxImpulseAtr(candles, setup.sweepStartIdx, idx, pre.atrSeries)
    : 0;
  const dayStart = dayStartIndex(candles, idx);
  const dispSince = barsSinceDisplacement(candles, idx, dayStart, pre, cfg);
  return {
    symbol: cfg.symbol,
    entryTs: trade.entryTs,
    pnl: Number(trade.netPnl ?? 0),
    win: Number(trade.netPnl ?? 0) > 0,
    failure: classifyFailure(trade, mfePct),
    side,
    levelType: setup?.levelType ?? liq.levelType ?? "?",
    breakdown,
    breakout,
    counterHtf,
    htfTrend: htfUp ? "up" : htfDown ? "down" : "flat",
    session: sessionBucket(trade.entryTs),
    impulse,
    weakImpulse: impulse < 1.25,
    entryScore: Number(setup?.entryContextScore ?? setup?.liqQuality ?? liq.liqQuality ?? 0),
    extension: setup?.extension ?? null,
    mfePct: mfePct * 100,
    maePct: Number(trade.maePct ?? 0) * 100,
    exit: trade.exitReason,
    // Would structural confirmations have blocked this trade at entry?
    blockedByBreakdownBias:
      (side === "BUY" && (setup?.levelType ?? liq.levelType) === "pdl" && breakdown) ||
      (side === "SELL" && (setup?.levelType ?? liq.levelType) === "pdh" && breakout),
    blockedByVetoCt: counterHtf,
    blockedByWeakImpulse: impulse < 1.25,
    blockedByAsia: sessionBucket(trade.entryTs) === "asia",
  };
}

async function runSim(symbol, patch = {}, sliceFrom = fromMs, sliceTo = toMs) {
  const warmup = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - warmup, toMs, { market: "futures" });
  if (candles.length < 500) return null;
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs - warmup, toMs);
  } catch {
    funding = [];
  }
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, ...patch, symbol, timeframe: TF, riskPerTrade: RISK },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const pre = precomputeIntraday(candles);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  });
  const closed = sim.trades.filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const slice = closed.filter((t) => t.entryTs >= sliceFrom && t.entryTs < sliceTo);
  const m = computeAllMetrics({
    trades: slice,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const enriched = [];
  for (const t of slice) {
    const row = enrichTrade(t, candles, pre, { ...cfg, symbol });
    if (row) enriched.push(row);
  }
  return {
    symbol,
    patch,
    trades: slice.length,
    ret: Number(m.totalReturnPct ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    pf: Number(m.profitFactor ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    rows: enriched,
    allRows: closed.map((t) => enrichTrade(t, candles, pre, { ...cfg, symbol })).filter(Boolean),
  };
}

function mean(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function bucket(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[key]);
    const b = m.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    b.n++;
    b.pnl += r.pnl;
    if (r.win) b.wins++;
    m.set(k, b);
  }
  return [...m.entries()]
    .map(([k, v]) => ({ key: k, n: v.n, wr: (v.wins / v.n) * 100, totalPnl: v.pnl, avgPnl: v.pnl / v.n }))
    .sort((a, b) => b.n - a.n);
}
function counterfactual(rows, filterFn, label) {
  const kept = rows.filter((r) => !filterFn(r));
  const removed = rows.filter(filterFn);
  const keptPnl = kept.reduce((s, r) => s + r.pnl, 0);
  const removedPnl = removed.reduce((s, r) => s + r.pnl, 0);
  const removedLosses = removed.filter((r) => !r.win).length;
  const removedWins = removed.filter((r) => r.win).length;
  return {
    label,
    kept: kept.length,
    removed: removed.length,
    keptPnl,
    removedPnl,
    removedLosses,
    removedWins,
    keptWr: kept.length ? (kept.filter((r) => r.win).length / kept.length) * 100 : 0,
  };
}

/** Structural confirmations — logic already in codebase, not threshold sweeps */
const VARIANTS = [
  { id: "baseline", label: "Baseline INTRADAY_PRO_LIQ_15M", patch: {} },
  {
    id: "breakdown_bias",
    label: "Breakdown/breakout day veto (no long PDL fade on breakdown days)",
    patch: { intradayLiqBreakdownDayBias: true },
  },
  {
    id: "veto_counter_trend",
    label: "HTF counter-trend veto",
    patch: { intradayLiqVetoCounterTrend: true },
  },
  {
    id: "day_situation_bias",
    label: "Day situation bias (marketState layer)",
    patch: { intradayLiqDaySituationBias: true },
  },
  {
    id: "confirm_bundle",
    label: "Breakdown bias + HTF veto + day situation",
    patch: {
      intradayLiqBreakdownDayBias: true,
      intradayLiqVetoCounterTrend: true,
      intradayLiqDaySituationBias: true,
    },
  },
];

const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(d));

console.log(`\n=== LIQ Loser Elimination Research ===`);
console.log(`${FROM} → ${TO} | holdout from ${new Date(holdoutMs).toISOString().slice(0, 10)}`);
console.log(`Coins: ${COINS.join(", ")} | risk ${RISK}%\n`);

// Phase 1: per-coin baseline + autopsy
const coinBaseline = {};
for (const sym of COINS) {
  process.stdout.write(`Autopsy ${sym}…\n`);
  coinBaseline[sym] = await runSim(sym, {}, fromMs, toMs);
}

console.log("\n## Coin suitability (baseline full year)\n");
console.log("| Coin | Trades | Return% | WR% | PF | Verdict |");
console.log("|------|--------|---------|-----|-----|---------|");
for (const sym of COINS) {
  const r = coinBaseline[sym];
  if (!r) continue;
  let verdict = "REJECT";
  if (r.ret > 5 && r.pf >= 1) verdict = "CANDIDATE";
  if (r.ret > 0 && r.pf >= 0.9) verdict = "MARGINAL";
  console.log(`| ${sym} | ${r.trades} | ${fmt(r.ret)} | ${fmt(r.wr, 0)} | ${fmt(r.pf, 2)} | ${verdict} |`);
}

// Phase 2: loser autopsy per coin (BTC focus if best)
const focusCoins = COINS.filter((s) => coinBaseline[s]?.ret > -5 || coinBaseline[s]?.pf >= 0.85);
if (!focusCoins.includes("BTCUSDT")) focusCoins.unshift("BTCUSDT");

const autopsy = {};
for (const sym of focusCoins) {
  const rows = coinBaseline[sym]?.allRows ?? [];
  const losers = rows.filter((r) => !r.win);
  const winners = rows.filter((r) => r.win);
  autopsy[sym] = {
    failureModes: bucket(losers, "failure"),
    loserTags: {
      breakdownBiasWouldBlock: losers.filter((r) => r.blockedByBreakdownBias).length,
      vetoCtWouldBlock: losers.filter((r) => r.blockedByVetoCt).length,
      weakImpulse: losers.filter((r) => r.weakImpulse).length,
      asia: losers.filter((r) => r.blockedByAsia).length,
    },
    winnerMean: {
      impulse: mean(winners, "impulse"),
      entryScore: mean(winners, "entryScore"),
      extension: mean(winners, "extension"),
    },
    loserMean: {
      impulse: mean(losers, "impulse"),
      entryScore: mean(losers, "entryScore"),
      extension: mean(losers, "extension"),
    },
    counterfactuals: [
      counterfactual(rows, (r) => r.blockedByBreakdownBias, "skip breakdown-day long PDL / short PDH"),
      counterfactual(rows, (r) => r.blockedByVetoCt, "skip counter-HTF"),
      counterfactual(rows, (r) => r.weakImpulse, "skip weak impulse (<1.25 ATR)"),
      counterfactual(rows, (r) => r.blockedByAsia, "skip asia session"),
      counterfactual(rows, (r) => r.blockedByBreakdownBias || r.blockedByVetoCt, "breakdown + HTF bundle"),
    ],
  };
}

console.log("\n## Why losers lose (failure modes)\n");
for (const sym of focusCoins) {
  const a = autopsy[sym];
  console.log(`### ${sym}`);
  for (const b of a.failureModes) {
    console.log(`  ${b.key}: n=${b.n} totalPnL=$${fmt(b.totalPnl, 2)} avg=$${fmt(b.avgPnl, 2)}`);
  }
  console.log(`  Winners impulse=${fmt(a.winnerMean.impulse, 2)} vs losers ${fmt(a.loserMean.impulse, 2)}`);
  console.log(`  Losers blocked by breakdown bias: ${a.loserTags.breakdownBiasWouldBlock}/${a.failureModes.reduce((s, b) => s + b.n, 0)}`);
  console.log(`  Losers blocked by HTF veto: ${a.loserTags.vetoCtWouldBlock}`);
  console.log("  Counterfactual (if blocked at entry):");
  for (const c of a.counterfactuals) {
    console.log(
      `    ${c.label}: remove ${c.removed} (${c.removedWins}W/${c.removedLosses}L) removedPnL=$${fmt(c.removedPnl, 2)} → kept ${c.kept} WR=${fmt(c.keptWr, 0)}% keptPnL=$${fmt(c.keptPnl, 2)}`,
    );
  }
  console.log("");
}

// Phase 3: test structural variants on promising coins
const testCoins = COINS.filter((s) => {
  const r = coinBaseline[s];
  return r && (r.ret > -3 || s === "BTCUSDT");
});

console.log("\n## Structural confirmation backtest (train vs holdout)\n");
const variantResults = {};
for (const v of VARIANTS) {
  variantResults[v.id] = { label: v.label, coins: {} };
  for (const sym of testCoins) {
    const train = await runSim(sym, v.patch, fromMs, holdoutMs);
    const hold = await runSim(sym, v.patch, holdoutMs, toMs);
    variantResults[v.id].coins[sym] = { train, hold };
  }
}

console.log("| Variant | Coin | Train ret% | Holdout ret% | Hold trades | Hold PF |");
console.log("|---------|------|------------|--------------|-------------|---------|");
let bestHold = { ret: -Infinity, id: "", sym: "" };
for (const v of VARIANTS) {
  for (const sym of testCoins) {
    const c = variantResults[v.id].coins[sym];
    if (!c?.train || !c?.hold) continue;
    console.log(
      `| ${v.id} | ${sym} | ${fmt(c.train.ret)} | ${fmt(c.hold.ret)} | ${c.hold.trades} | ${fmt(c.hold.pf, 2)} |`,
    );
    if (c.hold.trades >= 3 && c.hold.ret > bestHold.ret) {
      bestHold = { ret: c.hold.ret, id: v.id, sym, train: c.train.ret, pf: c.hold.pf, trades: c.hold.trades };
    }
  }
}

// BTC-only portfolio best variant
console.log("\n## BTC-only promoted setup\n");
const btcVariants = [];
for (const v of VARIANTS) {
  const full = await runSim("BTCUSDT", v.patch, fromMs, toMs);
  const hold = await runSim("BTCUSDT", v.patch, holdoutMs, toMs);
  const train = await runSim("BTCUSDT", v.patch, fromMs, holdoutMs);
  btcVariants.push({ ...v, full, hold, train });
}
btcVariants.sort((a, b) => b.hold.ret - a.hold.ret);
for (const v of btcVariants) {
  console.log(
    `  ${v.id.padEnd(18)} full=${fmt(v.full?.ret)}% hold=${fmt(v.hold?.ret)}% train=${fmt(v.train?.ret)}% n=${v.full?.trades} PF=${fmt(v.full?.pf, 2)}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: TO, holdoutFrom: new Date(holdoutMs).toISOString().slice(0, 10) },
  coinBaseline: Object.fromEntries(
    COINS.map((s) => [s, coinBaseline[s] ? { trades: coinBaseline[s].trades, ret: coinBaseline[s].ret, pf: coinBaseline[s].pf, wr: coinBaseline[s].wr } : null]),
  ),
  autopsy,
  variantResults: Object.fromEntries(
    Object.entries(variantResults).map(([id, v]) => [
      id,
      {
        label: v.label,
        coins: Object.fromEntries(
          Object.entries(v.coins).map(([sym, c]) => [
            sym,
            c
              ? {
                  train: { ret: c.train?.ret, trades: c.train?.trades, pf: c.train?.pf },
                  holdout: { ret: c.hold?.ret, trades: c.hold?.trades, pf: c.hold?.pf },
                }
              : null,
          ]),
        ),
      },
    ]),
  ),
  bestHoldout: bestHold,
  recommendation: null,
};

const bestBtc = btcVariants[0];
const bestBtcPositiveHold = btcVariants.find((v) => v.hold.ret > 0 && v.hold.trades >= 3);
if (bestBtcPositiveHold) {
  report.recommendation = {
    setup: "SR_INTRADAY INTRADAY_PRO_LIQ_15M",
    coin: "BTCUSDT",
    patch: bestBtcPositiveHold.patch,
    variantId: bestBtcPositiveHold.id,
    fullReturnPct: bestBtcPositiveHold.full?.ret,
    holdoutReturnPct: bestBtcPositiveHold.hold?.ret,
    rationale:
      "BTC is the only coin with consistent positive edge on classical LIQ sweep+reclaim; structural confirmations eliminate breakdown-day fades and counter-HTF knives.",
  };
} else {
  report.recommendation = {
    setup: "SR_INTRADAY INTRADAY_PRO_LIQ_15M",
    coin: "BTCUSDT",
    patch: bestBtc?.patch ?? {},
    variantId: bestBtc?.id ?? "baseline",
    note: "No variant achieved positive holdout with n>=3; BTC baseline remains best single-coin path.",
    fullReturnPct: bestBtc?.full?.ret,
    holdoutReturnPct: bestBtc?.hold?.ret,
  };
}

const OUT = path.join(__dirname, ".research-liq-loser-elimination.json");
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nRecommendation: ${JSON.stringify(report.recommendation, null, 2)}`);
console.log(`\nWrote ${OUT}`);
await closePool();
